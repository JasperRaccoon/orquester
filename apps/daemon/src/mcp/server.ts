import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { DaemonApi } from "./daemon-api.ts";
import { ToolError } from "./errors.ts";
import type { FsTools } from "./fs-tools.ts";
import { ok, toSafeToolError } from "./result.ts";
import type { TodoTools } from "./todo-tools.ts";
import type { ToolContext, ToolDef } from "./tool.ts";
import { catalogTools } from "./tools/catalog.ts";
import { fileTools } from "./tools/files.ts";
import { messageTools } from "./tools/messages.ts";
import { requestTools } from "./tools/requests.ts";
import { sessionTools } from "./tools/sessions.ts";
import { todoTools } from "./tools/todos.ts";
import { usageTools } from "./tools/usage.ts";
import { watchTools } from "./tools/watch.ts";

/** 16 MiB: room for inline base64 attachments (spec §8.2). */
const MCP_BODY_LIMIT = 16 * 1024 * 1024;

export interface McpDeps {
  /** Built per request with the caller's own `Authorization` header, so every daemon call is authorised as the caller (spec §4.2). */
  createApi: (authorization: string | undefined) => DaemonApi;
  todos: TodoTools;
  files: FsTools;
  now?: () => number;
}

export const SERVER_VERSION = "2.0.0";

/**
 * ≤ 2 KB: Claude Code truncates server instructions around there (and surfaces them only with tool
 * search on), so every load-bearing rule is also in the description of the tool it governs.
 */
export const SERVER_INSTRUCTIONS = `Orquester MCP drives Orquester's agent chat sessions (Claude Code, Codex, OpenCode, Grok) exactly like the chat GUI. A session is a tab: a chat with an agent, or a terminal (listed and closable only). Addressing: sessions by sessionId (list_sessions); projects by absolute path or "workspace/project" (list_projects). Call list_agents for the valid models, options (effort…), permission modes and accounts before create_session or update_session. create_session opens a chat tab, or resumes a conversation from list_conversations; send_message talks to it — wait:true (default) returns the reply or the question/approval it stopped on; while a turn runs, a message steers it. get_session shows status (status/attention/reason), pending questions and approvals with their ids and options, the proposed plan, subagents and the context meter; read_transcript shows what was said and done (agentId drills into a subagent). answer_question / resolve_approval / dismiss_question act on pending requests; implement_plan is the GUI's Implement button. update_session changes model, effort/options, permission mode, account or title. wait_for_session blocks until a session needs you — pass its cursor back as \`after\`; never poll in a loop. Attachments are inline ({path} in the sandbox or {name, base64}). get_usage percentages are % USED. Errors carry a code (SESSION_BUSY, PENDING_REQUEST, INVALID_ARGUMENT…) and a message naming the fix.`;

/** Every tool, in tools/list order (spec §7.10: 29). */
export function allTools(): ToolDef[] {
  return [...catalogTools, ...sessionTools, ...messageTools, ...requestTools, ...watchTools, ...usageTools, ...fileTools, ...todoTools];
}

/** How many refused fields an INVALID_ARGUMENT names before "…". */
const MAX_NAMED_ISSUES = 5;

/** The one line an argument the schema refuses answers with: each bad field and why, as zod words it. */
export function argumentProblems(toolName: string, error: z.ZodError): string {
  const named = error.issues.slice(0, MAX_NAMED_ISSUES).map((issue) => `${issue.path.length ? issue.path.join(".") : "arguments"}: ${issue.message}`);
  const more = error.issues.length > MAX_NAMED_ISSUES ? "; …" : "";
  return `Invalid arguments for ${toolName}: ${named.join("; ")}${more}.`.replace(/\s+/g, " ");
}

/**
 * A per-request McpServer with every tool bound to the caller's DaemonApi. The registrations are what `tools/list`
 * serves; `tools/call` is our own handler, installed over the SDK's through its public `server.setRequestHandler`: the
 * SDK answers an argument the schema refuses with its own text, outside spec §4.5's envelope. Ours parses the
 * arguments ONCE with the tool's own schema (defaults applied; no `arguments` at all is `{}`), answers a refusal as
 * INVALID_ARGUMENT naming the fields, and turns anything `run` throws into a coded isError result. An unknown tool is
 * the JSON-RPC InvalidParams error the SDK raises for it.
 */
export function buildServer(deps: McpDeps, authorization: string | undefined, signal: AbortSignal): McpServer {
  const server = new McpServer({ name: "orquester", version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const ctx: ToolContext = { api: deps.createApi(authorization), todos: deps.todos, files: deps.files, signal, now: deps.now ?? (() => Date.now()) };
  const call = async (tool: ToolDef, args: unknown) => {
    try {
      return ok(await tool.run(args as never, ctx));
    } catch (error) {
      return toSafeToolError(error);
    }
  };
  const tools = new Map<string, ToolDef>();
  for (const tool of allTools()) {
    tools.set(tool.name, tool);
    // Never invoked — the tools/call handler below replaces the SDK's — but it would answer the same way.
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: tool.annotations }, (args: Record<string, unknown>) => call(tool, args));
  }
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.get(request.params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
    const parsed = await z.object(tool.input).safeParseAsync(request.params.arguments ?? {});
    if (!parsed.success) return toSafeToolError(new ToolError("INVALID_ARGUMENT", argumentProblems(tool.name, parsed.error)));
    return call(tool, parsed.data);
  });
  return server;
}

/** What the SDK's own stateless examples answer for the two methods a stateless server does not serve. */
const METHOD_NOT_ALLOWED = { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null };

/**
 * Mount `POST /mcp` (Streamable HTTP, stateless, JSON responses). The caller registers this ONLY on
 * the HTTP transport, behind the global bearer hook: the unix socket is unauthenticated.
 */
export function registerMcp(app: FastifyInstance, deps: McpDeps): void {
  app.post("/mcp", { bodyLimit: MCP_BODY_LIMIT }, async (request, reply) => {
    const ctrl = new AbortController(); // aborts in-flight waits when the client goes away
    const server = buildServer(deps, request.headers.authorization, ctrl.signal);
    // The transport answers 406 unless Accept lists both application/json and text/event-stream.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true
    });
    reply.hijack();
    reply.raw.on("close", () => {
      ctrl.abort();
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      console.error("[mcp] request failed", error);
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
      }
      reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
    }
  });
  // No sessions and no server-initiated stream: answer the MCP spec's 405 rather than the daemon's JSON 404.
  const notAllowed = async (_request: FastifyRequest, reply: FastifyReply) => reply.code(405).header("allow", "POST").send(METHOD_NOT_ALLOWED);
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
}
