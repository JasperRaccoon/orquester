/**
 * Thread lineage's persisted shapes (spec 2026-10-14 §6): the tab record's and
 * the head's `lineage`, the fork handoff and the merge outbox — all tolerant.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  agentChatReplyOutboxFile,
  agentToolsFile,
  parseAgentThreadHead,
  parseForkHandoff,
  parseMergeOutbox,
  parseReplyOutbox,
  serializeMergeOutbox,
  serializeReplyOutbox,
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
  const newer = { ...record, fromNewerBuild: { x: 1 } };
  assert.deepEqual(parseForkHandoff(newer), newer, "a newer build's fields survive a read, so a rewrite keeps them");
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
  for (const value of ["garbage", null, [], { entries: "no" }, { version: 2, entries: [] }]) {
    assert.throws(() => parseMergeOutbox(value), /merge outbox/, JSON.stringify(value));
  }
  // Unknown top-level keys survive a rewrite.
  const withExtra = parseMergeOutbox({ version: 1, entries: [], note: "newer" });
  assert.deepEqual(withExtra.extra, { note: "newer" });
  assert.deepEqual(JSON.parse(serializeMergeOutbox(withExtra)), { note: "newer", version: 1, entries: [] });
});

test("a lineage's delegation depth persists, and a bad one is dropped on its own", () => {
  const kept = parseSessionsConfig({ version: 1, sessions: [chatRecord({ lineage: { ...LINEAGE, relation: "delegate", delegationDepth: 2 } })] });
  assert.equal(kept.sessions[0]?.lineage?.delegationDepth, 2);
  const bad = parseSessionsConfig({ version: 1, sessions: [chatRecord({ lineage: { ...LINEAGE, delegationDepth: "deep" } })] });
  assert.equal(bad.sessions[0]?.lineage?.parentThreadId, "parent-1");
  assert.equal(bad.sessions[0]?.lineage?.delegationDepth, undefined);
});

test("a queued merge keeps its plan mode; an unknown mode is dropped, never the merge", () => {
  const entry = { mergeId: "m1", parentSessionId: "p", childSessionId: "c", input: "x", queuedAt: "t" };
  assert.equal(parseMergeOutbox({ entries: [{ ...entry, interactionMode: "plan" }] }).entries[0]?.interactionMode, "plan");
  const odd = parseMergeOutbox({ entries: [{ ...entry, interactionMode: "edit" }] }).entries[0];
  assert.equal(odd?.mergeId, "m1");
  assert.equal(odd?.interactionMode, undefined);
});

// ---------------------------------------------------------------------------
// Unified MCP (design 2026-10-15): `opened`, `agentCreated`, the delivery queue's kinds, the reply outbox
// ---------------------------------------------------------------------------

test("a tab record keeps an `opened` lineage and `agentCreated: true`; any other agentCreated is dropped on its own", () => {
  const opened = { ...LINEAGE, relation: "opened", forkedFrom: undefined, delegationDepth: 1, agentCreated: true };
  const kept = parseSessionsConfig({ version: 1, sessions: [chatRecord({ lineage: opened })] });
  assert.equal(kept.sessions[0]?.lineage?.relation, "opened");
  assert.equal(kept.sessions[0]?.lineage?.agentCreated, true);
  const odd = parseSessionsConfig({ version: 1, sessions: [chatRecord({ lineage: { ...opened, agentCreated: "yes" } })] });
  assert.equal(odd.sessions[0]?.lineage?.relation, "opened");
  assert.equal(odd.sessions[0]?.lineage?.agentCreated, undefined);
});

test("the delivery queue: merge, reply and message entries; an unknown kind is kept verbatim, never delivered as a merge", () => {
  const entry = { mergeId: "m1", parentSessionId: "p", childSessionId: "c", input: "x", queuedAt: "t" };
  const reply = {
    ...entry,
    mergeId: "r1",
    kind: "reply",
    subscriptionId: "s1",
    causedBy: { threadId: "c", exchangeId: "x1", hop: 3 },
    context: [{ kind: "thread-reply", label: "Reply from another chat", ref: "c" }]
  };
  const parsed = parseMergeOutbox({ entries: [entry, reply, { ...entry, mergeId: "q1", kind: "message" }, { ...entry, mergeId: "z", kind: "hologram" }] });
  assert.deepEqual(parsed.entries.map((e) => [e.mergeId, e.kind]), [["m1", undefined], ["r1", "reply"], ["q1", "message"]]);
  assert.deepEqual(parsed.entries[1]?.causedBy, { threadId: "c", exchangeId: "x1", hop: 3 });
  assert.equal(parsed.entries[1]?.subscriptionId, "s1");
  assert.equal(parsed.unreadable.length, 1);
  const badCause = parseMergeOutbox({ entries: [{ ...reply, causedBy: { hop: 0 } }] }).entries[0];
  assert.equal(badCause?.mergeId, "r1");
  assert.equal(badCause?.causedBy, undefined, "a bad causedBy is dropped, never the entry");
});

const subscription = {
  id: "s1",
  fromThreadId: "claude",
  toThreadId: "codex",
  commandId: "cmd-1",
  state: "waiting",
  interactionMode: "default",
  exchange: { id: "x1", hop: 2 },
  createdAt: "2026-10-15T10:00:00.000Z"
};
const delivery = {
  id: "d1",
  subscriptionId: "s1",
  toThreadId: "claude",
  fromThreadId: "codex",
  commandId: "cmd-d1",
  outcome: "reply",
  input: "[Reply from thread \"Codex review\" · session codex]\n…\n\nLGTM",
  interactionMode: "plan",
  causedBy: { threadId: "codex", exchangeId: "x1", hop: 3 },
  state: "pending",
  createdAt: "2026-10-15T10:01:00.000Z"
};

test("the reply outbox round-trips and keeps unknown fields, unknown states and unreadable entries verbatim", () => {
  const raw = {
    version: 1,
    note: "newer",
    subscriptions: [{ ...subscription, fromNewerBuild: 1 }, { ...subscription, id: "s2", state: "teleported" }, { ...subscription, id: "s1", state: "done" }, 7],
    deliveries: [delivery, { ...delivery, id: "d2", outcome: "poem" }]
  };
  const outbox = parseReplyOutbox(raw);
  assert.deepEqual(outbox.subscriptions.map((s) => [s.id, s.state]), [["s1", "waiting"]], "the first of a duplicate id wins");
  assert.equal((outbox.subscriptions[0] as Record<string, unknown>).fromNewerBuild, 1);
  assert.equal(outbox.unreadableSubscriptions.length, 3);
  assert.deepEqual(outbox.deliveries.map((d) => [d.id, d.outcome, d.interactionMode]), [["d1", "reply", "plan"]]);
  assert.equal(outbox.unreadableDeliveries.length, 1);
  assert.deepEqual(outbox.extra, { note: "newer" });
  const rewritten = JSON.parse(serializeReplyOutbox(outbox));
  assert.deepEqual(rewritten, raw, "a rewrite puts every entry back");
  assert.deepEqual(parseReplyOutbox({}), { subscriptions: [], deliveries: [], unreadableSubscriptions: [], unreadableDeliveries: [] });
});

test("the reply outbox refuses anything but a version-1 outbox", () => {
  for (const value of [null, [], "x", { version: 2 }, { subscriptions: {} }, { deliveries: "no" }]) {
    assert.throws(() => parseReplyOutbox(value), /reply outbox/, JSON.stringify(value));
  }
  // A subscription's missing interaction mode reads as default; an unknown origin is dropped on its own.
  const read = parseReplyOutbox({ subscriptions: [{ ...subscription, interactionMode: undefined, origin: "carrier-pigeon" }] });
  assert.equal(read.subscriptions[0]?.interactionMode, "default");
  assert.equal(read.subscriptions[0]?.origin, undefined);
});

test("the new stores live beside the merge outbox", () => {
  assert.equal(agentChatReplyOutboxFile("/srv/orq"), "/srv/orq/daemon/agent-reply-outbox.json");
  assert.equal(agentToolsFile("/srv/orq"), "/srv/orq/daemon/agent-tools.json");
});
