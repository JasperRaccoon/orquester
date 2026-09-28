// The failover matrix (spec §5.4, §9): a usage limit or an auth failure never fails the block while
// an eligible candidate remains in its chain.

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentChainEntry, AgentHop } from "@orquester/api";
import type { NodeResult } from "../contracts.ts";
import type { AgentBlockOutput } from "./executor.ts";
import { AUTONOMY_NOTE, CONTINUE_AFTER_SWITCH, handoffNotice } from "./prompt.ts";
import { byAccount, type ProviderStep } from "./testing/fake-chat-host.ts";
import { account, agentNode, testWorkflow } from "./testing/fake-context.ts";
import { Scenario } from "./testing/scenario.ts";

const CLAUDE = [account("claude", "a1", "alpha"), account("claude", "a2", "beta"), account("claude", "a3", "gamma")];
const CODEX = [account("codex", "c1", "cx-one"), account("codex", "c2", "cx-two")];
const FIXED = { strategy: "fixed", includeSystem: false, soonestResetWindow: "weekly", leastUsedMetric: "max", unknownUsage: "last" } as const;
const HOUR = 60 * 60_000;

function chain(...entries: [string, string, string[]?][]): AgentChainEntry[] {
  return entries.map(([agent, model, accounts]) => ({ agent, model, accounts: { ...FIXED, ...(accounts ? { accounts } : {}) } }));
}

function outputOf(result: NodeResult): AgentBlockOutput {
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  return (result as { output: AgentBlockOutput }).output;
}

function errorOf(result: NodeResult): { kind: string; message: string; detail?: unknown } {
  assert.equal(result.status, "failed", JSON.stringify(result));
  return (result as { error: { kind: string; message: string; detail?: unknown } }).error;
}

const ok = (text = "finished"): ProviderStep[] => [{ kind: "say", text }];
const limitAt = (sc: Scenario, inMs = HOUR) => new Date(sc.clock.now().getTime() + inMs).toISOString();

/** The same-family switch of §5.4 step 3: interrupt, idle, `/account`, the continue message — the session kept. */
function assertSwitched(sc: Scenario, out: AgentBlockOutput, accounts: string[]): void {
  assert.equal(sc.host.sessions.size, 1, "the session is kept");
  assert.deepEqual(out.hops.map((h) => h.accountId), accounts);
  assert.deepEqual(out.hops.map((h) => h.via), ["initial", ...accounts.slice(1).map(() => "switched")]);
  const session = sc.host.session(out.sessionId);
  const switches = session.commands.filter((c) => c.name === "account" && !c.deduped).map((c) => c.body.accountId);
  assert.deepEqual(switches, accounts.slice(1));
  const continues = sc.host.turnLog.filter((t) => t.input === `${CONTINUE_AFTER_SWITCH}\n\n${AUTONOMY_NOTE}`);
  assert.equal(continues.length, accounts.length - 1, "one continue message per switch");
  for (const hop of out.hops.slice(0, -1)) assert.equal(hop.reason, "usage_limit");
}

test("limit at create (the provider never starts): switch account in the same session", async () => {
  const sc = new Scenario({ accounts: CLAUDE, behaviour: byAccount({ a1: [{ kind: "limit", atStart: true }], a2: ok("done on beta") }) });
  const out = outputOf((await sc.run(testWorkflow([agentNode("n1")]), "n1")).result);
  assert.equal(out.text, "done on beta");
  assert.equal(out.accountId, "a2");
  assertSwitched(sc, out, ["a1", "a2"]);
});

test("limit at turn start: switch account", async () => {
  const sc = new Scenario({ accounts: CLAUDE, behaviour: byAccount({ a1: [{ kind: "limit" }], a2: ok() }) });
  const out = outputOf((await sc.run(testWorkflow([agentNode("n1")]), "n1")).result);
  assertSwitched(sc, out, ["a1", "a2"]);
});

test("limit mid-turn: the partial work stays in the session and the new account continues it", async () => {
  const sc = new Scenario({
    accounts: CLAUDE,
    behaviour: byAccount({ a1: [{ kind: "say", text: "half done" }, { kind: "wait", ms: 30_000 }, { kind: "limit" }], a2: ok("rest done") })
  });
  const out = outputOf((await sc.run(testWorkflow([agentNode("n1")]), "n1")).result);
  assert.equal(out.text, "rest done");
  assertSwitched(sc, out, ["a1", "a2"]);
});

