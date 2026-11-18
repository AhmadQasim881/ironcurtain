import { toDisplayText } from '../terminal/display-sanitize.js';

/** Inert, single-line terminal text; persistent logs retain their own redaction. */
export function relayDiagnosticText(text: string): string {
  return toDisplayText(text, { maxLength: 4096 });
}

/** Keep a complete sample for redaction, dropping it whole if it exceeds the cap. */
export class StartupStderrCapture {
  private value = '';
  private active = true;
  private overflow = false;

  constructor(private readonly maxChars = 64 * 1024) {
    if (!Number.isSafeInteger(maxChars) || maxChars < 0) throw new RangeError('Invalid startup stderr limit');
  }

  append(text: string): void {
    if (!this.active) return;
    if (text.length > this.maxChars - this.value.length) {
      // Do not expose the prefix of a credential cut at this boundary.
      this.value = '';
      this.overflow = true;
      this.active = false;
    } else {
      this.value += text;
    }
  }

  finish(): string | undefined {
    const value = this.overflow ? undefined : this.value;
    this.active = false;
    this.value = '';
    return value;
  }
}
