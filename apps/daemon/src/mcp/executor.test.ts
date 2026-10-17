/**
 * THE executor (unified MCP design 2026-10-15 §3.3, §14.2.2–3): strict parse per audience and its
 * stripped keys, TOOL_NOT_FOUND (no per-chat tool switch), deny / card / allow through the ApprovalPort
 * double, grants, frozen arguments and pins, PREVIEW_TOO_LARGE, the re-run gate after a card, the
 * turn policy and the exchange, the principal on every daemon request.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { agentChatRoutes, parseThreadMessage, type CallerPrincipal } from "@orquester/api/agent-chat";

import { FakeApprovalPort } from "./catalog/approval-double.ts";
import { defineTool, MUTATING, READ_ONLY, type AnyOrquesterTool, type CallContext, type ScopeClaim, type ThreadCaller } from "./catalog/contract.ts";
import type { DaemonMethod, DaemonRequestOptions, DaemonResponse } from "./daemon-api.ts";
import { audienceShape, executeToolCall, NEW_SESSION, type ExecutorDeps } from "./executor.ts";
import { head, snapshot } from "./fixtures.ts";
import { FakeDaemonApi } from "./testing.ts";

/** A FakeDaemonApi that also records each request's principal. */
class PrincipalApi extends FakeDaemonApi {
  principals: (CallerPrincipal | undefined)[] = [];
  override async request(method: DaemonMethod, path: string, opts?: DaemonRequestOptions): Promise<DaemonResponse> {
    this.principals.push(opts?.principal);
    return super.request(method, path, opts);
  }
}

// Real directories: the gate canonicalises projects and refuses one that no longer exists (§13).
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "umcp-exec-")));
const WS = join(ROOT, "w");
const OWN = join(WS, "acme/api");
const SAME = join(WS, "acme/web");
const OTHER = join(WS, "beta/app");
for (const dir of [OWN, SAME, OTHER]) mkdirSync(dir, { recursive: true });
test.after(() => rmSync(ROOT, { recursive: true, force: true }));

function caller(over: Partial<ThreadCaller> = {}): ThreadCaller {
  return {
    kind: "thread", threadId: "me", title: "Implement auth", projectPath: OWN, workspace: "acme", cwd: OWN, agentId: "claude", callId: "call-1",
    runtimeMode: "full-access", planning: false, workflowOwned: false, exchange: null, ...over
  };
}

const claim = (over: Partial<ScopeClaim> = {}): ScopeClaim => ({ projects: [], sessions: [], reads: "none", writes: false, causesTurnIn: [], ...over });

