// Reporter (runs in vitest's main process) that reproduces the teardown flake
// of issue #363 deterministically. When a file whose test recorded
// `meta.icKillWorkerPid` finishes, it SIGKILLs that worker and waits until the
// main process has reaped it. Vitest delivers the file's final result while
// the worker awaits the reply to that update, so the worker dies with the
// file complete but before it reports "testfileFinished": vitest then records
// "[vitest-pool]: Worker forks emitted error." caused by
// "Worker exited unexpectedly", exactly the shape seen on macOS CI.
const REAP_TIMEOUT_MS = 10_000;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilReaped(pid) {
  const deadline = Date.now() + REAP_TIMEOUT_MS;
  while (isAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`worker ${pid} was not reaped within ${REAP_TIMEOUT_MS}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // The exit event that records the worker error fires when the child is
  // reaped; give its listeners a turn before vitest continues.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

export default class KillWorkerAfterFile {
  async onTestModuleEnd(testModule) {
    for (const test of testModule.children.allTests()) {
      const pid = test.meta().icKillWorkerPid;
      if (typeof pid !== 'number') continue;
      process.kill(pid, 'SIGKILL');
      await waitUntilReaped(pid);
    }
  }
}
