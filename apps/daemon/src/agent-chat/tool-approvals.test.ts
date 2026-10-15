import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import Fastify from "fastify";
import {
  ADMIN_APPROVAL_TIMEOUT_MS,
  MAX_PENDING_TOOL_APPROVALS_PER_THREAD,
  TOOL_APPROVAL_LIMIT,
  TOOL_APPROVAL_SUMMARY_MAX_BYTES,
  type AgentChatToolApprovalEventPayload,
  type CallerPrincipal
} from "@orquester/api/agent-chat";

import {
  registerToolApprovalRoutes,
  ToolApprovalAnswerRefusal,
  ToolApprovalRegistry,
  type ToolApprovalClock,
  type ToolApprovalOpenInput
} from "./tool-approvals.ts";

/** A clock the test advances by hand: no sleeps. */
class FakeClock implements ToolApprovalClock {
  private t = Date.parse("2026-10-15T10:00:00.000Z");
  private timers = new Map<number, { at: number; fn: () => void }>();
  private next = 1;
  now(): number {
    return this.t;
  }
  setTimer(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimer(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  advance(ms: number): void {
    this.t += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.t) {
        this.timers.delete(id);
        timer.fn();
      }
    }
  }
  get armed(): number {
    return this.timers.size;
  }
}

function card(over: Partial<ToolApprovalOpenInput> = {}): ToolApprovalOpenInput {
  return {
    threadId: "t1",
    tool: "edit_agent_profile",
    kind: "admin",
    family: "agent-profile",
    title: "Claude wants to add the skill `release-notes` to Claude Code",
    scope: { label: "Global — every Claude Code chat" },
    reason: "The user asked for release notes.",
    sections: [{ kind: "code", title: "SKILL.md", text: "---\nname: release-notes\n---\nWrite notes." }],
    secretFields: [],
    grantOptions: [],
    ...over
  };
}

function harness(opts: { journalFile?: string; timeoutMs?: number } = {}) {
  const clock = new FakeClock();
  const events: AgentChatToolApprovalEventPayload[] = [];
  const logs: string[] = [];
  const changes: string[] = [];
  let n = 0;
  const registry = new ToolApprovalRegistry({
    publish: (payload) => events.push(payload),
    onChange: (threadId) => changes.push(threadId),
    log: (line) => logs.push(line),
    clock,
    newId: () => `a${++n}`,
    ...(opts.journalFile ? { journalFile: opts.journalFile } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {})
  });
  return { registry, clock, events, logs, changes };
}

test("approve: the waiting call gets the outcome; opened/closed events, attention changes and one log line", async () => {
  const h = harness();
  const waiting = h.registry.open(card(), new AbortController().signal);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]!.opened?.approvalId, "a1");
  assert.equal(h.events[0]!.opened?.expiresAt, new Date(h.clock.now() + ADMIN_APPROVAL_TIMEOUT_MS).toISOString());
  assert.deepEqual(h.registry.list("t1").map((c) => c.approvalId), ["a1"]);
  assert.deepEqual(h.registry.pendingTitles("t1"), [{ approvalId: "a1", title: "Claude wants to add the skill `release-notes` to Claude Code" }]);
  assert.deepEqual(h.changes, ["t1"]);

  const answer = await h.registry.answer("t1", "a1", { decision: "approve" });
  assert.deepEqual(answer, { ok: true, response: { ok: true, outcome: "approved" } });
  assert.deepEqual(await waiting, { outcome: "approved", approvalId: "a1" });
  assert.deepEqual(h.events[1], { threadId: "t1", closed: { approvalId: "a1", outcome: "approved" } });
  assert.deepEqual(h.changes, ["t1", "t1"]);
  assert.equal(h.registry.list("t1").length, 0);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0]!, /thread=t1 approval=a1 tool=edit_agent_profile kind=admin family=agent-profile outcome=approved/);
  assert.ok(!h.logs[0]!.includes("release-notes"), "no argument or title in the log");
  assert.equal(h.clock.armed, 0, "the deadline timer is cleared");
});

