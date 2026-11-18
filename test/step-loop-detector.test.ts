import { describe, it, expect } from 'vitest';
import { StepLoopDetector, outcomeCarriesError } from '../src/session/step-loop-detector.js';
import { computeHash, stableStringify } from '../src/hash.js';

// --- Hash utility tests ---

describe('stableStringify', () => {
  it('sorts object keys deterministically', () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe(stableStringify({ a: 1, b: 2 }));
  });

  it('handles nested objects', () => {
    const a = { x: { b: 2, a: 1 }, y: [3, 1] };
    const b = { y: [3, 1], x: { a: 1, b: 2 } };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('handles primitives', () => {
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify('hello')).toBe('"hello"');
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(true)).toBe('true');
  });

  it('handles arrays', () => {
    expect(stableStringify([1, 2, 3])).toBe('[1,2,3]');
  });

  it('handles undefined', () => {
    expect(stableStringify(undefined)).toBe(undefined);
  });
});

describe('computeHash', () => {
  it('returns consistent hashes for equivalent objects', () => {
    expect(computeHash({ b: 2, a: 1 })).toBe(computeHash({ a: 1, b: 2 }));
  });

  it('returns different hashes for different values', () => {
    expect(computeHash({ a: 1 })).not.toBe(computeHash({ a: 2 }));
  });

  it('returns a 64-character hex string', () => {
    const hash = computeHash('test');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// --- StepLoopDetector tests ---

describe('StepLoopDetector', () => {
  describe('2x2 matrix classification', () => {
    it('classifies full progress: new code + new result', () => {
      const detector = new StepLoopDetector();
      const verdict = detector.analyzeStep('code1', 'result1');
      expect(verdict.action).toBe('allow');
    });

    it('classifies world changed: repeated code + new result', () => {
      const detector = new StepLoopDetector();
      detector.analyzeStep('code1', 'result1');
      // Same code, different result
      const verdict = detector.analyzeStep('code1', 'result2');
      expect(verdict.action).toBe('allow');
    });

    it('classifies stuck: new code + repeated result', () => {
      const detector = new StepLoopDetector();
      detector.analyzeStep('code1', 'result1');
      // Different code, same result
      const verdict = detector.analyzeStep('code2', 'result1');
      expect(verdict.action).toBe('allow'); // First stuck step, below threshold
    });

    it('classifies full stagnation: repeated code + repeated result', () => {
      const detector = new StepLoopDetector();
      detector.analyzeStep('code1', 'result1');
      // Same code, same result
      const verdict = detector.analyzeStep('code1', 'result1');
      expect(verdict.action).toBe('allow'); // First stagnation, below threshold
    });
  });

  describe('stagnation streak', () => {
    function buildStagnationDetector(n: number): StepLoopDetector {
      const detector = new StepLoopDetector();
      // First step is always full_progress
      detector.analyzeStep('code1', 'result1');
      // Subsequent identical steps are full_stagnation
      for (let i = 1; i < n; i++) {
        detector.analyzeStep('code1', 'result1');
      }
      return detector;
    }

    it('allows below warn threshold', () => {
      const detector = buildStagnationDetector(3); // 2 stagnation steps
      const verdict = detector.analyzeStep('code1', 'result1');
      expect(verdict.action).toBe('warn'); // 3rd stagnation = warn threshold
    });

    it('warns at stagnation threshold (3)', () => {
      const detector = new StepLoopDetector();
      detector.analyzeStep('code1', 'result1'); // full_progress
      detector.analyzeStep('code1', 'result1'); // stagnation 1
      detector.analyzeStep('code1', 'result1'); // stagnation 2
      const verdict = detector.analyzeStep('code1', 'result1'); // stagnation 3
      expect(verdict.action).toBe('warn');
      expect(verdict).toHaveProperty('category', 'full_stagnation');
    });

    it('blocks at stagnation threshold (5)', () => {
      const detector = buildStagnationDetector(6); // 5 stagnation steps
      const verdict = detector.analyzeStep('code1', 'result1'); // 6th stagnation
      expect(verdict.action).toBe('block');
      expect(verdict).toHaveProperty('category', 'full_stagnation');
    });

    it('resets on full progress', () => {
      const detector = new StepLoopDetector();
      detector.analyzeStep('code1', 'result1'); // full_progress
      detector.analyzeStep('code1', 'result1'); // stagnation 1
      detector.analyzeStep('code1', 'result1'); // stagnation 2
      // Full progress resets the streak
      detector.analyzeStep('code2', 'result2');
      // Start stagnation again — should be fresh
      detector.analyzeStep('code2', 'result2'); // stagnation 1
      detector.analyzeStep('code2', 'result2'); // stagnation 2
      const verdict = detector.analyzeStep('code2', 'result2'); // stagnation 3
      expect(verdict.action).toBe('warn'); // Only at 3, not accumulated from before
    });

    it('resets on world changed', () => {
      const detector = new StepLoopDetector();
      detector.analyzeStep('code1', 'result1'); // full_progress
      detector.analyzeStep('code1', 'result1'); // stagnation 1
      detector.analyzeStep('code1', 'result1'); // stagnation 2
      // World changed (same code, new result) resets streak
      detector.analyzeStep('code1', 'result3');
      const verdict = detector.analyzeStep('code1', 'result3'); // stagnation 1 (fresh)
      expect(verdict.action).toBe('allow');
    });
  });

  describe('stuck streak (outcomes that report an error)', () => {
    /** The execute_code output of a step whose tool call was denied. */
    const DENIED = { console: ['[ERROR] Code execution failed: Error: denied by policy'], result: null };

    function buildStuckDetector(n: number): StepLoopDetector {
      const detector = new StepLoopDetector();
      detector.analyzeStep('code1', DENIED); // full_progress
      // Each new code with the same failing result is "stuck"
      for (let i = 1; i <= n; i++) {
        detector.analyzeStep(`different_code_${i}`, DENIED);
      }
      return detector;
    }

    it('allows below warn threshold', () => {
      const detector = buildStuckDetector(3); // 3 stuck steps
      expect(detector.analyzeStep('yet_another_code', DENIED).action).toBe('allow'); // 4th stuck
    });

    it('warns at stuck threshold (5)', () => {
      const detector = buildStuckDetector(4); // 4 stuck steps
      const verdict = detector.analyzeStep('more_code', DENIED); // 5th stuck
      expect(verdict.action).toBe('warn');
      expect(verdict).toHaveProperty('category', 'stuck');
    });

    it('blocks at stuck threshold (8)', () => {
      const detector = buildStuckDetector(7); // 7 stuck steps
      const verdict = detector.analyzeStep('final_code', DENIED); // 8th stuck
      expect(verdict.action).toBe('block');
      expect(verdict).toHaveProperty('category', 'stuck');
      expect(detector.isBlocked()).not.toBeNull();
    });

    it.each([
      ['a host-side error field', { error: 'Sandbox not initialized' }],
      ['an [ERROR] console line', { console: ['[ERROR] boom'], result: null }],
      ['an error object as the result', { result: { error: 'ENOENT: no such file' } }],
      ['an isError result', { result: { isError: true, content: [] } }],
      ['String(error) as the result', { result: 'TypeError: x is not a function' }],
    ])('counts %s toward the stuck threshold', (_label, outcome) => {
      const detector = new StepLoopDetector();
      detector.analyzeStep('code0', outcome); // full_progress
      const verdicts = Array.from({ length: 8 }, (_, i) => detector.analyzeStep(`code${i + 1}`, outcome));
      expect(verdicts.at(-1)?.action).toBe('block');
    });

    it('resets on progress', () => {
      const detector = new StepLoopDetector();
      detector.analyzeStep('code1', DENIED); // full_progress
      detector.analyzeStep('code2', DENIED); // stuck 1
      detector.analyzeStep('code3', DENIED); // stuck 2
      detector.analyzeStep('code4', DENIED); // stuck 3
      detector.analyzeStep('code5', DENIED); // stuck 4
      // New result → world_changed → resets stuck streak
      detector.analyzeStep('code5', { error: 'different failure' });
      // Start new stuck streak
      const verdict = detector.analyzeStep('code6', { error: 'different failure' }); // stuck 1
      expect(verdict.action).toBe('allow');
    });
  });

  describe('stuck streak (benign outcomes)', () => {
    it('ten distinct steps returning ok do not trigger stuck', () => {
      const detector = new StepLoopDetector();
      for (let i = 1; i <= 10; i++) {
        expect(
          detector.analyzeStep(`filesystem.write_file({ path: 'f${i}.txt' }); return 'ok';`, { result: 'ok' }),
        ).toEqual({
          action: 'allow',
        });
      }
      expect(detector.isBlocked()).toBeNull();
    });

    it('ten distinct writes that return nothing do not trigger stuck', () => {
      const detector = new StepLoopDetector();
      for (let i = 1; i <= 10; i++) {
        // UTCP turns code without a return value into `null`.
        const verdict = detector.analyzeStep(`filesystem.write_file({ path: 'f${i}.txt', content: '${i}' });`, {
          result: null,
        });
        expect(verdict.action).toBe('allow');
      }
      expect(detector.isBlocked()).toBeNull();
    });

    it('still stops an agent that keeps failing silently, at the higher thresholds', () => {
      const detector = new StepLoopDetector();
      detector.analyzeStep('attempt0', { result: null }); // full_progress
      const verdicts = Array.from({ length: 25 }, (_, i) => detector.analyzeStep(`attempt${i + 1}`, { result: null }));

      expect(verdicts.slice(0, 14).every((v) => v.action === 'allow')).toBe(true); // stuck 1-14
      expect(verdicts[14]).toMatchObject({ action: 'warn', category: 'stuck' }); // stuck 15
      expect((verdicts[14] as { message: string }).message).toContain('return a short description');
      expect(verdicts[24]).toMatchObject({ action: 'block', category: 'stuck' }); // stuck 25
      expect(detector.isBlocked()).not.toBeNull();
    });

    it('counts errors within a mixed stuck streak toward the lower threshold', () => {
      const detector = new StepLoopDetector();
      const failure = { error: 'denied' };
      detector.analyzeStep('setup-a', failure); // full_progress (error outcome seen)
      detector.analyzeStep('setup-b', { result: null }); // full_progress (null outcome seen)
      let verdict = detector.analyzeStep('e1', failure);
      for (const code of ['e2', 'e3', 'e4']) verdict = detector.analyzeStep(code, failure); // 4 errors
      detector.analyzeStep('b1', { result: null }); // benign stuck step, streak continues
      for (const code of ['e5', 'e6', 'e7']) verdict = detector.analyzeStep(code, failure); // errors 5-7
      expect(verdict.action).toBe('warn');
      verdict = detector.analyzeStep('e8', failure); // 8th error in the streak
      expect(verdict).toMatchObject({ action: 'block', category: 'stuck' });
    });

    it('uses custom benign thresholds', () => {
      const detector = new StepLoopDetector({ benignStuck: { warn: 2, block: 3 } });
      detector.analyzeStep('code1', 'result1'); // full_progress
      detector.analyzeStep('code2', 'result1'); // stuck 1
      expect(detector.analyzeStep('code3', 'result1').action).toBe('warn'); // stuck 2
      expect(detector.analyzeStep('code4', 'result1').action).toBe('block'); // stuck 3
    });
  });

  describe('outcomeCarriesError', () => {
    it.each([
      [{ error: 'boom' }, true],
      [{ console: ['[INFO] fine', '[ERROR] Code execution failed: Error: denied'], result: null }, true],
      [{ result: { error: { code: 'ENOENT' } } }, true],
      [{ result: { isError: true } }, true],
      [{ result: 'Error: no such file' }, true],
      [{ result: 'McpError: tool failed' }, true],
      ['Error: thrown text', true],
      [{ result: null }, false],
      [{ result: 'ok' }, false],
      [{ result: '' }, false],
      [{ result: 'Error-free run' }, false],
      [{ result: { error: null, data: 1 } }, false],
      [{ result: { error: false } }, false],
      [{ console: ['[WARN] slow', 'plain log'], result: 'done' }, false],
      [{ result: [{ error: 'nested deeper is not inspected' }] }, false],
      [null, false],
      ['result1', false],
    ])('%j -> %s', (outcome, expected) => {
      expect(outcomeCarriesError(outcome)).toBe(expected);
    });
  });

  describe('blocking behavior', () => {
    it('isBlocked returns null before block', () => {
      const detector = new StepLoopDetector();
      expect(detector.isBlocked()).toBeNull();
    });

    it('isBlocked returns verdict after block', () => {
      const detector = new StepLoopDetector({ stagnation: { warn: 1, block: 2 } });
      detector.analyzeStep('code1', 'result1'); // full_progress
      detector.analyzeStep('code1', 'result1'); // stagnation 1
      detector.analyzeStep('code1', 'result1'); // stagnation 2 = block

      const blocked = detector.isBlocked();
      expect(blocked).not.toBeNull();
      expect(blocked!.action).toBe('block');
      expect(blocked!.message).toContain('blocked for the rest of this turn');
    });

    it('reset forgets the streaks and the outcomes seen so far', () => {
      const detector = new StepLoopDetector();
      const failure = { error: 'denied' };
      detector.analyzeStep('code0', failure); // full_progress
      for (let i = 1; i <= 7; i++) detector.analyzeStep(`code${i}`, failure); // stuck 1-7

      detector.reset();

      // After the reset the failure is a new outcome again (full progress),
      // and a fresh stuck streak needs eight more repeats to block.
      expect(detector.analyzeStep('code8', failure)).toEqual({ action: 'allow' });
      for (let i = 9; i <= 15; i++) {
        expect(detector.analyzeStep(`code${i}`, failure).action).not.toBe('block'); // stuck 1-7
      }
      expect(detector.analyzeStep('code16', failure).action).toBe('block'); // stuck 8
    });

    it('block persists until reset', () => {
      const detector = new StepLoopDetector({ stagnation: { warn: 1, block: 2 } });
      detector.analyzeStep('code1', 'result1');
      detector.analyzeStep('code1', 'result1');
      detector.analyzeStep('code1', 'result1'); // triggers block

      expect(detector.isBlocked()).not.toBeNull();
      expect(detector.isBlocked()).not.toBeNull(); // still blocked

      detector.reset();
      expect(detector.isBlocked()).toBeNull();
    });
  });

  describe('custom thresholds', () => {
    it('uses custom stagnation thresholds', () => {
      const detector = new StepLoopDetector({ stagnation: { warn: 2, block: 3 } });
      detector.analyzeStep('code1', 'result1'); // full_progress
      detector.analyzeStep('code1', 'result1'); // stagnation 1
      const warn = detector.analyzeStep('code1', 'result1'); // stagnation 2 = warn
      expect(warn.action).toBe('warn');

      const block = detector.analyzeStep('code1', 'result1'); // stagnation 3 = block
      expect(block.action).toBe('block');
    });

    it('uses custom stuck thresholds', () => {
      const detector = new StepLoopDetector({ stuck: { warn: 2, block: 3 } });
      const failure = { error: 'denied' };
      detector.analyzeStep('code1', failure); // full_progress
      detector.analyzeStep('code2', failure); // stuck 1
      const warn = detector.analyzeStep('code3', failure); // stuck 2 = warn
      expect(warn.action).toBe('warn');

      const block = detector.analyzeStep('code4', failure); // stuck 3 = block
      expect(block.action).toBe('block');
    });
  });

  describe('streak interaction', () => {
    it('stuck resets stagnation streak and vice versa', () => {
      const detector = new StepLoopDetector({ stagnation: { warn: 3, block: 5 }, stuck: { warn: 3, block: 5 } });
      detector.analyzeStep('code1', 'result1'); // full_progress
      detector.analyzeStep('code1', 'result1'); // stagnation 1
      detector.analyzeStep('code1', 'result1'); // stagnation 2
      // Switch to stuck (new code, same result1)
      detector.analyzeStep('code2', 'result1'); // stuck 1 — resets stagnation
      // Back to stagnation
      detector.analyzeStep('code2', 'result1'); // stagnation 1 — resets stuck
      const verdict = detector.analyzeStep('code2', 'result1'); // stagnation 2
      expect(verdict.action).toBe('allow'); // not at warn (3) because resets happened
    });
  });
});
