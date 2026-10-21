/**
 * `fork_session` and `merge_back_session` for an external caller (full trust), ported from the
 * pre-catalog definitions' tests (spec §11): the fork cut by transcript turn number, the host's
 * refusal passed through, one fork per call however often the host restarts (the same commandId),
 * a fork's merge back, and `resolve_merge_back` as `merge_back_session {mergeId, action}`.
 * `get_session_lineage` is `get_session`'s `lineage` (`sessions.test.ts`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { agentChatRoutes } from "@orquester/api/agent-chat";
import type { CallContext } from "../catalog/contract.ts";
import { chatSummary, head, snapshot, stamp, turn } from "../fixtures.ts";
import { FakeDaemonApi } from "../testing.ts";
import { lineageFamily } from "./lineage.ts";

/** An external caller's context (full trust), as the executor builds it for `/mcp`. */
const external = (api: FakeDaemonApi): CallContext => ({
  api,
  signal: new AbortController().signal,
  now: () => 0,
  caller: { kind: "external" },
  turn: { interactionMode: "default", provenance: (_origin, text) => text }
});
const tool = (name: string) => {
  const unified = lineageFamily.find((t) => t.name === name)!;
  return { run: (args: Record<string, unknown>, api: FakeDaemonApi) => unified.run(args as never, external(api)) as Promise<Record<string, unknown>> };
};
/** A POST body without its minted commandId, which every call must carry. */
const withoutId = (body: unknown): Record<string, unknown> => {
  const { commandId, ...rest } = body as Record<string, unknown>;
  assert.equal(typeof commandId, "string", "a commandId is minted for the call");
  return rest;
};

function harness(turns = [turn({ turnId: "t1", state: "completed" }), turn({ turnId: "t2", state: "completed" })]) {
  const api = new FakeDaemonApi();
  const snap = { ...snapshot(), turns };
  api
    .on("GET", "/api/sessions", {
      status: 200,
      body: [chatSummary(), chatSummary({ id: "f1", title: "fork", lineage: { parentThreadId: "c1", relation: "fork", createdAt: stamp(1) } })]
    })
    .on("GET", "/api/sessions/c1/thread", { status: 200, body: { kind: "snapshot", thread: snap } })
    .on("GET", "/api/sessions/f1/thread", { status: 200, body: { kind: "snapshot", thread: snap } })
    .on("GET", "/api/registry", { status: 200, body: { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [] } })
    .on("GET", "/api/agent/providers", { status: 200, body: { hostInstanceId: "h", providers: [] } })
    .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [], defaults: {} } });
  return { api };
}

test("fork_session forks through a transcript turn number and returns the new session", async () => {
  const { api } = harness();
  api.on("POST", agentChatRoutes.fork("c1"), {
    status: 200,
    body: { session: chatSummary({ id: "f1" }), strategy: "native", lineage: { parentThreadId: "c1", relation: "fork", createdAt: "x" } }
  });
  const result = await tool("fork_session").run({ sessionId: "c1", throughTurn: 1, title: "B" }, api);
  assert.equal(result.strategy, "native");
  assert.equal((result.session as { id: string }).id, "f1");
  const post = api.calls.find((c) => c.method === "POST")!;
  assert.deepEqual(withoutId(post.body), { unattended: true, title: "B", turnId: "t1", role: "assistant" }, "a tool's fork is unattended (Agent Profiles §5.5); no profileId: the original's");

  await tool("fork_session").run({ sessionId: "c1", throughTurn: 0 }, api);
  assert.deepEqual(withoutId(api.calls.filter((c) => c.method === "POST").at(-1)!.body), { unattended: true, turnId: "t1", role: "user" });
  await tool("fork_session").run({ sessionId: "c1" }, api);
  assert.deepEqual(withoutId(api.calls.filter((c) => c.method === "POST").at(-1)!.body), { unattended: true }, "default: the host picks the latest finished turn");
});

test("fork_session refuses a turn past the end, and passes the host's refusal through", async () => {
  const { api } = harness();
  await assert.rejects(tool("fork_session").run({ sessionId: "c1", throughTurn: 3 }, api), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /between 0 and 2/.test(e.message));
  api.on("POST", agentChatRoutes.fork("c1"), { status: 409, body: { error: { code: "COMMAND_REJECTED", message: "That reply is still being written." } } });
  await assert.rejects(tool("fork_session").run({ sessionId: "c1" }, api), (e: { code: string; message: string }) => e.code === "COMMAND_REJECTED" && /still being written/.test(e.message));
});

