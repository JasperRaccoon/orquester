/**
 * The pool key (spec §3.2 — "one `opencode serve` **per project**, shared by
 * its threads").
 *
 * R4 #6: the key was the thread's own `cwd`, so a thread at `/p` and a thread
 * at `/p/packages/ui` got two servers, two ports and two ~4.3 MB catalogue
 * probes, while the code comment claimed the opposite.
 *
 * `projectPath` is the host's field to add (the fix-wave arbitration assigns
 * it to W1). These tests pin the behaviour **before and after** it exists, so
 * the adapter is correct either way and needs no edit when the seam lands.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { AdapterContext, StartSessionInput } from "../../adapter.ts";
import { createOpenCodeAdapter, projectDirFor } from "./index.ts";

function input(over: Partial<StartSessionInput> & Record<string, unknown>): StartSessionInput {
  return {
    threadId: "t",
    cwd: "/repo",
    home: { kind: "system", path: "/home/u" },
    modelSelection: { model: "openrouter/x" },
    runtimeMode: "approval-required",
    ...over
  } as StartSessionInput;
}

test("with no projectPath, the key falls back to the thread's cwd", () => {
  // The pre-seam world: identical to the old behaviour, so nothing regresses
  // while W1's field is still in flight.
  assert.equal(projectDirFor(input({ cwd: "/repo" })), "/repo");
});

test("with projectPath, two threads in one project share ONE key", () => {
  const root = projectDirFor(input({ cwd: "/repo", projectPath: "/repo" }));
  const subdir = projectDirFor(
    input({ threadId: "t2", cwd: "/repo/packages/ui", projectPath: "/repo" })
  );
  assert.equal(root, subdir, "a subdirectory thread rides the project's server");
  assert.equal(root, "/repo");
});

test("two different projects still get two keys", () => {
  assert.notEqual(
    projectDirFor(input({ cwd: "/a", projectPath: "/a" })),
    projectDirFor(input({ cwd: "/b", projectPath: "/b" }))
  );
});

test("the key is RESOLVED, because the server never validates a directory", () => {
  // Fixtures README observation 21: a directory that does not exist is not
  // rejected — it silently serves a different instance scope. Two spellings of
  // one path must therefore not produce two servers.
  assert.equal(
    projectDirFor(input({ cwd: "/repo/packages/ui", projectPath: "/repo/packages/../packages" })),
    projectDirFor(input({ threadId: "t2", cwd: "/x", projectPath: "/repo/packages" }))
  );
  assert.equal(projectDirFor(input({ cwd: "relative/dir" })).startsWith("/"), true);
});

test("a blank or non-string projectPath is ignored, not trusted", () => {
  assert.equal(projectDirFor(input({ cwd: "/repo", projectPath: "   " })), "/repo");
  assert.equal(projectDirFor(input({ cwd: "/repo", projectPath: "" })), "/repo");
  assert.equal(projectDirFor(input({ cwd: "/repo", projectPath: 42 })), "/repo");
  assert.equal(projectDirFor(input({ cwd: "/repo", projectPath: null })), "/repo");
});

// ---------------------------------------------------------------------------
// E9 — a cold snapshot probe must not wait on a server start
// ---------------------------------------------------------------------------

function probeCtx(over: Partial<AdapterContext> = {}): AdapterContext {
  return {
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
    resolveBin: async () => "/definitely/not/a/real/opencode",
    sessionPath: () => "/usr/bin",
    tmpDir: () => "/tmp",
    signal: new AbortController().signal,
    ...over
  } as AdapterContext;
}

test("E9: a COLD snapshot probe answers without waiting for a server start", async () => {
  // Measured cold: 10 435 ms against a 10 s host budget, so the first visit to
  // Settings showed no OpenCode at all and had to retry blind. Warm: 474 ms.
  // The fix answers from the CLI (no server needed) and warms in background.
  const adapter = await createOpenCodeAdapter(probeCtx());
  const started = Date.now();
  const snapshot = await adapter.refreshSnapshot({ cwd: "/tmp" });
  const elapsed = Date.now() - started;

  // The binary path resolves but cannot be spawned here, so every probe fails
  // fast. The point is that it FAILS FAST and returns a snapshot rather than
  // hanging on a server start until the caller's 10 s deadline fires.
  assert.ok(elapsed < 5_000, `cold probe took ${elapsed}ms`);
  assert.equal(snapshot.id, "opencode");
  assert.equal(snapshot.version, null, "the version probe could not run");
  assert.equal(snapshot.status, "error");
  // Even a total failure is a well-formed snapshot the client can render.
  assert.deepEqual(snapshot.models, []);
  assert.deepEqual(
    snapshot.slashCommands.map((command) => command.name),
    ["compact"]
  );
  await adapter.stopAll();
});

test("E9: a cwd-less refresh never starts a server either", async () => {
  const adapter = await createOpenCodeAdapter(probeCtx());
  const snapshot = await adapter.refreshSnapshot();
  assert.equal(snapshot.id, "opencode");
  assert.equal(snapshot.capabilities.reportsContextWindow, false);
  await adapter.stopAll();
});

// ---------------------------------------------------------------------------
// R4 #21 — the account home a shared server cannot honour
// ---------------------------------------------------------------------------

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
