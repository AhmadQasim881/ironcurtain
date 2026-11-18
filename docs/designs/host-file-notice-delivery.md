# Host-file notice delivery

**Status (2026-11-16):** Implemented (`src/docker/host-mount-privilege-scan.ts`).

The host-mount privilege scanner can report files requiring operator cleanup even when a session never starts. A dependency-provisioning container also writes a host-backed base that the agent container never mounts, so its findings need their own delivery path.

Docker infrastructure accepts an internal `onHostPrivilegedFiles` callback. Standalone session creation forwards it to the session diagnostic handler; shared workflow bundles record it in the workflow message log and tab. Startup and provisioning scans deliver their findings before returning. If the callback is absent or throws, the notice is printed safely on stderr. A startup failure also includes the notice in its error message while preserving the original error object and code where that object is writable. A frozen error is retained as the cause of a new error.

Recovery teardown results follow the same reporting rules as normal teardown. A failed session factory reports the result before releasing its directory claim. Workflow bundle creation interrupted by abort or control-server setup failure records the teardown finding in the run's message log.

Completed cron records retain their notices through the daemon's run-status parser. The waiting CLI prints them, and the Jobs view displays them even for a successful run. Browser host-file warnings also have a separate list outside live session rows, so a `session.ended` event cannot immediately erase the warning. This list holds the newest twenty distinct warnings in the open application and supports explicit dismissal. It survives RPC refreshes in the current page; a full page reload or a new browser opened after a session ended must use the persisted job, workflow or session logs.

All paths use existing display escaping. Scanner metadata, accepted session outcomes and stored records are otherwise preserved. The notice is advisory: it does not authorize a tool call or change a successful run into a failure.
