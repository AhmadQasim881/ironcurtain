/**
 * PTY terminal subscription JSON-RPC dispatch.
 *
 * Handles the per-client PTY methods:
 *   - sessions.ptyAttach   (subscribe + one-shot replay snapshot)
 *   - sessions.ptyDetach   (unsubscribe)
 *   - sessions.ptyInput    (forward base64 keystroke bytes to the child stdin)
 *   - sessions.ptyResize   (resize the child PTY, within fixed bounds)
 *   - sessions.ptyPrompt   (inject a TRUSTED user message)
 *
 * All delegate to `ctx.ptySessionManager`. Mirrors token-stream-dispatch.ts:
 * every method is keyed to the calling WebSocket, so the client is required.
 * The manager uses the client identity to treat input/prompt/resize from a
 * client that is not attached as activity (it restarts the idle-TTL countdown).
 */

import { z } from 'zod';
import type { WebSocket as WsWebSocket } from 'ws';

import { type DispatchContext, validateParams, labelSchema } from './types.js';
import { MethodNotFoundError, RpcError } from '../web-ui-types.js';
import { PTY_MAX_COLS, PTY_MAX_ROWS, PTY_MIN_COLS, PTY_MIN_ROWS } from '../../pty/pty-size.js';

// ---------------------------------------------------------------------------
// Param validation schemas
// ---------------------------------------------------------------------------

const ptyInputSchema = z.object({ label: z.number().int().positive(), data: z.string() });
// Bounded: a single oversized frame would make the daemon's headless xterm
// allocate gigabytes (see src/pty/pty-size.ts). PtyBridge.resize clamps again.
const ptyResizeSchema = z.object({
  label: z.number().int().positive(),
  cols: z.number().int().min(PTY_MIN_COLS).max(PTY_MAX_COLS),
  rows: z.number().int().min(PTY_MIN_ROWS).max(PTY_MAX_ROWS),
});
// A trusted user message (not raw keystrokes): the daemon writes user-context
// (source 'mux-trusted-input') and injects the text into the PTY.
const ptyPromptSchema = z.object({ label: z.number().int().positive(), text: z.string().min(1) });

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function ptyDispatch(
  ctx: DispatchContext,
  method: string,
  params: Record<string, unknown>,
  client: WsWebSocket,
): unknown {
  const manager = ctx.ptySessionManager;
  if (!manager) {
    throw new RpcError('INTERNAL_ERROR', 'PTY session manager not available');
  }

  switch (method) {
    case 'sessions.ptyAttach': {
      const { label } = validateParams(labelSchema, params);
      manager.attach(label, client);
      return { attached: true };
    }

    case 'sessions.ptyDetach': {
      const { label } = validateParams(labelSchema, params);
      manager.detach(label, client);
      return { detached: true };
    }

    case 'sessions.ptyInput': {
      const { label, data } = validateParams(ptyInputSchema, params);
      manager.input(label, data, client);
      return { accepted: true };
    }

    case 'sessions.ptyResize': {
      const { label, cols, rows } = validateParams(ptyResizeSchema, params);
      manager.resize(label, cols, rows, client);
      return { resized: true };
    }

    case 'sessions.ptyPrompt': {
      const { label, text } = validateParams(ptyPromptSchema, params);
      manager.sendPrompt(label, text, client);
      return { accepted: true };
    }

    default:
      throw new MethodNotFoundError(method);
  }
}