/** One tool per behaviour; `runs` records what `run` saw. */
function rig(over: { tools?: AnyOrquesterTool[]; port?: FakeApprovalPort | null; deps?: Partial<ExecutorDeps> } = {}) {
  const runs: { args: Record<string, unknown>; ctx: CallContext }[] = [];
  const record = (args: Record<string, unknown>, ctx: CallContext) => {
    runs.push({ args, ctx });
    return { done: true };
  };
  const tools: AnyOrquesterTool[] = [
    defineTool({
      name: "both_ways", title: "Both ways", description: "d", input: { text: z.string(), delegate: z.boolean().optional(), value: z.string().optional() },
      chatOnlyInput: ["delegate"], externalOnlyInput: ["value"], audiences: ["external", "chat"], toolset: "core", tier: "read",
      scope: async () => claim(), annotations: READ_ONLY, resultKind: "json", run: async (args, ctx) => record(args, ctx)
    }),
    defineTool({
      name: "chat_only", title: "Chat only", description: "d", input: {}, audiences: ["chat"], toolset: "core", tier: "read",
      scope: async () => claim(), annotations: READ_ONLY, resultKind: "json", run: async (args, ctx) => record(args, ctx)
    }),
    defineTool({
      name: "notes_tool", title: "Notes", description: "d", input: {}, audiences: ["chat"], toolset: "notes", tier: "act",
      scope: async () => claim({ writes: true }), annotations: MUTATING, resultKind: "json", run: async (args, ctx) => record(args, ctx)
    }),
    defineTool({
      name: "open_desktop", title: "Open a desktop", description: "d", input: { command: z.string(), reason: z.string().optional(), big: z.boolean().optional() },
      audiences: ["external", "chat"], toolset: "core", tier: "admin", adminFamily: "desktops",
      scope: async () => claim({ projects: [OWN], writes: true }),
      approval: async (args) => ({
        title: "Claude wants to open a desktop‮ running a command",
        scopeLabel: "Project acme/api",
        sections: [{ kind: "code", title: "Command", text: args.big ? "x".repeat(1_100_000) : args.command }],
        pins: { "desktop:revision": "r1" }
      }),
      annotations: MUTATING, resultKind: "json", run: async (args, ctx) => record(args, ctx)
    }),
    defineTool({
      name: "create_wf", title: "Create a workflow", description: "d", input: { name: z.string() },
      audiences: ["chat"], toolset: "core", tier: "admin", adminFamily: "workflows",
      scope: async () => claim({ projects: [OWN], writes: true }),
      approval: async () => ({ title: "Create", scopeLabel: "acme/api", sections: [{ kind: "text", text: "a workflow" }] }),
      annotations: MUTATING, resultKind: "json", run: async (args, ctx) => ({ ...record(args, ctx), workflowId: "wf_new" })
    }),
    defineTool({
      name: "act_in", title: "Act in a project", description: "d", input: { project: z.string() },
      audiences: ["chat"], toolset: "core", tier: "act",
      scope: async (args) => claim({ projects: [args.project], writes: true }), annotations: MUTATING, resultKind: "json", run: async (args, ctx) => record(args, ctx)
    }),
    defineTool({
      name: "message", title: "Message", description: "d", input: { to: z.string() },
      audiences: ["external", "chat"], toolset: "core", tier: "act",
      scope: async (args) => claim({ sessions: [args.to], causesTurnIn: [args.to] }), annotations: MUTATING, resultKind: "json",
      run: async (args, ctx) => ({ ...record(args, ctx), text: ctx.turn.provenance("sent", "hello", "notify") })
    }),
    defineTool({
      name: "boom", title: "Boom", description: "d", input: {}, audiences: ["chat"], toolset: "core", tier: "read",
      scope: async () => claim(), annotations: READ_ONLY, resultKind: "json", run: async () => { throw new Error("/secret/host/path exploded"); }
    }),
    defineTool({
      name: "image", title: "Image", description: "d", input: {}, audiences: ["chat"], toolset: "core", tier: "read",
      scope: async () => claim(), annotations: READ_ONLY, resultKind: "image",
      run: async (): Promise<CallToolResult> => ({ content: [{ type: "image", data: "AA==", mimeType: "image/png" }] })
    }),
    ...(over.tools ?? [])
  ];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const api = new PrincipalApi()
    .on("GET", "/api/workspaces", { status: 200, body: [{ name: "beta", path: join(WS, "beta"), projectCount: 1, gitAccountId: "acc1" }, { name: "acme", path: join(WS, "acme"), projectCount: 2, gitAccountId: "acc2" }] })
    .on("GET", "/api/accounts", { status: 200, body: [{ id: "acc1", label: "beta-bot" }, { id: "acc2", label: "acme-bot" }] })
    .on("GET", agentChatRoutes.thread("t2"), { status: 200, body: { kind: "snapshot", thread: snapshot({ head: head({ id: "t2", runtimeMode: "auto" }) }) } })
    .on("GET", agentChatRoutes.thread("wide"), { status: 200, body: { kind: "snapshot", thread: snapshot({ head: head({ id: "wide", runtimeMode: "full-access" }) }) } });
  api.fsRoot = ROOT;
  api.workspacesDir = WS;
  const port = over.port === undefined ? new FakeApprovalPort() : over.port;
  const deps: ExecutorDeps = {
    lookup: (name, audience) => {
      const tool = byName.get(name);
      return tool && tool.audiences.includes(audience) ? tool : undefined;
    },
    approvals: port,
    newId: () => "ex-new",
    ...over.deps
  };
  const call = (name: string, args: unknown, who: ThreadCaller | { kind: "external" } = caller(), signal = new AbortController().signal, principal?: CallerPrincipal) =>
    executeToolCall(deps, { name, arguments: args }, { caller: who, api, signal, ...(principal ? { principal } : {}) });
  return { runs, api, port, deps, call };
}

const code = (result: CallToolResult) => (result.structuredContent as { code?: string } | undefined)?.code;
const message = (result: CallToolResult) => (result.structuredContent as { message?: string } | undefined)?.message ?? "";

