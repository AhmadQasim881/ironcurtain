import { closestMatch } from '../utils/edit-distance.js';

/** Supported LLM provider identifiers. */
export type ProviderId = 'anthropic' | 'google' | 'openai';

/** Default provider when no prefix is specified. */
const DEFAULT_PROVIDER: ProviderId = 'anthropic';

/** Known provider identifiers, in display order. */
export const KNOWN_PROVIDER_IDS: readonly ProviderId[] = ['anthropic', 'google', 'openai'];

/** Known provider identifiers for validation. */
const KNOWN_PROVIDERS = new Set<string>(KNOWN_PROVIDER_IDS);

/** Largest edit distance at which an unknown prefix counts as a misspelled provider. */
const NEAR_MISS_MAX_DISTANCE = 2;

/**
 * Environment variable that supplies each provider's API key.
 *
 * Single source of truth for the provider→env-var mapping. Declared as an
 * exhaustive `Record<ProviderId, string>` so adding a provider to
 * {@link ProviderId} forces a matching entry here at compile time. Must stay
 * in sync with the env-var overrides applied in `resolveUserConfig()`.
 */
export const PROVIDER_ENV_VARS: Record<ProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  openai: 'OPENAI_API_KEY',
};

/**
 * Parsed model specifier. A "qualified model ID" has the form
 * "provider:model-name". A bare model ID defaults to Anthropic.
 */
export interface ParsedModelId {
  readonly provider: ProviderId;
  readonly modelId: string;
}

/**
 * Parses a qualified model ID string into provider and model components.
 *
 * Format: "provider:model-id" or just "model-id" (defaults to anthropic).
 *
 * @throws Error if the model ID is empty after a recognized provider prefix (e.g. "anthropic:").
 * Unknown prefixes are treated as part of the model ID and default to the anthropic provider.
 */
export function parseModelId(qualifiedId: string): ParsedModelId {
  const colonIndex = qualifiedId.indexOf(':');

  if (colonIndex === -1) {
    return { provider: DEFAULT_PROVIDER, modelId: qualifiedId };
  }

  const prefix = qualifiedId.substring(0, colonIndex);

  // Only treat the prefix as a provider if it's a known provider name.
  // Otherwise the entire string is a model ID (e.g. Ollama tags like
  // "qwen3.5-uncensored:35b" where the colon separates name from tag).
  if (!KNOWN_PROVIDERS.has(prefix)) {
    return { provider: DEFAULT_PROVIDER, modelId: qualifiedId };
  }

  const modelId = qualifiedId.substring(colonIndex + 1);
  if (!modelId) {
    throw new Error(`Empty model ID in "${qualifiedId}". ` + `Expected format: "provider:model-id"`);
  }

  return { provider: prefix as ProviderId, modelId };
}

/**
 * The provider that the prefix of `qualifiedId` (the text before its first
 * colon) looks like a misspelling of, such as "openai" for "opnai:gpt-5" or
 * "anthropic" for "Anthropic:claude-x". Undefined when there is no prefix,
 * when it already names a provider, or when it looks like the name half of an
 * Ollama-style "name:tag" ID instead: it contains a "/" or a "." (as in
 * "glm-5.1:cloud" or "jaahas/qwen3.5:35b") or is more than two edits (after
 * lowercasing) from every provider name.
 *
 * {@link parseModelId} sends any unknown prefix, typo or not, to the default
 * provider as part of the model ID, so validators use this to reject the typo
 * before a request fails at the provider mid-session.
 */
export function nearMissProviderPrefix(qualifiedId: string): ProviderId | undefined {
  const colonIndex = qualifiedId.indexOf(':');
  if (colonIndex <= 0) return undefined;
  const prefix = qualifiedId.substring(0, colonIndex);
  if (KNOWN_PROVIDERS.has(prefix) || prefix.includes('/') || prefix.includes('.')) return undefined;
  return closestMatch(prefix.toLowerCase(), KNOWN_PROVIDER_IDS, NEAR_MISS_MAX_DISTANCE);
}
