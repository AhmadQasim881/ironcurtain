/**
 * Content-free contracts for LLM exchange metrics.
 *
 * These types deliberately contain no request/response bodies, message text,
 * tool arguments, arbitrary headers, or provider error strings. Protocol and
 * gateway adapters may inspect such envelopes transiently, but their durable
 * output is restricted to the bounded scalar facts below.
 */

export type BuiltInLlmProtocol =
  'anthropic-messages' | 'openai-responses' | 'openai-chat-completions' | 'google-generate-content';

export type LlmProtocolId = BuiltInLlmProtocol | (string & {});

export type UsageCompleteness = 'complete' | 'partial' | 'missing' | 'invalid';

export type OutputTokenSemantics = 'includes_thinking' | 'excludes_thinking' | 'no_thinking_breakdown' | 'unknown';

export type TokenMeasurementAccuracy =
  'reported_exact' | 'provider_estimate' | 'derived_exact' | 'derived_from_estimate' | 'unknown';

/**
 * Kind of one provider-itemized billing attempt inside a single exchange
 * (Anthropic `usage.iterations`). `other` keeps an unrecognized future kind
 * countable without retaining its raw name.
 */
export type UsageIterationKind = 'compaction' | 'message' | 'advisor_message' | 'fallback_message' | 'other';

/**
 * One billing attempt of an exchange. Each attempt bills at the rates of its
 * own model, so the model is kept per attempt. Counts follow the exchange's
 * protocol semantics (for Anthropic, `inputTokensUncached` excludes cache).
 */
export interface UsageIteration {
  readonly kind: UsageIterationKind;
  /** Bounded identifier; null when the provider names no model for the attempt. */
  readonly model: string | null;
  readonly inputTokensUncached: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly outputTokens: number | null;
}

/**
 * Where an exchange's cost comes from: the gateway's own report (OpenRouter
 * `usage.cost`), or the host's estimate at first-party list prices for a
 * verified official provider origin (`cost-estimate.ts`). Null: no cost.
 */
export type LlmCostSource = 'gateway_reported' | 'list_price';

/** Provider-billed server-tool request counts (allowlisted kinds only). */
export interface ServerToolRequests {
  readonly webSearchRequests: number | null;
  readonly webFetchRequests: number | null;
}

export interface NormalizedUsage {
  readonly inputTokensReported: number | null;
  readonly inputTokensTotal: number | null;
  readonly inputTokensAccuracy: TokenMeasurementAccuracy;
  readonly inputTokensUncached: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  /** Google tool-use prompt tokens, included in inputTokensTotal when reported. */
  readonly toolUseInputTokens: number | null;

  readonly outputTokensReported: number | null;
  readonly outputTokenSemantics: OutputTokenSemantics;
  /** Inclusive generated output, including thinking/reasoning. */
  readonly outputTokensTotal: number | null;
  readonly outputTokensAccuracy: TokenMeasurementAccuracy;
  readonly thinkingTokens: number | null;
  readonly thinkingTokensAccuracy: TokenMeasurementAccuracy;
  readonly nonThinkingOutputTokens: number | null;
  readonly nonThinkingOutputTokensAccuracy: TokenMeasurementAccuracy;

  readonly providerTotalTokens: number | null;
  readonly canonicalTotalTokens: number | null;
  /** Cost the gateway reported (OpenRouter `usage.cost`); never a host estimate. */
  readonly costUsd: number | null;
  /**
   * Host-side estimate at first-party list prices, set only for a verified
   * official direct origin and a model the price table lists (and then only
   * when the gateway reported no cost). The exchange's cost is
   * `costUsd ?? estimatedCostUsd` (see `exchangeCostUsd`).
   */
  readonly estimatedCostUsd?: number | null;
  readonly costSource?: LlmCostSource | null;
  /** `PRICING_VERSION` of the table behind `estimatedCostUsd`. */
  readonly pricingVersion?: string | null;

  readonly usageSource: string | null;
  readonly usageCompleteness: UsageCompleteness;
  readonly usageSemanticsVersion: 1;
  readonly qualityFlags: readonly string[];

  /*
   * Optional breakdowns, present only when the protocol itemizes them. They
   * are pricing inputs and never add to the totals above, which already
   * include them.
   */
  /** Cache writes with a 5-minute TTL; a subset of cacheWriteInputTokens. */
  readonly cacheWrite5mInputTokens?: number | null;
  /** Cache writes with a 1-hour TTL; a subset of cacheWriteInputTokens. */
  readonly cacheWrite1hInputTokens?: number | null;
  readonly serverToolRequests?: ServerToolRequests;
  /** Per-attempt breakdown; the totals above are its sums, never sums plus top-level usage. */
  readonly iterations?: readonly UsageIteration[];
}