test("strict parse per audience: each audience's only-inputs are stripped from the other's schema and refused", async () => {
  const r = rig();
  const tool = r.deps.lookup!("both_ways", "chat")!;
  assert.deepEqual(Object.keys(audienceShape(tool, "external")), ["text", "value"]);
  assert.deepEqual(Object.keys(audienceShape(tool, "chat")), ["text", "delegate"]);
  const ext = await r.call("both_ways", { text: "a", delegate: true }, { kind: "external" });
  assert.equal(code(ext), "INVALID_ARGUMENT");
  assert.match(message(ext), /delegate/);
  const chat = await r.call("both_ways", { text: "a", value: "v" });
  assert.equal(code(chat), "INVALID_ARGUMENT");
  assert.match(message(chat), /value/);
  assert.equal(code(await r.call("both_ways", { text: "a", texxt: "b" })), "INVALID_ARGUMENT", "an unknown key is refused, never dropped");
  assert.equal(code(await r.call("both_ways", {})), "INVALID_ARGUMENT");
  assert.equal(r.runs.length, 0);
  assert.equal((await r.call("both_ways", { text: "a", delegate: true })).isError, undefined);
  assert.equal((await r.call("both_ways", { text: "a", value: "v" }, { kind: "external" })).isError, undefined);
});

test("TOOL_NOT_FOUND for another audience's tool or an unknown name; a tool of any group runs for any chat (no switch)", async () => {
  const r = rig();
  assert.equal(code(await r.call("chat_only", {}, { kind: "external" })), "TOOL_NOT_FOUND");
  const unknown = await r.call("x".repeat(5_000), {});
  assert.equal(code(unknown), "TOOL_NOT_FOUND");
  assert.ok(message(unknown).length < 200, "the name is quoted capped");
  assert.equal(r.runs.length, 0);
  // `notes` was an off-by-default toolset: its tools now run like any other, for every agent.
  for (const agentId of ["claude", "codex", "grok", "opencode"] as const) {
    const ran = await r.call("notes_tool", {}, caller({ agentId }));
    assert.equal(ran.isError, undefined, message(ran));
  }
  assert.equal(r.runs.length, 4);
});

test("Admin from a workflow-owned chat is ADMIN_NOT_AVAILABLE at once: no preview, no card, no run", async () => {
  const r = rig();
  const result = await r.call("open_desktop", { command: "xterm" }, caller({ workflowOwned: true }));
  assert.equal(code(result), "ADMIN_NOT_AVAILABLE");
  assert.equal(r.port!.cards.length, 0);
  assert.equal(r.port!.grantQueries.length, 0);
  assert.equal(r.runs.length, 0);
});

test("an Admin card: what runs is the frozen copy that was shown; pins and the approval reach run; grant options follow the mode", async () => {
  const r = rig();
  const result = await r.call("open_desktop", { command: "xterm", reason: "to test the UI" });
  assert.equal(result.isError, undefined, message(result));
  const card = r.port!.cards[0]!;
  assert.equal(card.kind, "admin");
  assert.equal(card.family, "desktops");
  assert.equal(card.threadId, "me");
  assert.equal(card.callerProjectPath, OWN);
  assert.equal(card.title, "Claude wants to open a desktop running a command", "the bidi override is stripped");
  assert.equal(card.reason, "to test the UI");
  assert.deepEqual(card.grantOptions, ["chat", "project"], "full-access: the desktops grants");
  assert.deepEqual(card.scope.projects?.map((project) => project.path), [OWN]);
  const run = r.runs[0]!;
  assert.equal(Object.isFrozen(run.args), true);
  assert.deepEqual(run.args, { command: "xterm", reason: "to test the UI" });
  assert.deepEqual(run.ctx.approval, { outcome: "approved", approvalId: "a_1", pins: { "desktop:revision": "r1" } });

  await r.call("open_desktop", { command: "xterm" }, caller({ runtimeMode: "auto" }));
  assert.deepEqual(r.port!.cards[1]!.grantOptions, [], "grants only for full-access callers");
});

