/**
 * Rotation settings of the long-lived process logs (the daemon's and the
 * Signal bot's `logs/<name>.log`), from `retention.logs` in config.json.
 * Session logs are not rotated: they go with their session directory.
 */

import { RETENTION_CONFIG_DEFAULTS, type ResolvedRetentionConfig } from '../config/user-config.js';
import type { LogRotationOptions } from '../logger.js';

/** The logger rotation for a process log, or undefined when `retention.logs.maxBytes` is null. */
export function processLogRotation(retention: ResolvedRetentionConfig | undefined): LogRotationOptions | undefined {
  const logs = (retention ?? RETENTION_CONFIG_DEFAULTS).logs;
  return logs.maxBytes === null ? undefined : { maxBytes: logs.maxBytes, maxFiles: logs.maxFiles };
}
