/**
 * `request_toolset` (unified MCP design 2026-10-15 §4 row 45, §9.3, §13): already on → enabled at
 * once without a card; otherwise one toolset card through the executor's port (kind and family
 * `toolset`, no grants, the tools with their tiers and the agent's reason), with every outcome
 * mapped to `RequestToolsetResult` — enabled `now` / `after-restart`, `declined` (30-minute
 * memory), `timed_out`, `cancelled`; workflow-owned chats refused before any card; a recent
 * decline refused by the port (`TOOLSET_DECLINED`). First over the port double, then end to end
 * through the REAL `AgentToolsApprovalPort` and service (what `index.ts` wires), the chat
 * transport's advertised set simulated both ways (re-listed now, or restarted at idle).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TOOLSET_DECLINE_MS, toolsetById, type RequestToolsetResult, type ThreadAgentToolsResponse, type ToolsetId } from "@orquester/api";
import { agentChatRoutes, TOOL_APPROVAL_EVENT_TYPE, type AgentChatToolApprovalEventPayload } from "@orquester/api/agent-chat";

import { connectExecutor, createAgentToolsRuntime } from "../../agent-tools/approval-port.ts";
import { FakeApprovalPort, type CardAnswer } from "../catalog/approval-double.ts";
import type { ApprovalOutcome, ThreadCaller, ToolCaller, ToolsetApplyOutcome } from "../catalog/contract.ts";
import { toolByName } from "../catalog/index.ts";
import { ToolError } from "../errors.ts";
import { executeToolCall, executorPorts } from "../executor.ts";
import { head, snapshot } from "../fixtures.ts";
import { FakeDaemonApi } from "../testing.ts";
import { REQUEST_TOOLSET_NOTES, REQUESTABLE_TOOLSETS, toolsetCardSections, toolsetsFamily } from "./toolsets.ts";

const ME = "me";
const NOW = Date.UTC(2026, 9, 15, 10, 0, 0);
const tool = toolsetsFamily[0]!;

function chatCaller(over: Partial<ThreadCaller> = {}): ThreadCaller {
  return {
    kind: "thread", threadId: ME, title: "Nightly report", projectPath: "", workspace: "", cwd: "/w/acme/api", agentId: "claude", callId: "call-1",
    runtimeMode: "approval-required", planning: false, workflowOwned: false, exchange: null, ...over
  };
}

function view(over: Partial<ThreadAgentToolsResponse> = {}): ThreadAgentToolsResponse {
  return { threadId: ME, agent: "claude", overrides: {}, resolved: ["core", "reads"], workflowOwned: false, appliesAtNextIdle: false, declines: {}, grants: [], ...over };
}

/** The port double plus a chat view the test scripts before and after the card. */
function rig(answer: CardAnswer = { outcome: "approved", approvalId: "" }) {
  const port = new FakeApprovalPort(answer);
  const api = new FakeDaemonApi();
  let current: ThreadAgentToolsResponse | null = view();
  api.on("GET", agentChatRoutes.agentTools(ME), () => (current === null ? { status: 404, body: { error: { code: "THREAD_NOT_FOUND", message: "x" } } } : { status: 200, body: current }));
  const call = (
    args: unknown,
    opts: { caller?: ToolCaller; signal?: AbortSignal; approvals?: FakeApprovalPort | null; applied?: ToolsetApplyOutcome } = {}
  ): Promise<CallToolResult> =>
    executeToolCall(
      {
        approvals: opts.approvals === undefined ? port : opts.approvals,
        enabledToolsets: async () => new Set(["core"]),
        now: () => NOW,
        // The chat transport's answer (Task 6), when the test gives one.
        ...(opts.applied ? { onToolsetApproved: async () => opts.applied } : {})
      },
      { name: "request_toolset", arguments: args },
      { caller: opts.caller ?? chatCaller(), api, signal: opts.signal ?? new AbortController().signal }
    );
  return {
    port,
    api,
    call,
    setView: (next: ThreadAgentToolsResponse | null) => {
      current = next;
    }
  };
}

/** The structured result, every variant's fields optional (the tests assert which ones are there). */
type AnyResult = { enabled: boolean; toolset: ToolsetId; available?: string; outcome?: string; declinedUntil?: string; reason?: string; note: string };
/** The tool's own result; the row's `toolApproval` reference (Task 6's executor adds it) is read by {@link referenceOf}. */
const result = (r: CallToolResult): AnyResult => {
  const { toolApproval: _reference, ...value } = r.structuredContent as RequestToolsetResult & { note: string; toolApproval?: unknown };
  return value as AnyResult;
};
const referenceOf = (r: CallToolResult) => (r.structuredContent as { toolApproval?: { kind?: string; family?: string; outcome?: string } }).toolApproval;
const errorOf = (r: CallToolResult) => {
  assert.equal(r.isError, true, JSON.stringify(r.structuredContent));
  return r.structuredContent as { code: string; message: string; detail?: unknown };
};

