/** Host-side work bound, independent of the container's command deadline. */
export const MAX_AGENT_RESPONSE_OUTPUT_BYTES = 4 * 1024 * 1024;

export class AgentResponseOutputLimitError extends Error {
  readonly code = 'AGENT_RESPONSE_OUTPUT_LIMIT';

  constructor(limit: number) {
    super(
      `Agent response output exceeds ${limit} bytes; the response was not parsed. Use PTY mode for streaming output.`,
    );
    this.name = 'AgentResponseOutputLimitError';
  }
}

/**
 * Bound stdout and stderr together before an adapter parses either stream.
 * Oversized ASCII/code-unit counts fail in constant time; the UTF-8 check
 * scans at most the accepted code-unit budget. Never parse a truncated JSON
 * envelope or classify this failure as an empty-output retry.
 */
export function assertAgentResponseOutputBound(
  stdout: string,
  stderr = '',
  maxBytes = MAX_AGENT_RESPONSE_OUTPUT_BYTES,
): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('Invalid agent output byte limit');
  if (
    stdout.length + stderr.length > maxBytes ||
    Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') > maxBytes
  ) {
    throw new AgentResponseOutputLimitError(maxBytes);
  }
}
