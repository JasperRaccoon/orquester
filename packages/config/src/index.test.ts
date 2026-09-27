import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir } from "node:fs/promises";
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

test("assertInsideFsRoot allows in-root paths and rejects escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "fsroot-"));
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

test("a head carrying the goal-resume marker round-trips it", () => {
  const parsed = parseAgentThreadHead({ ...persistedHead, resumeGoalAfterRestart: true });
  assert.ok(parsed);
  assert.equal(parsed.resumeGoalAfterRestart, true);
  // …next to the other head-only marker, which it never disturbs.
  const both = parseAgentThreadHead({
    ...persistedHead,
    continueAfterRestart: { turnId: "turn-7" },
    resumeGoalAfterRestart: true
  });
  assert.deepEqual(both?.continueAfterRestart, { turnId: "turn-7" });
  assert.equal(both?.resumeGoalAfterRestart, true);
  // Through JSON, as meta.json holds it.
  const reread = parseAgentThreadHead(JSON.parse(JSON.stringify(parsed)));
  assert.equal(reread?.resumeGoalAfterRestart, true);
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

// --- goals §5.7: the head's `goalHeldForHandover` ---------------------------

test("a head carrying the goal-hold marker round-trips it, beside the other two", () => {
  const parsed = parseAgentThreadHead({ ...persistedHead, goalHeldForHandover: true });
  assert.ok(parsed, "the head parses");
  assert.equal(parsed.goalHeldForHandover, true);
  const all = parseAgentThreadHead({
    ...persistedHead,
    continueAfterRestart: { turnId: "turn-7" },
    resumeGoalAfterRestart: true,
    goalHeldForHandover: true
  });
  assert.deepEqual(all?.continueAfterRestart, { turnId: "turn-7" });
  assert.equal(all?.resumeGoalAfterRestart, true);
  assert.equal(all?.goalHeldForHandover, true);
  // Through JSON, as meta.json holds it.
  const reread = parseAgentThreadHead(JSON.parse(JSON.stringify(parsed)));
  assert.equal(reread?.goalHeldForHandover, true);
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