test("deny: the user's reason reaches the call, sanitised; a grant on a deny is refused", async () => {
  const h = harness();
  const waiting = h.registry.open(card(), new AbortController().signal);
  const withGrant = await h.registry.answer("t1", "a1", { decision: "deny", grant: "chat" });
  assert.equal(withGrant.ok, false);
  const denied = await h.registry.answer("t1", "a1", { decision: "deny", reason: "Not now‮ please" });
  assert.deepEqual(denied, { ok: true, response: { ok: true, outcome: "denied" } });
  assert.deepEqual(await waiting, { outcome: "denied", approvalId: "a1", reason: "Not now please" });
});

test("timeout: the deadline (injected clock) ends the wait as timed_out; a late answer is 409", async () => {
  const h = harness();
  const waiting = h.registry.open(card(), new AbortController().signal);
  h.clock.advance(ADMIN_APPROVAL_TIMEOUT_MS - 1);
  assert.equal(h.registry.list("t1").length, 1);
  h.clock.advance(1);
  assert.deepEqual(await waiting, { outcome: "timed_out", approvalId: "a1" });
  const late = await h.registry.answer("t1", "a1", { decision: "approve" });
  assert.deepEqual(late.ok ? null : [late.status, late.code], [409, "APPROVAL_NOT_PENDING"]);
  assert.match(h.logs.at(-1)!, /outcome=timed_out/);
});

test("cancel: the call's signal (abort, Stop, session end) ends the wait as cancelled", async () => {
  const h = harness();
  const controller = new AbortController();
  const waiting = h.registry.open(card(), controller.signal);
  controller.abort();
  assert.deepEqual(await waiting, { outcome: "cancelled", approvalId: "a1", reason: "aborted" });
  assert.deepEqual(h.events.at(-1), { threadId: "t1", closed: { approvalId: "a1", outcome: "cancelled" } });
  assert.equal(h.clock.armed, 0);
  // An already-aborted signal opens no card.
  const pre = new AbortController();
  pre.abort();
  assert.deepEqual(await h.registry.open(card(), pre.signal), { outcome: "cancelled", approvalId: "a2", reason: "aborted" });
  assert.equal(h.events.filter((e) => e.opened).length, 1);
});

test("a closed chat cancels its cards; shutdown cancels every card", async () => {
  const h = harness();
  const a = h.registry.open(card(), new AbortController().signal);
  const b = h.registry.open(card({ threadId: "t2" }), new AbortController().signal);
  h.registry.cancelThread("t1");
  assert.deepEqual(await a, { outcome: "cancelled", approvalId: "a1", reason: "closed" });
  assert.equal(h.registry.list("t2").length, 1);
  await h.registry.shutdown();
  assert.deepEqual(await b, { outcome: "cancelled", approvalId: "a2", reason: "restarting" });
});

test("two clients: the first answer wins, the second is 409; unknown cards are 404; another thread's card is 404", async () => {
  const h = harness();
  const waiting = h.registry.open(card(), new AbortController().signal);
  const [first, second] = await Promise.all([
    h.registry.answer("t1", "a1", { decision: "approve" }),
    h.registry.answer("t1", "a1", { decision: "deny" })
  ]);
  assert.equal(first.ok, true);
  assert.deepEqual(second.ok ? null : [second.status, second.code], [409, "APPROVAL_NOT_PENDING"]);
  assert.equal((await waiting).outcome, "approved");
  const unknown = await h.registry.answer("t1", "nope", { decision: "approve" });
  assert.deepEqual(unknown.ok ? null : [unknown.status, unknown.code], [404, "APPROVAL_NOT_FOUND"]);
  h.registry.open(card(), new AbortController().signal);
  const other = await h.registry.answer("t2", "a2", { decision: "approve" });
  assert.deepEqual(other.ok ? null : other.status, 404);
});