test("limit while parked (Claude's warning, turn still running): cooled until resetsAt, interrupted, switched", async () => {
  const sc = new Scenario({ accounts: CLAUDE, behaviour: () => [] });
  const resetsAt = limitAt(sc, 3 * HOUR);
  sc.host.behaviour = byAccount({ a1: [{ kind: "say", text: "working" }, { kind: "limit", parked: true, resetsAt }], a2: ok() });
  const out = outputOf((await sc.run(testWorkflow([agentNode("n1")]), "n1")).result);
  assertSwitched(sc, out, ["a1", "a2"]);
  assert.equal(out.hops[0]!.resetsAt, resetsAt);
  assert.equal(sc.cooldowns.entries["claude:a1"]!.until, resetsAt);
  assert.equal(sc.cooldowns.entries["claude:a1"]!.reason, "usage_limit");
  const first = sc.host.session(out.sessionId).turns[0]!;
  assert.equal(first.state, "interrupted", "the parked turn was interrupted");
});

test("a legacy limit row (no reason field, only the adapter's prefix) still fails over", async () => {
  const sc = new Scenario({ accounts: CLAUDE, behaviour: byAccount({ a1: [{ kind: "limit", legacy: true }], a2: ok() }) });
  const out = outputOf((await sc.run(testWorkflow([agentNode("n1")]), "n1")).result);
  assertSwitched(sc, out, ["a1", "a2"]);
});

test("limit during background work: the whole thread is interrupted, then switched", async () => {
  const sc = new Scenario({
    accounts: CLAUDE,
    behaviour: byAccount({
      a1: [{ kind: "say", text: "spawned helpers" }, { kind: "background", steps: [{ kind: "wait", ms: 40_000 }, { kind: "limit" }] }],
      a2: ok("helpers redone")
    })
  });
  const out = outputOf((await sc.run(testWorkflow([agentNode("n1")]), "n1")).result);
  assert.equal(out.text, "helpers redone");
  assertSwitched(sc, out, ["a1", "a2"]);
  const interrupts = sc.host.session(out.sessionId).commands.filter((c) => c.name === "interrupt");
  assert.ok(interrupts.every((c) => !("turnId" in c.body)), "the interrupt never names a turn");
});

test("a switch refused once (something still in flight) waits for idle again, then switches", async () => {
  const sc = new Scenario({ accounts: CLAUDE, behaviour: byAccount({ a1: [{ kind: "limit" }], a2: ok() }) });
  sc.host.refuseAccountSwitches = 1;
  const out = outputOf((await sc.run(testWorkflow([agentNode("n1")]), "n1")).result);
  assert.equal(sc.host.sessions.size, 1);
  const session = sc.host.session(out.sessionId);
  assert.equal(session.commands.filter((c) => c.name === "account").length, 2, "refused, then accepted");
  assert.equal(out.accountId, "a2");
});

test("a switch the host keeps refusing hands off to a NEW session on the same agent's next account", async () => {
  const sc = new Scenario({ accounts: CLAUDE, behaviour: byAccount({ a1: [{ kind: "say", text: "partial" }, { kind: "limit" }], a2: ok("new session done") }) });
  sc.host.refuseAccountSwitches = 10;
  const out = outputOf((await sc.run(testWorkflow([agentNode("n1")]), "n1")).result);
  assert.equal(out.text, "new session done");
  assert.equal(sc.host.sessions.size, 2);
  assert.deepEqual(out.hops.map((h) => [h.accountId, h.via]), [["a1", "initial"], ["a2", "handoff"]]);
  assert.match(sc.host.turnLog.at(-1)!.input, /A previous agent \(claude\) was cut off by a usage limit/);
});