test("card outcomes: denied quotes the user, timed out, cancelled; no port fails closed; an oversized preview never opens a card", async () => {
  const denied = rig({ port: new FakeApprovalPort({ outcome: "denied", approvalId: "a", reason: "not now" }) });
  const d = await denied.call("open_desktop", { command: "xterm" });
  assert.equal(code(d), "APPROVAL_DENIED");
  assert.match(message(d), /"not now"/);
  const timedOut = rig({ port: new FakeApprovalPort({ outcome: "timed_out", approvalId: "a" }) });
  assert.equal(code(await timedOut.call("open_desktop", { command: "xterm" })), "APPROVAL_TIMEOUT");
  const cancelled = rig({ port: new FakeApprovalPort({ outcome: "cancelled", approvalId: "a" }) });
  assert.equal(code(await cancelled.call("open_desktop", { command: "xterm" })), "CANCELLED");
  const none = rig({ port: null });
  assert.equal(code(await none.call("open_desktop", { command: "xterm" })), "PERMISSION_DENIED");
  const big = rig();
  const tooLarge = await big.call("open_desktop", { command: "xterm", big: true });
  assert.equal(code(tooLarge), "PREVIEW_TOO_LARGE");
  assert.match(message(tooLarge), /[Ss]plit the change/);
  assert.equal(big.port!.cards.length, 0);
  for (const rr of [denied, timedOut, cancelled, none, big]) assert.equal(rr.runs.length, 0);
});

test("grants: honoured for a full-access caller without a card; never below full-access", async () => {
  const port = new FakeApprovalPort().grant({ family: "desktops", scope: "project", projectPath: OWN });
  const r = rig({ port });
  const granted = await r.call("open_desktop", { command: "xterm" });
  assert.equal(granted.isError, undefined, message(granted));
  assert.equal(port.cards.length, 0);
  assert.deepEqual(r.runs[0]!.ctx.approval, { outcome: "granted", grantId: "g_1", pins: { "desktop:revision": "r1" } });
  assert.equal(port.grantQueries[0]!.projectPath, OWN);
  assert.deepEqual(port.grantQueries[0]!.projects, [OWN]);
  await r.call("open_desktop", { command: "xterm" }, caller({ runtimeMode: "auto" }));
  assert.equal(port.cards.length, 1, "an auto caller gets the card despite the grant");
});

test("the gate re-runs after the card on the caller as it is now: planning by then refuses, nothing runs", async () => {
  const r = rig({ deps: { refreshCaller: async (before) => ({ ...before, planning: true }) } });
  const result = await r.call("open_desktop", { command: "xterm" });
  assert.equal(code(result), "PERMISSION_DENIED");
  assert.match(message(result), /planning/);
  assert.equal(r.port!.cards.length, 1);
  assert.equal(r.runs.length, 0);
});

test("a chosen grant is committed only after the re-gate passes; refused there, or not recordable, the row claims no grant", async () => {
  const commits: string[] = [];
  const chosen = (result: { grantId: string; grantScope: "chat" | "project" } | null) => ({
    outcome: "approved" as const,
    approvalId: "a1",
    grantId: "g_planned",
    grantScope: "project" as const,
    grantChosen: "project" as const,
    commitGrant: async () => {
      commits.push("commit");
      return result;
    }
  });
  const toolApproval = (result: CallToolResult) => (result.structuredContent as { toolApproval?: Record<string, unknown> }).toolApproval;
  // Refused by the re-gate: never committed.
  const planning = rig({ port: new FakeApprovalPort(chosen({ grantId: "g_planned", grantScope: "project" })), deps: { refreshCaller: async (before) => ({ ...before, planning: true }) } });
  const refused = await planning.call("open_desktop", { command: "xterm" });
  assert.equal(code(refused), "PERMISSION_DENIED");
  assert.deepEqual(commits, []);
  assert.equal(toolApproval(refused)?.grantId, undefined);
  // Passing: committed once, and the recorded grant's id is what runs and what the row names.
  const passing = rig({ port: new FakeApprovalPort(chosen({ grantId: "g_real", grantScope: "project" })) });
  const ok = await passing.call("open_desktop", { command: "xterm" });
  assert.equal(ok.isError, undefined, message(ok));
  assert.deepEqual(commits, ["commit"]);
  assert.equal(passing.runs[0]!.ctx.approval?.grantId, "g_real");
  assert.equal(toolApproval(ok)?.grantId, "g_real");
  // Not recordable (the chat left Full access): approved once.
  const lost = rig({ port: new FakeApprovalPort(chosen(null)) });
  const once = await lost.call("open_desktop", { command: "xterm" });
  assert.equal(once.isError, undefined, message(once));
  assert.equal(lost.runs[0]!.ctx.approval?.grantId, undefined);
  assert.equal(toolApproval(once)?.grantId, undefined);
  assert.equal(toolApproval(once)?.outcome, "approved");
});

