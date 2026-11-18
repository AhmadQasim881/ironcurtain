import { describe, it, expect } from 'vitest';
import {
  classifyContentType,
  decodeTextBody,
  detectTextEncoding,
  looksBinary,
  parseContentType,
} from '../src/servers/fetch-content.js';

const latin1 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'latin1'));
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('parseContentType', () => {
  it.each([
    [undefined, '', undefined],
    [null, '', undefined],
    ['', '', undefined],
    ['text/html', 'text/html', undefined],
    ['Text/HTML; Charset=ISO-8859-1', 'text/html', 'ISO-8859-1'],
    ['text/plain; format=flowed; charset="windows-1252"', 'text/plain', 'windows-1252'],
    ['text/plain; charset=""; charset=utf-8', 'text/plain', 'utf-8'],
    ['application/json;charset=utf-8', 'application/json', 'utf-8'],
    ['not a mime type', '', undefined],
    ['text/html, text/plain', '', undefined],
  ])('parses %j', (header, essence, charset) => {
    expect(parseContentType(header)).toEqual({ essence, charset });
  });
});

describe('classifyContentType', () => {
  it.each([
    ['text/html', 'html'],
    ['application/xhtml+xml', 'html'],
    ['text/plain', 'text'],
    ['text/csv', 'text'],
    ['application/json', 'text'],
    ['application/ld+json', 'text'],
    ['application/rss+xml', 'text'],
    ['image/svg+xml', 'text'],
    ['application/javascript', 'text'],
    ['image/png', 'binary'],
    ['application/pdf', 'binary'],
    ['application/zip', 'binary'],
    ['video/mp4', 'binary'],
    ['font/woff2', 'binary'],
    ['application/vnd.ms-excel', 'binary'],
    ['', 'unknown'],
    ['application/octet-stream', 'unknown'],
  ])('%s is %s', (essence, kind) => {
    expect(classifyContentType(essence)).toBe(kind);
  });
});

describe('looksBinary', () => {
  it('flags bytes that never occur in text', () => {
    expect(looksBinary(new Uint8Array([0x48, 0x00, 0x49]))).toBe(true);
    expect(looksBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  });

  it('flags a PDF even though its header is printable', () => {
    expect(looksBinary(utf8('%PDF-1.7\n%âãÏÓ\n1 0 obj'))).toBe(true);
  });

  it('accepts text, including tabs, newlines, form feeds, escapes and high bytes', () => {
    expect(looksBinary(utf8('plain text\twith\r\nwhitespace\f and \u001b[0m'))).toBe(false);
    expect(looksBinary(latin1('Café crème'))).toBe(false);
    expect(looksBinary(new Uint8Array(0))).toBe(false);
  });

  it('treats a UTF-16 byte order mark as text', () => {
    expect(looksBinary(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toBe(false);
  });
});

describe('detectTextEncoding', () => {
  const html = parseContentType('text/html');

  it('prefers a byte order mark over every declaration', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('<meta charset="iso-8859-1">')]);
    expect(detectTextEncoding(bytes, parseContentType('text/html; charset=shift_jis'))).toBe('utf-8');
    expect(detectTextEncoding(new Uint8Array([0xfe, 0xff, 0x00, 0x41]), html)).toBe('utf-16be');
  });

  it('uses the Content-Type charset over the document declaration', () => {
    const bytes = utf8('<meta charset="shift_jis">');
    expect(detectTextEncoding(bytes, parseContentType('text/html; charset=iso-8859-1'))).toBe('windows-1252');
  });

  it('falls back from an unknown charset label instead of throwing', () => {
    expect(detectTextEncoding(utf8('x'), parseContentType('text/plain; charset=not-a-charset'))).toBe('utf-8');
    expect(detectTextEncoding(utf8('x'), parseContentType('text/plain; charset=iso-2022-kr'))).toBe('utf-8');
  });

  it('reads <meta charset> and the http-equiv form for HTML', () => {
    expect(detectTextEncoding(utf8('<html><head><meta charset=koi8-r>'), html)).toBe('koi8-r');
    expect(
      detectTextEncoding(
        utf8('<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS"><title>x</title>'),
        html,
      ),
    ).toBe('shift_jis');
  });

  it('ignores a charset= inside an unrelated attribute or a comment', () => {
    expect(detectTextEncoding(utf8('<meta name="description" content="set charset=koi8-r here">'), html)).toBe('utf-8');
    expect(detectTextEncoding(utf8('<!-- <meta charset="koi8-r"> --><p>x</p>'), html)).toBe('utf-8');
  });

  it('reads a declared UTF-16 as UTF-8, since the declaration was readable as ASCII', () => {
    expect(detectTextEncoding(utf8('<meta charset="utf-16">'), html)).toBe('utf-8');
  });

  it('does not look for <meta> in non-HTML text', () => {
    expect(detectTextEncoding(utf8('<meta charset="koi8-r">'), parseContentType('text/plain'))).toBe('utf-8');
  });

  it('reads the XML declaration for XML and XHTML', () => {
    const declared = utf8('<?xml version="1.0" encoding="ISO-8859-1"?><root/>');
    expect(detectTextEncoding(declared, parseContentType('application/xml'))).toBe('windows-1252');
    expect(detectTextEncoding(declared, parseContentType('application/xhtml+xml'))).toBe('windows-1252');
    expect(detectTextEncoding(declared, parseContentType('application/atom+xml'))).toBe('windows-1252');
  });
});

describe('decodeTextBody', () => {
  it('decodes ISO-8859-1 by the Content-Type charset', () => {
    expect(decodeTextBody(latin1('Café crème brûlée'), parseContentType('text/plain; charset=ISO-8859-1'))).toBe(
      'Café crème brûlée',
    );
  });

  it('decodes windows-1252 punctuation that ISO-8859-1 labels also select', () => {
    const smartQuotes = new Uint8Array([0x93, 0x68, 0x69, 0x94, 0x20, 0x96, 0x20, 0x80]);
    expect(decodeTextBody(smartQuotes, parseContentType('text/plain; charset=latin1'))).toBe('“hi” – €');
  });

  it('decodes Shift_JIS declared by <meta>', () => {
    // "日本語" in Shift_JIS.
    const body = new Uint8Array([...utf8('<meta charset="shift_jis"><p>'), 0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);
    expect(decodeTextBody(body, parseContentType('text/html'))).toContain('日本語');
  });

  it('decodes UTF-16LE with a byte order mark and drops the mark', () => {
    const body = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
    expect(decodeTextBody(body, parseContentType('text/plain'))).toBe('hi');
  });

  it('defaults to UTF-8 and replaces invalid sequences instead of throwing', () => {
    expect(decodeTextBody(utf8('naïve'), parseContentType(''))).toBe('naïve');
    expect(decodeTextBody(new Uint8Array([0x61, 0xff, 0x62]), parseContentType('text/plain'))).toBe('a�b');
  });
});
