/**
 * Thread lineage's persisted shapes (spec 2026-10-14 §6): the tab record's and
 * the head's `lineage`, the fork handoff and the merge outbox — all tolerant.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseAgentThreadHead,
  parseForkHandoff,
  parseMergeOutbox,
  parseSessionsConfig
} from "./index.ts";

const LINEAGE = {
  parentThreadId: "parent-1",
  relation: "fork",
  forkedFrom: { messageId: "m1", turnId: "t1" },
  createdAt: "2026-10-14T00:00:00.000Z"
};

const chatRecord = (extra: Record<string, unknown> = {}) => ({
  id: "child-1",
  title: "Child",
  order: 0,
  projectPath: "/w/p",
  refId: "claude",
  kind: "agent-chat",
  cwd: "/w/p",
  createdAt: "2026-10-14T00:00:00.000Z",
  chat: { threadId: "child-1", accountId: "", home: "system", lastSeq: 0 },
  ...extra
});

test("a tab record keeps its lineage, and drops one it cannot read — never the record", () => {
  const kept = parseSessionsConfig({ version: 1, sessions: [chatRecord({ lineage: LINEAGE })] });
  assert.deepEqual(kept.sessions[0]?.lineage, LINEAGE);

  const bad = parseSessionsConfig({
    version: 1,
    sessions: [chatRecord({ lineage: { parentThreadId: "", relation: "adopt" } })]
  });
  assert.equal(bad.sessions.length, 1);
  assert.equal(bad.sessions[0]?.lineage, undefined);

  const old = parseSessionsConfig({ version: 1, sessions: [chatRecord()] });
  assert.equal(old.sessions[0]?.lineage, undefined);
});

test("a fork point that does not read is dropped on its own", () => {
  const parsed = parseSessionsConfig({
    version: 1,
    sessions: [chatRecord({ lineage: { ...LINEAGE, forkedFrom: { messageId: 1 } } })]
  });
  assert.deepEqual(parsed.sessions[0]?.lineage, { ...LINEAGE, forkedFrom: undefined });
});

test("the head keeps its lineage, and a malformed one reads as none", () => {
  const head = {
    id: "child-1",
    projectPath: "/w/p",
    cwd: "/w/p",
    title: "Child",
    adapter: "claude",
    refId: "claude",
    accountId: "",
    home: "system",
    modelSelection: { model: "m" },
    runtimeMode: "approval-required",
    session: { status: "idle", activeTurnId: null },
    turnCount: 0,
    seq: 1,
    createdAt: "x",
    updatedAt: "x"
  };
  assert.deepEqual(parseAgentThreadHead({ ...head, lineage: LINEAGE })?.lineage, LINEAGE);
  const malformed = parseAgentThreadHead({ ...head, lineage: "nope" });
  assert.ok(malformed);
  assert.equal(malformed?.lineage, undefined);
});

test("the fork handoff reads whole or not at all", () => {
  const record = { version: 1, parentThreadId: "p", transcript: "t", createdAt: "x" };
  assert.deepEqual(parseForkHandoff(record), record);
  assert.equal(parseForkHandoff({ ...record, version: 2 }), null);
  assert.equal(parseForkHandoff({ ...record, transcript: "" }), null);
  assert.equal(parseForkHandoff(null), null);
  const delivered = { ...record, deliveredTurnId: "turn-1" };
  assert.deepEqual(parseForkHandoff(delivered), delivered);
  const unreadable = parseForkHandoff({ ...record, deliveredTurnId: 7 });
  assert.equal(unreadable?.transcript, "t", "an unreadable delivery does not cost the transcript");
  assert.equal(unreadable?.deliveredTurnId, undefined, "an unreadable delivery is none");
});

test("the merge outbox keeps unreadable entries and unknown fields for the next rewrite", () => {
  const good = {
    mergeId: "m1",
    parentSessionId: "p",
    childSessionId: "c",
    input: "hello",
    queuedAt: "x",
    fromNewerBuild: 7
  };
  const parsed = parseMergeOutbox({ version: 1, entries: [good, { mergeId: 3 }, "junk"] });
  assert.equal(parsed.entries.length, 1);
  assert.equal((parsed.entries[0] as Record<string, unknown>).fromNewerBuild, 7);
  // An entry from before the failure state reads as queued, untried; a bad state as queued.
  assert.equal(parsed.entries[0]!.state, "queued");
  assert.equal(parsed.entries[0]!.attempts, 0);
  const failed = parseMergeOutbox({ entries: [{ ...good, state: "failed", attempts: 2, error: "no" }, { ...good, mergeId: "m2", state: "weird" }] });
  assert.deepEqual(failed.entries.map((entry) => [entry.state, entry.attempts, entry.error]), [["failed", 2, "no"], ["queued", 0, undefined]]);
  assert.deepEqual(parsed.unreadable, [{ mergeId: 3 }, "junk"]);
  assert.deepEqual(parseMergeOutbox("garbage"), { entries: [], unreadable: [] });
});