test("a grant outside grantOptions is 400 and the card stays pending; an offered grant is accepted", async () => {
  const h = harness();
  let committed: unknown = null;
  const waiting = h.registry.open(card({ family: "desktops", tool: "control_desktop", grantOptions: ["chat"] }), new AbortController().signal, {
    commitApproval: (answer) => {
      committed = answer.grant;
      return { grantId: "g1" };
    }
  });
  const bad = await h.registry.answer("t1", "a1", { decision: "approve", grant: "project" });
  assert.deepEqual(bad.ok ? null : [bad.status, bad.code], [400, "INVALID_ARGUMENT"]);
  assert.equal(h.registry.list("t1").length, 1);
  const ok = await h.registry.answer("t1", "a1", { decision: "approve", grant: "chat" });
  assert.deepEqual(ok, { ok: true, response: { ok: true, outcome: "approved", grantId: "g1" } });
  assert.equal(committed, "chat");
  assert.deepEqual(await waiting, { outcome: "approved", approvalId: "a1", grantId: "g1", grantChosen: "chat" });
  assert.match(h.logs.at(-1)!, /outcome=approved \(grant=chat\)/);
});

test("a refused preparation keeps the card pending; the deadline winning during preparation makes the answer 409", async () => {
  const h = harness();
  let refuse = true;
  const waiting = h.registry.open(card({ family: "desktops", grantOptions: ["chat"] }), new AbortController().signal, {
    prepareApproval: async () => {
      if (refuse) throw new ToolApprovalAnswerRefusal("INVALID_ARGUMENT", "This chat is no longer in Full access: approve without a grant.");
      h.clock.advance(ADMIN_APPROVAL_TIMEOUT_MS);
    }
  });
  const refused = await h.registry.answer("t1", "a1", { decision: "approve", grant: "chat" });
  assert.deepEqual(refused.ok ? null : [refused.status, refused.message], [400, "This chat is no longer in Full access: approve without a grant."]);
  assert.equal(h.registry.list("t1").length, 1);
  refuse = false;
  const late = await h.registry.answer("t1", "a1", { decision: "approve", grant: "chat" });
  assert.deepEqual(late.ok ? null : late.status, 409);
  assert.equal((await waiting).outcome, "timed_out");
});

test("card secrets go to the waiting call only: never in events, summaries, details, logs or the journal", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-approvals-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const journalFile = join(dir, "agent-tool-approvals.json");
  const h = harness({ journalFile });
  const secret = "sk-live-VERY-SECRET-0123456789";
  const waiting = h.registry.open(
    card({ tool: "set_workflow_secret", family: "workflow-secrets", secretFields: [{ key: "value", label: "Secret value" }] }),
    new AbortController().signal
  );
  const missing = await h.registry.answer("t1", "a1", { decision: "approve" });
  assert.equal(missing.ok, false, "every secret field needs a value");
  const answered = await h.registry.answer("t1", "a1", { decision: "approve", secrets: { value: secret } });
  assert.ok(answered.ok && !JSON.stringify(answered).includes(secret), "the response never echoes it");
  assert.deepEqual(await waiting, { outcome: "approved", approvalId: "a1", secrets: { value: secret } });
  await h.registry.shutdown();
  const everything = JSON.stringify([h.events, h.logs, h.registry.list("t1"), await readFile(journalFile, "utf8")]);
  assert.ok(!everything.includes(secret));
});

test("agent-derived text is sanitised: bidi/control/zero-width stripped from labels, escaped in code", async () => {
  const h = harness();
  void h.registry.open(
    card({
      title: "Claude wants\nto add ‮evil​",
      reason: "because⁦ hidden\u0007",
      scope: { label: "Project‮ ws/p" },
      sections: [{ kind: "code", title: "run.sh", text: "echo hi‮" }],
      secretFields: [{ key: "k", label: "Token​" }]
    }),
    new AbortController().signal
  );
  const [summary] = h.registry.list("t1");
  assert.equal(summary!.title, "Claude wants to add evil");
  assert.equal(summary!.reason, "because hidden");
  assert.equal(summary!.scope.label, "Project ws/p");
  assert.deepEqual(summary!.sections, [{ kind: "code", title: "run.sh", text: "echo hi<U+202E>" }]);
  assert.deepEqual(summary!.secretFields, [{ key: "k", label: "Token" }]);
  await h.registry.shutdown();
});

