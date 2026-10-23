import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { isValidName, parseAgentThreadHead, parseSessionsConfig } from "./index.ts";
import { assertInsideFsRoot, FsSandboxError } from "./fs.ts";

test("isValidName rejects traversal and empties", () => {
  assert.equal(isValidName("project"), true);
  assert.equal(isValidName(".hidden"), false);
  assert.equal(isValidName("a/b"), false);
  assert.equal(isValidName("a\\b"), false);
  assert.equal(isValidName(""), false);
  assert.equal(isValidName(undefined), false);
});

test("sessionRecordSchema round-trips accountId so reattach keeps the account pin", () => {
  // Zod strips unknown keys, so without accountId on the schema a persisted pin
  // would be silently dropped on read — leaving a reattached account-pinned
  // session invisible to liveAccountIds() and its refresher gate.
  const base = {
    id: "s1",
    title: "Claude",
    order: 0,
    projectPath: "/p",
    refId: "claude",
    kind: "agent" as const,
    cwd: "/p",
    createdAt: "2026-07-21T00:00:00.000Z"
  };
  const parsed = parseSessionsConfig({ version: 1, sessions: [{ ...base, accountId: "acct-A" }] });
  assert.equal(parsed.sessions[0].accountId, "acct-A");
  // Absent accountId (System/host-identity sessions and legacy records) stays undefined.
  const noAccount = parseSessionsConfig({ version: 1, sessions: [base] });
  assert.equal(noAccount.sessions[0].accountId, undefined);
});

test("sessionRecordSchema keeps a workflow owner and drops a malformed one, never the record", () => {
  const base = {
    id: "c1",
    title: "Claude",
    order: 0,
    projectPath: "/p",
    refId: "claude",
    kind: "agent-chat" as const,
    cwd: "/p",
    createdAt: "2026-09-28T00:00:00.000Z",
    chat: { threadId: "c1", accountId: "", home: "system" as const, lastSeq: 0 }
  };
  const owner = { kind: "workflow" as const, workflowId: "w1", runId: "r1", nodeId: "n1" };
  const kept = parseSessionsConfig({ version: 1, sessions: [{ ...base, owner }] });
  assert.deepEqual(kept.sessions[0].owner, owner);
  // Absent: no key at all, so a re-written record stays byte-identical to an old one.
  const absent = parseSessionsConfig({ version: 1, sessions: [base] });
  assert.equal("owner" in absent.sessions[0], false);
  for (const bad of [
    { ...owner, kind: "cron" },
    { ...owner, runId: "" },
    { ...owner, nodeId: "   " },
    { ...owner, workflowId: "x".repeat(201) },
    "workflow",
    null
  ]) {
    const parsed = parseSessionsConfig({ version: 1, sessions: [{ ...base, owner: bad }] });
    assert.equal(parsed.sessions.length, 1, `record survives ${JSON.stringify(bad)}`);
    assert.equal(parsed.sessions[0].owner, undefined);
    assert.equal(parsed.sessions[0].chat?.threadId, "c1");
  }
  // The Knowledge Graph indexer's worker chats: kept, extra keys stripped; a blank run id dropped.
  const knowledge = parseSessionsConfig({ version: 1, sessions: [{ ...base, owner: { kind: "knowledge-indexer", runId: "kr1", stray: 1 } }] });
  assert.deepEqual(knowledge.sessions[0].owner, { kind: "knowledge-indexer", runId: "kr1" });
  const blank = parseSessionsConfig({ version: 1, sessions: [{ ...base, owner: { kind: "knowledge-indexer", runId: " " } }] });
  assert.equal(blank.sessions.length, 1);
  assert.equal(blank.sessions[0].owner, undefined);
});

test("assertInsideFsRoot allows in-root paths and rejects escapes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fsroot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "ws"), { recursive: true });
  assert.equal(await assertInsideFsRoot(root, join(root, "ws")), join(root, "ws"));
  // not-yet-existing child still passes (deepest existing ancestor is realpath'd)
  assert.equal(await assertInsideFsRoot(root, join(root, "ws", "new")), join(root, "ws", "new"));
  await assert.rejects(() => assertInsideFsRoot(root, join(root, "..", "escape")), FsSandboxError);
  await assert.rejects(() => assertInsideFsRoot(root, "/etc"), FsSandboxError);
});

// --- goals §5.5: the head's `resumeGoalAfterRestart` ------------------------