export type IdentitySource =
  | 'request'
  | 'forwarded_request'
  | 'protocol_response'
  | 'protocol_response_direct'
  | 'router_metadata'
  | 'trusted_gateway_header'
  | 'configured_route'
  | 'not_exposed';

export interface SourcedIdentity {
  readonly value: string | null;
  readonly source: IdentitySource;
}

export interface LlmModelIdentity {
  readonly requestedModel: SourcedIdentity;
  readonly forwardedModel: SourcedIdentity;
  readonly responseModel: SourcedIdentity;
  readonly servedModel: SourcedIdentity;
  readonly servedProvider: SourcedIdentity;
}

export type NormalizedTermination =
  'stop' | 'length' | 'tool' | 'refusal' | 'content_filter' | 'error' | 'aborted' | 'unknown';

export type NormalizedStopReason =
  | 'end_turn'
  | 'stop_sequence'
  | 'max_tokens'
  | 'context_window'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal'
  | 'content_filter'
  | 'completed'
  | 'incomplete'
  | 'failed'
  | 'cancelled'
  | 'other'
  | 'not_reported';

export type RefusalSource =
  'stop_reason' | 'stop_details' | 'content_item' | 'content_filter' | 'prompt_feedback' | 'not_reported';

export interface LlmOutcome {
  readonly termination: NormalizedTermination;
  readonly providerStopReason: NormalizedStopReason;
  readonly responseStatus: number | null;
  /** False means an explicit successful/non-refusal outcome, not merely absence of evidence. */
  readonly refusal: boolean | null;
  readonly refusalCategory: string | null;
  readonly refusalSource: RefusalSource;
}

export type ReasoningMode = 'disabled' | 'enabled' | 'adaptive' | 'effort' | 'unknown';

export interface LlmRequestFacts {
  readonly requestedModel: string | null;
  readonly streaming: boolean | null;
  readonly requestedServiceTier: string | null;
  readonly reasoningMode: ReasoningMode;
  readonly reasoningEffort: string | null;
  readonly thinkingBudgetTokens: number | null;
  readonly speedMode: string | null;
  readonly qualityFlags: readonly string[];
}

export interface LlmProtocolObservation {
  readonly protocol: LlmProtocolId;
  readonly responseModel: string | null;
  readonly providerRequestId: string | null;
  readonly providerResponseId: string | null;
  readonly actualServiceTier: string | null;
  /** The speed the provider reports it served (Anthropic `usage.speed`), when it reports one. */
  readonly actualSpeedMode?: 'standard' | 'fast' | null;
  readonly usage: NormalizedUsage;
  readonly outcome: LlmOutcome;
  readonly protocolTerminal: boolean;
  readonly qualityFlags: readonly string[];
}

export interface ProtocolRequestContext {
  /** Path only. Query strings must be removed before calling an adapter. */
  readonly path?: string;
}

export interface ProtocolStreamEvent {
  readonly eventType?: string;
  /** Parsed provider event, or the literal `[DONE]`. */
  readonly data: unknown;
}

export type ProtocolEventPhase = 'control' | 'reasoning' | 'output';

export interface LlmProtocolAccumulator {
  /** Inspect only protocol-specific, explicitly allowlisted response headers. */
  observeResponseHeaders(headers: GatewayResponseHeaders): void;
  observeJsonResponse(value: unknown): void;
  /** Classify whether this envelope contains generated reasoning/output. */
  observeStreamEvent(event: ProtocolStreamEvent): ProtocolEventPhase;
  /** Cheap terminal-state check for the per-event hot path. */
  isProtocolTerminal(): boolean;
  snapshot(): LlmProtocolObservation;
}

/** Route-level usage contract facts an accumulator cannot learn from the protocol alone. */
export interface LlmProtocolAccumulatorOptions {
  /**
   * The route omits (or sends null for) zero-valued cache counters instead
   * of reporting 0, as OpenRouter's Anthropic-compatible Messages skin does.
   * Once the final usage report has arrived (`message_delta`, or a JSON
   * body), a cache counter still absent counts as 0 with an
   * `absent_usage_assumed_zero:<field>` quality flag. Before that report a
   * counter may simply not be reported yet, so it stays unknown, as it does
   * without this option. An invalid counter is never assumed to be zero.
   */
  readonly absentCacheCountsAreZero?: boolean;
}

export interface LlmProtocolAdapter {
  readonly id: LlmProtocolId;
  inspectRequest(value: unknown, context?: ProtocolRequestContext): LlmRequestFacts;
  createAccumulator(options?: LlmProtocolAccumulatorOptions): LlmProtocolAccumulator;
}

