import {
  addCounts,
  asArray,
  asKnownString,
  asRecord,
  asSafeCount,
  makeNormalizedUsage,
  subtractCount,
  usageCompleteness,
  type UnknownRecord,
} from '../normalization.js';
import type {
  LlmProtocolAccumulator,
  LlmProtocolAccumulatorOptions,
  LlmProtocolAdapter,
  LlmProtocolObservation,
  LlmRequestFacts,
  GatewayResponseHeaders,
  NormalizedStopReason,
  NormalizedTermination,
  ProtocolStreamEvent,
  RefusalSource,
  ServerToolRequests,
  UsageIteration,
  UsageIterationKind,
} from '../types.js';
import {
  emptyOutcome,
  hasTypedItem,
  inspectCommonRequest,
  readIdentifier,
  readResponseHeaderIdentifier,
  SERVICE_TIERS,
  SPEED_MODES,
  stableFlags,
} from './common.js';

/*
 * Anthropic usage contract, as this adapter applies it:
 *
 * - `message_start` usage carries the initial input and cache counters. Its
 *   `output_tokens` is a placeholder and is ignored.
 * - `message_delta` usage counters are cumulative finals. Reported input,
 *   cache, output, thinking and server-tool counters supersede the earlier
 *   values; that is the documented contract, not a conflict. Without
 *   iterations both reports describe the same attempt and counters only grow,
 *   so a lower later value (a gateway sending a zero placeholder) keeps the
 *   larger one and is flagged as a regression.
 * - `usage.iterations` itemizes every billing attempt of the exchange
 *   (compaction, executor messages, advisor sub-inferences, refusal
 *   fallbacks). Top-level usage then covers only part of the exchange (the
 *   attempt that produced the message, or the executor iterations without
 *   compaction), so the totals are the sums over the iterations and never
 *   iterations plus top-level usage. An earlier report can describe another
 *   part (a declined attempt, the context before compaction), so only the
 *   final top-level report counts and nothing is merged across reports.
 */

/** A counter as reported: `undefined` when absent or null, `null` when invalid. */
type Reported = number | null | undefined;

type CountField =
  | 'input'
  | 'cacheRead'
  | 'cacheWrite'
  | 'cacheWrite5m'
  | 'cacheWrite1h'
  | 'output'
  | 'thinking'
  | 'webSearchRequests'
  | 'webFetchRequests';

type IterationCountField = 'input' | 'cacheRead' | 'cacheWrite' | 'cacheWrite5m' | 'cacheWrite1h' | 'output';

interface PhaseCount {
  /** Largest valid value reported in this phase; counters are cumulative. */
  max: number | undefined;
  /** Latest valid value reported in this phase. */
  last: number | undefined;
  /** The latest report in this phase was invalid. */
  invalid: boolean;
}

interface CountSlot {
  readonly initial: PhaseCount;
  readonly terminal: PhaseCount;
}

interface ParsedIteration {
  readonly kind: UsageIterationKind;
  readonly model: string | null;
  readonly counts: Readonly<Record<IterationCountField, Reported>>;
}

/** Iterations as last reported: absent, unusable, or parsed. */
type IterationReport =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | {
      readonly kind: 'parsed';
      readonly entries: readonly ParsedIteration[];
    };

interface ResolvedCounts {
  readonly input: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly cacheWrite5m: number | null;
  readonly cacheWrite1h: number | null;
  readonly output: number | null;
}

interface ItemizedUsage extends ResolvedCounts {
  readonly attempts: number;
  readonly retained: readonly UsageIteration[];
  readonly splitReported: boolean;
}

const COUNT_FIELDS: readonly CountField[] = [
  'input',
  'cacheRead',
  'cacheWrite',
  'cacheWrite5m',
  'cacheWrite1h',
  'output',
  'thinking',
  'webSearchRequests',
  'webFetchRequests',
];

const CACHE_FIELD_KEYS = {
  cacheRead: 'cache_read_input_tokens',
  cacheWrite: 'cache_creation_input_tokens',
} as const;

const ITERATION_KINDS = ['compaction', 'message', 'advisor_message', 'fallback_message'] as const;

/** Iterations retained in the record; totals always sum every reported iteration. */
const MAX_RETAINED_USAGE_ITERATIONS = 16;

