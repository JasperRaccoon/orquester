/** A shared OpenCode server cannot honor a thread-specific account home. */

import assert from "node:assert/strict";
import test from "node:test";

import { createOpenCodeAdapter } from "./index.ts";

test("a non-system account home is REFUSED, never silently dropped", async () => {
  // The server is shared by a project's threads and `OPENCODE_DATA` belongs to
  // that one process, so a per-thread home is not expressible. Dropping it
  // would make an account selection look applied when it is not.
  const adapter = await createOpenCodeAdapter({
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    },
    clock: { now: () => new Date(0), nowIso: () => "2026-09-21T00:00:00.000Z" },
    ids: { eventId: () => "e", messageId: (p) => p, uuid: () => "u" },
    resolveAttachmentPath: async () => "/tmp/a",
    attachmentsDir: () => "/tmp",
    logRawFrame: () => undefined,
    buildEnv: () => ({}),
    resolveBin: async () => "/usr/bin/opencode",
    sessionPath: () => "/usr/bin",
    tmpDir: () => "/tmp",
    signal: new AbortController().signal
  });

  await assert.rejects(
    adapter.startSession({
      threadId: "t",
      cwd: "/repo",
      home: { kind: "account", accountId: "acc1", path: "/homes/acc1" },
      modelSelection: { model: "openrouter/x" },
      runtimeMode: "approval-required"
    }),
    /cannot bind the 'account' account home/
  );
  // It refuses BEFORE spawning anything.
  assert.deepEqual(adapter.listSessions(), []);
});
