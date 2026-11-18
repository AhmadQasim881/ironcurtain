/**
 * Host-enforced token and cost budget for one Docker infrastructure bundle.
 *
 * The MITM proxy is the only point every provider request of a container
 * agent passes through, so the budget is enforced there, per bundle (one MITM
 * proxy serves one bundle): the gate counts every completion exchange the
 * proxy forwards, whatever proxy credential (metrics lease) it carried. The
 * lease is an agent-readable correlation hint (`attribution-registry.ts`),
 * never an authority, so no decision here reads it: a process that drops or
 * forges the lease is counted all the same. In a shared-container workflow
 * all lanes of one bundle share one budget; per-state usage is still reported
 * (`BudgetGateSnapshot.byState`) from the exchanges' attribution.
 *
 * Admission (before a completion request is forwarded):
 *
 *   - `turn` mode (batch and workflow bundles): a request is forwarded only
 *     while the host runs an agent turn on the bundle (`beginTurn()`). A
 *     process left running between turns, or a deterministic workflow step,
 *     cannot reach the provider with the bundle's credentials.
 *   - `session` mode (PTY bundles): one session-long allowance; the cap is
 *     the bundle's cumulative usage.
 *   - The request's output cap (`max_tokens` and its per-protocol spellings,
 *     or {@link DEFAULT_OUTPUT_TOKEN_ESTIMATE} when it names none), times the
 *     number of choices it asks for (`n`, `candidateCount`), is pre-charged:
 *     a request is refused when the charged totals, plus the reservations of
 *     the requests still in flight, plus its own reservation, would exceed
 *     `maxTotalTokens` or `maxEstimatedCostUsd`. Field names are matched the
 *     way a lenient decoder may match them (case and `_`/`-` folded), and the
 *     largest value counts. The reservation covers output only; the inputs of
 *     the exchanges in flight can still take the totals past a limit, which
 *     then refuses every later request.
 *   - Prices follow the speed the request asks for: a fast-mode request
 *     (Anthropic `speed: "fast"`) is priced at the model's fast-mode list
 *     price (`pricingForSpeed`), which bills every token at a multiple of the
 *     standard rate. Any `speed` other than `standard` counts as fast, so an
 *     unrecognized value prices fail-closed (see {@link requestedSpeed}).
 *   - The first budget refusal latches the gate: every later completion
 *     request is refused and `onExhausted` listeners (the session) stop the
 *     running turn and end the session with `BudgetExhaustedError`.
 *
 * Settlement (when the exchange ends) replaces the reservation with a charge:
 *
 *   - final usage (the protocol's terminal report was observed and every
 *     counter is known): the measured tokens, priced with the gateway's own
 *     cost when it reports one (OpenRouter) and otherwise at list prices
 *     (`llm-metrics/pricing.ts`, per billing attempt and per attempt model,
 *     at the fast-mode price when the request as forwarded, or the observed
 *     exchange record, asked for fast mode). A request whose prompt is past
 *     its model's unmodeled long-context threshold (Sonnet 4.x and Opus 4.6
 *     above 200K tokens, the Gemini Pro upper tiers) bills at prices the
 *     table does not list, so it is charged twice the listed rates
 *     (`estimateCapRequestCostUsd`), with a warning once per model;
 *   - usage that could not be measured (a protocol the proxy does not parse, a
 *     stream that ended or was aborted before its final usage report, a
 *     response without usage, an unparsable body): a conservative estimate,
 *     never zero, and a warning in the log. Output is the larger of what was
 *     measured and the reserved output cap. Input is the measured total when
 *     the response reported one, and otherwise the larger of the measured
 *     parts and an estimate from the size of the forwarded request body
 *     ({@link ESTIMATED_REQUEST_BYTES_PER_INPUT_TOKEN}), priced at the plain
 *     input rate: the agent chooses whether usage is reported (a Chat
 *     Completions stream without `include_usage`, a stream dropped before its
 *     usage event), so unmeasured input must not be free;
 *   - nothing for a request the provider answered with an error status (it
 *     bills none) or that never reached the provider (the upstream connection
 *     was never established). Both facts come from the upstream side of the
 *     proxy, never from the agent.
 *
 * The gate works whether or not statistics persistence is enabled: the proxy
 * observes completion usage for it either way and publishes exchange records
 * to the statistics bus only when statistics are on.
 */

import * as logger from '../logger.js';
import {
  USER_CONFIG_DEFAULTS,
  type ResolvedResourceBudgetConfig,
  type ResolvedUserConfig,
} from '../config/user-config.js';
import {
  estimateCapRequestCostUsd,
  normalizeModelId,
  pricingForSpeed,
  resolveModelPricing,
  unmodeledLongContextWarning,
  type ModelPricing,
  type ModelPricingOverrides,
  type PricingSpeed,
  type RequestTokenUsage,
} from '../llm-metrics/pricing.js';
import type { LlmExchangeCompleted, NormalizedUsage } from '../llm-metrics/types.js';
import { usageTokenBounds, type UsageTokenBounds } from '../llm-metrics/usage-bounds.js';
import type { AgentKind } from './provider-config.js';

/**
 * `turn`: completion requests are forwarded only while a host turn is open
 * (batch and workflow bundles). `session`: one session-long allowance (PTY).
 */
export type BudgetGateMode = 'turn' | 'session';

export type BudgetGateDimension = 'tokens' | 'cost';

