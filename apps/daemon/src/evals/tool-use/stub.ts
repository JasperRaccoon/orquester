/**
 * The `orquester` server a sample talks to: the thread's real manifest (tool list and instruction
 * block) and the catalog's real advertised schemas, served by the host's own in-process server —
 * but every call is answered from the case's mocks, or a default shaped like the daemon's, after
 * the same strict argument parse the daemon runs. Nothing reaches a daemon.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import { catalogFor, toolByName } from "../../mcp/catalog/index.ts";
import { ToolError } from "../../mcp/errors.ts";
import { audienceSchema } from "../../mcp/executor.ts";
import { argumentProblems, ok, toSafeToolError } from "../../mcp/result.ts";
import { buildChatToolDefinitions } from "../../agent-host/session-tools/definitions.ts";
import { buildSessionToolsMcpServer, type SessionToolsMcpServer } from "../../agent-host/session-tools/mcp-server.ts";
import { buildSessionToolsManifest } from "../../session-tools/manifest.ts";
import type { Mock, ToolUseCase } from "./case.ts";
import { argsMatch } from "./grade.ts";

/** What this sample's chat has done through Orquester: the chats it opened, in order. */
export interface StubState {
  sessions: { sessionId: string; title: string; agent: string; status: string }[];
  nextSession: number;
}

export const newStubState = (): StubState => ({ sessions: [], nextSession: 2001 });

export interface StubServer {
  server: SessionToolsMcpServer;
  /** The thread's "Orquester" block, as the daemon would compose it. */
  instructions: string;
  /** The advertised tools, as the model gets them. */
  tools: readonly Tool[];
  names: ReadonlySet<string>;
}

/** The manifest and tool entries a case's chat is given. */
export async function advertisedFor(testCase: ToolUseCase, home: string, cwd: string): Promise<{ instructions: string; tools: Tool[] }> {
  const toolsets = testCase.setup.toolsets;
  const manifest = buildSessionToolsManifest({
    thread: { agentId: "claude", home, projectPaths: [cwd], workflowOwned: testCase.setup.workflowOwned },
    catalog: catalogFor("chat"),
    daemonPointing: [],
    boxesAvailable: toolsets.boxes === true,
    devicesAvailable: toolsets.devices === true,
    ...(toolsets.knowledge !== undefined
      ? { knowledge: { enabled: true, worker: false, searchable: toolsets.knowledge.length > 0, visibleCollectionNames: toolsets.knowledge } }
      : {})
  });
  const definitions = await buildChatToolDefinitions();
  const tools = manifest.tools.flatMap((name) => {
    const entry = definitions.byName.get(name)?.entry;
    return entry === undefined ? [] : [entry];
  });
  return { instructions: manifest.instructions, tools };
}

export async function buildStubServer(testCase: ToolUseCase, home: string, cwd: string): Promise<StubServer> {
  const { instructions, tools } = await advertisedFor(testCase, home, cwd);
  const names = new Set(tools.map((tool) => tool.name));
  const state = newStubState();
  const server = buildSessionToolsMcpServer({ list: () => tools, accepts: (name) => names.has(name) }, async ({ name, arguments: args }) =>
    answer(testCase, name, (args ?? {}) as Record<string, unknown>, state)
  );
  return { server, instructions, tools, names };
}

/** One call's result: the daemon's argument refusal, else the case's mock, else the default. */
export async function answer(testCase: ToolUseCase, name: string, args: Record<string, unknown>, state: StubState = newStubState()): Promise<CallToolResult> {
  const tool = toolByName(name, "chat");
  if (tool !== undefined) {
    const parsed = await audienceSchema(tool, "chat").safeParseAsync(args);
    if (!parsed.success) return toSafeToolError(new ToolError("INVALID_ARGUMENT", argumentProblems(tool.name, parsed.error)));
  }
  const mocks = testCase.setup.mocks[name];
  const mock = (Array.isArray(mocks) ? mocks : mocks === undefined ? [] : [mocks]).find((candidate: Mock) => argsMatch(candidate.when, args));
  if (mock !== undefined) return mockResult(mock);
  return ok(defaultResult(name, args, state));
}

function mockResult(mock: Mock): CallToolResult {
  const text = typeof mock.result === "string" ? mock.result : JSON.stringify(mock.result);
  if (mock.isError === true) {
    const code = /^([A-Z][A-Z_]+):/.exec(text)?.[1] ?? "INTERNAL";
    return { content: [{ type: "text", text }], structuredContent: { code, message: text.replace(/^[A-Z][A-Z_]+:\s*/, "") }, isError: true };
  }
  return mock.result !== null && typeof mock.result === "object"
    ? { content: [{ type: "text", text }], structuredContent: mock.result as Record<string, unknown> }
    : { content: [{ type: "text", text }] };
}

// Result wording, verbatim from `mcp/tools/messages.ts`, `visuals.ts`, `secrets.ts` and `boxes.ts`.
const NOTIFY_HINT = "Its final reply will be delivered to you as a new message; end your turn or go on with other work.";
const HTML_RENDER_MESSAGE = "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.";
const SECRET_PROVIDED_NOTE =
  "The user provided the value. Use it only where it is needed (an env var for one command, the config file the user asked for); never print, echo, log or commit it, and never repeat it in chat.";
