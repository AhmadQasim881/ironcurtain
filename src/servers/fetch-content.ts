/**
 * Response-body classification and charset-aware decoding for the fetch MCP
 * server.
 *
 * - The `Content-Type` essence decides what a body is: HTML (`text/html` and
 *   XHTML, which the server converts to markdown or text), other text, binary
 *   (returned as metadata only, never as decoded garbage), or unknown
 *   (missing or `application/octet-stream`; sniffed from its first bytes).
 * - Text is decoded with the encoding the WHATWG order picks: a byte order
 *   mark, then the `charset` parameter, then the document's own declaration
 *   (`<meta charset>` / `http-equiv` for HTML, the XML declaration for XML),
 *   then UTF-8. Labels go through `TextDecoder`, so `iso-8859-1` decodes as
 *   windows-1252 exactly as browsers do, and an unknown label falls back
 *   instead of throwing.
 *
 * Pure functions over bytes; no I/O.
 */

/** A parsed `Content-Type` header. */
export interface ParsedContentType {
  /** Lowercased `type/subtype`, or `''` when the header is missing or malformed. */
  readonly essence: string;
  /** The `charset` parameter (unquoted, trimmed), when present. */
  readonly charset: string | undefined;
}

/** How the fetch server treats a response body. */
export type ContentKind = 'html' | 'text' | 'binary' | 'unknown';

/** RFC 7230 token characters, lowercased. */
const MIME_ESSENCE_RE = /^[!#$%&'*+.^`|~0-9a-z-]+\/[!#$%&'*+.^`|~0-9a-z-]+$/u;

const HTML_TYPES: ReadonlySet<string> = new Set(['text/html', 'application/xhtml+xml']);

/** Declared types that say nothing about the bytes; sniffed instead. */
const UNKNOWN_TYPES: ReadonlySet<string> = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/unknown',
  'application/x-unknown',
  'unknown/unknown',
]);

/** Textual `application/*` types (besides every `+json` / `+xml` suffix). */
const TEXTUAL_APPLICATION_TYPES: ReadonlySet<string> = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/ecmascript',
  'application/x-javascript',
  'application/x-www-form-urlencoded',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/x-toml',
  'application/sql',
  'application/graphql',
  'application/ndjson',
  'application/x-ndjson',
  'application/jsonl',
  'application/x-jsonlines',
  'application/csv',
  'application/x-csv',
  'application/rtf',
  'application/x-sh',
  'application/x-csh',
  'application/x-httpd-php',
  'application/x-tex',
  'application/x-latex',
]);

/** Bytes inspected when sniffing an undeclared type or a document's own charset declaration. */
const SNIFF_BYTES = 1024;

/** Parses a `Content-Type` header value. Never throws. */
export function parseContentType(header: string | null | undefined): ParsedContentType {
  if (!header) return { essence: '', charset: undefined };
  const [rawEssence, ...params] = header.split(';');
  const essence = rawEssence.trim().toLowerCase();
  let charset: string | undefined;
  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq === -1 || param.slice(0, eq).trim().toLowerCase() !== 'charset') continue;
    let value = param.slice(eq + 1).trim();
    if (value.startsWith('"')) {
      const close = value.indexOf('"', 1);
      value = value.slice(1, close === -1 ? undefined : close).trim();
    }
    if (value !== '') {
      charset = value;
      break;
    }
  }
  return { essence: MIME_ESSENCE_RE.test(essence) ? essence : '', charset };
}

/** Classifies a body by its `Content-Type` essence (see {@link ParsedContentType.essence}). */
export function classifyContentType(essence: string): ContentKind {
  if (HTML_TYPES.has(essence)) return 'html';
  if (UNKNOWN_TYPES.has(essence)) return 'unknown';
  if (
    essence.startsWith('text/') ||
    essence.endsWith('+json') ||
    essence.endsWith('+xml') ||
    TEXTUAL_APPLICATION_TYPES.has(essence)
  ) {
    return 'text';
  }
  return 'binary';
}

/**
 * Sniffs a body of unknown type: binary when it starts like a PDF or when its
 * first bytes contain a byte that never occurs in text (the WHATWG MIME
 * sniffing "binary data byte" set: 0x00-0x08, 0x0B, 0x0E-0x1A, 0x1C-0x1F).
 * A byte order mark means text.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  if (bomEncoding(bytes) !== undefined) return false;
  if (startsWithAscii(bytes, '%PDF-')) return true;
  const end = Math.min(bytes.byteLength, SNIFF_BYTES);
  for (let index = 0; index < end; index += 1) {
    const byte = bytes[index];
    if (byte <= 0x08 || byte === 0x0b || (byte >= 0x0e && byte <= 0x1a) || (byte >= 0x1c && byte <= 0x1f)) return true;
  }
  return false;
}

/**
 * Picks the encoding for a text body: byte order mark, then the
 * `Content-Type` charset, then (XML types) the XML declaration and (HTML)
 * the `<meta>` declaration, then UTF-8. Returns a WHATWG encoding name that
 * `TextDecoder` accepts.
 */
