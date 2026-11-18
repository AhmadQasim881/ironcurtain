/**
 * Signal transport module public API.
 */

export { SignalBotDaemon } from './signal-bot-daemon.js';
export type {
  SignalBotDaemonOptions,
  SignalEnvelope,
  SignalTextMode,
  SendSignalMessageOptions,
  EscalationOrigin,
} from './signal-bot-daemon.js';
export { parseSignalEnvelope, isAuthorizedSender, normalizePhoneNumber } from './signal-bot-daemon.js';

export {
  EscalationCodes,
  parseEscalationReply,
  replySentAt,
  predatesEscalation,
  sentBefore,
  ESCALATION_CODE_ALPHABET,
  ESCALATION_CODE_LENGTH,
  REPLY_CLOCK_SKEW_MS,
} from './escalation-reply.js';
export type { EscalationReply, EscalationReplyVerb } from './escalation-reply.js';

export {
  selectRecipientIdentity,
  normalizeFingerprint,
  isOtherAccount,
  matchSenderAccount,
} from './recipient-identity.js';
export type { RecipientIdentity, SelectedIdentity, SenderAccountMatch } from './recipient-identity.js';

export {
  SIGNAL_DEFAULT_IMAGE,
  SIGNAL_IMAGE_REPOSITORY,
  SIGNAL_IMAGE_PINNED_DIGEST,
  SIGNAL_IMAGE_DIGEST_PLACEHOLDER,
  SignalImageError,
  hasSignalImageErrorCode,
  isSignalImageError,
  isDigestPinned,
  parseImageReference,
  pullSignalImageCandidate,
  discardSignalImageCandidate,
  tagNotRestoredMessage,
  resolveSignalImage,
} from './signal-image.js';
export type {
  ImageReference,
  ResolvedSignalImage,
  SignalImageCandidate,
  SignalImageErrorCode,
  SignalImageUpdateRuntime,
} from './signal-image.js';

export { SignalSessionTransport } from './signal-transport.js';

export { createSignalContainerManager } from './signal-container.js';
export type { SignalContainerConfig, SignalContainerManager } from './signal-container.js';

export { resolveSignalConfig, getSignalDataDir, SIGNAL_DEFAULTS } from './signal-config.js';
export type { SignalConfig, ResolvedSignalConfig } from './signal-config.js';

export { markdownToSignal } from './markdown-to-signal.js';

export {
  formatEscalationBanner,
  formatEscalationDetails,
  formatPendingEscalations,
  whitelistOffer,
  formatBudgetMessage,
  formatBudgetSummary,
  splitMessage,
  SIGNAL_MAX_MESSAGE_LENGTH,
} from './format.js';
export type {
  EscalationBanner,
  EscalationBannerOptions,
  EscalationDetailsOptions,
  PendingEscalationSummary,
} from './format.js';

export { runBot } from './bot-command.js';
export type { BotOptions } from './bot-command.js';

export { runSignalSetup, runUpdateImage } from './setup-signal.js';

export type { SignalBridgeClient } from './signal-bridge-client.js';
