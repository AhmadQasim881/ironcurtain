/**
 * Models that search the web on every request just by being selected. No
 * request field turns that off, so the sanitizers judge the model itself:
 *
 * - the OpenRouter gateway layer (`./openrouter.ts`) forwards one only when
 *   the provider profile names it;
 * - the layer on OpenAI's own routes, api.openai.com and the ChatGPT Codex
 *   backend (`openaiPlatformSanitizer` in `./openai.ts`), never forwards one.
 *
 * This is a denylist of known name patterns: a search model added under
 * another name passes until the list learns it.
 */

/** Name patterns of web-search models, matched against a lowercased model name. */
const WEB_SEARCH_MODEL_PATTERNS: readonly RegExp[] = [
  // Perplexity Sonar models answer from a live web search.
  /^perplexity\//,
  // Search models by name: gpt-4o(-mini)-search-preview[-date], gpt-5-search-api[-date], *-search.
  /-search(?:-|$)/,
  // Deep-research models browse the web (o3-deep-research, o4-mini-deep-research, sonar-deep-research).
  /deep-research/,
  // Legacy online slugs (perplexity/llama-3.1-sonar-large-128k-online).
  /-online$/,
];

/** True when `model` (lowercased by the caller) names a model that searches the web for every request. */
export function isWebSearchModel(model: string): boolean {
  return WEB_SEARCH_MODEL_PATTERNS.some((pattern) => pattern.test(model));
}
