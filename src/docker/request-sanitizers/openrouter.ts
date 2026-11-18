/**
 * OpenRouter request sanitizer (a gateway layer).
 *
 * OpenRouter adds egress features of its own to every wire protocol it serves:
 * a web-search plugin, a `:online` model variant that switches that plugin on,
 * models that search the web on every request, fallback model lists, and
 * presets (saved settings, including models, applied by name). No
 * wire-protocol sanitizer knows about them, so this one runs on every
 * OpenRouter POST route (`/api/v1/messages` and its `count_tokens`,
 * `/api/v1/responses`, `/api/v1/chat/completions`), chained in front of the
 * protocol's own sanitizer (see `sanitizedEndpointsFor` in ./index.ts). The
 * gateway binding declares it: `GatewayDefinition.gatewaySanitizer`.
 *
 * - `plugins` (the `web` plugin, file parsers, ...), `web_search_options`
 *   (native search of search models), `models` (fallback models, which the
 *   profile's model map never sees and which could name any of the below)
 *   and `preset` (a preset applied by name) are dropped. Field names are
 *   compared ignoring case, `_` and `-`, and a non-canonical spelling of
 *   `model` is dropped too, in case a lenient parser reads one of them.
 * - The `:online` variant is stripped from `model`. The sanitizer runs after
 *   the compatibility rewriter mapped the model, so the variant goes whether
 *   the agent asked for it or a mapping produced it. A model that still names
 *   it in a form this cannot strip is refused.
 * - A web-search model (every `perplexity/` model, `*-search`, `*-search-*`
 *   such as OpenAI's `*-search-preview` and `*-search-api`, `*deep-research*`,
 *   legacy `*-online` slugs; the shared list in ./web-search-models.ts) is
 *   refused unless the provider profile names it itself, as a model-map
 *   target, a per-agent model or the default model. The agent cannot pick one
 *   on its own.
 * - A model that applies a preset (`@preset/<slug>`, alone or after a model
 *   slug) is refused unless the provider profile names that exact model. A
 *   preset is account configuration the proxy cannot see: its saved model
 *   list can name a web-search model or an `:online` variant, so an
 *   agent-chosen preset would get around both rules above.
 * - `model` must be a string.
 *
 * Everything else passes through to the protocol sanitizer.
 */

import { labelValue, rejectRequest, type RequestSanitizer, type SanitizeResult } from './core.js';
import { isWebSearchModel } from './web-search-models.js';

/**
 * Normalized names (see {@link fieldKey}) of top-level fields that enable
 * OpenRouter web search, model fallbacks or a preset.
 */
const DROPPED_FIELD_KEYS: ReadonlySet<string> = new Set(['plugins', 'websearchoptions', 'models', 'preset']);

/** A field name ignoring case, `_` and `-`, so `Plugins` or `webSearchOptions` cannot slip past. */
function fieldKey(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, '');
}

function isDroppedField(field: string): boolean {
  const key = fieldKey(field);
  return DROPPED_FIELD_KEYS.has(key) || (key === 'model' && field !== 'model');
}

/** A `:online` variant left after stripping, e.g. joined to a preset reference (`:online@preset/x`). */
const ONLINE_VARIANT_LEFTOVER = /:\s*online/i;

/**
 * The slug OpenRouter routes on: lowercased and trimmed, without a leading
 * `~` alias marker or any `:variant` suffix.
 */
export function openRouterModelBase(model: string): string {
  const [base] = model.toLowerCase().split(':', 1);
  return base.trim().replace(/^~\s*/, '');
}

/** True when the model (a base slug, see {@link openRouterModelBase}) searches the web for every request. */
export function isOpenRouterSearchModel(base: string): boolean {
  return isWebSearchModel(base);
}

/** `model` without its `:online` variants (compared ignoring case and spaces); other variants are kept. */
export function stripOnlineVariant(model: string): string {
  const [base, ...variants] = model.split(':');
  const kept = variants.filter((variant) => variant.trim().toLowerCase() !== 'online');
  return kept.length === variants.length ? model : [base, ...kept].join(':');
}

/**
 * True when the model applies an OpenRouter preset: `@preset/<slug>` on its
 * own or after a model slug (`openai/gpt-4o@preset/<slug>`). No model slug
 * contains `@`, so any `@` counts, whatever follows it.
 */
export function namesOpenRouterPreset(model: string): boolean {
  return model.includes('@');
}

/** A preset-applying model as compared with the profile's own: lowercased and trimmed. */
function presetModelKey(model: string): string {
  return model.trim().toLowerCase();
}

export interface OpenRouterSanitizerOptions {
  /**
   * Models the provider profile names itself: model-map targets, per-agent
   * models and the default model. A web-search model is forwarded only when
   * it is one of these (compared by {@link openRouterModelBase}), and a
   * preset-applying model only when it is exactly one of these.
   */
  readonly configuredModels: readonly string[];
}

/** Build the OpenRouter gateway sanitizer for one provider profile. */
export function createOpenRouterRequestSanitizer(options: OpenRouterSanitizerOptions): RequestSanitizer {
  const approvedSearchModels: ReadonlySet<string> = new Set(
    options.configuredModels.map(openRouterModelBase).filter(isOpenRouterSearchModel),
  );
  const approvedPresetModels: ReadonlySet<string> = new Set(
    options.configuredModels.filter(namesOpenRouterPreset).map(presetModelKey),
  );

  function sanitizeBody(body: Readonly<Record<string, unknown>>): SanitizeResult {
    const model = body.model;
    if (typeof model !== 'string') return rejectRequest('the request must name its model as a string');
    const stripped = stripOnlineVariant(model);
    if (ONLINE_VARIANT_LEFTOVER.test(stripped)) {
      return rejectRequest(
        `model "${labelValue(model)}" asks for the :online web search variant in a form the proxy cannot remove`,
      );
    }
    const base = openRouterModelBase(stripped);
    if (isOpenRouterSearchModel(base) && !approvedSearchModels.has(base)) {
      return rejectRequest(
        `model "${labelValue(stripped)}" searches the web on every request; ` +
          'it is forwarded only when the provider profile maps to it',
      );
    }
    if (namesOpenRouterPreset(stripped) && !approvedPresetModels.has(presetModelKey(stripped))) {
      return rejectRequest(
        `model "${labelValue(stripped)}" applies an OpenRouter preset, whose saved models and settings the proxy ` +
          'cannot inspect; it is forwarded only when the provider profile maps to it',
      );
    }
    const dropped = Object.keys(body).filter(isDroppedField);
    const removed = dropped.map((field) => labelValue(field));
    if (stripped !== model) removed.push('model:online');
    if (removed.length === 0) return { body, removed };
    // Object.fromEntries defines own properties, so even a `__proto__` key in
    // the parsed body is carried over as data rather than invoking the setter.
    const sanitized = Object.fromEntries(
      Object.entries(body)
        .filter(([field]) => !dropped.includes(field))
        .map(([field, value]) => [field, field === 'model' ? stripped : value]),
    );
    return { body: sanitized, removed };
  }

  return Object.freeze({
    protocol: 'openrouter',
    // No OpenRouter request header enables a hosted feature; the body rules are the control.
    sanitizeHeaders: (): readonly string[] => [],
    sanitizeBody,
  });
}
