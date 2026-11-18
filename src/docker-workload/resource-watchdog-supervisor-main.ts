/**
 * Minimal detached-process entrypoint for the resource watchdog supervisor.
 *
 * The launcher points stderr at an owner-only log in the lease directory.
 * Every fatal error is reported there as one bounded line (an error message
 * can embed a whole runtime argv), so the log stays small and its tail is
 * enough to explain a failed startup.
 */

import { boundIncidentDetail } from './incident-detail.js';
import {
  runResourceWatchdogSupervisor,
  type RunResourceWatchdogSupervisorOptions,
} from './resource-watchdog-supervisor.js';

/** Largest fatal record written to the stderr log. */
const MAX_FATAL_RECORD_CODE_POINTS = 4096;

function reportFatal(error: unknown): void {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(
    `resource-watchdog-supervisor: fatal: ${boundIncidentDetail(text, MAX_FATAL_RECORD_CODE_POINTS)}\n`,
  );
}

process.on('uncaughtException', (error) => {
  reportFatal(error);
  process.exit(1);
});

function parseArguments(argv: readonly string[]): RunResourceWatchdogSupervisorOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv.at(index);
    const value = argv.at(index + 1);
    if (name === undefined || value === undefined || !name.startsWith('--') || values.has(name)) {
      throw new Error('invalid resource-watchdog-supervisor arguments');
    }
    values.set(name, value);
  }
  const expected = ['--lease', '--policy', '--status', '--stop-request'];
  if (values.size !== expected.length || expected.some((name) => !values.has(name))) {
    throw new Error('resource-watchdog-supervisor requires lease, policy, status, and stop-request paths');
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined) throw new Error(`missing resource-watchdog-supervisor argument: ${name}`);
    return value;
  };
  return {
    leasePath: required('--lease'),
    policyPath: required('--policy'),
    statusPath: required('--status'),
    stopRequestPath: required('--stop-request'),
  };
}

try {
  await runResourceWatchdogSupervisor(parseArguments(process.argv.slice(2)));
} catch (error) {
  reportFatal(error);
  process.exitCode = 1;
}