const ANTHROPIC_REQUEST_SERVICE_TIERS = [...SERVICE_TIERS, 'standard_only'] as const;

function emptyPhase(): PhaseCount {
  return { max: undefined, last: undefined, invalid: false };
}

function emptySlot(): CountSlot {
  return { initial: emptyPhase(), terminal: emptyPhase() };
}

function emptySlots(): Record<CountField, CountSlot> {
  const slots = {} as Record<CountField, CountSlot>;
  for (const field of COUNT_FIELDS) slots[field] = emptySlot();
  return slots;
}

/** Read one counter; an invalid value is flagged under `label` and returned as null. */
function readReported(record: UnknownRecord | undefined, key: string, flags: Set<string>, label = key): Reported {
  if (!record || !(key in record) || record[key] === null || record[key] === undefined) return undefined;
  const count = asSafeCount(record[key]);
  if (count === null) flags.add(`invalid_count:${label}`);
  return count;
}

function sumReported(values: readonly Reported[]): Reported {
  let total = 0;
  for (const value of values) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function stopReason(reason: unknown): {
  normalized: NormalizedStopReason;
  termination: NormalizedTermination;
} {
  switch (reason) {
    case 'end_turn':
      return { normalized: 'end_turn', termination: 'stop' };
    case 'stop_sequence':
      return { normalized: 'stop_sequence', termination: 'stop' };
    case 'max_tokens':
      return { normalized: 'max_tokens', termination: 'length' };
    case 'model_context_window_exceeded':
      return { normalized: 'context_window', termination: 'length' };
    case 'tool_use':
      return { normalized: 'tool_use', termination: 'tool' };
    case 'pause_turn':
      // Anthropic paused the response for a continuation; it did not request
      // a client tool. `stop` is the closest normalized terminal category.
      return { normalized: 'pause_turn', termination: 'stop' };
    case 'refusal':
      return { normalized: 'refusal', termination: 'refusal' };
    case undefined:
    case null:
      return { normalized: 'not_reported', termination: 'unknown' };
    default:
      return { normalized: 'other', termination: 'unknown' };
  }
}

export class AnthropicMessagesAccumulator implements LlmProtocolAccumulator {
  private responseModel: string | null = null;
  private providerRequestId: string | null = null;
  private providerResponseId: string | null = null;
  private actualServiceTier: string | null = null;
  /** `usage.speed`: the speed the response was served at (fast mode prices differently). */
  private actualSpeedMode: (typeof SPEED_MODES)[number] | null = null;
  private readonly counts = emptySlots();
  private iterations: IterationReport = { kind: 'absent' };
  /** Counters reported lower than an earlier report of the same counter. */
  private readonly regressedCounts = new Set<CountField>();
  private sawUsage = false;
  /** The final usage report (`message_delta`, or a JSON body) arrived. */
  private sawTerminalUsage = false;
  private terminal = false;
  private termination: NormalizedTermination = 'unknown';
  private providerStopReason: NormalizedStopReason = 'not_reported';
  private refusal: boolean | null = null;
  private refusalCategory: string | null = null;
  private refusalSource: RefusalSource = 'not_reported';
  private readonly flags = new Set<string>();

  constructor(private readonly options: LlmProtocolAccumulatorOptions = {}) {}

  observeResponseHeaders(headers: GatewayResponseHeaders): void {
    this.providerRequestId = readResponseHeaderIdentifier(headers, 'request-id', this.flags);
  }

  observeJsonResponse(value: unknown): void {
    const message = asRecord(value);
    if (!message) {
      this.flags.add('invalid_response_envelope');
      return;
    }
    this.observeMessageIdentity(message);
    this.observeInitialUsage(asRecord(message['usage']));
    this.observeTerminalUsage(asRecord(message['usage']));
    this.observeStop(message['stop_reason'], asRecord(message['stop_details']));
    if (hasTypedItem(message, ['refusal'])) this.markRefusal('content_item');
    this.terminal = true;
  }

  observeStreamEvent(event: ProtocolStreamEvent): 'control' | 'reasoning' | 'output' {
    const payload = asRecord(event.data);
    if (!payload) {
      this.flags.add('invalid_stream_event');
      return 'control';
    }
    const type = typeof payload['type'] === 'string' ? payload['type'] : event.eventType;
    if (type === 'message_start') {
      const message = asRecord(payload['message']);
      if (!message) {
        this.flags.add('invalid_message_start');
        return 'control';
      }
      this.observeMessageIdentity(message);
      this.observeInitialUsage(asRecord(message['usage']));
      return 'control';
    }
    if (type === 'message_delta') {
      const delta = asRecord(payload['delta']);
      this.observeTerminalUsage(asRecord(payload['usage']));
      this.observeStop(delta?.['stop_reason'], asRecord(delta?.['stop_details']));
      return 'control';
    }
    if (type === 'message_stop') {
      if (this.terminal) this.flags.add('duplicate_protocol_terminal');
      this.terminal = true;
      const metadata = asRecord(payload['message']);
      if (metadata) this.observeMessageIdentity(metadata);
      return 'control';
    }
    if (type === 'content_block_start' && hasTypedItem(payload['content_block'], ['refusal'])) {
      this.markRefusal('content_item');
    }
    if (type === 'content_block_delta') {
      const deltaType = asRecord(payload['delta'])?.['type'];
      if (deltaType === 'thinking_delta') return 'reasoning';
      if (deltaType === 'text_delta' || deltaType === 'input_json_delta') return 'output';
    }
    return 'control';
  }

  isProtocolTerminal(): boolean {
    return this.terminal;
  }

  snapshot(): LlmProtocolObservation {
    const usageFlags = new Set<string>();
    const topInput = this.resolve('input');
    const topOutput = this.resolve('output');
    const topThinking = this.resolve('thinking');
    const itemized = this.iterations.kind === 'parsed' ? this.itemize(this.iterations.entries, usageFlags) : null;
    // Unusable iterations leave the per-attempt totals unknown. The top-level
    // counters still describe one attempt and remain as lower-bound parts.
    const totalsKnown = this.iterations.kind !== 'invalid';
    if (!totalsKnown) usageFlags.add('invalid_usage_iterations');

    // Itemized usage explains a lower final report: it covers another part of the exchange.
    if (!this.itemizedUsage()) {
      for (const field of this.regressedCounts) usageFlags.add(`regressing_cumulative_usage:${field}`);
    }

    const counts: ResolvedCounts = itemized ?? {
      input: topInput ?? null,
      cacheRead: this.resolveCache('cacheRead', usageFlags),
      cacheWrite: this.resolveCache('cacheWrite', usageFlags),
      cacheWrite5m: this.resolve('cacheWrite5m') ?? null,
      cacheWrite1h: this.resolve('cacheWrite1h') ?? null,
      output: topOutput ?? null,
    };
    const inputTotal = totalsKnown ? addCounts(counts.input, counts.cacheRead, counts.cacheWrite) : null;
    const outputTotal = totalsKnown ? counts.output : null;

    // The thinking breakdown describes the top-level attempt only. Once several
    // attempts add output it no longer partitions the summed output.
    let thinking = topThinking ?? null;
    if (itemized !== null && itemized.attempts > 1 && thinking !== null) {
      usageFlags.add('thinking_breakdown_unavailable:usage_iterations');
      thinking = null;
    }
    const nonThinking = subtractCount(outputTotal, thinking);
    if (thinking !== null && outputTotal !== null && thinking > outputTotal) {
      usageFlags.add('contradictory_usage:thinking_exceeds_output');
    }
    const validNonThinking = usageFlags.has('contradictory_usage:thinking_exceeds_output') ? null : nonThinking;

    const split = this.cacheWriteSplit(counts, itemized, usageFlags);
    const serverToolRequests = this.serverToolRequests();
    const invalid = [...this.flags].some((flag) => flag.startsWith('invalid_count:'));
    const complete = usageCompleteness(inputTotal, outputTotal, this.sawUsage, invalid);
    const outcome =
      this.providerStopReason === 'not_reported'
        ? emptyOutcome()
        : {
            termination: this.termination,
            providerStopReason: this.providerStopReason,
            responseStatus: null,
            refusal: this.refusal,
            refusalCategory: this.refusalCategory,
            refusalSource: this.refusalSource,
          };
    return {
      protocol: 'anthropic-messages',
      responseModel: this.responseModel,
      providerRequestId: this.providerRequestId,
      providerResponseId: this.providerResponseId,
      actualServiceTier: this.actualServiceTier,
      actualSpeedMode: this.actualSpeedMode,
      usage: makeNormalizedUsage({
        inputTokensReported: topInput ?? null,
        inputTokensTotal: inputTotal,
        inputTokensAccuracy: inputTotal === null ? 'unknown' : 'derived_exact',
        inputTokensUncached: counts.input,
        cacheReadInputTokens: counts.cacheRead,
        cacheWriteInputTokens: counts.cacheWrite,
        outputTokensReported: topOutput ?? null,
        outputTokenSemantics: 'includes_thinking',
        outputTokensTotal: outputTotal,
        // A sum over several reported attempts is derived, not one reported count.
        outputTokensAccuracy:
          outputTotal === null
            ? 'unknown'
            : itemized !== null && itemized.attempts > 1
              ? 'derived_exact'
              : 'reported_exact',
        thinkingTokens: thinking,
        thinkingTokensAccuracy: thinking === null ? 'unknown' : 'provider_estimate',
        nonThinkingOutputTokens: validNonThinking,
        nonThinkingOutputTokensAccuracy: validNonThinking === null ? 'unknown' : 'derived_from_estimate',
        providerTotalTokens: null,
        canonicalTotalTokens: addCounts(inputTotal, outputTotal),
        usageSource: !this.sawUsage ? null : itemized ? 'anthropic_usage_iterations' : 'anthropic_message_usage',
        usageCompleteness: complete,
        qualityFlags: [...usageFlags],
        ...(split ?? {}),
        ...(serverToolRequests ? { serverToolRequests } : {}),
        ...(itemized ? { iterations: itemized.retained } : {}),
      }),
      outcome,
      protocolTerminal: this.terminal,
      qualityFlags: stableFlags([...this.flags], [...usageFlags]),
    };
  }

  private observeMessageIdentity(message: Record<string, unknown>): void {
    const model = readIdentifier(message, 'model', this.flags);
    const id = readIdentifier(message, 'id', this.flags);
    if (model !== null) this.responseModel = model;
    if (id !== null) this.providerResponseId = id;
    this.observeServiceTier(message['service_tier']);
  }

  /**
   * The tier that served the response. The Messages API reports it as
   * `usage.service_tier` (`standard`, `priority`, `batch`); a message-level
   * `service_tier` is accepted too. An unrecognized value is flagged, so the
   * exchange is not priced as standard.
   */
  private observeServiceTier(value: unknown): void {
    if (value === undefined || value === null) return;
    const tier = asKnownString(value, SERVICE_TIERS);
    if (tier === null) this.flags.add('unknown_response_service_tier');
    else this.actualServiceTier = tier;
  }

  /** `usage.speed` (`standard` | `fast`) and `usage.service_tier`, reported in any usage object. */
  private observeServingMode(usage: UnknownRecord): void {
    this.observeServiceTier(usage['service_tier']);
    const speed = usage['speed'];
    if (speed === undefined || speed === null) return;
    const known = asKnownString(speed, SPEED_MODES);
    if (known === null) this.flags.add('unknown_response_speed_mode');
    else this.actualSpeedMode = known;
  }

  private observeInitialUsage(usage: UnknownRecord | undefined): void {
    if (!usage) return;
    this.sawUsage = true;
    this.observeServingMode(usage);
    const cacheCreation = asRecord(usage['cache_creation']);
    this.record('input', 'initial', readReported(usage, 'input_tokens', this.flags));
    this.record('cacheRead', 'initial', readReported(usage, 'cache_read_input_tokens', this.flags));
    this.record('cacheWrite', 'initial', readReported(usage, 'cache_creation_input_tokens', this.flags));
    this.record('cacheWrite5m', 'initial', readReported(cacheCreation, 'ephemeral_5m_input_tokens', this.flags));
    this.record('cacheWrite1h', 'initial', readReported(cacheCreation, 'ephemeral_1h_input_tokens', this.flags));
  }

  private observeTerminalUsage(usage: UnknownRecord | undefined): void {
    if (!usage) return;
    this.sawUsage = true;
    this.sawTerminalUsage = true;
    this.observeServingMode(usage);
    const cacheCreation = asRecord(usage['cache_creation']);
    const details = asRecord(usage['output_tokens_details']);
    const serverTools = asRecord(usage['server_tool_use']);
    this.record('input', 'terminal', readReported(usage, 'input_tokens', this.flags));
    this.record('cacheRead', 'terminal', readReported(usage, 'cache_read_input_tokens', this.flags));
    this.record('cacheWrite', 'terminal', readReported(usage, 'cache_creation_input_tokens', this.flags));
    this.record('cacheWrite5m', 'terminal', readReported(cacheCreation, 'ephemeral_5m_input_tokens', this.flags));
    this.record('cacheWrite1h', 'terminal', readReported(cacheCreation, 'ephemeral_1h_input_tokens', this.flags));
    this.record('output', 'terminal', readReported(usage, 'output_tokens', this.flags));
    this.record('thinking', 'terminal', readReported(details, 'thinking_tokens', this.flags));
    this.record('webSearchRequests', 'terminal', readReported(serverTools, 'web_search_requests', this.flags));
    this.record('webFetchRequests', 'terminal', readReported(serverTools, 'web_fetch_requests', this.flags));
    const iterations = usage['iterations'];
    if (iterations !== undefined && iterations !== null) this.iterations = this.readIterations(iterations);
  }

  /** The provider itemized the exchange's attempts (even unreadably): top-level usage is then only part of it. */
  private itemizedUsage(): boolean {
    return this.iterations.kind !== 'absent';
  }

  private record(field: CountField, phase: 'initial' | 'terminal', value: Reported): void {
    if (value === undefined) return;
    const { initial, terminal } = this.counts[field];
    const slot = phase === 'initial' ? initial : terminal;
    // The latest report decides validity.
    slot.invalid = value === null;
    if (value === null) return;
    if (phase === 'initial') {
      // A repeated message_start that disagrees with itself is a protocol anomaly.
      if (slot.last !== undefined && value !== slot.last) this.flags.add(`conflicting_usage:initial:${field}`);
    } else if (
      (terminal.max !== undefined && value < terminal.max) ||
      (initial.max !== undefined && value < initial.max)
    ) {
      this.regressedCounts.add(field);
    }
    slot.max = Math.max(slot.max ?? value, value);
    slot.last = value;
  }

  /**
   * Final value of one top-level counter. Without iterations it is the
   * cumulative terminal report when present, never lower than an earlier
   * report of the same attempt. Itemized usage takes the final top-level
   * report alone: an earlier report may describe another attempt or the
   * context before compaction, so a counter the final report omits stays
   * unknown instead of borrowing that value. An invalid final report leaves
   * the counter unknown rather than falling back to a stale initial value.
   */
  private resolve(field: CountField): Reported {
    const { initial, terminal } = this.counts[field];
    if (terminal.invalid) return null;
    if (this.itemizedUsage()) return terminal.last;
    if (terminal.last !== undefined) return Math.max(terminal.max ?? terminal.last, initial.max ?? terminal.last);
    if (initial.invalid) return null;
    return initial.max;
  }

  /**
   * A cache counter the route omits counts as zero only under its declared
   * contract, and only once the final usage report has arrived: such a route
   * may report a cache counter in `message_delta` alone, so before it an
   * absent counter is merely not yet reported.
   */
  private absentCacheIsZero(): boolean {
    return this.sawTerminalUsage && this.options.absentCacheCountsAreZero === true;
  }

  private resolveCache(field: 'cacheRead' | 'cacheWrite', usageFlags: Set<string>): number | null {
    const value = this.resolve(field);
    if (value !== undefined) return value;
    if (this.absentCacheIsZero()) {
      usageFlags.add(`absent_usage_assumed_zero:${CACHE_FIELD_KEYS[field]}`);
      return 0;
    }
    return null;
  }

  private readIterations(value: unknown): IterationReport {
    const entries = asArray(value);
    if (!entries) {
      this.flags.add('invalid_usage_iterations');
      return { kind: 'invalid' };
    }
    if (entries.length === 0) return { kind: 'absent' };
    const parsed: ParsedIteration[] = [];
    for (const entry of entries) {
      const record = asRecord(entry);
      if (!record) {
        this.flags.add('invalid_usage_iterations');
        return { kind: 'invalid' };
      }
      const kind = asKnownString(record['type'], ITERATION_KINDS) ?? 'other';
      if (kind === 'other') this.flags.add('unknown_usage_iteration_type');
      const cacheCreation = asRecord(record['cache_creation']);
      parsed.push({
        kind,
        model: readIdentifier(record, 'model', this.flags),
        counts: {
          input: readReported(record, 'input_tokens', this.flags, 'iterations.input_tokens'),
          cacheRead: readReported(record, 'cache_read_input_tokens', this.flags, 'iterations.cache_read_input_tokens'),
          cacheWrite: readReported(
            record,
            'cache_creation_input_tokens',
            this.flags,
            'iterations.cache_creation_input_tokens',
          ),
          cacheWrite5m: readReported(
            cacheCreation,
            'ephemeral_5m_input_tokens',
            this.flags,
            'iterations.ephemeral_5m_input_tokens',
          ),
          cacheWrite1h: readReported(
            cacheCreation,
            'ephemeral_1h_input_tokens',
            this.flags,
            'iterations.ephemeral_1h_input_tokens',
          ),
          output: readReported(record, 'output_tokens', this.flags, 'iterations.output_tokens'),
        },
      });
    }
    return { kind: 'parsed', entries: parsed };
  }

  /** Sum every billing attempt. Top-level usage is never added on top. */
  private itemize(entries: readonly ParsedIteration[], usageFlags: Set<string>): ItemizedUsage {
    const resolved = this.fillFinalAttempt(entries);
    const absentCacheIsZero = this.absentCacheIsZero();
    const cacheValue = (value: Reported, key: string): Reported => {
      if (value !== undefined || !absentCacheIsZero) return value;
      usageFlags.add(`absent_usage_assumed_zero:${key}`);
      return 0;
    };
    // A TTL split an attempt omits is trivially zero when that attempt wrote nothing.
    const splitValue = (iteration: ParsedIteration, field: 'cacheWrite5m' | 'cacheWrite1h'): Reported => {
      const value = iteration.counts[field];
      return value === undefined && cacheValue(iteration.counts.cacheWrite, 'cache_creation_input_tokens') === 0
        ? 0
        : value;
    };
    const sum = (pick: (iteration: ParsedIteration) => Reported): number | null =>
      sumReported(resolved.map(pick)) ?? null;

    usageFlags.add('usage_iterations_summed');
    for (const iteration of resolved) {
      if (iteration.kind === 'fallback_message') usageFlags.add('fallback_served');
      else if (iteration.kind !== 'message') usageFlags.add(`usage_iteration:${iteration.kind}`);
    }
    if (resolved.length > MAX_RETAINED_USAGE_ITERATIONS) usageFlags.add('usage_iterations_truncated');

    return {
      input: sum((iteration) => iteration.counts.input),
      cacheRead: sum((iteration) => cacheValue(iteration.counts.cacheRead, 'cache_read_input_tokens')),
      cacheWrite: sum((iteration) => cacheValue(iteration.counts.cacheWrite, 'cache_creation_input_tokens')),
      cacheWrite5m: sum((iteration) => splitValue(iteration, 'cacheWrite5m')),
      cacheWrite1h: sum((iteration) => splitValue(iteration, 'cacheWrite1h')),
      output: sum((iteration) => iteration.counts.output),
      attempts: resolved.length,
      splitReported: resolved.some(
        (iteration) => iteration.counts.cacheWrite5m !== undefined || iteration.counts.cacheWrite1h !== undefined,
      ),
      retained: resolved.slice(0, MAX_RETAINED_USAGE_ITERATIONS).map((iteration) => ({
        kind: iteration.kind,
        model: iteration.model,
        inputTokensUncached: iteration.counts.input ?? null,
        cacheReadInputTokens: cacheValue(iteration.counts.cacheRead, 'cache_read_input_tokens') ?? null,
        cacheWriteInputTokens: cacheValue(iteration.counts.cacheWrite, 'cache_creation_input_tokens') ?? null,
        outputTokens: iteration.counts.output ?? null,
      })),
    };
  }

  /**
   * Top-level usage covers the attempt that produced the returned message,
   * which is the last iteration. When that iteration omits cache counters and
   * its input and output match the top-level ones exactly, it takes the
   * top-level cache counters: the same attempt, reported once.
   */
  private fillFinalAttempt(entries: readonly ParsedIteration[]): readonly ParsedIteration[] {
    const last = entries.at(-1);
    const topInput = this.resolve('input');
    const topOutput = this.resolve('output');
    if (
      last === undefined ||
      typeof topInput !== 'number' ||
      typeof topOutput !== 'number' ||
      last.counts.input !== topInput ||
      last.counts.output !== topOutput
    ) {
      return entries;
    }
    const fill = (field: 'cacheRead' | 'cacheWrite' | 'cacheWrite5m' | 'cacheWrite1h'): Reported =>
      last.counts[field] !== undefined ? last.counts[field] : this.resolve(field);
    const filled: ParsedIteration = {
      ...last,
      counts: {
        ...last.counts,
        cacheRead: fill('cacheRead'),
        cacheWrite: fill('cacheWrite'),
        cacheWrite5m: fill('cacheWrite5m'),
        cacheWrite1h: fill('cacheWrite1h'),
      },
    };
    return [...entries.slice(0, -1), filled];
  }

  /** The cache-write TTL split, kept only when reported and consistent with the cache-write total. */
  private cacheWriteSplit(
    counts: ResolvedCounts,
    itemized: ItemizedUsage | null,
    usageFlags: Set<string>,
  ): { readonly cacheWrite5mInputTokens: number | null; readonly cacheWrite1hInputTokens: number | null } | null {
    const reported = itemized
      ? itemized.splitReported
      : this.resolve('cacheWrite5m') !== undefined || this.resolve('cacheWrite1h') !== undefined;
    if (!reported) return null;
    const { cacheWrite, cacheWrite5m, cacheWrite1h } = counts;
    if (
      cacheWrite !== null &&
      cacheWrite5m !== null &&
      cacheWrite1h !== null &&
      cacheWrite5m + cacheWrite1h !== cacheWrite
    ) {
      usageFlags.add('contradictory_usage:cache_creation_split');
      return { cacheWrite5mInputTokens: null, cacheWrite1hInputTokens: null };
    }
    return { cacheWrite5mInputTokens: cacheWrite5m, cacheWrite1hInputTokens: cacheWrite1h };
  }

  private serverToolRequests(): ServerToolRequests | null {
    const webSearch = this.resolve('webSearchRequests');
    const webFetch = this.resolve('webFetchRequests');
    if (webSearch === undefined && webFetch === undefined) return null;
    return { webSearchRequests: webSearch ?? null, webFetchRequests: webFetch ?? null };
  }

  private observeStop(reason: unknown, details: Record<string, unknown> | undefined): void {
    const mapped = stopReason(reason);
    if (mapped.normalized !== 'not_reported') {
      if (this.providerStopReason !== 'not_reported' && this.providerStopReason !== mapped.normalized) {
        this.flags.add('conflicting_stop_reason');
      }
      this.providerStopReason = mapped.normalized;
      this.termination = mapped.termination;
      if (mapped.termination !== 'unknown') this.refusal = mapped.termination === 'refusal';
    }
    if (details?.['type'] === 'refusal') {
      this.markRefusal('stop_details');
      const category = asKnownString(details['category'], [
        'cyber',
        'bio',
        'frontier_llm',
        'reasoning_extraction',
        'general_harms',
      ] as const);
      if (details['category'] != null && category === null) this.flags.add('unknown_refusal_category');
      if (category !== null) this.refusalCategory = category;
    } else if (mapped.normalized === 'refusal') {
      this.markRefusal('stop_reason');
    }
  }

  private markRefusal(source: RefusalSource): void {
    this.refusal = true;
    this.refusalSource = source;
    this.termination = 'refusal';
    this.providerStopReason = 'refusal';
  }
}

export class AnthropicMessagesAdapter implements LlmProtocolAdapter {
  readonly id = 'anthropic-messages' as const;

  inspectRequest(value: unknown): LlmRequestFacts {
    return inspectCommonRequest(value, ANTHROPIC_REQUEST_SERVICE_TIERS);
  }

  createAccumulator(options?: LlmProtocolAccumulatorOptions): LlmProtocolAccumulator {
    return new AnthropicMessagesAccumulator(options);
  }
}