test("an approved workflow create records the new workflow only in the grant its outcome names", async () => {
  const r = rig();
  const once = await r.call("create_wf", { name: "nightly" });
  assert.equal(once.isError, undefined, message(once));
  assert.deepEqual(r.port!.recorded, [], "approved once, no grant named: nothing joins (never widens a standing grant)");
  r.port!.answerWith({ outcome: "approved", approvalId: "", grantId: "g_chat" });
  const granted = await r.call("create_wf", { name: "weekly" });
  assert.equal(granted.isError, undefined, message(granted));
  assert.deepEqual(r.port!.recorded, [{ threadId: "me", callerProjectPath: OWN, workflowId: "wf_new", grantId: "g_chat" }]);
});

test("boundary cards: cross-workspace Act names its one target and git identity; same-workspace Act below full-access cards without grants", async () => {
  const r = rig();
  const other = await r.call("act_in", { project: OTHER });
  assert.equal(other.isError, undefined, message(other));
  const card = r.port!.cards[0]!;
  assert.equal(card.kind, "boundary");
  assert.equal(card.family, "cross-project");
  assert.equal(card.targetProjectPath, OTHER);
  assert.deepEqual(card.grantOptions, ["chat"]);
  assert.deepEqual(card.scope.projects, [
    { path: OWN, workspace: "acme", gitAccountLabel: "acme-bot" },
    { path: OTHER, workspace: "beta", gitAccountLabel: "beta-bot" }
  ], "the caller's own project and identity beside the target's");
  assert.match(card.title, /Act in a project in beta\/app/);
  assert.ok(card.sections.some((section) => section.kind === "code" && section.text.includes(OTHER)), "the arguments are shown in full");

  await r.call("act_in", { project: SAME }, caller({ runtimeMode: "auto" }));
  assert.deepEqual([r.port!.cards[1]!.family, r.port!.cards[1]!.grantOptions], ["cross-project", []]);
  const full = await r.call("act_in", { project: SAME });
  assert.equal(full.isError, undefined);
  assert.equal(r.port!.cards.length, 2, "full-access acts in its own workspace without a card");
  assert.equal(code(await r.call("act_in", { project: join(WS, "acme") })), "PROJECT_NOT_FOUND", "a workspace is no project");
  assert.equal(code(await r.call("act_in", { project: join(WS, "acme/removed") })), "PROJECT_NOT_FOUND", "a removed project is not found");
});

test("turn policy and the exchange: hop + 1, a new exchange at hop 1, EXCHANGE_LIMIT past 8, never into a broader chat, plan carries on", async () => {
  const r = rig();
  const sent = await r.call("message", { to: "t2" }, caller({ runtimeMode: "auto", exchange: { id: "ex-1", hop: 3 } }));
  assert.equal(sent.isError, undefined, message(sent));
  assert.deepEqual(r.runs[0]!.ctx.turn.causedBy, { threadId: "me", exchangeId: "ex-1", hop: 4 });
  assert.equal(r.runs[0]!.ctx.turn.interactionMode, "default");
  const header = parseThreadMessage((sent.structuredContent as { text: string }).text);
  assert.equal(header?.fromSessionId, "me");
  assert.equal(header?.fromProject, "acme/api");

  await r.call("message", { to: "t2" }, caller({ runtimeMode: "auto", planning: true }));
  assert.deepEqual(r.runs[1]!.ctx.turn.causedBy, { threadId: "me", exchangeId: "ex-new", hop: 1 });
  assert.equal(r.runs[1]!.ctx.turn.interactionMode, "plan");

  const limit = await r.call("message", { to: "t2" }, caller({ runtimeMode: "auto", exchange: { id: "ex-1", hop: 8 } }));
  assert.equal(code(limit), "EXCHANGE_LIMIT");
  const broader = await r.call("message", { to: "wide" }, caller({ runtimeMode: "auto" }));
  assert.equal(code(broader), "PERMISSION_DENIED");
  const self = await r.call("message", { to: "me" });
  assert.equal(code(self), "PERMISSION_DENIED");
  assert.equal(r.runs.length, 2);

  const external = await r.call("message", { to: "wide" }, { kind: "external" });
  assert.equal(external.isError, undefined, "external callers are full trust");
  assert.equal(r.runs[2]!.ctx.turn.causedBy, undefined, "an external client's turn starts a fresh exchange");
  assert.equal((external.structuredContent as { text: string }).text, "hello", "no provenance header for an external client");
});