/** `GET /api/session-profiles` as the daemon lists two profiles. */
const PROFILES = { profiles: [
  { id: "prof-1", name: "Video", description: "", revision: "3", preparation: [{ agent: "claude", state: "ready", updatedAt: "x" }] },
  { id: "prof-2", name: "Ops", description: "", revision: "1", preparation: [] }
], errors: [] };

test("fork_session profile (Agent Profiles §5.5): by name or id, null or \"global\" for Global, omitted inherits; the result reports it", async () => {
  const { api } = harness();
  api.on("GET", "/api/session-profiles", { status: 200, body: PROFILES });
  // The fork tab as the daemon then lists it: the named profile, else the parent's (prof-2).
  let forked: string | null = null;
  api.on("GET", "/api/sessions", () => ({ status: 200, body: [chatSummary({ profileId: "prof-2" }), chatSummary({ id: "f1", profileId: forked, lineage: { parentThreadId: "c1", relation: "fork", createdAt: stamp(1) } })] }));
  api.on("POST", agentChatRoutes.fork("c1"), ({ body }) => {
    const profileId = (body as { profileId?: string | null }).profileId;
    forked = profileId === undefined ? "prof-2" : profileId;
    return { status: 200, body: { session: chatSummary({ id: "f1", profileId: forked }), strategy: "native", lineage: { parentThreadId: "c1", relation: "fork", createdAt: "x" } } };
  });
  const lastBody = () => withoutId(api.calls.filter((c) => c.method === "POST").at(-1)!.body);
  const byName = await tool("fork_session").run({ sessionId: "c1", profile: "video" }, api);
  assert.deepEqual(lastBody(), { unattended: true, profileId: "prof-1" }, "a name is matched case-insensitively and sent as its id");
  assert.deepEqual((byName.session as { chat: { profile: unknown } }).chat.profile, { id: "prof-1", name: "Video" });
  await tool("fork_session").run({ sessionId: "c1", profile: "prof-2" }, api);
  assert.deepEqual(lastBody(), { unattended: true, profileId: "prof-2" });
  await tool("fork_session").run({ sessionId: "c1", profile: null }, api);
  assert.deepEqual(lastBody(), { unattended: true, profileId: null });
  await tool("fork_session").run({ sessionId: "c1", profile: "Global" }, api);
  assert.deepEqual(lastBody(), { unattended: true, profileId: null }, "\"global\" is Global");
  const inherited = await tool("fork_session").run({ sessionId: "c1" }, api);
  assert.deepEqual(lastBody(), { unattended: true }, "omitted: the original's, chosen by the daemon");
  assert.deepEqual((inherited.session as { chat: { profile: unknown } }).chat.profile, { id: "prof-2", name: "Ops" });
});

test("fork_session profile refusals: an unknown one is refused before anything is forked; a profile the daemon cannot prepare fails naming it", async () => {
  const { api } = harness();
  api.on("GET", "/api/session-profiles", { status: 200, body: PROFILES });
  await assert.rejects(tool("fork_session").run({ sessionId: "c1", profile: "Nope" }, api),
    (e: { code: string; message: string }) => e.code === "PROFILE_NOT_FOUND" && /No Agent Profile "Nope"/.test(e.message) && /"Video", "Ops"/.test(e.message));
  assert.equal(api.calls.some((c) => c.method === "POST"), false, "nothing forked");
  api.on("POST", agentChatRoutes.fork("c1"), { status: 409, body: { error: { code: "PROFILE_NOT_READY", message: "The MCP server \"slack\" has no command." } } });
  await assert.rejects(tool("fork_session").run({ sessionId: "c1", profile: "Video" }, api),
    (e: { code: string; message: string }) => e.code === "PROFILE_NOT_READY" && /Agent Profile "Video" could not be used, so nothing was forked: The MCP server "slack" has no command\./.test(e.message));
  // Inherited: a parent whose profile is gone fails the (unattended) fork too, naming the profile by id when no name is known.
  api.on("GET", "/api/sessions", { status: 200, body: [chatSummary({ profileId: "prof-gone" })] });
  api.on("POST", agentChatRoutes.fork("c1"), { status: 400, body: { code: "PROFILE_NOT_FOUND", message: "No Agent Profile \"prof-gone\"." } });
  await assert.rejects(tool("fork_session").run({ sessionId: "c1" }, api), (e: { code: string; message: string }) => e.code === "PROFILE_NOT_FOUND" && /Agent Profile "prof-gone"/.test(e.message));
});

