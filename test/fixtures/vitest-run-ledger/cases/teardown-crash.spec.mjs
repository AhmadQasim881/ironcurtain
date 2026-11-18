// The genuine teardown flake (issue #363): every test passes, then the worker
// dies before it tells vitest the file is done. kill-worker-after-file.mjs, a
// reporter in vitest's main process, kills this worker once the file's final
// result has arrived; the test records the pid it should kill.
it('passes and records its worker pid', ({ task }) => {
  task.meta.icKillWorkerPid = process.pid;
  expect(1).toBe(1);
});

it('also passes before the worker dies', () => {
  expect(true).toBe(true);
});
