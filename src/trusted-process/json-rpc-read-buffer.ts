import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from '@modelcontextprotocol/sdk/shared/stdio.js';

/**
 * Bounded newline framing with linear copying and scanning. Fixed-size pages
 * also bound metadata when a peer delivers a line one byte at a time. Bytes
 * enter a page once, are searched once, and are copied out once per line.
 */
export class JsonRpcReadBuffer {
  private pages: Buffer[] = [];
  private head = 0;
  private headOffset = 0;
  private scan = 0;
  private scanOffset = 0;
  private tailOffset = 0;
  private length = 0;

  constructor(
    private readonly maxBufferSize = STDIO_DEFAULT_MAX_BUFFER_SIZE,
    private readonly pageSize = 64 * 1024,
  ) {
    for (const limit of [maxBufferSize, pageSize]) {
      if (!Number.isSafeInteger(limit) || limit <= 0)
        throw new Error('Read buffer limits must be a positive safe integer');
    }
  }

  get byteLength(): number {
    return this.length;
  }

  append(chunk: Buffer): void {
    if (chunk.length > this.maxBufferSize - this.length) {
      this.clear();
      throw new Error(`ReadBuffer exceeded maximum size of ${this.maxBufferSize} bytes`);
    }
    let offset = 0;
    while (offset < chunk.length) {
      let tail = this.pages.at(-1);
      if (!tail || this.tailOffset === tail.length) {
        tail = Buffer.allocUnsafe(Math.min(this.pageSize, this.maxBufferSize));
        this.pages.push(tail);
        this.tailOffset = 0;
      }
      const count = Math.min(chunk.length - offset, tail.length - this.tailOffset);
      chunk.copy(tail, this.tailOffset, offset, offset + count);
      this.tailOffset += count;
      offset += count;
    }
    this.length += chunk.length;
  }

  /** Consumes a complete line before its caller parses it, including invalid JSON. */
  readLine(): string | null {
    while (this.scan < this.pages.length) {
      const page = this.pages[this.scan];
      const end = this.scan === this.pages.length - 1 ? this.tailOffset : page.length;
      const newline = page.subarray(0, end).indexOf(10, this.scanOffset);
      if (newline !== -1) {
        const parts: Buffer[] = [];
        let lineLength = 0;
        for (let index = this.head; index <= this.scan; index++) {
          const part = this.pages[index].subarray(
            index === this.head ? this.headOffset : 0,
            index === this.scan ? newline : undefined,
          );
          parts.push(part);
          lineLength += part.length;
        }
        const line = (parts.length === 1 ? parts[0] : Buffer.concat(parts, lineLength)).toString('utf8');
        this.length -= lineLength + 1;
        this.head = this.scan;
        this.headOffset = newline + 1;
        this.scanOffset = this.headOffset;
        if (this.headOffset === end) {
          this.head++;
          this.scan++;
          this.headOffset = this.scanOffset = 0;
        }
        this.compact();
        return line.endsWith('\r') ? line.slice(0, -1) : line;
      }
      this.scanOffset = end;
      // The last page can be extended by append(); revisit only its new bytes.
      if (this.scan === this.pages.length - 1) return null;
      this.scan++;
      this.scanOffset = 0;
    }
    return null;
  }

  private compact(): void {
    if (this.length === 0) {
      this.clear();
    } else if (this.head > 0 && this.head >= this.pages.length / 2) {
      this.pages = this.pages.slice(this.head);
      this.scan -= this.head;
      this.head = 0;
    }
  }

  private clear(): void {
    this.pages = [];
    this.head = this.scan = this.headOffset = this.scanOffset = this.tailOffset = this.length = 0;
  }
}