test("cross-family handoff: a new session with the handoff prompt (original prompt, notice, last messages, git status)", async () => {
  const sc = new Scenario({
    accounts: [account("claude", "a1", "alpha"), ...CODEX],
    behaviour: byAccount({ a1: [{ kind: "say", text: "I changed src/app.ts" }, { kind: "say", text: "Next: tests" }, { kind: "limit" }], c1: ok("codex finished") })
  });
  const wf = testWorkflow([agentNode("n1", { chain: chain(["claude", "opus"], ["codex", "gpt-5"]), prompt: { kind: "text", text: "Fix issue #7." } })]);
  const { result } = await sc.run(wf, "n1", { gitStatus: " M src/app.ts\n?? src/new.ts\n" });
  const out = outputOf(result);
  assert.equal(out.text, "codex finished");
  assert.equal(out.agent, "codex");
  assert.equal(out.accountId, "c1");
  assert.equal(sc.host.sessions.size, 2);
  assert.deepEqual(out.hops.map((h) => [h.agent, h.accountId, h.via]), [["claude", "a1", "initial"], ["codex", "c1", "handoff"]]);
  const handoff = sc.host.turnLog.find((t) => t.refId === "codex")!.input;
  assert.ok(handoff.startsWith("Fix issue #7.\n\n"), "the original prompt first");
  assert.ok(handoff.includes(handoffNotice("claude")));
  assert.ok(handoff.includes("I changed src/app.ts\n\nNext: tests"), "the previous agent's messages");
  assert.ok(handoff.includes(" M src/app.ts\n?? src/new.ts"), "git status --short");
  assert.ok(handoff.endsWith(AUTONOMY_NOTE));
  const create = sc.host.calls.filter((c) => c.method === "POST" && c.path === "/api/sessions")[1]!.body as Record<string, unknown>;
  assert.deepEqual(create.owner, { kind: "workflow", workflowId: "wf-1", runId: "run-1", nodeId: "n1" }, "the same owner");
  assert.equal(create.accountId, "c1");
});

test("the handoff caps the previous messages at 32 KiB (newest kept) and git status at 8 KiB", async () => {
  const big = "x".repeat(40 * 1024);
  const sc = new Scenario({
    accounts: [account("claude", "a1"), ...CODEX],
    behaviour: byAccount({ a1: [{ kind: "say", text: `old ${big}` }, { kind: "say", text: "NEWEST" }, { kind: "limit" }], c1: ok() })
  });
  const wf = testWorkflow([agentNode("n1", { chain: chain(["claude", "opus"], ["codex", "gpt-5"]) })]);
  await sc.run(wf, "n1", { gitStatus: `${"M f\n".repeat(4 * 1024)}` });
  const handoff = sc.host.turnLog.find((t) => t.refId === "codex")!.input;
  assert.ok(handoff.includes("NEWEST"));
  assert.ok(Buffer.byteLength(handoff) < 32 * 1024 + 8 * 1024 + 2 * 1024);
});

test("OpenCode has no accounts: a limit goes to the next chain entry", async () => {
  const sc = new Scenario({ accounts: CLAUDE, behaviour: byAccount({ opencode: [{ kind: "limit" }], a1: ok("claude took over") }) });
  const wf = testWorkflow([agentNode("n1", { chain: chain(["opencode", "oc/model"], ["claude", "opus"]) })]);
  const out = outputOf((await sc.run(wf, "n1")).result);
  assert.equal(out.text, "claude took over");
  assert.equal(sc.host.commandCount("account"), 0, "no account switch on OpenCode");
  assert.deepEqual(out.hops.map((h) => [h.agent, h.accountId, h.via]), [["opencode", "system", "initial"], ["claude", "a1", "handoff"]]);
});

test("chain exhausted: fails all_burnt with every hop and skip", async () => {
  const sc = new Scenario({ accounts: [account("claude", "a1", "alpha"), account("claude", "a2", "beta"), ...CODEX], behaviour: () => [{ kind: "limit" }] });
  const wf = testWorkflow([agentNode("n1", { chain: chain(["claude", "opus"], ["codex", "gpt-5"]) })]);
  const { result } = await sc.run(wf, "n1");
  const error = errorOf(result);
  assert.equal(error.kind, "all_burnt");
  const detail = error.detail as { hops: AgentHop[]; skipped: { accountId: string; why: string }[] };
  assert.deepEqual(detail.hops.map((h) => h.accountId), ["a1", "a2", "c1", "c2"]);
  assert.ok(detail.hops.every((h) => h.reason === "usage_limit"));
  assert.deepEqual(new Set(detail.skipped.map((s) => s.accountId)), new Set(["a1", "a2", "c1", "c2"]));
  assert.match(error.message, /claude\/alpha → usage limit/);
});