test("long previews: the summary is cut to 64 KiB and marked fullPreview; the detail has it all; over 1 MiB is PREVIEW_TOO_LARGE", async () => {
  const h = harness();
  const text = "x".repeat(200 * 1024);
  void h.registry.open(card({ sections: [{ kind: "code", title: "big", text }] }), new AbortController().signal);
  const [summary] = h.registry.list("t1");
  assert.equal(summary!.fullPreview, true);
  assert.ok(Buffer.byteLength(JSON.stringify(summary!.sections)) <= TOOL_APPROVAL_SUMMARY_MAX_BYTES);
  assert.equal(JSON.stringify(h.events[0]!.opened!.sections), JSON.stringify(summary!.sections), "the bus carries the summary");
  const detail = h.registry.detail("t1", "a1");
  assert.equal(detail!.fullPreview, false);
  assert.deepEqual(detail!.sections, [{ kind: "code", title: "big", text }]);
  assert.equal(h.registry.detail("t2", "a1"), null);
  await assert.rejects(
    h.registry.open(card({ sections: [{ kind: "code", title: "huge", text: "y".repeat(1024 * 1024 + 1) }] }), new AbortController().signal),
    (error: Error & { code?: string }) => error.code === "PREVIEW_TOO_LARGE"
  );
  assert.equal(h.registry.list("t1").length, 1, "no card for a too-large preview");
  await h.registry.shutdown();
});

test("an approved call whose result never reached the host closes again as not_delivered", async () => {
  const h = harness();
  let deliver!: (ok: boolean) => void;
  const delivered = new Promise<boolean>((resolve) => (deliver = resolve));
  const waiting = h.registry.open(card(), new AbortController().signal, { delivered });
  await h.registry.answer("t1", "a1", { decision: "approve" });
  await waiting;
  deliver(false);
  // The registry's own `then` was attached first, so it has run once this await resumes.
  await delivered;
  assert.deepEqual(h.events.at(-1), { threadId: "t1", closed: { approvalId: "a1", outcome: "not_delivered" } });
});

test("a daemon that died with cards open resolves them as cancelled at the next boot — never approved", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-approvals-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const journalFile = join(dir, "agent-tool-approvals.json");
  const before = harness({ journalFile });
  void before.registry.open(card(), new AbortController().signal);
  void before.registry.open(card({ threadId: "t2", tool: "run_workflow", family: "workflows" }), new AbortController().signal);
  // Let the journal writes land (the process then "dies": no shutdown).
  await before.registry["journalWrites"];
  const journal = JSON.parse(await readFile(journalFile, "utf8")) as { open: unknown[] };
  assert.equal(journal.open.length, 2);
  assert.ok(!JSON.stringify(journal).includes("release-notes"), "ids and kinds only");

  const after = harness({ journalFile });
  await after.registry.recover();
  assert.deepEqual(after.events, [
    { threadId: "t1", closed: { approvalId: "a1", outcome: "cancelled" } },
    { threadId: "t2", closed: { approvalId: "a2", outcome: "cancelled" } }
  ]);
  assert.equal(after.logs.length, 2);
  assert.ok(after.logs.every((line) => line.includes("outcome=cancelled (Orquester restarted)")));
  const late = await after.registry.answer("t1", "a1", { decision: "approve" });
  assert.deepEqual(late.ok ? null : [late.status, late.code], [404, "APPROVAL_NOT_FOUND"], "the old card is gone (spec §13) and can never be approved");
  assert.deepEqual((JSON.parse(await readFile(journalFile, "utf8")) as { open: unknown[] }).open, []);
  // A garbled journal is ignored.
  await writeFile(journalFile, "{not json");
  const third = harness({ journalFile });
  await third.registry.recover();
  assert.equal(third.events.length, 0);
});