export function detectTextEncoding(bytes: Uint8Array, contentType: ParsedContentType): string {
  const isXml = isXmlEssence(contentType.essence);
  const isHtml = HTML_TYPES.has(contentType.essence);
  return (
    bomEncoding(bytes) ??
    resolveEncodingLabel(contentType.charset) ??
    (isXml ? xmlDeclarationEncoding(bytes) : undefined) ??
    (isHtml ? metaCharsetEncoding(bytes) : undefined) ??
    'utf-8'
  );
}

/** Decodes a text body with {@link detectTextEncoding}; invalid sequences become U+FFFD. */
export function decodeTextBody(bytes: Uint8Array, contentType: ParsedContentType): string {
  return new TextDecoder(detectTextEncoding(bytes, contentType)).decode(bytes);
}

// ── Helpers ────────────────────────────────────────────────────────────

function isXmlEssence(essence: string): boolean {
  return essence === 'application/xml' || essence === 'text/xml' || essence.endsWith('+xml');
}

function startsWithAscii(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.byteLength < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix.charCodeAt(index)) return false;
  }
  return true;
}

function bomEncoding(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  return undefined;
}

/** The WHATWG encoding a label names, or undefined for an unknown or unusable label. */
function resolveEncodingLabel(label: string | undefined): string | undefined {
  if (label === undefined || label.trim() === '') return undefined;
  try {
    return new TextDecoder(label.trim()).encoding;
  } catch {
    return undefined;
  }
}

/**
 * An encoding found inside the document: it was read as ASCII, so a UTF-16
 * claim is wrong and means UTF-8, and x-user-defined means windows-1252
 * (HTML encoding sniffing rules).
 */
function resolveDeclaredEncoding(label: string | undefined): string | undefined {
  const encoding = resolveEncodingLabel(label);
  if (encoding === 'utf-16le' || encoding === 'utf-16be') return 'utf-8';
  if (encoding === 'x-user-defined') return 'windows-1252';
  return encoding;
}

/** A capture group that may not have taken part in the match (TS types every group as `string`). */
function optionalGroup(match: RegExpMatchArray, index: number): string | undefined {
  return match[index];
}

function asciiHead(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, SNIFF_BYTES)).toString('latin1');
}

/** `<?xml version="1.0" encoding="..."?>` at the very start of the body. */
function xmlDeclarationEncoding(bytes: Uint8Array): string | undefined {
  const match = /^<\?xml\s[^>]*?\bencoding\s*=\s*(["'])([A-Za-z][A-Za-z0-9._-]*)\1/u.exec(asciiHead(bytes));
  return resolveDeclaredEncoding(match?.[2]);
}

const META_TAG_RE = /<meta\b([^>]*)>/giu;
const ATTRIBUTE_RE = /([^\s"'=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gu;
const CONTENT_CHARSET_RE = /charset\s*=\s*["']?\s*([^\s"';]+)/iu;

/**
 * The first `<meta charset>` or `<meta http-equiv="content-type"
 * content="...; charset=...">` in the first {@link SNIFF_BYTES} bytes (a
 * simplified HTML prescan: comments are skipped and attributes are parsed, so
 * a `charset=` inside an unrelated attribute value does not count).
 */
function metaCharsetEncoding(bytes: Uint8Array): string | undefined {
  const head = asciiHead(bytes).replace(/<!--[\s\S]*?(?:-->|$)/gu, '');
  for (const tag of head.matchAll(META_TAG_RE)) {
    const attributes = new Map<string, string>();
    for (const attribute of tag[1].matchAll(ATTRIBUTE_RE)) {
      const name = attribute[1].toLowerCase();
      const value = optionalGroup(attribute, 2) ?? optionalGroup(attribute, 3) ?? optionalGroup(attribute, 4) ?? '';
      if (!attributes.has(name)) attributes.set(name, value);
    }
    const charset = attributes.get('charset');
    if (charset !== undefined) {
      const encoding = resolveDeclaredEncoding(charset);
      if (encoding !== undefined) return encoding;
      continue;
    }
    if (attributes.get('http-equiv')?.toLowerCase() === 'content-type') {
      const encoding = resolveDeclaredEncoding(CONTENT_CHARSET_RE.exec(attributes.get('content') ?? '')?.[1]);
      if (encoding !== undefined) return encoding;
    }
  }
  return undefined;
}
