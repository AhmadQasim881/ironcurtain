// A native crash (an isolated-vm segfault, an OOM kill) that takes the forked
// worker down mid-file, on every run. The test after the crash point never
// runs, and vitest reports no failure for it (BLD-3).
it('runs before the crash', () => {
  expect(1).toBe(1);
});

it('kills its own worker', () => {
  process.kill(process.pid, 'SIGKILL');
});

it('never runs', () => {
  expect.unreachable('a test after the crash point ran');
});
