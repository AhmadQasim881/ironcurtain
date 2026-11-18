/**
 * The memory server's LLM endpoint, and which API key may be sent to it.
 *
 * The memory server sends its key as a bearer token to whatever base URL it is
 * given (it uses an OpenAI-compatible client). A key must therefore reach only
 * the service it belongs to:
 *
 *  - `memory.llmApiKey` is the user's key for the memory endpoint, and goes to
 *    `memory.llmBaseUrl` (or, without one, to the Anthropic route below).
 *  - Without `memory.llmApiKey`, the Anthropic API key is used only on the
 *    Anthropic route itself: Anthropic's OpenAI-compatible endpoint
 *    (`https://api.anthropic.com/v1/`), or, when an Anthropic base URL is
 *    configured (ANTHROPIC_BASE_URL / `anthropicBaseUrl`, for example a LiteLLM
 *    gateway whose virtual key is the "Anthropic key"), the `/v1/` endpoint
 *    under that root. A `memory.llmBaseUrl` on any other origin gets no key
 *    (a local Ollama needs none; another provider needs `memory.llmApiKey`).
 *  - `memory.llmBaseUrl` must use https, or plain http only to this machine
 *    (`localhost`, 127.0.0.0/8, `[::1]`): plain http to another host would
 *    carry memory content, and any key, in clear text. The user config schema
 *    rejects any other URL when the config is loaded; as a last line,
 *    {@link resolveMemoryLlm} refuses to hand the memory server a key for such
 *    a URL. (The Anthropic route is the endpoint the user configured for
 *    Anthropic itself, which already carries that key; it is not re-judged.)
 *
 * The Anthropic route is also the default memory endpoint when
 * `memory.llmBaseUrl` is unset. No key is ever sent outside the route it
 * belongs to.
 */

import { classifyHostLiteral } from '../net/address-policy.js';

/** Anthropic's OpenAI-compatible endpoint: the memory LLM route when no Anthropic base URL is configured. */
export const ANTHROPIC_OPENAI_COMPAT_URL = 'https://api.anthropic.com/v1/';

/** Inputs that decide the memory server's LLM endpoint and key. */
export interface MemoryLlmInputs {
  /** `memory.llmBaseUrl`. */
  readonly llmBaseUrl?: string;
  /** `memory.llmApiKey`. */
  readonly llmApiKey?: string;
  /** The resolved Anthropic API key (ANTHROPIC_API_KEY or `anthropicApiKey`). */
  readonly anthropicApiKey?: string;
  /** The resolved Anthropic API root (ANTHROPIC_BASE_URL or `anthropicBaseUrl`); empty or absent for Anthropic itself. */
  readonly anthropicBaseUrl?: string;
}

/** The memory server's LLM: where it talks to, and the key it sends there (if any). */
export interface MemoryLlmEndpoint {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  /**
   * True when an Anthropic API key was available but `baseUrl` is not the
   * Anthropic route, so the key was not handed to the memory server.
   */
  readonly anthropicKeyWithheld: boolean;
}

/** True for `localhost` and for IP literals in 127.0.0.0/8 or `::1` (as a WHATWG URL hostname spells them). */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname.toLowerCase() === 'localhost') return true;
  const literal = classifyHostLiteral(hostname);
  if (literal.kind !== 'ip') return false;
  return literal.family === 4 ? literal.address.startsWith('127.') : literal.address === '::1';
}

/**
 * Why `url` cannot be the memory LLM base URL, or undefined when it can: it
 * must parse, and use https, or http to this machine only.
 */
export function memoryLlmBaseUrlProblem(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'must be a valid URL';
  }
  if (parsed.protocol === 'https:') return undefined;
  if (parsed.protocol === 'http:') {
    if (isLoopbackHostname(parsed.hostname)) return undefined;
    return (
      'must use https:// unless it points at this machine (localhost, 127.0.0.0/8 or [::1]); ' +
      'plain http to another host would carry memory content and any API key in clear text'
    );
  }
  return 'must be an https:// URL (or an http:// URL on this machine)';
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * The memory LLM URL on the Anthropic route: Anthropic's OpenAI-compatible
 * endpoint, or the `/v1/` endpoint under the configured Anthropic API root (the
 * root is given as Claude Code and the MITM proxy use it; an explicit `/v1`
 * root is kept, as for the AI SDK in `model-provider.ts`).
 */
function anthropicRouteUrl(anthropicBaseUrl: string | undefined): string {
  if (anthropicBaseUrl === undefined) return ANTHROPIC_OPENAI_COMPAT_URL;
  const root = anthropicBaseUrl.replace(/\/+$/, '');
  return root.endsWith('/v1') ? `${root}/` : `${root}/v1/`;
}

/**
 * Decides the memory server's LLM endpoint and key (see the module comment).
 * Throws when `llmBaseUrl` is not a URL, or when a key would be sent to it in
 * clear text (plain http to another machine); the user config schema rejects
 * such a URL first.
 */
export function resolveMemoryLlm(inputs: MemoryLlmInputs): MemoryLlmEndpoint {
  const endpoint = chooseMemoryLlm(inputs);
  if (endpoint.apiKey !== undefined && inputs.llmBaseUrl !== undefined) {
    const problem = memoryLlmBaseUrlProblem(inputs.llmBaseUrl);
    if (problem !== undefined) {
      throw new Error(`Refusing to send the memory LLM API key to memory.llmBaseUrl: it ${problem}`);
    }
  }
  return endpoint;
}

function chooseMemoryLlm(inputs: MemoryLlmInputs): MemoryLlmEndpoint {
  const { llmBaseUrl, llmApiKey, anthropicApiKey } = inputs;
  if (llmBaseUrl !== undefined && originOf(llmBaseUrl) === undefined) {
    throw new Error('memory.llmBaseUrl must be a valid URL');
  }
  const anthropicBaseUrl = inputs.anthropicBaseUrl === '' ? undefined : inputs.anthropicBaseUrl;
  const anthropicRoute = anthropicRouteUrl(anthropicBaseUrl);

  if (llmApiKey) {
    return { apiKey: llmApiKey, baseUrl: llmBaseUrl ?? anthropicRoute, anthropicKeyWithheld: false };
  }
  if (!anthropicApiKey) {
    return { baseUrl: llmBaseUrl, anthropicKeyWithheld: false };
  }

  const baseUrl = llmBaseUrl ?? anthropicRoute;
  const origin = originOf(baseUrl);
  // A URL with a non-special scheme has the opaque origin "null", which matches nothing.
  if (origin !== undefined && origin !== 'null' && origin === originOf(anthropicRoute)) {
    return { apiKey: anthropicApiKey, baseUrl, anthropicKeyWithheld: false };
  }
  return { baseUrl, anthropicKeyWithheld: true };
}