test("a session the call creates takes the exchange but no mode check", async () => {
  const opens = defineTool({
    name: "opens", title: "Opens", description: "d", input: {}, audiences: ["chat"], toolset: "core", tier: "act",
    scope: async () => claim({ causesTurnIn: [NEW_SESSION] }), annotations: MUTATING, resultKind: "json",
    run: async (_args, ctx) => ({ causedBy: ctx.turn.causedBy })
  });
  const r = rig({ tools: [opens] });
  const result = await r.call("opens", {}, caller({ exchange: { id: "e", hop: 1 } }));
  assert.deepEqual((result.structuredContent as { causedBy: unknown }).causedBy, { threadId: "me", exchangeId: "e", hop: 2 });
  assert.equal(r.api.calls.filter((c) => c.path.includes("/api/sessions/")).length, 0, "nothing to read for a new session");
});

test("every daemon request carries the caller's principal, forced: a tool cannot name another; agent projectPath is canonical or \"\"", async () => {
  const reads = defineTool({
    name: "reads", title: "Reads", description: "d", input: {}, audiences: ["external", "chat"], toolset: "core", tier: "read",
    scope: async (_args, ctx) => { await ctx.api.request("GET", "/api/x"); return claim(); },
    annotations: READ_ONLY, resultKind: "json",
    run: async (_args, ctx) => { await ctx.api.request("GET", "/api/y"); await ctx.api.request("GET", "/api/z", { principal: { kind: "user" } }); return {}; }
  });
  const r = rig({ tools: [reads] });
  await r.call("reads", {}, caller({ exchange: { id: "e", hop: 2 } }));
  const agent = { kind: "agent", threadId: "me", projectPath: OWN, agent: "claude", title: "Implement auth", exchange: { id: "e", hop: 2 } };
  assert.deepEqual(r.api.principals, [agent, agent, agent], "a tool's explicit principal is replaced");
  r.api.principals.length = 0;
  await r.call("reads", {}, caller({ projectPath: join(WS, "acme/removed"), workspace: "acme" }));
  assert.equal((r.api.principals[0] as { projectPath: string }).projectPath, "", "no canonical project: \"\"");
  r.api.principals.length = 0;
  await r.call("reads", {}, { kind: "external" }, new AbortController().signal, { kind: "external", credentialId: "cred_1" });
  assert.deepEqual(r.api.principals.slice(0, 2), [{ kind: "external", credentialId: "cred_1" }, { kind: "external", credentialId: "cred_1" }]);
});

test("results: a record is ok()-wrapped, a CallToolResult passes through, an unexpected throw is INTERNAL without its text; an aborted call is cancelled", async () => {
  const r = rig();
  const recordResult = await r.call("chat_only", {});
  assert.deepEqual(recordResult.structuredContent, { done: true });
  assert.equal((await r.call("image", {})).content[0]!.type, "image");
  const boom = await r.call("boom", {});
  assert.equal(code(boom), "INTERNAL");
  assert.doesNotMatch(JSON.stringify(boom), /secret\/host/);
  const controller = new AbortController();
  controller.abort();
  assert.equal(code(await r.call("chat_only", {}, caller(), controller.signal)), "CANCELLED");
});

test("every gated outcome carries the row's reference: granted (with the grant's scope), timed out, cancelled", async () => {
  const granted = rig({ port: new FakeApprovalPort().grant({ family: "desktops", scope: "project", projectPath: OWN }) });
  const allowed = await granted.call("open_desktop", { command: "xterm" });
  assert.deepEqual((allowed.structuredContent as { toolApproval?: unknown }).toolApproval, {
    kind: "admin", family: "desktops", title: "Claude wants to open a desktop running a command", outcome: "granted", grantId: "g_1", grantScope: "project"
  });
  const late = rig({ port: new FakeApprovalPort({ outcome: "timed_out", approvalId: "" }) });
  const timedOut = await late.call("open_desktop", { command: "xterm" });
  assert.equal(code(timedOut), "APPROVAL_TIMEOUT");
  assert.equal((timedOut.structuredContent as { toolApproval?: { outcome: string } }).toolApproval?.outcome, "timed_out");
  assert.match(String((timedOut.content.at(-1) as { text?: string }).text), /"toolApproval"/);
  const gone = rig({ port: new FakeApprovalPort({ outcome: "cancelled", approvalId: "", reason: "closed" }) });
  const cancelled = await gone.call("open_desktop", { command: "xterm" });
  assert.equal(code(cancelled), "CANCELLED");
  assert.equal((cancelled.structuredContent as { toolApproval?: { outcome: string } }).toolApproval?.outcome, "cancelled");
  // A call no card or grant gated carries none.
  assert.equal((await granted.call("chat_only", {})).structuredContent?.toolApproval, undefined);
});