test("routes: list, detail, answer; only a person answers (agent and external principals 403); unknown chat 404", async () => {
  const h = harness();
  const app = Fastify();
  let principal: CallerPrincipal | undefined;
  app.addHook("onRequest", async (request) => {
    if (principal) (request as unknown as { principal: CallerPrincipal }).principal = principal;
  });
  registerToolApprovalRoutes(app, { registry: h.registry, isChatSession: (id) => id === "t1" });
  try {
    const waiting = h.registry.open(card({ secretFields: [{ key: "v", label: "Value" }] }), new AbortController().signal);
    const list = await app.inject({ method: "GET", url: "/api/sessions/t1/tool-approvals" });
    assert.equal(list.statusCode, 200);
    assert.deepEqual((list.json() as { approvals: { approvalId: string }[] }).approvals.map((a) => a.approvalId), ["a1"]);
    assert.equal((await app.inject({ method: "GET", url: "/api/sessions/zz/tool-approvals" })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/api/sessions/t1/tool-approvals/a1" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/sessions/t1/tool-approvals/nope" })).statusCode, 404);
    for (const p of [{ kind: "agent", threadId: "t1", projectPath: "/w/p" }, { kind: "external", credentialId: "c" }] as CallerPrincipal[]) {
      principal = p;
      const refused = await app.inject({ method: "POST", url: "/api/sessions/t1/tool-approvals/a1", payload: { decision: "approve", secrets: { v: "agent-typed-value" } } });
      assert.equal(refused.statusCode, 403);
      assert.equal((refused.json() as { error: { code: string } }).error.code, "PERMISSION_DENIED");
      assert.ok(!refused.body.includes("agent-typed-value"));
    }
    principal = undefined;
    assert.equal(h.registry.list("t1").length, 1, "the refused answers changed nothing");
    const bad = await app.inject({ method: "POST", url: "/api/sessions/t1/tool-approvals/a1", payload: { decision: "approve", grant: "chat", secrets: { v: "x1234" } } });
    assert.equal(bad.statusCode, 400);
    assert.ok(!bad.body.includes("x1234"));
    const ok = await app.inject({ method: "POST", url: "/api/sessions/t1/tool-approvals/a1", payload: { decision: "approve", secrets: { v: "the-typed-value" } } });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json(), { ok: true, outcome: "approved" });
    assert.equal((await waiting).outcome, "approved");
    const again = await app.inject({ method: "POST", url: "/api/sessions/t1/tool-approvals/a1", payload: { decision: "deny" } });
    assert.equal(again.statusCode, 409);
  } finally {
    await app.close();
  }
});

test("at most MAX_PENDING_TOOL_APPROVALS_PER_THREAD cards wait per chat (APPROVAL_LIMIT); other chats are not affected", async () => {
  const h = harness();
  for (let i = 0; i < MAX_PENDING_TOOL_APPROVALS_PER_THREAD; i += 1) void h.registry.open(card(), new AbortController().signal);
  await assert.rejects(h.registry.open(card(), new AbortController().signal), (e: Error & { code?: string }) => e.code === TOOL_APPROVAL_LIMIT);
  assert.equal(h.registry.list("t1").length, MAX_PENDING_TOOL_APPROVALS_PER_THREAD);
  void h.registry.open(card({ threadId: "t2" }), new AbortController().signal);
  assert.equal(h.registry.list("t2").length, 1);
  // One answered frees a slot.
  await h.registry.answer("t1", "a1", { decision: "deny" });
  void h.registry.open(card(), new AbortController().signal);
  assert.equal(h.registry.list("t1").length, MAX_PENDING_TOOL_APPROVALS_PER_THREAD);
  await h.registry.shutdown();
});

test("a read-only store refusing the approval's write answers 503 AGENT_TOOLS_UNAVAILABLE and keeps the card", async () => {
  const h = harness();
  let readOnly = true;
  const waiting = h.registry.open(card(), new AbortController().signal, {
    commitApproval: () => {
      if (readOnly) throw Object.assign(new Error("read-only"), { status: 503, code: "AGENT_TOOLS_UNAVAILABLE" });
      return {};
    }
  });
  const refused = await h.registry.answer("t1", "a1", { decision: "approve" });
  assert.deepEqual(refused.ok ? null : [refused.status, refused.code], [503, "AGENT_TOOLS_UNAVAILABLE"]);
  assert.match(refused.ok ? "" : refused.message, /read-only/);
  assert.equal(h.registry.list("t1").length, 1);
  readOnly = false;
  assert.ok((await h.registry.answer("t1", "a1", { decision: "approve" })).ok);
  assert.equal((await waiting).outcome, "approved");
});
