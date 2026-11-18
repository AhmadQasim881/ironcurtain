/**
 * One write per frame for the mux renderer.
 *
 * terminal-kit sends every call (`term.moveTo`, `term.cyan(...)`,
 * `term.eraseLineAfter()`) straight to its output stream, so a redraw built
 * from hundreds of calls reaches the host terminal as hundreds of writes,
 * and the terminal can show any intermediate state: a dialog row blanked
 * before it is refilled, PTY rows painted before the overlay that covers
 * them. A frame collects everything written to the stream while it is being
 * drawn and sends it as a single write, wrapped in synchronized-output mode
 * (DEC private mode 2026), so a terminal that supports it presents the
 * frame at once and one that does not still receives it in one piece.
 * Terminals ignore private modes they do not know.
 *
 * `capture` collects a part of a frame separately so the renderer can
 * compare it with what it last sent for that region of the screen and skip
 * it when nothing changed (see mux-renderer.ts).
 *
 * The collection works by replacing the stream's `write` method for the
 * duration of the (synchronous) draw and restoring it in a `finally`, so
 * nothing outside a frame is affected. Writes made while no frame is open
 * go straight through.
 */

/** Begin synchronized update (DEC private mode 2026). */
export const SYNC_OUTPUT_BEGIN = '\u001b[?2026h';
/** End synchronized update: the terminal presents the frame. */
export const SYNC_OUTPUT_END = '\u001b[?2026l';

/** The part of a writable stream the frame writer uses. */
export interface FrameStream {
  write(chunk: string | Uint8Array, ...rest: unknown[]): boolean;
}

export interface FrameWriter {
  /**
   * Runs `draw` with everything written to the stream collected, then
   * writes it as one synchronized-output frame (nothing when nothing was
   * written). `epilogue` runs last inside the frame, and only when `draw`
   * wrote something (the renderer places the cursor there). A frame opened
   * inside another joins the outer one; its epilogue is not run.
   */
  frame(draw: () => void, epilogue?: () => void): void;
  /**
   * Runs `draw` with what it writes collected separately and returns it,
   * instead of adding it to the frame (or writing it).
   */
  capture(draw: () => void): string;
  /** Adds `text` to the open frame; with no frame open, writes it at once. */
  append(text: string): void;
}

function chunkText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return String(chunk);
}

/**
 * A frame writer for `stream`. Without a stream (a terminal object that has
 * none) every draw runs unbatched and `capture` returns an empty string.
 */
export function createFrameWriter(stream: FrameStream | undefined): FrameWriter {
  /** Collection buffers, innermost last; empty while no frame or capture is open. */
  const buffers: string[][] = [];
  let restore: (() => void) | undefined;

  function install(target: FrameStream): void {
    // The stream's own `write` (a test spy, a wrapper), if any; usually the
    // method comes from the prototype and the override is simply deleted.
    const ownWrite = Object.getOwnPropertyDescriptor(target, 'write');
    target.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      buffers[buffers.length - 1].push(chunkText(chunk));
      // A write callback still runs, asynchronously, as the stream would run it.
      const callback = rest.find((arg): arg is () => void => typeof arg === 'function');
      if (callback) queueMicrotask(callback);
      return true;
    };
    restore = (): void => {
      if (ownWrite) Object.defineProperty(target, 'write', ownWrite);
      else Reflect.deleteProperty(target, 'write');
    };
  }

  function collect(draw: () => void): string {
    if (!stream) {
      draw();
      return '';
    }
    const outermost = buffers.length === 0;
    if (outermost) install(stream);
    const buffer: string[] = [];
    buffers.push(buffer);
    try {
      draw();
    } finally {
      // Restore the stream even when the draw throws (its output is dropped).
      buffers.pop();
      if (outermost) {
        restore?.();
        restore = undefined;
      }
    }
    return buffer.join('');
  }

  return {
    frame(draw: () => void, epilogue?: () => void): void {
      if (!stream || buffers.length > 0) {
        draw();
        return;
      }
      const content = collect(() => {
        draw();
        if (epilogue && buffers[0].some((chunk) => chunk !== '')) epilogue();
      });
      if (content !== '') stream.write(SYNC_OUTPUT_BEGIN + content + SYNC_OUTPUT_END);
    },

    capture(draw: () => void): string {
      return collect(draw);
    },

    append(text: string): void {
      if (text === '') return;
      if (buffers.length > 0) buffers[buffers.length - 1].push(text);
      else stream?.write(text);
    },
  };
}