test("tier(args, scope): the tier and family the scope resolved drive the gate, the card and grants — fail closed without one", async () => {
  const seen: { args: unknown; scope: ScopeClaim }[] = [];
  const resolvedBy = defineTool({
    name: "edit_record", title: "Edit a record", description: "d", input: { id: z.string() },
    audiences: ["chat"], toolset: "core",
    tier: (args, scope) => {
      seen.push({ args, scope });
      return scope.resolved?.tier ?? "admin";
    },
    adminFamily: (_args, scope) => scope.resolved?.adminFamily ?? "workflows",
    // The stored record decides: "mine" is the agent's own (Act), "theirs" the user's (Admin, desktops), else unknown.
    scope: async (args) => ({
      ...claim({ projects: [OWN], writes: true }),
      ...(args.id === "mine" ? { resolved: { tier: "act" as const } } : args.id === "theirs" ? { resolved: { tier: "admin" as const, adminFamily: "desktops" as const } } : {})
    }),
    approval: async () => ({ title: "Edit", scopeLabel: "acme/api", sections: [{ kind: "text", text: "x" }] }),
    annotations: MUTATING, resultKind: "json", run: async () => ({ done: true })
  });
  const port = new FakeApprovalPort().grant({ family: "desktops", scope: "chat", threadId: "me", projectPath: OWN });
  const r = rig({ tools: [resolvedBy], port });
  // Act: no card, no grant query.
  assert.equal((await r.call("edit_record", { id: "mine" })).isError, undefined);
  assert.equal(port.cards.length + port.grantQueries.length, 0);
  assert.equal(seen[0]!.scope.resolved?.tier, "act", "the tier function sees the claim scope() returned");
  // Admin, desktops: the chat grant for desktops covers it.
  const granted = await r.call("edit_record", { id: "theirs" });
  assert.equal(granted.isError, undefined, message(granted));
  assert.equal(port.grantQueries.at(-1)!.family, "desktops");
  assert.equal(port.cards.length, 0, "granted: no card");
  // Unknown: Admin workflows (never covered by a desktops grant): a card.
  assert.equal((await r.call("edit_record", { id: "gone" })).isError, undefined);
  assert.deepEqual([port.cards.at(-1)!.kind, port.cards.at(-1)!.family], ["admin", "workflows"]);
  // While planning, the resolved Admin tier refuses (the gate reads the computed tier, not a static one).
  assert.equal(code(await r.call("edit_record", { id: "theirs" }, caller({ planning: true }))), "PERMISSION_DENIED");
});

test("Admin cards: the computed adminFamily is the card's; a preview may only make it stricter (a strict subset of its grant scopes)", async () => {
  const withPreviewFamily = (name: string, computed: "desktops" | "workflows", asked: "agent-profile" | "workflows" | "desktops") =>
    defineTool({
      name, title: name, description: "d", input: {}, audiences: ["chat"], toolset: "core", tier: "admin", adminFamily: computed,
      scope: async () => claim({ projects: [OWN], writes: true }),
      approval: async () => ({ title: "x", scopeLabel: "acme/api", sections: [{ kind: "text", text: "x" }], family: asked }),
      annotations: MUTATING, resultKind: "json", run: async () => ({})
    });
  const r = rig({
    tools: [
      withPreviewFamily("narrow_ok", "desktops", "agent-profile"),
      withPreviewFamily("subset_ok", "desktops", "workflows"),
      withPreviewFamily("wider_no", "workflows", "desktops")
    ]
  });
  const familyOf = async (name: string) => {
    await r.call(name, {});
    return r.port!.cards.at(-1)!.family;
  };
  assert.equal(await familyOf("narrow_ok"), "agent-profile", "never granted ⊂ desktops' grants: stricter, taken");
  assert.equal(await familyOf("subset_ok"), "workflows", "[chat] ⊂ [chat, project]: stricter, taken");
  assert.equal(await familyOf("wider_no"), "workflows", "desktops offers MORE grants than workflows: ignored, the computed family stands");
  assert.deepEqual(r.port!.cards.at(-1)!.grantOptions, ["chat"], "workflows' own grant options, never desktops' project scope");
});

