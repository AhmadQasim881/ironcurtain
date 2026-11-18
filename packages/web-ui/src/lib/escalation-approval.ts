import type { EscalationDto } from './types.js';

/**
 * Whether an escalation names what approving it would allow: its server, its
 * tool and an arguments object. One that does not (a record that lost its
 * details) can only be denied: Approve would approve an unknown call. The
 * daemon refuses such an approval too; this keeps the UI from offering it.
 */
export function isApprovableEscalation(
  escalation: Pick<EscalationDto, 'serverName' | 'toolName' | 'arguments' | 'reviewUnavailable'>,
): boolean {
  const args: unknown = escalation.arguments;
  return (
    escalation.reviewUnavailable !== true &&
    typeof escalation.serverName === 'string' &&
    escalation.serverName !== '' &&
    typeof escalation.toolName === 'string' &&
    escalation.toolName !== '' &&
    typeof args === 'object' &&
    args !== null &&
    !Array.isArray(args)
  );
}

/** Shown on a disabled Approve button and in the card's notice. */
export const NOT_APPROVABLE_REASON = 'This request cannot be reviewed completely here, so it can only be denied.';