export interface GatewayRouteAttempt {
  readonly ordinal: number;
  readonly provider: string | null;
  readonly model: string | null;
  readonly status: number | null;
  readonly selected: boolean | null;
  readonly source: 'router_metadata' | 'trusted_gateway_header';
}

export interface GatewayObservation {
  readonly servedModel: SourcedIdentity;
  readonly servedProvider: SourcedIdentity;
  readonly generationId: string | null;
  readonly costUsd: number | null;
  /**
   * True only for a verified official provider origin (a direct route to the
   * provider's own API), where the provider's first-party list prices apply
   * to the served model. Only such exchanges get a host list-price estimate;
   * opaque, gateway and unverified routes never do.
   */
  readonly officialListPricing?: boolean;
  readonly routeAttempts: readonly GatewayRouteAttempt[];
  readonly qualityFlags: readonly string[];
}

export interface GatewayResponseHeaders {
  readonly [name: string]: string | readonly string[] | undefined;
}

export interface LlmGatewayAccumulator {
  observeHeaders(headers: GatewayResponseHeaders): void;
  observePayload(value: unknown): void;
  snapshot(protocol?: LlmProtocolObservation): GatewayObservation;
}

export interface LlmGatewayAdapter {
  readonly id: string;
  /** The gateway's known usage-reporting contract, passed to the protocol accumulator. */
  readonly protocolAccumulatorOptions?: LlmProtocolAccumulatorOptions;
  createAccumulator(): LlmGatewayAccumulator;
}

export type AttributionQuality = 'exact' | 'bundle_only' | 'unattributed';

export interface LlmExchangeAttribution {
  readonly sessionId: string | null;
  readonly agentConversationId: string | null;
  readonly turnId: string | null;
  readonly bundleId: string | null;
  readonly workflowRunId: string | null;
  readonly stateId: string | null;
  readonly personaId: string | null;
  readonly agentId: string | null;
  readonly quality: AttributionQuality;
}

export interface LlmExchangeRoute {
  readonly logicalProvider: string;
  readonly providerProfileId: string | null;
  readonly protocol: LlmProtocolId;
  readonly gatewayKind: 'direct' | 'openrouter' | 'ironcurtain' | 'opaque';
  readonly clientRouteId: string | null;
  readonly upstreamRouteId: string | null;
}

export interface LlmExchangeTiming {
  readonly requestReceivedAt: string;
  readonly requestBodyCompleteOffsetMs: number | null;
  readonly responseHeadersOffsetMs: number | null;
  readonly firstUpstreamBodyByteOffsetMs: number | null;
  readonly firstProtocolEventOffsetMs: number | null;
  readonly firstReasoningEventOffsetMs: number | null;
  readonly lastReasoningEventOffsetMs: number | null;
  readonly firstOutputEventOffsetMs: number | null;
  readonly lastOutputEventOffsetMs: number | null;
  readonly protocolTerminalOffsetMs: number | null;
  readonly upstreamResponseEndOffsetMs: number | null;
  readonly clientDeliveryEndOffsetMs: number | null;
  readonly clientAborted: boolean;
}

export interface TransportAttempt {
  readonly ordinal: number;
  readonly startedOffsetMs: number;
  readonly endedOffsetMs: number;
  readonly responseStatus: number | null;
  readonly outcome: 'response' | 'auth_retry' | 'error' | 'aborted';
}

export interface LlmResponseMetadata {
  /** Transport request identifier from a protocol-specific allowlisted response header. */
  readonly providerRequestId: string | null;
  /** Provider response/message/generation identifier from the protocol body. */
  readonly providerResponseId: string | null;
  /** Gateway generation identifier from a trusted gateway contract. */
  readonly gatewayGenerationId: string | null;
  readonly actualServiceTier: string | null;
}

/** Canonical immutable record emitted once an observed HTTP exchange settles. */
export interface LlmExchangeCompleted {
  readonly schemaVersion: 1;
  readonly exchangeId: string;
  readonly attribution: LlmExchangeAttribution;
  readonly route: LlmExchangeRoute;
  readonly identity: LlmModelIdentity;
  readonly responseMetadata: LlmResponseMetadata;
  readonly request: LlmRequestFacts;
  readonly outcome: LlmOutcome;
  readonly usage: NormalizedUsage;
  readonly timing: LlmExchangeTiming;
  readonly transportAttempts: readonly TransportAttempt[];
  readonly gatewayRouteAttempts: readonly GatewayRouteAttempt[];
  readonly qualityFlags: readonly string[];
}