const persistedHead = {
  id: "t1",
  projectPath: "/w/p",
  cwd: "/w/p",
  title: "Chat",
  adapter: "codex",
  refId: "codex",
  accountId: "acc1",
  home: "account",
  modelSelection: { model: "gpt-5" },
  runtimeMode: "approval-required",
  session: { status: "ready", activeTurnId: null, resumeCursor: { threadId: "p1" } },
  turnCount: 2,
  seq: 40,
  createdAt: "2026-09-24T00:00:00.000Z",
  updatedAt: "2026-09-24T00:05:00.000Z"
};

test("legacy proxy-home tabs and thread heads remain readable after launcher retirement", () => {
  const tabs = parseSessionsConfig({
    version: 1,
    sessions: [{
      id: "t1",
      title: "Saved proxy conversation",
      order: 0,
      projectPath: "/w/p",
      refId: "claudex",
      kind: "agent-chat",
      cwd: "/w/p",
      createdAt: "2026-09-24T00:00:00.000Z",
      chat: { threadId: "t1", accountId: "", home: "cliproxy", lastSeq: 40 }
    }]
  });
  assert.deepEqual(tabs.sessions.map((tab) => ({ id: tab.id, refId: tab.refId, chat: tab.chat })), [{
    id: "t1",
    refId: "claudex",
    chat: { threadId: "t1", accountId: "", home: "system", lastSeq: 40 }
  }]);

  const head = parseAgentThreadHead({
    ...persistedHead,
    adapter: "claude",
    refId: "claudex",
    accountId: "",
    home: "cliproxy",
    session: { status: "ready", activeTurnId: null, resumeCursor: { threadId: "t1", resume: "provider-session" } }
  });
  assert.ok(head);
  assert.equal(head.id, "t1");
  assert.equal(head.refId, "claudex");
  assert.equal(head.home, "system");
  assert.equal(head.seq, 40);
  assert.deepEqual(head.session.resumeCursor, { threadId: "t1", resume: "provider-session" });
});

test("a head written before goals — no marker — still parses, and says no", () => {
  const parsed = parseAgentThreadHead(persistedHead);
  assert.ok(parsed, "an older head is not a broken one");
  assert.equal(parsed.resumeGoalAfterRestart, undefined);
  assert.equal("resumeGoalAfterRestart" in JSON.parse(JSON.stringify(parsed)), false);
});

test("a malformed goal-resume marker is dropped, never the whole head", () => {
  // A bad optional marker must not turn the thread into an unreadable one.
  for (const value of [false, "yes", 1, null, { turnId: "x" }]) {
    const parsed = parseAgentThreadHead({ ...persistedHead, resumeGoalAfterRestart: value });
    assert.ok(parsed, JSON.stringify(value));
    assert.equal(parsed.resumeGoalAfterRestart, undefined, JSON.stringify(value));
  }
});

test("a head without the goal-hold marker says no, and writes none back", () => {
  const parsed = parseAgentThreadHead(persistedHead);
  assert.ok(parsed, "the head parses");
  assert.equal(parsed.goalHeldForHandover, undefined);
  assert.equal("goalHeldForHandover" in JSON.parse(JSON.stringify(parsed)), false);
});

test("a malformed goal-hold marker is dropped, never the whole head", () => {
  for (const value of [false, "yes", 1, null, { held: true }]) {
    const parsed = parseAgentThreadHead({ ...persistedHead, goalHeldForHandover: value });
    assert.ok(parsed, JSON.stringify(value));
    assert.equal(parsed.goalHeldForHandover, undefined, JSON.stringify(value));
    assert.equal(parsed.id, "t1", "the rest of the head is untouched");
  }
});

// --- §3.3: the continuation marker's stamp (`markedAt`) ---------------------

test("a stamped continuation marker round-trips beside both goal marks — through JSON, as meta.json holds it", () => {
  const marker = { turnId: "turn-7", prepared: true, markedAt: "2026-09-27T08:00:00.000Z" };
  const parsed = parseAgentThreadHead({
    ...persistedHead,
    continueAfterRestart: marker,
    resumeGoalAfterRestart: true,
    goalHeldForHandover: true
  });
  assert.ok(parsed, "the head parses");
  // A zod object drops a key it does not list: a stamp lost here would make
  // every marker read as an older host's, never continued once the host's own
  // teardown settled its turn.
  assert.deepEqual(parsed.continueAfterRestart, marker);
  assert.equal(parsed.resumeGoalAfterRestart, true);
  assert.equal(parsed.goalHeldForHandover, true);
  const reread = parseAgentThreadHead(JSON.parse(JSON.stringify(parsed)));
  assert.deepEqual(reread, parsed, "unchanged through JSON");
});

// --- §3.3: crash-safe resume (`crashAttempt`, `crashResumedTurn`) ----------