// "Continue in another agent": `agent`, `model`, `options`, `accountId`, checked as create_session checks them.
const AGENTS = { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [
  { id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } },
  { id: "codex", kind: "agent", name: "Codex", bin: ["codex"], enabled: true, installState: "idle", chat: { adapter: "codex" } },
  { id: "grok", kind: "agent", name: "Grok Build", bin: ["grok"], enabled: false, installState: "idle", chat: { adapter: "grok" } }
] };
const effort = { optionDescriptors: [{ id: "effort", label: "Effort", type: "select", options: [{ id: "medium", label: "Medium", isDefault: true }, { id: "high", label: "High" }] }] };
const providerRow = (id: string, models: unknown[]) => ({ id, refIds: [id], installed: true, version: "1", status: "ready", auth: { status: "authenticated" }, checkedAt: stamp(0), slashCommands: [], skills: [], models,
  capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: true, showPlanModeToggle: true, reportsContextWindow: true, compaction: { type: "native" } } });
const PROVIDERS = { hostInstanceId: "h", providers: [
  providerRow("claude", [{ slug: "opus", name: "Opus", isDefault: true, capabilities: effort }, { slug: "sonnet", name: "Sonnet", capabilities: effort }]),
  providerRow("codex", [{ slug: "gpt-5-codex", name: "GPT-5 Codex", isDefault: true, capabilities: effort }, { slug: "gpt-5", name: "GPT-5", capabilities: effort }])
] };
const ACCOUNTS = { accounts: [
  { id: "cx-1", agent: "codex", label: "codex one", email: null, plan: null, needsReauth: false, createdAt: stamp(0), importedAt: stamp(0) },
  { id: "cl-2", agent: "claude", label: "claude two", email: null, plan: null, needsReauth: false, createdAt: stamp(0), importedAt: stamp(0) }
], defaults: { claude: null, codex: "cx-1", grok: null } };

function continuing() {
  const { api } = harness();
  api.on("GET", "/api/registry", { status: 200, body: AGENTS })
    .on("GET", "/api/agent/providers", { status: 200, body: PROVIDERS })
    .on("GET", "/api/agent-accounts", { status: 200, body: ACCOUNTS })
    .on("GET", agentChatRoutes.threadHead("c1"), { status: 200, body: { head: head({ modelSelection: { model: "opus", options: [{ id: "effort", value: "high" }] } }) } });
  const handoff = { carried: 3, total: 4, bytes: 2_048 };
  api.on("POST", agentChatRoutes.fork("c1"), ({ body }) => {
    const request = body as { refId?: string; accountId?: string };
    const continued = request.refId !== undefined || request.accountId !== undefined;
    return {
      status: 200,
      body: {
        session: chatSummary({ id: "f1", refId: request.refId ?? "claude", accountId: request.accountId ?? "" }),
        strategy: continued ? "transcript" : "native",
        lineage: { parentThreadId: "c1", relation: "fork", createdAt: "x", ...(continued ? { sourceAgent: "claude" } : {}) },
        ...(continued ? { handoff } : {})
      }
    };
  });
  const lastBody = () => withoutId(api.calls.filter((c) => c.method === "POST").at(-1)!.body);
  return { api, lastBody, handoff };
}

test("fork_session continues in another agent: its model (named, else its default), options and account", async () => {
  const { api, lastBody, handoff } = continuing();
  const result = await tool("fork_session").run({ sessionId: "c1", agent: "codex", model: "gpt-5", options: { effort: "high" }, accountId: "cx-1" }, api);
  assert.deepEqual(lastBody(), { unattended: true, refId: "codex", accountId: "cx-1", modelSelection: { model: "gpt-5", options: [{ id: "effort", value: "high" }] } });
  assert.equal(result.strategy, "transcript");
  assert.equal(result.agent, "codex");
  assert.equal(result.accountId, "cx-1");
  assert.equal(result.model, "gpt-5");
  assert.deepEqual(result.handoff, handoff);
  assert.equal((result.lineage as { sourceAgent?: string }).sourceAgent, "claude");

  // No model named: the agent's launch default, never the parent's (another catalogue).
  await tool("fork_session").run({ sessionId: "c1", agent: "codex" }, api);
  assert.deepEqual(lastBody(), { unattended: true, refId: "codex", modelSelection: { model: "gpt-5-codex", options: [] } });
});