describe("request_toolset definition", () => {
  it("is the catalog's chat-only core Act tool, plan-safe, asking for any toolset but the locked core", () => {
    assert.equal(toolByName("request_toolset", "chat"), tool);
    assert.equal(toolByName("request_toolset", "external"), undefined);
    assert.deepEqual([tool.audiences, tool.toolset, tool.tier, tool.planSafe], [["chat"], "core", "act", true]);
    assert.deepEqual(REQUESTABLE_TOOLSETS, ["reads", "notes", "chat-extras", "files-git", "workflow-authoring", "agent-profile-editing", "desktops"]);
    assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    for (const fragment of ["one-click card", '"now"', '"after-restart"', "end your turn", "30 min"]) assert.ok(tool.description.includes(fragment), fragment);
  });

  it("refuses core, an unknown toolset, and a missing, blank or over-long reason before any card", async () => {
    const r = rig();
    for (const args of [
      { toolset: "core", reason: "x" },
      { toolset: "everything", reason: "x" },
      { toolset: "notes" },
      { toolset: "notes", reason: "   " },
      { toolset: "notes", reason: "r".repeat(301) },
      { toolset: "notes", reason: "x", threadId: "someone-else" }
    ]) {
      assert.equal(errorOf(await r.call(args)).code, "INVALID_ARGUMENT", JSON.stringify(args));
    }
    assert.equal(r.port.cards.length, 0);
  });

  it("the card shows the toolset's tools with their tiers", () => {
    const [fields, note] = toolsetCardSections("workflow-authoring");
    assert.equal(fields!.kind, "fields");
    assert.ok(fields!.kind === "fields" && fields!.title?.startsWith("Workflow authoring (changes need your approval): 9 tools"));
    assert.deepEqual(
      fields!.kind === "fields" ? fields!.rows.map((row) => [row.label, row.value.split(":")[0]]) : [],
      toolsetById("workflow-authoring").tools.map((entry) => [entry.name, entry.tier[0]!.toUpperCase() + entry.tier.slice(1)])
    );
    assert.equal(note!.kind, "text");
  });
});

