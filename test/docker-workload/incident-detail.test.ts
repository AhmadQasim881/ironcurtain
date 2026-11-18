import { describe, expect, it } from 'vitest';
import {
  boundIncidentDetail,
  EMPTY_INCIDENT_DETAIL,
  incidentDetailFromError,
  MAX_INCIDENT_DETAIL_CODE_POINTS,
  preserveOriginalFailure,
} from '../../src/docker-workload/incident-detail.js';

/** An execFile failure message as Node builds it: the whole argv, then the daemon's stderr. */
function execFileStyleMessage(idCount: number): string {
  const ids = Array.from({ length: idCount }, (_, index) => index.toString(16).padStart(64, '0'));
  return `Command failed: docker --host unix:///var/run/docker.sock container inspect ${ids.join(' ')}\nError response from daemon: simulated inspect failure`;
}

describe('bounded incident detail', () => {
  it('keeps short single-line text unchanged', () => {
    expect(boundIncidentDetail('cleanup proof accepted')).toBe('cleanup proof accepted');
  });

  it('removes control, format, and separator characters', () => {
    expect(boundIncidentDetail('line one\nline two\t\u001b[31mred\u001b[0m\u202Eevil\u2028end')).toBe(
      'line one line two [31mred [0m evil end',
    );
  });

  it('never returns an empty detail', () => {
    expect(boundIncidentDetail('')).toBe(EMPTY_INCIDENT_DETAIL);
    expect(boundIncidentDetail('\n\t\u0000')).toBe(EMPTY_INCIDENT_DETAIL);
    expect(incidentDetailFromError(new Error(''))).toBe(EMPTY_INCIDENT_DETAIL);
  });

  it('bounds a 300-container argv to the lease schema while keeping the command and the daemon stderr', () => {
    const message = execFileStyleMessage(300);
    expect(message.length).toBeGreaterThan(19_000);

    const bounded = boundIncidentDetail(message);
    expect(Array.from(bounded).length).toBeLessThanOrEqual(MAX_INCIDENT_DETAIL_CODE_POINTS);
    // The lease incident field is the smallest schema bound (4096 UTF-16 units).
    expect(bounded.length).toBeLessThanOrEqual(4096);
    expect(bounded.startsWith('Command failed: docker --host unix:///var/run/docker.sock container inspect')).toBe(
      true,
    );
    expect(bounded.endsWith('Error response from daemon: simulated inspect failure')).toBe(true);
    expect(bounded).toMatch(/\[\.\.\. \d+ characters omitted \.\.\.\]/u);
  });

  it('stays within the UTF-16 bound for astral text and never splits a surrogate pair', () => {
    const bounded = boundIncidentDetail('🙂'.repeat(10_000));
    expect(bounded.length).toBeLessThanOrEqual(4096);
    // With the `u` flag only an unpaired surrogate is a `Cs` code point.
    expect(bounded).not.toMatch(/\p{Cs}/u);
  });

  it('honours a smaller explicit bound and rejects an unusable one', () => {
    expect(Array.from(boundIncidentDetail(execFileStyleMessage(50), 256)).length).toBeLessThanOrEqual(256);
    expect(() => boundIncidentDetail('x', 8)).toThrow(RangeError);
  });

  it('reports non-Error throwables', () => {
    expect(incidentDetailFromError('plain string failure')).toBe('plain string failure');
  });
});

describe('original failure preservation', () => {
  it('returns the original failure itself when recording succeeded', () => {
    const original = new Error('inventory inspect failed');
    expect(preserveOriginalFailure(original, [])).toBe(original);
  });

  it('keeps the original first when recording also failed', () => {
    const original = new Error('inventory inspect failed');
    const recording = new Error('Docker-workload lease is busy');
    const combined = preserveOriginalFailure(original, [recording]);

    expect(combined).toBeInstanceOf(AggregateError);
    expect(combined).toMatchObject({ cause: original, errors: [original, recording] });
    expect((combined as Error).message).toMatch(
      /^inventory inspect failed \(recording this failure also failed: Docker-workload lease is busy\)$/u,
    );
  });
});
