/**
 * The macOS Seatbelt profile srt would apply for a written srt settings
 * file, and last-match-wins evaluation of its file rules, so macOS read and
 * write containment can be checked on any runner.
 */

import { readFileSync } from 'node:fs';
import { parse as parseShell } from 'shell-quote';
// srt's own Seatbelt profile generator. Internal to sandbox-runtime, but it is
// the only way to check the macOS rules on a Linux runner; a package upgrade
// that moves it fails this import loudly rather than skipping.
import { wrapCommandWithSandboxMacOS } from '@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js';

/** The Seatbelt profile srt would apply on macOS for a written settings file. */
export function macosProfileFor(settingsPath: string): string {
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
    filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[]; denyWrite: string[] };
  };
  const wrapped = wrapCommandWithSandboxMacOS({
    command: 'true',
    needsNetworkRestriction: false,
    readConfig: { denyOnly: settings.filesystem.denyRead, allowWithinDeny: settings.filesystem.allowRead },
    writeConfig: { allowOnly: settings.filesystem.allowWrite, denyWithinAllow: settings.filesystem.denyWrite },
  });
  const argv = parseShell(wrapped);
  const profile = argv[argv.indexOf('-p') + 1];
  if (typeof profile !== 'string') throw new Error('no Seatbelt profile in the wrapped command');
  return profile;
}

/**
 * Last-match-wins evaluation of the `file-read*` rules in an srt-generated
 * Seatbelt profile, which is how macOS applies them. Supports the filter
 * shapes srt emits for literal and simple glob entries; anything else fails
 * the test rather than being guessed at.
 */
export function seatbeltReadDecision(profile: string, path: string): 'allow' | 'deny' {
  const section = profile.slice(profile.indexOf('; File read'), profile.indexOf('; File write'));
  return seatbeltDecision(section, 'file-read\\*', path);
}

/**
 * Last-match-wins evaluation of the `file-write*` rules in the profile's
 * write section (the default is deny). The move-blocking
 * `file-write-unlink`/`file-write-create` rules are not evaluated.
 */
export function seatbeltWriteDecision(profile: string, path: string): 'allow' | 'deny' {
  const start = profile.indexOf('; File write');
  const next = profile.indexOf('\n; ', start + 1);
  const section = profile.slice(start, next === -1 ? undefined : next);
  return seatbeltDecision(section, 'file-write\\*', path);
}

function seatbeltDecision(section: string, operation: string, path: string): 'allow' | 'deny' {
  let decision: 'allow' | 'deny' = 'deny';
  const headPattern = new RegExp(`^\\((allow|deny) ${operation}(\\)?)`);
  for (const form of section.split(/\n(?=\()/)) {
    const head = headPattern.exec(form);
    if (!head) continue;
    const action = head[1] === 'allow' ? 'allow' : 'deny';
    if (head[2] === ')') {
      decision = action;
      continue;
    }
    if (/require-(all|any|not)/.test(form)) throw new Error(`unsupported Seatbelt filter: ${form}`);
    const filters = [...form.matchAll(/\((subpath|literal|regex) ("(?:[^"\\]|\\.)*")\)/g)];
    const matches = filters.some(([, kind, quoted]) => {
      const value = JSON.parse(quoted) as string;
      if (kind === 'literal') return path === value;
      if (kind === 'subpath') return path === value || path.startsWith(value + '/');
      return new RegExp(value).test(path);
    });
    if (matches) decision = action;
  }
  return decision;
}