test("the crash-resume count round-trips on the marker and the head — through JSON, as meta.json holds it", () => {
  const marker = { turnId: "turn-7", prepared: true, markedAt: "2026-10-23T08:00:00.000Z", crashAttempt: 2 };
  const parsed = parseAgentThreadHead({
    ...persistedHead,
    continueAfterRestart: marker,
    crashResumedTurn: { turnId: "turn-8", attempt: 1 }
  });
  assert.ok(parsed);
  assert.deepEqual(parsed.continueAfterRestart, marker, "a dropped count would let a crashing turn loop");
  assert.deepEqual(parsed.crashResumedTurn, { turnId: "turn-8", attempt: 1 });
  assert.deepEqual(parseAgentThreadHead(JSON.parse(JSON.stringify(parsed))), parsed);
});

test("a pending wake round-trips on the head through JSON; a bad one reads as none, a bad task is dropped", () => {
  const pendingWake = {
    since: "2026-10-23T09:20:10.905Z",
    tasks: [
      {
        taskId: "a848b4c83033e0f67",
        status: "completed",
        completedAt: "2026-10-23T09:20:10.905Z",
        title: "Fix: revocable auth sessions",
        taskType: "local_agent",
        result: "All four items (A to D) are fixed and committed.",
        outputFile: "/tmp/tasks/a848b4c83033e0f67.output"
      }
    ],
    prepared: true,
    attempt: 1
  };
  const parsed = parseAgentThreadHead({ ...persistedHead, pendingWake });
  assert.ok(parsed);
  assert.deepEqual(parsed.pendingWake, pendingWake, "a dropped mark would lose the finished task's result");
  assert.deepEqual(parseAgentThreadHead(JSON.parse(JSON.stringify(parsed))), parsed);

  const mixed = parseAgentThreadHead({
    ...persistedHead,
    pendingWake: { since: "2026-10-23T09:20:10.905Z", tasks: [{ status: "completed" }, pendingWake.tasks[0]], attempt: "x" }
  });
  assert.ok(mixed);
  assert.deepEqual(mixed.pendingWake?.tasks, pendingWake.tasks);
  assert.equal(mixed.pendingWake?.attempt, undefined);
  for (const value of [null, 7, { tasks: [] }, { since: 3, tasks: [] }]) {
    const head = parseAgentThreadHead({ ...persistedHead, pendingWake: value });
    assert.ok(head, JSON.stringify(value));
    assert.equal(head.pendingWake, undefined, JSON.stringify(value));
  }
});

test("a malformed crash-resume count reads as none, never an unreadable head", () => {
  for (const value of [0, -1, 1.5, "2", null, { n: 2 }]) {
    const parsed = parseAgentThreadHead({
      ...persistedHead,
      continueAfterRestart: { turnId: "turn-7", prepared: true, crashAttempt: value },
      crashResumedTurn: { turnId: "turn-8", attempt: value }
    });
    assert.ok(parsed, JSON.stringify(value));
    assert.deepEqual(JSON.parse(JSON.stringify(parsed.continueAfterRestart)), { turnId: "turn-7", prepared: true }, JSON.stringify(value));
    assert.equal(parsed.crashResumedTurn, undefined, JSON.stringify(value));
    assert.equal(parsed.id, "t1");
  }
});

test("a malformed continuation stamp reads as unstamped — an older host's marker — never an unreadable head", () => {
  // The stamp is optional state the host writes; a bad one must not turn the
  // thread's meta.json into one nothing can read. Unstamped, the marker keeps
  // the older rule: continued only while the head still reads running.
  for (const value of [7, null, true, { at: "2026-09-27T08:00:00.000Z" }, ["2026-09-27T08:00:00.000Z"]]) {
    const parsed = parseAgentThreadHead({
      ...persistedHead,
      continueAfterRestart: { turnId: "turn-7", prepared: true, markedAt: value },
      goalHeldForHandover: true
    });
    assert.ok(parsed, JSON.stringify(value));
    assert.equal(parsed.continueAfterRestart?.turnId, "turn-7", JSON.stringify(value));
    assert.equal(parsed.continueAfterRestart?.prepared, true, JSON.stringify(value));
    assert.equal(parsed.continueAfterRestart?.markedAt, undefined, JSON.stringify(value));
    assert.deepEqual(
      JSON.parse(JSON.stringify(parsed.continueAfterRestart)),
      { turnId: "turn-7", prepared: true },
      "written back unstamped"
    );
    assert.equal(parsed.goalHeldForHandover, true, "the rest of the head is untouched");
    assert.equal(parsed.id, "t1");
  }
});