/** Bundle-level limits; null disables a dimension. */
export interface BudgetGateLimits {
  readonly maxTotalTokens: number | null;
  readonly maxEstimatedCostUsd: number | null;
}

/**
 * Output tokens charged for a request that names no output cap (OpenAI
 * Responses and Gemini requests often omit it; Anthropic requires one). Used
 * for the admission reservation and, when the response's usage cannot be
 * measured, as the charge for its output.
 */
export const DEFAULT_OUTPUT_TOKEN_ESTIMATE = 32_000;

/**
 * Request-body bytes per input token when an exchange's input was never
 * measured: its input is estimated as the forwarded body's size divided by
 * this. English text averages about four characters per token; code and
 * JSON-escaped text, which agent requests are mostly made of, come out
 * denser, so the ratio is rounded toward more tokens. It is an estimate, not
 * a bound: text built to tokenize densely can carry up to about three times
 * more tokens, and base64 image data far fewer.
 */
export const ESTIMATED_REQUEST_BYTES_PER_INPUT_TOKEN = 3;

/** Status of a refused completion request: a non-retryable 4xx (never 429, which agents retry as a quota error). */
export const BUDGET_REFUSAL_STATUS = 400;

/** Response header naming why the proxy refused a completion request. */
export const BUDGET_REFUSAL_HEADER = 'x-ironcurtain-refusal';

/** `error.type` and `error.code` of a refusal; also the {@link BUDGET_REFUSAL_HEADER} value without the prefix. */
export const BUDGET_EXHAUSTED_ERROR_TYPE = 'ironcurtain_budget_exhausted';
export const NO_ACTIVE_TURN_ERROR_TYPE = 'ironcurtain_no_active_turn';

/** A limit that refused a request; latched once reached. */
export interface BudgetGateExhaustion {
  readonly dimension: BudgetGateDimension;
  /** Charged usage of settled exchanges when the gate tripped. */
  readonly used: number;
  /** Reservations of in-flight requests plus the refused request's own. */
  readonly reserved: number;
  readonly limit: number;
  /** User-facing description, without a trailing period. */
  readonly message: string;
}

export interface BudgetRefusal {
  readonly reason: 'budget_exhausted' | 'no_active_turn';
  /** Safe to show the agent and the user. */
  readonly message: string;
  readonly exhaustion?: BudgetGateExhaustion;
}

/** Facts about one completion request, read from the body as forwarded. */
export interface BudgetRequest {
  /** Wire protocol of the completion endpoint, or null when the route could not be classified. */
  readonly protocol: string | null;
  /** Requested model, for pricing the reservation; null when not named. */
  readonly model: string | null;
  /** The request's output-token cap per choice; null when it names none (or the body was not inspected). */
  readonly outputCapTokens: number | null;
  /** Choices the request asks for (`n`, `candidateCount`), each billed up to the cap; 1 when omitted. */
  readonly choices?: number;
  /**
   * The speed the request asks for ({@link requestedSpeed}): a fast request is
   * reserved and charged at the model's fast-mode price. Standard when omitted
   * (or when the body was not inspected; the exchange record can still show a
   * fast request at settlement).
   */
  readonly speed?: PricingSpeed;
  /**
   * Size of the request body as forwarded, in bytes, for the input estimate of
   * an exchange whose input is never measured. Omitted when the body streams
   * through unread; the proxy then counts it with {@link BudgetTicket.addRequestBytes}.
   */
  readonly requestBytes?: number;
}

/**
 * The reservation of one admitted request. The proxy reports each upstream
 * attempt and then settles the ticket exactly once.
 */
export interface BudgetTicket {
  /** An upstream attempt starts (the first send, or the OAuth refresh retry); it replaces the previous attempt's outcome. */
  beginAttempt(): void;
  /** The attempt's upstream connection was established, so the request may have reached the provider. */
  markDelivered(): void;
  /** The attempt's upstream response status. */
  markUpstreamStatus(status: number): void;
  /** Bytes of a request body that streams through unread (see {@link BudgetRequest.requestBytes}). */
  addRequestBytes(bytes: number): void;
  /** Replace the reservation with the charge; `exchange` is the observed record when the proxy parsed the response. */
  settle(exchange?: LlmExchangeCompleted): void;
}

export type BudgetAdmission =
  | { readonly admitted: true; readonly ticket: BudgetTicket }
  | { readonly admitted: false; readonly refusal: BudgetRefusal };

/** An open host turn; completion requests are admitted in `turn` mode only while one is open. */
export interface BudgetGateTurn {
  end(): void;
}

export interface BudgetGateStateUsage {
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly exchanges: number;
}

export interface BudgetGateSnapshot {
  readonly mode: BudgetGateMode;
  readonly limits: BudgetGateLimits;
  /** Charged tokens of settled exchanges (measured, or estimated when unmeasurable). */
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly reservedTokens: number;
  readonly reservedCostUsd: number;
  readonly admittedRequests: number;
  readonly settledExchanges: number;
  /** Settled exchanges charged with an estimate because their usage could not be measured. */
  readonly estimatedExchanges: number;
  readonly refusedRequests: number;
  readonly activeTurns: number;
  readonly exhaustion?: BudgetGateExhaustion;
  /**
   * Charged usage per workflow state, from each exchange's metrics attribution
   * (reporting only; a key is the state id, or `(bundle)` for an exchange no
   * state lease covered).
   */
  readonly byState: Readonly<Record<string, BudgetGateStateUsage>>;
}