describe("request_toolset over the port double", () => {
  it("already on in this chat: enabled now, without a card", async () => {
    const r = rig();
    const answer = await r.call({ toolset: "reads", reason: "list workflows" });
    assert.deepEqual(result(answer), { enabled: true, toolset: "reads", available: "now", note: REQUEST_TOOLSET_NOTES.now });
    assert.equal(r.port.cards.length, 0);
  });

  it("already on, but the provider session does not advertise this chat's set yet: after-restart, without a card", async () => {
    const r = rig();
    r.setView(view({ resolved: ["core", "reads", "notes"], appliesAtNextIdle: true }));
    assert.deepEqual(result(await r.call({ toolset: "notes", reason: "todos" })), {
      enabled: true, toolset: "notes", available: "after-restart", note: REQUEST_TOOLSET_NOTES["after-restart"]
    });
    assert.equal(r.port.cards.length, 0);
  });

  it("off: one toolset card — kind and family toolset, the toolset named, no grants, the agent's reason — approved and re-listed: now", async () => {
    const r = rig((card) => {
      r.setView(view({ resolved: ["core", "reads", card.toolset as ToolsetId], overrides: { [card.toolset as ToolsetId]: true } }));
      return { outcome: "approved", approvalId: "a1" };
    });
    const answer = await r.call({ toolset: "workflow-authoring", reason: "  set up the nightly report  " });
    assert.deepEqual(result(answer), { enabled: true, toolset: "workflow-authoring", available: "now", note: REQUEST_TOOLSET_NOTES.now });
    assert.equal(r.port.cards.length, 1);
    const card = r.port.cards[0]!;
    assert.deepEqual(
      [card.threadId, card.tool, card.kind, card.family, card.toolset, card.grantOptions, card.secretFields],
      [ME, "request_toolset", "toolset", "toolset", "workflow-authoring", [], []]
    );
    assert.equal(card.title, "Claude asks to enable Workflow authoring (changes need your approval) for this chat");
    assert.equal(card.reason, "set up the nightly report");
    assert.deepEqual(card.sections, toolsetCardSections("workflow-authoring"));
    assert.match(card.scope.label, /This chat/);
  });

  it("approved, but the provider session must restart to list the tools: after-restart, telling the agent to end its turn", async () => {
    const r = rig((card) => {
      r.setView(view({ resolved: ["core", "reads", card.toolset as ToolsetId], appliesAtNextIdle: true }));
      return { outcome: "approved", approvalId: "a1" };
    });
    const answer = result(await r.call({ toolset: "desktops", reason: "open the app" }));
    assert.deepEqual(answer, { enabled: true, toolset: "desktops", available: "after-restart", note: REQUEST_TOOLSET_NOTES["after-restart"] });
    assert.match(answer.note, /End your turn now/);
  });

  it("approved: the chat transport's own answer decides — now, after-restart (continue coming) or pending (next start, nothing comes)", async () => {
    const r = rig((card) => {
      // After the card the view would say "now" (advertised already); the transport's answer wins.
      r.setView(view({ resolved: ["core", "reads", card.toolset as ToolsetId], appliesAtNextIdle: false }));
      return { outcome: "approved", approvalId: "a1" };
    });
    const restart = await r.call({ toolset: "notes", reason: "todos" }, { applied: "after-restart" });
    assert.deepEqual(result(restart), { enabled: true, toolset: "notes", available: "after-restart", note: REQUEST_TOOLSET_NOTES["after-restart"] });
    assert.deepEqual(
      [referenceOf(restart)?.kind, referenceOf(restart)?.family, referenceOf(restart)?.outcome],
      ["toolset", "toolset", "approved"],
      "the row's reference rides along"
    );
    r.setView(view());
    assert.deepEqual(result(await r.call({ toolset: "desktops", reason: "app" }, { applied: "now" })), {
      enabled: true, toolset: "desktops", available: "now", note: REQUEST_TOOLSET_NOTES.now
    });
    const pending = result(await r.call({ toolset: "files-git", reason: "diff" }, { applied: "pending" }));
    assert.deepEqual(pending, { enabled: true, toolset: "files-git", available: "after-restart", note: REQUEST_TOOLSET_NOTES.pending });
    assert.doesNotMatch(pending.note, /End your turn now/, "no continue turn is coming: never told to wait for one");
  });

  it("approved with an unreadable chat view: after-restart (the transport restarts whenever the sets differ)", async () => {
    const r = rig((_card) => {
      r.setView(null);
      return { outcome: "approved", approvalId: "a1" };
    });
    assert.equal(result(await r.call({ toolset: "notes", reason: "todos" })).available, "after-restart");
  });

  it("the port finding it on meanwhile (approved, no card id): enabled", async () => {
    const r = rig({ outcome: "approved", approvalId: "" });
    r.port.answerWith((card) => {
      r.setView(view({ resolved: ["core", "reads", card.toolset as ToolsetId] }));
      return { outcome: "approved", approvalId: "" };
    });
    assert.equal(result(await r.call({ toolset: "files-git", reason: "read a file" })).enabled, true);
  });

  it("denied: declined with the user's words and when asking is allowed again (the chat's record, else 30 minutes from now)", async () => {
    const until = "2026-10-15T10:30:00.000Z";
    const r = rig((card) => {
      r.setView(view({ declines: { [card.toolset as ToolsetId]: until } }));
      return { outcome: "denied", approvalId: "a1", reason: "not in this chat" };
    });
    assert.deepEqual(result(await r.call({ toolset: "notes", reason: "todos" })), {
      enabled: false, toolset: "notes", outcome: "declined", declinedUntil: until, reason: "not in this chat", note: REQUEST_TOOLSET_NOTES.declined
    });

    const bare = rig({ outcome: "denied", approvalId: "a2" });
    bare.port.answerWith(() => {
      bare.setView(null);
      return { outcome: "denied", approvalId: "a2" };
    });
    assert.deepEqual(result(await bare.call({ toolset: "notes", reason: "todos" })), {
      enabled: false, toolset: "notes", outcome: "declined", declinedUntil: new Date(NOW + TOOLSET_DECLINE_MS).toISOString(), note: REQUEST_TOOLSET_NOTES.declined
    });
  });

  it("timed out and cancelled: not enabled, nothing changed", async () => {
    for (const outcome of [{ outcome: "timed_out", approvalId: "a" }, { outcome: "cancelled", approvalId: "a", reason: "closed" }] as ApprovalOutcome[]) {
      const r = rig(outcome);
      assert.deepEqual(result(await r.call({ toolset: "notes", reason: "todos" })), {
        enabled: false, toolset: "notes", outcome: outcome.outcome, note: REQUEST_TOOLSET_NOTES[outcome.outcome as "timed_out" | "cancelled"]
      });
    }
  });

  it("a toolset declined in the last 30 minutes: the port's TOOLSET_DECLINED reaches the agent with its detail", async () => {
    const r = rig();
    const port = new (class extends FakeApprovalPort {
      override async request(): Promise<ApprovalOutcome> {
        throw new ToolError("TOOLSET_DECLINED", "The user declined.", { toolset: "notes", declinedUntil: "2026-10-15T10:30:00.000Z" });
      }
    })();
    const error = errorOf(await r.call({ toolset: "notes", reason: "todos" }, { approvals: port }));
    assert.deepEqual([error.code, error.detail], ["TOOLSET_DECLINED", { toolset: "notes", declinedUntil: "2026-10-15T10:30:00.000Z" }]);
  });

  it("a workflow-owned chat is refused before any card; so is a daemon without cards", async () => {
    const r = rig();
    const owned = errorOf(await r.call({ toolset: "notes", reason: "todos" }, { caller: chatCaller({ workflowOwned: true }) }));
    assert.equal(owned.code, "PERMISSION_DENIED");
    assert.match(owned.message, /automated workflow/);
    assert.equal(r.port.cards.length, 0);
    // Even for a toolset already on: no "enabled" answer for a workflow-owned chat.
    const alreadyOn = errorOf(await r.call({ toolset: "reads", reason: "list workflows" }, { caller: chatCaller({ workflowOwned: true }) }));
    assert.equal(alreadyOn.code, "PERMISSION_DENIED");
    assert.match(alreadyOn.message, /automated workflow/);
    assert.equal(r.port.cards.length, 0);
    assert.equal(errorOf(await r.call({ toolset: "notes", reason: "todos" }, { approvals: null })).code, "PERMISSION_DENIED");
  });

  it("is allowed in every permission mode and while planning", async () => {
    for (const over of [{ runtimeMode: "approval-required" as const, planning: true }, { runtimeMode: "auto-accept-edits" as const }, { runtimeMode: "auto" as const }, { runtimeMode: "full-access" as const, planning: true }]) {
      const r = rig({ outcome: "timed_out", approvalId: "a" });
      assert.equal(result(await r.call({ toolset: "notes", reason: "todos" }, { caller: chatCaller(over) })).outcome, "timed_out", JSON.stringify(over));
      assert.equal(r.port.cards.length, 1);
    }
  });

  it("is no external tool", async () => {
    const r = rig();
    assert.equal(errorOf(await r.call({ toolset: "notes", reason: "todos" }, { caller: { kind: "external" } })).code, "TOOL_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// End to end: the real port and service, as index.ts wires them
// ---------------------------------------------------------------------------

async function realRig(t: TestContext) {
  const appdir = mkdtempSync(join(tmpdir(), "umcp-request-toolset-"));
  const opened: string[] = [];
  const waiters: ((id: string) => void)[] = [];
  const api = new FakeDaemonApi().on("GET", agentChatRoutes.thread(ME), {
    status: 200,
    body: { kind: "snapshot", thread: snapshot({ head: head({ id: ME, runtimeMode: "approval-required" }) }) }
  });
  const runtime = createAgentToolsRuntime({
    baseDir: appdir,
    publish: (_channel, type, payload) => {
      const event = payload as AgentChatToolApprovalEventPayload;
      if (type !== TOOL_APPROVAL_EVENT_TYPE || !event.opened) return;
      const waiter = waiters.shift();
      if (waiter) waiter(event.opened.approvalId);
      else opened.push(event.opened.approvalId);
    },
    onApprovalsChanged: () => {},
    tab: (id) => (id === ME ? { projectPath: "" } : undefined),
    agentOf: (id) => (id === ME ? "claude" : null),
    api: () => api,
    logger: { log: () => {}, warn: () => {}, error: () => {} }
  });
  await runtime.load();
  // The Tools chip's route, as `agent-tools/routes.ts` answers it.
  api.on("GET", agentChatRoutes.agentTools(ME), () => ({ status: 200, body: runtime.tools.threadView(ME, runtime.threadInfo(ME)!) }));
  const disconnect = connectExecutor(runtime, executorPorts);
  t.after(async () => {
    disconnect();
    await runtime.shutdown();
    rmSync(appdir, { recursive: true, force: true });
  });
  // The chat transport (Task 6) reports what the running provider session advertises.
  let advertised: readonly string[] = runtime.tools.resolvedToolsets(ME, "claude");
  runtime.tools.setAdvertisedToolsets((id) => (id === ME ? advertised : null));
  const nextCard = (): Promise<string> => (opened.length > 0 ? Promise.resolve(opened.shift()!) : new Promise((resolve) => waiters.push(resolve)));
  const call = (name: string, args: unknown) =>
    executeToolCall({}, { name, arguments: args }, { caller: chatCaller(), api, signal: new AbortController().signal });
  return {
    runtime,
    call,
    nextCard,
    relist: () => {
      advertised = runtime.tools.resolvedToolsets(ME, "claude");
    }
  };
}

describe("request_toolset end to end (real port and service)", () => {
  it("a provider that re-lists: the listener reports the new set before the call resumes → now", async (t) => {
    const r = await realRig(t);
    assert.equal(r.runtime.tools.isToolsetOn(ME, "claude", "notes"), false);
    r.runtime.tools.onToolsetsChanged((threadId) => {
      if (threadId === ME) r.relist();
    });
    const asking = r.call("request_toolset", { toolset: "notes", reason: "keep a todo list" });
    const id = await r.nextCard();
    const card = r.runtime.approvals.list(ME)[0]!;
    assert.deepEqual([card.kind, card.family, card.tool, card.grantOptions, card.reason], ["toolset", "toolset", "request_toolset", [], "keep a todo list"]);
    assert.equal(card.title, "Claude asks to enable Todos & saved-prompt editing for this chat");
    assert.ok((await r.runtime.approvals.answer(ME, id, { decision: "approve" })).ok);
    assert.deepEqual(result(await asking), { enabled: true, toolset: "notes", available: "now", note: REQUEST_TOOLSET_NOTES.now });
    assert.ok(r.runtime.tools.isToolsetOn(ME, "claude", "notes"));
    // Already on now: no second card.
    assert.equal(result(await r.call("request_toolset", { toolset: "notes", reason: "again" })).available, "now");
    assert.equal(r.runtime.approvals.list(ME).length, 0);
  });

  it("a provider that must restart: after-restart until the session advertises the new set", async (t) => {
    const r = await realRig(t);
    const asking = r.call("request_toolset", { toolset: "desktops", reason: "open the app" });
    assert.ok((await r.runtime.approvals.answer(ME, await r.nextCard(), { decision: "approve" })).ok);
    assert.equal(result(await asking).available, "after-restart");
    assert.equal(result(await r.call("request_toolset", { toolset: "desktops", reason: "again" })).available, "after-restart", "still not advertised");
    r.relist();
    assert.equal(result(await r.call("request_toolset", { toolset: "desktops", reason: "again" })).available, "now");
  });

  it("denied: declined with the 30-minute memory, and asking again is TOOLSET_DECLINED without a card", async (t) => {
    const r = await realRig(t);
    const asking = r.call("request_toolset", { toolset: "files-git", reason: "read the config" });
    assert.ok((await r.runtime.approvals.answer(ME, await r.nextCard(), { decision: "deny", reason: "use the terminal" })).ok);
    const declined = result(await asking);
    assert.equal(declined.enabled, false);
    assert.equal(declined.outcome, "declined");
    assert.equal(declined.reason, "use the terminal");
    const until = r.runtime.tools.toolsetDeclinedUntil(ME, "files-git");
    assert.equal(declined.declinedUntil, until);
    const again = errorOf(await r.call("request_toolset", { toolset: "files-git", reason: "please" }));
    assert.equal(again.code, "TOOLSET_DECLINED");
    assert.deepEqual(again.detail, { toolset: "files-git", declinedUntil: until });
    assert.equal(r.runtime.approvals.list(ME).length, 0);
    assert.equal(r.runtime.tools.isToolsetOn(ME, "claude", "files-git"), false);
  });

  it("the master switch off: refused before any card (it would approve nothing)", async (t) => {
    const r = await realRig(t);
    const settings = r.runtime.tools.settingsView();
    r.runtime.tools.updateSettings({ revision: settings.revision, enabled: false });
    const refused = errorOf(await r.call("request_toolset", { toolset: "notes", reason: "todos" }));
    assert.equal(refused.code, "PERMISSION_DENIED");
    assert.match(refused.message, /switched off/);
    assert.equal(r.runtime.approvals.list(ME).length, 0);
  });
});
