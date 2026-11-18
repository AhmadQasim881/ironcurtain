/**
 * The Docker Desktop nested-daemon sidecar's seccomp profile against the
 * reviewed ceiling (config/docker-workload/profile-ceiling.json):
 *
 * - the rules tagged `IronCurtain P2:` are exactly the ceiling's additions,
 *   each an unconditional allow of one eligible, non-forbidden syscall;
 * - every other rule is Moby's reviewed default profile, unchanged: the
 *   canonical sha256 of the profile without the tagged rules is the ceiling's
 *   `source.canonicalSha256` (DWL-16). The sidecar lifecycle tests compare the
 *   effective profile with this same in-code definition, so a widened base
 *   allow list would pass them; it fails here;
 * - a forbidden syscall is allowed only by rules gated on capabilities the
 *   sidecar never holds. Moby's default keeps bpf and perf_event_open behind
 *   CAP_SYS_ADMIN, CAP_BPF and CAP_PERFMON; the sidecar drops every capability
 *   and adds only SETUID and SETGID.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getFrozenProfileCeilingPath } from '../../src/docker/docker-workload-paths.js';
import { DOCKER_DESKTOP_SIDECAR_CAP_ADD } from '../../src/docker-workload/docker-desktop-sidecar.js';
import { nestedDaemonSeccompProfile } from '../../src/docker-workload/nested-daemon-profile.js';

interface ProfileCeiling {
  schemaVersion: number;
  maximumArtifactsPerCategory: number;
  absoluteStops: readonly string[];
  categories: {
    idMap: { outerCapabilities: readonly string[] };
    seccomp: {
      eligibleGroups: Readonly<Record<string, readonly string[]>>;
      forbidden: readonly string[];
      source: { url: string; sha256: string; canonicalSha256: string };
      additions: readonly {
        syscall: string;
        arguments: string;
        group: string;
      }[];
    };
  };
}

interface SeccompFilter {
  caps?: string[];
  arches?: string[];
  minKernel?: string;
}

interface SeccompRule {
  names: string[];
  action: string;
  comment?: string;
  args?: unknown;
  includes?: SeccompFilter;
  excludes?: SeccompFilter;
  errnoRet?: unknown;
}

interface SeccompProfile {
  defaultAction: string;
  syscalls: SeccompRule[];
}

const P2_TAG = 'IronCurtain P2:';
/** Actions that refuse the call. Any other action (ALLOW, LOG, TRACE, NOTIFY, ...) can let it through. */
const DENY_ACTIONS = new Set([
  'SCMP_ACT_ERRNO',
  'SCMP_ACT_KILL',
  'SCMP_ACT_KILL_PROCESS',
  'SCMP_ACT_KILL_THREAD',
  'SCMP_ACT_TRAP',
]);

function loadCeiling(): ProfileCeiling {
  return JSON.parse(readFileSync(getFrozenProfileCeilingPath(), 'utf8')) as ProfileCeiling;
}

/** A mutable copy of the operational profile, which the negative cases widen. */
function currentProfile(): SeccompProfile {
  return structuredClone(nestedDaemonSeccompProfile()) as unknown as SeccompProfile;
}

function isTagged(rule: SeccompRule): boolean {
  return rule.comment?.startsWith(P2_TAG) === true;
}

