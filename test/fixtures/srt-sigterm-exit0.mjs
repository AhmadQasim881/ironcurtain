#!/usr/bin/env node
/**
 * Stands in for srt's signal handling (sandbox-runtime `dist/cli.js`) in the
 * smoke-run tests: it runs a command that never finishes, forwards SIGTERM to
 * it, and exits 0 when that command ends by SIGTERM, as srt does. Once its
 * handler is installed and the command is running it writes `ready` to the
 * file named by its first argument.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const command = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
process.on('SIGTERM', () => command.kill('SIGTERM'));
command.on('exit', (code, signal) => {
  process.exit(signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : (code ?? 0));
});
command.on('spawn', () => {
  if (process.argv[2]) writeFileSync(process.argv[2], 'ready');
});