test("wait-for-reset: waits until the earliest reset, then resumes in the same session on that account", async () => {
  const sc = new Scenario({ accounts: [account("claude", "a1", "alpha")], behaviour: () => [] });
  const resetsAt = limitAt(sc, 2 * HOUR);
  let calls = 0;
  sc.host.behaviour = () => (++calls === 1 ? [{ kind: "limit", resetsAt }] : ok("after the reset"));
  const wf = testWorkflow([agentNode("n1", { whenAllBurnt: { kind: "wait-for-reset", maxWaitHours: 5 }, maxMinutes: 60 })]);
  const { result, fc } = await sc.run(wf, "n1");
  const out = outputOf(result);
  assert.equal(out.text, "after the reset");
  assert.equal(sc.host.sessions.size, 1);
  assert.deepEqual(out.hops.map((h) => [h.accountId, h.via]), [["a1", "initial"], ["a1", "resumed"]]);
  assert.ok(sc.clock.now().getTime() >= Date.parse(resetsAt));
  assert.ok(fc.updates.some((u) => u.waitingUntil === resetsAt), "the block shows what it waits for");
  const waiting = fc.persisted.find((p) => p?.kind === "agent" && p.phase === "waiting-reset");
  assert.ok(waiting, "the wait is persisted");
});

test("wait-for-reset refuses a reset beyond maxWaitHours", async () => {
  const sc = new Scenario({ accounts: [account("claude", "a1")], behaviour: () => [] });
  sc.host.behaviour = () => [{ kind: "limit", resetsAt: limitAt(sc, 10 * HOUR) }];
  const wf = testWorkflow([agentNode("n1", { whenAllBurnt: { kind: "wait-for-reset", maxWaitHours: 5 } })]);
  const error = errorOf((await sc.run(wf, "n1")).result);
  assert.equal(error.kind, "all_burnt");
  assert.match(error.message, /within 5 h/);
});

test("an auth failure skips the account (1 h cooldown, unusable for the run) and fails over", async () => {
  const sc = new Scenario({ accounts: CLAUDE, behaviour: byAccount({ a1: [{ kind: "auth" }], a2: ok() }) });
  const start = sc.clock.now().getTime();
  const out = outputOf((await sc.run(testWorkflow([agentNode("n1")]), "n1")).result);
  assert.equal(out.accountId, "a2");
  assert.equal(out.hops[0]!.reason, "auth");
  const cooldown = sc.cooldowns.entries["claude:a1"]!;
  assert.equal(cooldown.reason, "auth");
  assert.equal(Date.parse(cooldown.until), start + HOUR + (Date.parse(cooldown.setAt) - start));
});

test("at most 12 hops: a chain of 14 burnt accounts gives up with limit_exceeded", async () => {
  const many = Array.from({ length: 14 }, (_, i) => account("claude", `acc${i}`));
  const sc = new Scenario({ accounts: many, behaviour: () => [{ kind: "limit" }] });
  const error = errorOf((await sc.run(testWorkflow([agentNode("n1")]), "n1")).result);
  assert.equal(error.kind, "limit_exceeded");
  assert.equal((error.detail as { hops: AgentHop[] }).hops.length, 12);
});

test("the cooldown is shared: the next block skips the burnt account", async () => {
  const sc = new Scenario({ accounts: CLAUDE, behaviour: byAccount({ a1: [{ kind: "limit" }], a2: ok(), a3: ok() }) });
  const wf = testWorkflow([agentNode("n1"), agentNode("n2")]);
  outputOf((await sc.run(wf, "n1")).result);
  const { result, fc } = await sc.run(wf, "n2");
  const out = outputOf(result);
  assert.equal(out.accountId, "a2", "a1 is cooling down");
  assert.equal(out.hops.length, 1);
  const selection = fc.live().selection!;
  assert.ok(selection.skipped.some((s) => s.accountId === "a1" && s.why === "cooldown"));
});

test("a hop never burns the same account twice unless its cooldown expired", async () => {
  const sc = new Scenario({ accounts: [account("claude", "a1"), account("claude", "a2")], behaviour: () => [{ kind: "limit" }] });
  const error = errorOf((await sc.run(testWorkflow([agentNode("n1")]), "n1")).result);
  const hops = (error.detail as { hops: AgentHop[] }).hops;
  assert.deepEqual(hops.map((h) => h.accountId), ["a1", "a2"]);
});

test("a model the catalogue does not list skips its chain entry (why: catalog) and the next entry runs", async () => {
  const sc = new Scenario({ accounts: [...CLAUDE, ...CODEX], behaviour: () => ok("codex ran") });
  const wf = testWorkflow([agentNode("n1", { chain: chain(["claude", "no-such-model"], ["codex", "gpt-5"]) })]);
  const { result, fc } = await sc.run(wf, "n1");
  const out = outputOf(result);
  assert.equal(out.agent, "codex");
  assert.ok(fc.live().selection!.skipped.some((s) => s.why === "catalog" && s.agent === "claude"));
});