test("a tier or adminFamily function that throws: the call is an error and run is never called", async () => {
  let ran = 0;
  const throwing = (which: "tier" | "family") =>
    defineTool({
      name: `throws_${which}`, title: "Throws", description: "d", input: {}, audiences: ["chat"], toolset: "core",
      tier: which === "tier" ? () => { throw new Error("the record could not be read"); } : "admin",
      adminFamily: which === "family" ? () => { throw new Error("no family"); } : "desktops",
      scope: async () => claim({ projects: [OWN], writes: true }),
      approval: async () => ({ title: "x", scopeLabel: "acme/api", sections: [{ kind: "text", text: "x" }] }),
      annotations: MUTATING, resultKind: "json", run: async () => ((ran += 1), {})
    });
  const r = rig({ tools: [throwing("tier"), throwing("family")] });
  for (const name of ["throws_tier", "throws_family"]) {
    const result = await r.call(name, {});
    assert.equal(result.isError, true, name);
    assert.equal(code(result), "INTERNAL", `${name}: a thrown non-ToolError is INTERNAL, its text never echoed`);
    assert.doesNotMatch(message(result), /could not be read|no family/);
  }
  assert.equal(ran, 0, "run never called");
  assert.equal(r.port!.cards.length, 0, "and no card opened");
});

test("a caller with no canonical project of its own is never offered a grant (findGrant would never honour it)", async () => {
  const r = rig();
  await r.call("open_desktop", { command: "xterm" }, caller({ projectPath: "", workspace: "" }));
  const card = r.port!.cards[0]!;
  assert.deepEqual(card.grantOptions, []);
  assert.equal(card.callerProjectPath, "");
  assert.equal(r.port!.grantQueries.length, 0, "no grant can match without an own project: findGrant is skipped");
});

test("a cancelled card says why: a restart withdraws it (call again later), a closed chat ends it", async () => {
  const port = new FakeApprovalPort({ outcome: "cancelled", approvalId: "a", reason: "restarting" });
  const r = rig({ port });
  const restarting = await r.call("open_desktop", { command: "xterm" });
  assert.equal(code(restarting), "CANCELLED");
  assert.match(message(restarting), /restarting/);
  port.answerWith({ outcome: "cancelled", approvalId: "a", reason: "closed" });
  assert.match(message(await r.call("open_desktop", { command: "xterm" })), /closed/);
  port.answerWith({ outcome: "cancelled", approvalId: "a" });
  assert.equal(message(await r.call("open_desktop", { command: "xterm" })), "The call was cancelled.");
  assert.equal(r.runs.length, 0);
});

test("the card carries what the port re-checks: pending temp projects and a workflow-referenced prompt", async () => {
  const pendingTool = defineTool({
    name: "wf_pending", title: "Workflow with a temp project", description: "d", input: {},
    audiences: ["chat"], toolset: "core", tier: "admin", adminFamily: "workflows",
    scope: async () => claim({ projects: [OWN], pendingProjects: [{ workspace: "acme" }], writes: true }),
    approval: async () => ({ title: "Create", scopeLabel: "acme/api", sections: [{ kind: "text", text: "a workflow" }], workflowReferencedPrompt: true }),
    annotations: MUTATING, resultKind: "json", run: async () => ({})
  });
  const r = rig({ tools: [pendingTool] });
  await r.call("wf_pending", {});
  const card = r.port!.cards[0]!;
  assert.deepEqual(card.pendingProjects, [{ workspace: "acme" }]);
  assert.equal(card.workflowReferencedPrompt, true);
  assert.deepEqual(card.grantOptions, []);
});

test("a grant is re-checked on the refreshed caller: no longer full-access → refused, nothing runs", async () => {
  const port = new FakeApprovalPort().grant({ family: "desktops", scope: "project", projectPath: OWN });
  const r = rig({ port, deps: { refreshCaller: async (before) => ({ ...before, runtimeMode: "auto" }) } });
  const result = await r.call("open_desktop", { command: "xterm" });
  assert.equal(code(result), "PERMISSION_DENIED");
  assert.match(message(result), /Full access/);
  assert.equal(port.cards.length, 0);
  assert.equal(r.runs.length, 0);
});