/** What a session (or the PTY driver) sees of its bundle's gate. */
export interface BundleBudgetGate {
  readonly mode: BudgetGateMode;
  readonly limits: BudgetGateLimits;
  /** Open a host turn; `end()` it when the agent turn's exec returns. */
  beginTurn(): BudgetGateTurn;
  /** The latched exhaustion, or a limit the charged totals already reached. */
  exhaustion(): BudgetGateExhaustion | undefined;
  /**
   * Called once, the first time the gate refuses a request because a limit is
   * reached. Returns an unsubscribe function.
   */
  onExhausted(listener: (exhaustion: BudgetGateExhaustion) => void): () => void;
  snapshot(): BudgetGateSnapshot;
}

/** The proxy-facing gate. */
export interface BudgetGate extends BundleBudgetGate {
  /**
   * Cheap check before a completion request's body is read: a refusal when
   * the gate is exhausted or (turn mode) no turn is open.
   */
  precheck(): BudgetRefusal | undefined;
  /** Admit a completion request and reserve its output cap, or refuse it. */
  admit(request: BudgetRequest): BudgetAdmission;
}

export interface BudgetGateOptions {
  readonly mode: BudgetGateMode;
  readonly limits: BudgetGateLimits;
  /** `resourceBudget.modelPricing` overrides, as for builtin sessions. */
  readonly pricingOverrides?: ModelPricingOverrides;
  /** Output tokens charged for a request without an output cap; defaults to {@link DEFAULT_OUTPUT_TOKEN_ESTIMATE}. */
  readonly defaultOutputTokens?: number;
  /** Prefix for log lines, e.g. the bundle id. */
  readonly label?: string;
}

/** Key in `byState` for an exchange no state lease covered. */
export const UNATTRIBUTED_STATE_KEY = '(bundle)';

/** Model id priced when an exchange names none: an unknown Claude id, which fails closed at the highest Claude tier. */
const UNNAMED_MODEL_PRICING_ID = 'claude-unnamed-model';

/**
 * Distinct model ids the gate warns about (unlisted prices, long prompts
 * charged at the long-context multiplier), per kind of warning. The model id
 * comes from the agent's request, so the set is bounded: past it, further
 * models still price fail-closed, without a warning each.
 */
const MAX_PRICING_WARNINGS = 32;

interface Reservation {
  readonly protocol: string | null;
  readonly model: string | null;
  /** The speed the request as forwarded asked for. */
  readonly speed: PricingSpeed;
  readonly outputTokens: number;
  readonly costUsd: number;
}

interface Charge {
  readonly tokens: number;
  readonly costUsd: number;
  /** Set when the charge is an estimate; names why usage could not be measured. */
  readonly estimateReason?: string;
}

interface MutableStateUsage {
  totalTokens: number;
  costUsd: number;
  exchanges: number;
}