/** The profile without its P2 additions: what was taken from the upstream profile. */
function baseProfile(profile: SeccompProfile): SeccompProfile {
  return { ...profile, syscalls: profile.syscalls.filter((rule) => !isTagged(rule)) };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Everything about `profile` beyond the reviewed ceiling, for a sidecar that
 * adds `capAdd` after dropping every capability. Empty when within it.
 */
function ceilingViolations(profile: SeccompProfile, ceiling: ProfileCeiling, capAdd: readonly string[]): string[] {
  const seccomp = ceiling.categories.seccomp;
  const violations: string[] = [];

  if (!DENY_ACTIONS.has(profile.defaultAction)) {
    violations.push(`default action ${profile.defaultAction} does not refuse unlisted syscalls`);
  }

  const canonical = sha256(JSON.stringify(baseProfile(profile)));
  if (canonical !== seccomp.source.canonicalSha256) {
    violations.push(
      `untagged rules (canonical sha256 ${canonical}) differ from the reviewed ${seccomp.source.url} (${seccomp.source.canonicalSha256})`,
    );
  }

  const declared = new Set<string>();
  for (const addition of seccomp.additions) {
    if (declared.has(addition.syscall)) violations.push(`ceiling declares ${addition.syscall} twice`);
    if (addition.arguments !== 'all') violations.push(`ceiling addition ${addition.syscall} restricts arguments`);
    if (!(seccomp.eligibleGroups[addition.group] ?? []).includes(addition.syscall)) {
      violations.push(`ceiling addition ${addition.syscall} is not eligible in group ${addition.group}`);
    }
    if (seccomp.forbidden.includes(addition.syscall))
      violations.push(`ceiling addition ${addition.syscall} is forbidden`);
    declared.add(addition.syscall);
  }
  const emitted = new Set<string>();
  for (const rule of profile.syscalls.filter(isTagged)) {
    const label = `P2 rule ${JSON.stringify(rule.names)}`;
    if (rule.action !== 'SCMP_ACT_ALLOW') violations.push(`${label}: action ${rule.action} is not SCMP_ACT_ALLOW`);
    if (rule.names.length !== 1) violations.push(`${label}: names ${rule.names.length} syscalls, not one`);
    for (const field of ['args', 'includes', 'excludes', 'errnoRet'] as const) {
      if (rule[field] !== undefined) violations.push(`${label}: has ${field}`);
    }
    for (const name of rule.names) {
      if (!declared.has(name)) violations.push(`${label}: ${name} is not a ceiling addition`);
      if (emitted.has(name)) violations.push(`${label}: ${name} is added twice`);
      emitted.add(name);
    }
  }
  for (const name of declared) {
    if (!emitted.has(name)) violations.push(`ceiling addition ${name} is missing from the profile`);
  }

  // A rule takes effect only when the container holds every capability in
  // includes.caps, so a forbidden syscall must sit behind capabilities the
  // sidecar never holds. Treat any rule without such a condition as active.
  const bounding = new Set(capAdd.map((capability) => `CAP_${capability}`));
  for (const rule of profile.syscalls) {
    if (DENY_ACTIONS.has(rule.action)) continue;
    const capabilities = rule.includes?.caps ?? [];
    for (const name of rule.names.filter((syscall) => seccomp.forbidden.includes(syscall))) {
      if (capabilities.length === 0) {
        violations.push(`forbidden syscall ${name} is allowed without a capability condition`);
      } else if (capabilities.some((capability) => bounding.has(capability))) {
        violations.push(`forbidden syscall ${name} is allowed on ${capabilities.join('+')}, which the sidecar adds`);
      }
    }
  }

  const outer = new Set(ceiling.categories.idMap.outerCapabilities);
  for (const capability of capAdd) {
    if (!outer.has(capability)) violations.push(`sidecar adds ${capability}, which the ceiling does not grant`);
    if (ceiling.absoluteStops.includes(capability)) violations.push(`sidecar adds ${capability}, an absolute stop`);
  }
  return violations;
}

/** The single-syscall rule allowing `name` behind exactly `capability`. */
function capabilityRule(profile: SeccompProfile, name: string, capability: string): SeccompRule {
  const rule = profile.syscalls.find(
    (candidate) =>
      candidate.names.length === 1 && candidate.names[0] === name && candidate.includes?.caps?.[0] === capability,
  );
  if (rule === undefined) throw new Error(`no ${name} rule behind ${capability}`);
  return rule;
}

describe('Docker Desktop profile ceiling', () => {
  const ceiling = loadCeiling();

  it('limits the sidecar to its reviewed seccomp and mount-mask additions', () => {
    const profile = currentProfile();

    expect(ceiling.schemaVersion).toBe(1);
    expect(ceiling.maximumArtifactsPerCategory).toBe(1);
    expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
    expect(ceilingViolations(profile, ceiling, DOCKER_DESKTOP_SIDECAR_CAP_ADD)).toEqual([]);
    expect(profile.syscalls.some((rule) => isTagged(rule) && rule.names[0] === 'sethostname')).toBe(true);

    expect(ceiling.absoluteStops).toContain('systempaths-unconfined-outside-reviewed-nested-daemon-sidecar');
    expect(ceiling.absoluteStops).not.toContain('systempaths-unconfined');
  });

  it('keeps the untagged rules identical to the upstream profile file', () => {
    // canonicalSha256 hashes the compact JSON; the upstream default.json is the
    // same document, tab-indented without a final newline (source.sha256).
    expect(sha256(JSON.stringify(baseProfile(currentProfile()), null, '\t'))).toBe(
      ceiling.categories.seccomp.source.sha256,
    );
  });

  it('allows the forbidden syscalls only behind capabilities the sidecar does not add', () => {
    const profile = currentProfile();
    const gated = profile.syscalls.filter(
      (rule) =>
        !DENY_ACTIONS.has(rule.action) &&
        rule.names.some((name) => ceiling.categories.seccomp.forbidden.includes(name)),
    );
    // Moby's cap-gated bpf and perf_event_open rules: present, and inert here.
    expect(gated.map((rule) => rule.includes?.caps)).toEqual([['CAP_SYS_ADMIN'], ['CAP_BPF'], ['CAP_PERFMON']]);
    expect([...DOCKER_DESKTOP_SIDECAR_CAP_ADD].sort()).toEqual([...ceiling.categories.idMap.outerCapabilities].sort());
  });

  describe('fails a profile that is wider than the ceiling', () => {
    it('rejects a syscall added to the untagged allow list', () => {
      const profile = currentProfile();
      profile.syscalls[0].names.push('chroot');
      expect(ceilingViolations(profile, ceiling, DOCKER_DESKTOP_SIDECAR_CAP_ADD)).toEqual([
        expect.stringContaining('untagged rules (canonical sha256'),
      ]);
    });

    it('rejects an untagged rule allowing a forbidden syscall', () => {
      const profile = currentProfile();
      profile.syscalls.push({ names: ['io_uring_setup'], action: 'SCMP_ACT_ALLOW' });
      expect(ceilingViolations(profile, ceiling, DOCKER_DESKTOP_SIDECAR_CAP_ADD)).toEqual([
        expect.stringContaining('untagged rules (canonical sha256'),
        'forbidden syscall io_uring_setup is allowed without a capability condition',
      ]);
    });

    it('rejects a forbidden syscall gated on a capability the sidecar adds', () => {
      const profile = currentProfile();
      const bpf = capabilityRule(profile, 'bpf', 'CAP_BPF');
      bpf.includes = { caps: ['CAP_SETUID'] };
      expect(ceilingViolations(profile, ceiling, DOCKER_DESKTOP_SIDECAR_CAP_ADD)).toEqual([
        expect.stringContaining('untagged rules (canonical sha256'),
        'forbidden syscall bpf is allowed on CAP_SETUID, which the sidecar adds',
      ]);
    });

    it('rejects a forbidden syscall that only a capability exclusion guards', () => {
      const profile = currentProfile();
      const perf = capabilityRule(profile, 'perf_event_open', 'CAP_PERFMON');
      delete perf.includes;
      perf.excludes = { caps: ['CAP_SYS_ADMIN'] };
      expect(ceilingViolations(profile, ceiling, DOCKER_DESKTOP_SIDECAR_CAP_ADD)).toContain(
        'forbidden syscall perf_event_open is allowed without a capability condition',
      );
    });

    it('rejects the cap-gated rules once the sidecar adds a capability that enables them', () => {
      expect(ceilingViolations(currentProfile(), ceiling, [...DOCKER_DESKTOP_SIDECAR_CAP_ADD, 'BPF'])).toEqual([
        'forbidden syscall bpf is allowed on CAP_BPF, which the sidecar adds',
        'sidecar adds BPF, which the ceiling does not grant',
      ]);
      expect(ceilingViolations(currentProfile(), ceiling, ['SYS_ADMIN'])).toEqual(
        expect.arrayContaining([
          'forbidden syscall bpf is allowed on CAP_SYS_ADMIN, which the sidecar adds',
          'forbidden syscall perf_event_open is allowed on CAP_SYS_ADMIN, which the sidecar adds',
          'sidecar adds SYS_ADMIN, an absolute stop',
        ]),
      );
    });

    it('rejects a tagged addition the ceiling does not declare', () => {
      const profile = currentProfile();
      profile.syscalls.push({ names: ['kexec_load'], action: 'SCMP_ACT_ALLOW', comment: `${P2_TAG} not reviewed` });
      expect(ceilingViolations(profile, ceiling, DOCKER_DESKTOP_SIDECAR_CAP_ADD)).toEqual([
        'P2 rule ["kexec_load"]: kexec_load is not a ceiling addition',
        'forbidden syscall kexec_load is allowed without a capability condition',
      ]);
    });

    it('rejects a tagged addition with conditions, or a declared addition left out', () => {
      const profile = currentProfile();
      const mount = profile.syscalls.find((rule) => isTagged(rule) && rule.names[0] === 'mount');
      if (mount === undefined) throw new Error('no tagged mount rule');
      mount.args = [{ index: 0, value: 0, op: 'SCMP_CMP_EQ' }];
      profile.syscalls = profile.syscalls.filter((rule) => !(isTagged(rule) && rule.names[0] === 'setns'));
      expect(ceilingViolations(profile, ceiling, DOCKER_DESKTOP_SIDECAR_CAP_ADD)).toEqual([
        'P2 rule ["mount"]: has args',
        'ceiling addition setns is missing from the profile',
      ]);
    });
  });
});