const BOX_READY_NOTE = "Ready and empty: Orquester copied nothing into it. It bills until destroy_box, its deadline, or this chat closing.";
const LEND_NEXT = "Pass this appdir to the eval (--appdir or ORQUESTER_APPDIR). Logins renew by themselves until lent_until. Call box_return_accounts when the run ends.";

function replyFields(reply: unknown): Record<string, unknown> {
  if (reply === "notify") return { delivery: "posted", subscriptionId: "sub-3001", willNotify: true, hint: NOTIFY_HINT };
  if (reply === "wait") return { outcome: "completed", reply: "Done." };
  return {};
}

const PROJECT = { project: "acme/app", path: "/home/user/workspaces/acme/app" };

/** A result shaped like the daemon's for a call no mock answers. */
export function defaultResult(name: string, args: Record<string, unknown>, state: StubState = newStubState()): Record<string, unknown> {
  switch (name) {
    case "list_projects":
      return { projects: [{ workspace: "acme", name: "app", ...PROJECT, openSessions: 1, current: true }], workspaces: [{ name: "acme" }] };
    case "list_agents": {
      const agent = (id: string, models: string[]) => ({
        id,
        enabled: true,
        installed: true,
        status: "ready",
        models: models.map((slug, index) => ({ slug, ...(index === 0 ? { isDefault: true } : {}) })),
        accounts: [{ id: `${id}-acct-1`, label: `${id}@acme.dev`, isDefault: true }]
      });
      return {
        agents: [
          agent("claude", ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]),
          agent("codex", ["gpt-6.1-sol", "gpt-6-astra"]),
          agent("grok", ["grok-5"]),
          agent("opencode", ["big-pickle"])
        ],
        thisThread: { agent: "claude", model: "claude-sonnet-5-5", options: {}, runtimeMode: "approval-required", accountId: "claude-acct-1" }
      };
    }
    case "list_sessions":
      return { sessions: state.sessions.map((session) => ({ ...session, project: PROJECT.project })) };
    case "get_session": {
      const known = state.sessions.find((session) => session.sessionId === args.sessionId);
      return known !== undefined ? { ...known, project: PROJECT.project } : { sessionId: args.sessionId ?? "sess-2001", status: "idle", title: "Chat" };
    }
    case "read_transcript":
      return { turns: [], olderTurns: 0 };
    case "search_sessions":
      return { hits: [], indexed: true };
    case "wait_for_session":
      return { sessionId: args.sessionId ?? "sess-2001", status: "idle" };
    case "create_session": {
      const session = {
        sessionId: `sess-${state.nextSession++}`,
        title: typeof args.title === "string" ? args.title : "New chat",
        agent: typeof args.agent === "string" ? args.agent : "claude",
        status: args.prompt !== undefined ? "running" : "idle"
      };
      state.sessions.push(session);
      return {
        ...session,
        project: typeof args.project === "string" ? args.project : PROJECT.project,
        ...(args.prompt !== undefined ? replyFields(args.reply ?? (args.delegate === true ? "notify" : "none")) : {})
      };
    }
    case "send_message":
      return { sessionId: args.sessionId ?? "sess-2001", ...replyFields(args.reply ?? "wait") };
    case "respond_to_request":
      return { seq: 12, session: { sessionId: args.sessionId ?? "sess-2001", status: "running" } };
    case "html_preview":
      return { width: args.width ?? 728, contentHeight: 640, capturedHeight: 640, consoleMessages: [] };
    case "html_render":
      return { htmlRender: { title: args.title ?? "Page", height: args.height ?? 640 }, message: HTML_RENDER_MESSAGE };
    case "request_secret":
      return { secretRequest: { name: args.name ?? "SECRET", outcome: "provided" }, value: "sk_test_eval_00000000", note: SECRET_PROVIDED_NOTE };
    case "create_box":
      return {
        box_id: "box-5001",
        kind: args.kind ?? "linux",
        provider: args.provider ?? "vultr",
        os: "ubuntu-24.04",
        arch: "x86_64",
        hourly_usd: 0.06,
        deadline: new Date(Date.now() + 4 * 3_600_000).toISOString(),
        note: BOX_READY_NOTE
      };
    case "list_boxes":
      return { boxes: [], lent_accounts: [] };
    case "box_lend_accounts": {
      const lentUntil = new Date(Date.now() + 4 * 3_600_000).toISOString();
      const lent = (agent: string, names: unknown) =>
        (Array.isArray(names) ? names : []).map((name, index) => ({
          agent,
          label: String(name),
          id: `${agent}-acct-${index + 1}`,
          home: `/var/lib/orquester/daemon/agent-accounts/${agent}/${agent}-acct-${index + 1}/home`,
          lent_until: lentUntil,
          token_expires_at: lentUntil
        }));
      return { box_id: args.box_id ?? "box-5001", appdir: "/var/lib/orquester", accounts: [...lent("claude", args.claude), ...lent("codex", args.codex)], next: LEND_NEXT };
    }
    case "box_return_accounts":
      return { box_id: args.box_id ?? "box-5001", returned: [] };
    case "box_exec":
      return { exitCode: 0, stdout: "", stderr: "" };
    case "knowledge_search":
      return { results: [] };
    default:
      return { ok: true };
  }
}