function isCount(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function count(value: number | null | undefined): number {
  return isCount(value) ? value : 0;
}

/** A positive safe integer, or undefined. */
function positiveCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Input tokens estimated from a request body of `bytes` bytes (see {@link ESTIMATED_REQUEST_BYTES_PER_INPUT_TOKEN}). */
function estimateInputTokens(bytes: number): number {
  return Math.min(Math.ceil(bytes / ESTIMATED_REQUEST_BYTES_PER_INPUT_TOKEN), Number.MAX_SAFE_INTEGER);
}

function assertLimit(value: number | null, name: string): void {
  if (value !== null && !(Number.isFinite(value) && value > 0)) {
    throw new Error(`budget gate ${name} must be a positive number or null, got ${String(value)}`);
  }
}

/**
 * Highest listed output rate of the model (its long-prompt tier may be
 * dearer). An unmodeled long-context premium is not reserved for: the prompt
 * size is not known at admission, and settlement charges it.
 */
function maxOutputRatePerMillion(pricing: ModelPricing): number {
  return Math.max(pricing.outputPerMillion, pricing.longPrompt?.rates.outputPerMillion ?? 0);
}

/**
 * The speed an exchange is charged at: fast when the request as forwarded
 * asked for it (the reservation), or when the observed exchange record shows
 * a fast or unrecognized speed (a body that streamed through uninspected).
 */
function chargedSpeed(reservation: Reservation, exchange: LlmExchangeCompleted | undefined): PricingSpeed {
  if (reservation.speed === 'fast') return 'fast';
  const request = exchange?.request;
  if (request === undefined) return 'standard';
  return request.speedMode === 'fast' || request.qualityFlags.includes('unknown_speed_mode') ? 'fast' : 'standard';
}

/**
 * True when the exchange's usage is final: every counter is known and the
 * protocol's terminal usage report arrived (its terminal event, or the stop
 * reason the final report carries). Completeness alone is not enough: a
 * stream that reports cumulative usage on every chunk (Gemini, and OpenAI
 * Chat Completions gateways that do so) has complete counters long before
 * its last chunk, so a client that abandons it mid-stream would otherwise be
 * charged only the output delivered so far.
 */
function hasFinalUsage(exchange: LlmExchangeCompleted): boolean {
  const terminal =
    exchange.timing.protocolTerminalOffsetMs !== null || exchange.outcome.providerStopReason !== 'not_reported';
  return terminal && exchange.usage.usageCompleteness === 'complete';
}

/** The model the provider served, falling back to what was requested. */
function exchangeModel(exchange: LlmExchangeCompleted | undefined): string | null {
  if (!exchange) return null;
  const { servedModel, responseModel, forwardedModel, requestedModel } = exchange.identity;
  return servedModel.value ?? responseModel.value ?? forwardedModel.value ?? requestedModel.value;
}

function describeTokens(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function describeUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * User-facing text; it reaches the agent's terminal through the refusal and
 * the transports through `BudgetExhaustedError`, so it names the setting.
 */
function describeExhaustion(dimension: BudgetGateDimension, used: number, reserved: number, limit: number): string {
  if (dimension === 'tokens') {
    const pending = reserved > 0 ? ` (${describeTokens(reserved)} more reserved for requests in flight)` : '';
    return (
      `Token budget exhausted: ${describeTokens(used)} of ${describeTokens(limit)} tokens charged ` +
      `to this agent container${pending}; limit set by resourceBudget.maxTotalTokens`
    );
  }
  const pending = reserved > 0 ? ` (${describeUsd(reserved)} more reserved for requests in flight)` : '';
  return (
    `Cost budget exhausted: ${describeUsd(used)} of ${describeUsd(limit)} estimated at list prices ` +
    `for this agent container${pending}; limit set by resourceBudget.maxEstimatedCostUsd`
  );
}

class Ticket implements BudgetTicket {
  private settled = false;
  /** Outcome of the latest upstream attempt. */
  delivered = false;
  upstreamStatus: number | null = null;

  constructor(
    private readonly gate: BudgetGateImpl,
    readonly reservation: Reservation,
    /** Bytes of the request body as forwarded. */
    public requestBytes: number,
  ) {}

  addRequestBytes(bytes: number): void {
    if (this.settled || !Number.isSafeInteger(bytes) || bytes <= 0) return;
    this.requestBytes = Math.min(this.requestBytes + bytes, Number.MAX_SAFE_INTEGER);
  }

  beginAttempt(): void {
    this.delivered = false;
    this.upstreamStatus = null;
  }

  markDelivered(): void {
    this.delivered = true;
  }

  markUpstreamStatus(status: number): void {
    this.upstreamStatus = status;
    // A response means the request reached the provider.
    this.delivered = true;
  }

  settle(exchange?: LlmExchangeCompleted): void {
    if (this.settled) return;
    this.settled = true;
    this.gate.settleTicket(this, exchange);
  }
}

class BudgetGateImpl implements BudgetGate {
  readonly mode: BudgetGateMode;
  readonly limits: BudgetGateLimits;
  private readonly pricingOverrides: ModelPricingOverrides | undefined;
  private readonly defaultOutputTokens: number;
  private readonly logPrefix: string;

  private chargedTokens = 0;
  private chargedCostUsd = 0;
  private reservedTokens = 0;
  private reservedCostUsd = 0;
  private outstandingTickets = 0;
  private admittedRequests = 0;
  private settledExchanges = 0;
  private estimatedExchanges = 0;
  private refusedRequests = 0;
  private activeTurns = 0;
  private latched: BudgetGateExhaustion | undefined;
  private readonly listeners = new Set<(exhaustion: BudgetGateExhaustion) => void>();
  private readonly byState = new Map<string, MutableStateUsage>();
  private readonly pricingWarned = new Set<string>();
  /** Models a long prompt was charged at the long-context multiplier for (warned once each). */
  private readonly longContextWarned = new Set<string>();

  constructor(options: BudgetGateOptions) {
    assertLimit(options.limits.maxTotalTokens, 'maxTotalTokens');
    assertLimit(options.limits.maxEstimatedCostUsd, 'maxEstimatedCostUsd');
    const defaultOutputTokens = options.defaultOutputTokens ?? DEFAULT_OUTPUT_TOKEN_ESTIMATE;
    if (!Number.isSafeInteger(defaultOutputTokens) || defaultOutputTokens <= 0) {
      throw new Error(`budget gate defaultOutputTokens must be a positive integer, got ${String(defaultOutputTokens)}`);
    }
    this.mode = options.mode;
    this.limits = Object.freeze({ ...options.limits });
    this.pricingOverrides = options.pricingOverrides;
    this.defaultOutputTokens = defaultOutputTokens;
    this.logPrefix = options.label ? `[budget-gate ${options.label}]` : '[budget-gate]';
  }

  beginTurn(): BudgetGateTurn {
    this.activeTurns += 1;
    let ended = false;
    return {
      end: () => {
        if (ended) return;
        ended = true;
        this.activeTurns -= 1;
      },
    };
  }

  exhaustion(): BudgetGateExhaustion | undefined {
    return this.latched ?? this.chargedOverLimit();
  }

  onExhausted(listener: (exhaustion: BudgetGateExhaustion) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  precheck(): BudgetRefusal | undefined {
    const exhausted = this.latched ?? this.chargedOverLimit();
    if (exhausted) return this.refuseForBudget(exhausted);
    if (this.mode === 'turn' && this.activeTurns === 0) {
      this.refusedRequests += 1;
      return {
        reason: 'no_active_turn',
        message:
          'no agent turn is running in this agent container; completion requests are forwarded only ' +
          'while IronCurtain runs an agent turn',
      };
    }
    return undefined;
  }

  admit(request: BudgetRequest): BudgetAdmission {
    const early = this.precheck();
    if (early) return { admitted: false, refusal: early };

    // Every choice the request asks for is billed up to the cap.
    const perChoice = positiveCount(request.outputCapTokens) ?? this.defaultOutputTokens;
    const choices = positiveCount(request.choices) ?? 1;
    const outputTokens = Math.min(perChoice * choices, Number.MAX_SAFE_INTEGER);
    const speed: PricingSpeed = request.speed === 'fast' ? 'fast' : 'standard';
    const costUsd = (outputTokens * maxOutputRatePerMillion(this.pricingFor(request.model, speed))) / 1_000_000;

    const exceeded = this.reservationExceedsLimit(outputTokens, costUsd);
    if (exceeded) return { admitted: false, refusal: this.refuseForBudget(exceeded) };

    this.reservedTokens += outputTokens;
    this.reservedCostUsd += costUsd;
    this.outstandingTickets += 1;
    this.admittedRequests += 1;
    return {
      admitted: true,
      ticket: new Ticket(
        this,
        Object.freeze({ protocol: request.protocol, model: request.model, speed, outputTokens, costUsd }),
        positiveCount(request.requestBytes) ?? 0,
      ),
    };
  }

  snapshot(): BudgetGateSnapshot {
    const byState: Record<string, BudgetGateStateUsage> = {};
    for (const [key, usage] of this.byState) byState[key] = Object.freeze({ ...usage });
    const exhaustion = this.exhaustion();
    return Object.freeze({
      mode: this.mode,
      limits: this.limits,
      totalTokens: this.chargedTokens,
      costUsd: this.chargedCostUsd,
      reservedTokens: this.reservedTokens,
      reservedCostUsd: this.reservedCostUsd,
      admittedRequests: this.admittedRequests,
      settledExchanges: this.settledExchanges,
      estimatedExchanges: this.estimatedExchanges,
      refusedRequests: this.refusedRequests,
      activeTurns: this.activeTurns,
      ...(exhaustion ? { exhaustion } : {}),
      byState: Object.freeze(byState),
    });
  }

  /** Internal: called by {@link Ticket.settle}. */
  settleTicket(ticket: Ticket, exchange: LlmExchangeCompleted | undefined): void {
    this.outstandingTickets -= 1;
    if (this.outstandingTickets === 0) {
      // Exact zero once nothing is in flight, so float residue never accumulates.
      this.reservedTokens = 0;
      this.reservedCostUsd = 0;
    } else {
      this.reservedTokens = Math.max(0, this.reservedTokens - ticket.reservation.outputTokens);
      this.reservedCostUsd = Math.max(0, this.reservedCostUsd - ticket.reservation.costUsd);
    }

    let charge: Charge;
    try {
      charge = this.chargeFor(ticket, exchange);
    } catch (error) {
      // Accounting must fail closed: an exchange that cannot be priced is
      // charged its reservation rather than nothing.
      charge = {
        tokens: ticket.reservation.outputTokens,
        costUsd: ticket.reservation.costUsd,
        estimateReason: `accounting failed (${error instanceof Error ? error.message : String(error)})`,
      };
    }
    this.chargedTokens += charge.tokens;
    this.chargedCostUsd += charge.costUsd;
    this.settledExchanges += 1;
    if (charge.estimateReason !== undefined) {
      this.estimatedExchanges += 1;
      logger.warn(
        `${this.logPrefix} usage of a ${ticket.reservation.protocol ?? 'unclassified'} exchange could not be measured ` +
          `(${charge.estimateReason}); charged an estimate of ${describeTokens(charge.tokens)} tokens / ` +
          `$${charge.costUsd.toFixed(4)}`,
      );
    }

    const stateKey = exchange?.attribution.stateId ?? UNATTRIBUTED_STATE_KEY;
    const state = this.byState.get(stateKey) ?? { totalTokens: 0, costUsd: 0, exchanges: 0 };
    state.totalTokens += charge.tokens;
    state.costUsd += charge.costUsd;
    state.exchanges += 1;
    this.byState.set(stateKey, state);
  }

  /** The first limit the charged totals alone already reached. */
  private chargedOverLimit(): BudgetGateExhaustion | undefined {
    const { maxTotalTokens, maxEstimatedCostUsd } = this.limits;
    if (maxTotalTokens !== null && this.chargedTokens >= maxTotalTokens) {
      return this.exhaustionFor('tokens', this.chargedTokens, this.reservedTokens, maxTotalTokens);
    }
    if (maxEstimatedCostUsd !== null && this.chargedCostUsd >= maxEstimatedCostUsd) {
      return this.exhaustionFor('cost', this.chargedCostUsd, this.reservedCostUsd, maxEstimatedCostUsd);
    }
    return undefined;
  }

  /** The first limit that charged + in-flight + this request's reservation would exceed. */
  private reservationExceedsLimit(outputTokens: number, costUsd: number): BudgetGateExhaustion | undefined {
    const { maxTotalTokens, maxEstimatedCostUsd } = this.limits;
    if (maxTotalTokens !== null && this.chargedTokens + this.reservedTokens + outputTokens > maxTotalTokens) {
      return this.exhaustionFor('tokens', this.chargedTokens, this.reservedTokens + outputTokens, maxTotalTokens);
    }
    if (maxEstimatedCostUsd !== null && this.chargedCostUsd + this.reservedCostUsd + costUsd > maxEstimatedCostUsd) {
      return this.exhaustionFor('cost', this.chargedCostUsd, this.reservedCostUsd + costUsd, maxEstimatedCostUsd);
    }
    return undefined;
  }

  private exhaustionFor(
    dimension: BudgetGateDimension,
    used: number,
    reserved: number,
    limit: number,
  ): BudgetGateExhaustion {
    return Object.freeze({
      dimension,
      used,
      reserved,
      limit,
      message: describeExhaustion(dimension, used, reserved, limit),
    });
  }

  /** Count a budget refusal; the first one latches the gate and notifies the listeners. */
  private refuseForBudget(exhaustion: BudgetGateExhaustion): BudgetRefusal {
    this.refusedRequests += 1;
    if (this.latched === undefined) {
      this.latched = exhaustion;
      logger.warn(
        `${this.logPrefix} ${exhaustion.message}; refusing every further completion request. ` +
          `Charged so far by state: ${this.describeByState()}`,
      );
      for (const listener of [...this.listeners]) {
        try {
          listener(exhaustion);
        } catch (error) {
          logger.warn(
            `${this.logPrefix} exhaustion listener failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    const latched = this.latched;
    return { reason: 'budget_exhausted', message: latched.message, exhaustion: latched };
  }

  private describeByState(): string {
    if (this.byState.size === 0) return 'nothing settled yet';
    return [...this.byState]
      .map(([key, usage]) => `${key}: ${describeTokens(usage.totalTokens)} tokens / $${usage.costUsd.toFixed(4)}`)
      .join(', ');
  }

  /**
   * The model's list price at `speed`: a fast request bills at the model's
   * fast-mode price. A model the table gives no fast-mode price (an override,
   * a fallback default) is charged its listed rates.
   */
  private pricingFor(model: string | null, speed: PricingSpeed): ModelPricing {
    const pricing = this.standardPricingFor(model);
    return speed === 'fast' ? (pricingForSpeed(pricing, 'fast') ?? pricing) : pricing;
  }

  private standardPricingFor(model: string | null): ModelPricing {
    if (model === null) {
      if (!this.pricingWarned.has(UNNAMED_MODEL_PRICING_ID)) {
        this.pricingWarned.add(UNNAMED_MODEL_PRICING_ID);
        logger.warn(`${this.logPrefix} an exchange named no model; its cost is estimated at the highest Claude price`);
      }
      return resolveModelPricing(UNNAMED_MODEL_PRICING_ID, this.pricingOverrides).pricing;
    }
    const resolved = resolveModelPricing(model, this.pricingOverrides);
    if (
      resolved.warning !== undefined &&
      !this.pricingWarned.has(resolved.normalizedId) &&
      this.pricingWarned.size < MAX_PRICING_WARNINGS
    ) {
      this.pricingWarned.add(resolved.normalizedId);
      logger.warn(`${this.logPrefix} ${resolved.warning}`);
    }
    return resolved.pricing;
  }

  private chargeFor(ticket: Ticket, exchange: LlmExchangeCompleted | undefined): Charge {
    const usage = exchange?.usage;
    const bounds = usage ? usageTokenBounds(usage) : undefined;
    const model = exchangeModel(exchange) ?? ticket.reservation.model;
    const speed = chargedSpeed(ticket.reservation, exchange);
    const status = ticket.upstreamStatus;

    // Providers bill neither an error response nor a request that never
    // reached them: charge only what was measured (normally nothing).
    if ((status !== null && status >= 400) || (status === null && !ticket.delivered)) {
      if (!usage || !bounds) return { tokens: 0, costUsd: 0 };
      return {
        tokens: bounds.totalTokens,
        costUsd: usage.costUsd ?? this.listCost(usage, bounds.inputTokens, model, bounds.outputTokens, speed),
      };
    }

    if (exchange && usage && bounds && hasFinalUsage(exchange)) {
      return {
        tokens: bounds.totalTokens,
        // The gateway's own cost (OpenRouter `usage.cost`) is what is billed.
        costUsd: usage.costUsd ?? this.finalListCost(usage, bounds, model, speed),
      };
    }

    // Not measurable: a conservative estimate, never zero. The measured lower
    // bounds count; the output cap stands in for output never reported, and
    // the request's size for input never reported (the agent decides whether
    // a response reports usage, so unmeasured input must not be free).
    const measuredInput = bounds?.inputTokens ?? 0;
    const inputEstimated = bounds?.inputExact !== true && estimateInputTokens(ticket.requestBytes) > measuredInput;
    const inputTokens = inputEstimated ? estimateInputTokens(ticket.requestBytes) : measuredInput;
    const outputTokens = Math.max(bounds?.outputTokens ?? 0, ticket.reservation.outputTokens);
    const tokens = Math.max(bounds?.totalTokens ?? 0, inputTokens + outputTokens);
    const costUsd = this.listCost(usage, inputTokens, model, outputTokens, speed);
    const reason = !exchange
      ? 'the proxy does not observe usage on this route'
      : !bounds?.measured
        ? 'the response reported no usage'
        : 'the response ended before its final usage report';
    const estimateReason = inputEstimated ? `${reason}; input estimated from the request size` : reason;
    return { tokens, costUsd, estimateReason };
  }

  /** List price of final usage: per billing attempt when the provider itemizes them, each at its own model's price. */
  private finalListCost(
    usage: NormalizedUsage,
    bounds: UsageTokenBounds,
    model: string | null,
    speed: PricingSpeed,
  ): number {
    const iterations = usage.iterations;
    if (
      iterations !== undefined &&
      iterations.length > 0 &&
      iterations.every(
        (iteration) =>
          isCount(iteration.inputTokensUncached) &&
          isCount(iteration.cacheReadInputTokens) &&
          isCount(iteration.cacheWriteInputTokens) &&
          isCount(iteration.outputTokens),
      )
    ) {
      // The exchange-level 1-hour cache-write count is apportioned to the
      // attempts in order; the remaining writes bill at the 5-minute rate.
      let remaining1h = count(usage.cacheWrite1hInputTokens);
      let total = 0;
      for (const iteration of iterations) {
        const cacheWrite = count(iteration.cacheWriteInputTokens);
        const cacheWrite1h = Math.min(cacheWrite, remaining1h);
        remaining1h -= cacheWrite1h;
        total += this.requestCost(iteration.model ?? model, speed, {
          uncachedInputTokens: count(iteration.inputTokensUncached),
          cacheReadTokens: count(iteration.cacheReadInputTokens),
          cacheWrite5mTokens: cacheWrite - cacheWrite1h,
          cacheWrite1hTokens: cacheWrite1h,
          outputTokens: count(iteration.outputTokens),
        });
      }
      return total;
    }
    return this.listCost(usage, bounds.inputTokens, model, bounds.outputTokens, speed);
  }

  /** List price of one request: `inputTokens` split by how they bill, plus `outputTokens`. */
  private listCost(
    usage: NormalizedUsage | undefined,
    inputTokens: number,
    model: string | null,
    outputTokens: number,
    speed: PricingSpeed,
  ): number {
    const cacheRead = count(usage?.cacheReadInputTokens);
    const cacheWrite = count(usage?.cacheWriteInputTokens);
    const cacheWrite1h = Math.min(cacheWrite, count(usage?.cacheWrite1hInputTokens));
    // Input beyond the known cache parts bills at the plain input rate; this
    // also covers tool-use prompt tokens, which only the input total includes,
    // and input estimated from the request size.
    const uncached = Math.max(0, inputTokens - cacheRead - cacheWrite);
    return this.requestCost(model, speed, {
      uncachedInputTokens: uncached,
      cacheReadTokens: cacheRead,
      cacheWrite5mTokens: cacheWrite - cacheWrite1h,
      cacheWrite1hTokens: cacheWrite1h,
      outputTokens,
    });
  }

  /**
   * One request's charge at `model`'s price for `speed`, as a cost cap
   * prices it (`estimateCapRequestCostUsd`): a prompt past the model's
   * unmodeled long-context threshold is charged twice the listed rates, and
   * the first such charge for a model is logged.
   */
  private requestCost(model: string | null, speed: PricingSpeed, tokens: RequestTokenUsage): number {
    const pricing = this.pricingFor(model, speed);
    const cost = estimateCapRequestCostUsd(pricing, tokens);
    if (cost.unmodeledLongContext) this.warnLongContext(model ?? UNNAMED_MODEL_PRICING_ID, pricing);
    return cost.costUsd;
  }

  private warnLongContext(model: string, pricing: ModelPricing): void {
    const key = normalizeModelId(model);
    if (this.longContextWarned.has(key) || this.longContextWarned.size >= MAX_PRICING_WARNINGS) return;
    this.longContextWarned.add(key);
    logger.warn(`${this.logPrefix} ${unmodeledLongContextWarning(model, pricing)}`);
  }
}

/** Creates a bundle's budget gate. Throws for a limit that is not a positive number or null. */
export function createBudgetGate(options: BudgetGateOptions): BudgetGate {
  return new BudgetGateImpl(options);
}

/**
 * Gate options for a bundle: the session's `resourceBudget` token and cost
 * limits and model price overrides. PTY bundles get a session-long allowance;
 * every other bundle (batch, workflow, and a legacy caller that names no
 * execution mode) forwards completions only during host turns.
 */
export function budgetGateOptionsFor(
  userConfig: Pick<ResolvedUserConfig, 'resourceBudget' | 'modelPricingOverrides'>,
  agentKind: AgentKind | undefined,
  label?: string,
): BudgetGateOptions {
  // Hand-built configs (tests, embedders) may omit the budget or one of its
  // limits: undefined takes the default, as `loadUserConfig()` merges it;
  // only an explicit null disables a limit.
  const budget: Partial<ResolvedResourceBudgetConfig> | undefined = (userConfig as Partial<typeof userConfig>)
    .resourceBudget;
  const defaults = USER_CONFIG_DEFAULTS.resourceBudget;
  return {
    mode: agentKind === 'pty' ? 'session' : 'turn',
    limits: {
      maxTotalTokens: budget?.maxTotalTokens !== undefined ? budget.maxTotalTokens : defaults.maxTotalTokens,
      maxEstimatedCostUsd:
        budget?.maxEstimatedCostUsd !== undefined ? budget.maxEstimatedCostUsd : defaults.maxEstimatedCostUsd,
    },
    pricingOverrides: userConfig.modelPricingOverrides,
    ...(label !== undefined ? { label } : {}),
  };
}

type FieldPaths = readonly (readonly string[])[];

/** Request body fields that cap generated output per choice, by wire protocol (paths into the JSON body). */
const OUTPUT_CAP_FIELDS: ReadonlyMap<string, FieldPaths> = new Map<string, FieldPaths>([
  ['anthropic-messages', [['max_tokens']]],
  ['openai-responses', [['max_output_tokens']]],
  ['openai-chat-completions', [['max_completion_tokens'], ['max_tokens']]],
  ['google-generate-content', [['generationConfig', 'maxOutputTokens']]],
]);

/**
 * Request body fields that ask for several choices, each billed up to the
 * output cap, by wire protocol. A protocol listed in {@link OUTPUT_CAP_FIELDS}
 * but not here generates one choice per request.
 */
const CHOICE_COUNT_FIELDS: ReadonlyMap<string, FieldPaths> = new Map<string, FieldPaths>([
  ['openai-chat-completions', [['n']]],
  ['google-generate-content', [['generationConfig', 'candidateCount']]],
]);

/** Every known spelling, for a protocol the tables do not list. */
const ALL_OUTPUT_CAP_FIELDS: FieldPaths = [...OUTPUT_CAP_FIELDS.values()].flat();
const ALL_CHOICE_COUNT_FIELDS: FieldPaths = [...CHOICE_COUNT_FIELDS.values()].flat();

/**
 * A field name as a lenient decoder may match it: letter case folded
 * (`toUpperCase` first, as Go's case folding does) and `_`/`-` ignored.
 * Google's JSON mapping accepts the proto names (`generation_config`,
 * `max_output_tokens`) as well as the camel-case ones, and a gateway may
 * decode names case-insensitively, so the gate reads every spelling that
 * could reach the upstream and lets the largest value count.
 */
function foldFieldName(name: string): string {
  return name.toUpperCase().toLowerCase().replace(/[_-]/g, '');
}

/** Collects the values at `path` (own keys only), under every key spelling that folds to each step. */
function collectFolded(value: unknown, path: readonly string[], depth: number, into: unknown[]): void {
  if (depth === path.length) {
    into.push(value);
    return;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
  const wanted = foldFieldName(path[depth] ?? '');
  for (const key of Object.keys(value)) {
    if (foldFieldName(key) === wanted) collectFolded((value as Record<string, unknown>)[key], path, depth + 1, into);
  }
}

/** The largest positive safe integer any spelling of `paths` holds in `body`, or null. */
function largestFoldedCount(body: unknown, paths: FieldPaths): number | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const values: unknown[] = [];
  for (const path of paths) collectFolded(body, path, 0, values);
  let largest: number | null = null;
  for (const value of values) {
    const counted = positiveCount(value);
    if (counted !== undefined) largest = Math.max(largest ?? 0, counted);
  }
  return largest;
}

/**
 * The output-token cap per choice a completion request names, or null when it
 * names none. When several spellings are present the largest counts.
 */
export function requestedOutputCap(protocol: string | null, body: unknown): number | null {
  const paths = (protocol !== null ? OUTPUT_CAP_FIELDS.get(protocol) : undefined) ?? ALL_OUTPUT_CAP_FIELDS;
  return largestFoldedCount(body, paths);
}

/**
 * The number of choices a completion request asks for (`n`,
 * `generationConfig.candidateCount`), each billed up to the output cap; 1
 * when it names none. When several spellings are present the largest counts.
 */
export function requestedChoiceCount(protocol: string | null, body: unknown): number {
  const paths =
    protocol !== null && OUTPUT_CAP_FIELDS.has(protocol)
      ? (CHOICE_COUNT_FIELDS.get(protocol) ?? [])
      : ALL_CHOICE_COUNT_FIELDS;
  return largestFoldedCount(body, paths) ?? 1;
}

/** Request body fields naming the speed a request is served at (Anthropic fast mode), in any protocol. */
const SPEED_FIELDS: FieldPaths = [['speed'], ['speed_mode']];

/**
 * The speed a completion request asks for, for pricing: `fast` when any
 * spelling of `speed` or `speed_mode` holds a value other than the string
 * `standard`. An unrecognized value counts as fast, so a speed the price
 * table does not know is never priced below the fast-mode price; a request
 * that names no speed (or only `null`) is standard. A model without a
 * fast-mode price is charged its listed rates either way.
 */
export function requestedSpeed(body: unknown): PricingSpeed {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'standard';
  const values: unknown[] = [];
  for (const path of SPEED_FIELDS) collectFolded(body, path, 0, values);
  return values.some((value) => value !== null && value !== undefined && value !== 'standard') ? 'fast' : 'standard';
}

/** The JSON error body, status and headers of a refused completion request. */
export function budgetRefusalResponse(refusal: BudgetRefusal): {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
} {
  const errorType = refusal.reason === 'budget_exhausted' ? BUDGET_EXHAUSTED_ERROR_TYPE : NO_ACTIVE_TURN_ERROR_TYPE;
  // The Anthropic error envelope; the OpenAI SDKs read the same `error`
  // object and surface its message and code.
  const body = JSON.stringify({
    type: 'error',
    error: {
      type: errorType,
      code: errorType,
      message: `IronCurtain refused this request: ${refusal.message}.`,
    },
  });
  return {
    status: BUDGET_REFUSAL_STATUS,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
      Connection: 'close',
      // Honoured by the Anthropic and OpenAI SDKs: never retry this answer.
      'x-should-retry': 'false',
      [BUDGET_REFUSAL_HEADER]: refusal.reason === 'budget_exhausted' ? 'budget-exhausted' : 'no-active-turn',
    },
    body,
  };
}
