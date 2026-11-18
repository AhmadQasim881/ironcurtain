// The worker dies while importing the file, before any test is collected, so
// vitest's test totals stay consistent and only the file count shows the gap.
process.kill(process.pid, 'SIGKILL');

it('is never collected', () => {
  expect.unreachable('a test in a file that crashed on import ran');
});