test("fork_session on the same agent: a model alone forks natively on it; another account continues by transcript", async () => {
  const { api, lastBody } = continuing();
  await tool("fork_session").run({ sessionId: "c1", model: "sonnet" }, api);
  assert.deepEqual(lastBody(), { unattended: true, modelSelection: { model: "sonnet", options: [{ id: "effort", value: "high" }] } }, "the parent's options survive a model its catalogue accepts them for");
  const accountOnly = await tool("fork_session").run({ sessionId: "c1", accountId: "cl-2" }, api);
  assert.deepEqual(lastBody(), { unattended: true, accountId: "cl-2" });
  assert.equal(accountOnly.strategy, "transcript");
  await tool("fork_session").run({ sessionId: "c1", agent: "claude" }, api);
  assert.deepEqual(lastBody(), { unattended: true }, "naming the parent's own agent is an ordinary fork");
});

test("fork_session refuses an unknown or unavailable agent, a model or account it does not have — before anything is forked", async () => {
  const { api } = continuing();
  const refused = (pattern: RegExp) => (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && pattern.test(e.message);
  await assert.rejects(tool("fork_session").run({ sessionId: "c1", agent: "gemini" }, api), refused(/Unknown agent "gemini"/));
  await assert.rejects(tool("fork_session").run({ sessionId: "c1", agent: "grok" }, api), refused(/not available on this host/));
  await assert.rejects(tool("fork_session").run({ sessionId: "c1", agent: "codex", model: "opus" }, api), refused(/Unknown model "opus" for codex/));
  await assert.rejects(tool("fork_session").run({ sessionId: "c1", agent: "codex", accountId: "cl-2" }, api), refused(/not usable with codex/));
  await assert.rejects(tool("fork_session").run({ sessionId: "c1", agent: "codex", options: { effort: "ludicrous" } }, api), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  assert.equal(api.calls.some((c) => c.method === "POST"), false, "nothing forked");
});

test("merge_back_session sends the fork's text and reports the delivery; a session that is no fork is refused", async () => {
  const { api } = harness();
  api.on("POST", agentChatRoutes.mergeBack("f1"), { status: 200, body: { parentSessionId: "c1", delivery: "queued", mergeId: "m1" } });
  const result = await tool("merge_back_session").run({ sessionId: "f1", text: "Use B." }, api);
  assert.deepEqual(result, { parentSessionId: "c1", delivery: "queued", mergeId: "m1" });
  assert.deepEqual(withoutId(api.calls.find((c) => c.method === "POST")!.body), { text: "Use B." });
  await tool("merge_back_session").run({ sessionId: "f1" }, api);
  assert.deepEqual(withoutId(api.calls.filter((c) => c.method === "POST").at(-1)!.body), {});
  const posts = api.calls.filter((c) => c.method === "POST").length;
  await assert.rejects(tool("merge_back_session").run({ sessionId: "c1", text: "x" }, api), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  assert.equal(api.calls.filter((c) => c.method === "POST").length, posts, "nothing was sent");
});

test("fork_session re-sends the SAME commandId while the host restarts, so a retry is one fork", async () => {
  const { api } = harness();
  let attempts = 0;
  api.on("POST", agentChatRoutes.fork("c1"), () => {
    attempts += 1;
    return attempts === 1
      ? { status: 503, body: { error: { code: "HOST_UNAVAILABLE", message: "restarting" } } }
      : { status: 200, body: { session: chatSummary({ id: "f1" }), strategy: "native", lineage: { parentThreadId: "c1", relation: "fork", createdAt: "x" } } };
  });
  await tool("fork_session").run({ sessionId: "c1" }, api);
  const ids = api.calls.filter((c) => c.method === "POST").map((c) => (c.body as { commandId: string }).commandId);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
});

test("resolve_merge_back is merge_back_session {mergeId, action}: deliver or discard a pending merge", async () => {
  const { api } = harness();
  api.on("POST", agentChatRoutes.mergeBackItem("c1", "m1"), (call) => ({
    status: 200,
    body: { mergeId: "m1", outcome: (call.body as { action: string }).action === "deliver" ? "sent" : "discarded" }
  }));
  assert.deepEqual(await tool("merge_back_session").run({ sessionId: "c1", mergeId: "m1", action: "deliver" }, api), { mergeId: "m1", outcome: "sent" });
  assert.deepEqual(await tool("merge_back_session").run({ sessionId: "c1", mergeId: "m1", action: "discard" }, api), { mergeId: "m1", outcome: "discarded" });
});
