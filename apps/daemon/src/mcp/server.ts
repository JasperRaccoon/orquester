import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { DaemonApi } from "./daemon-api.ts";
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

/**
 * A per-request McpServer with every tool bound to the caller's DaemonApi. The SDK parses each call's
 * arguments with the tool's own schema (defaults applied) before the handler runs, so `run` gets them
 * parsed — and answers an argument the schema refuses itself (isError, the SDK's own text). Anything
 * a tool throws becomes a coded isError result (spec §4.5).
 */
export function buildServer(deps: McpDeps, authorization: string | undefined, signal: AbortSignal): McpServer {
  const server = new McpServer({ name: "orquester", version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const ctx: ToolContext = { api: deps.createApi(authorization), todos: deps.todos, files: deps.files, signal, now: deps.now ?? (() => Date.now()) };
  for (const tool of allTools()) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: tool.annotations },
      async (args: Record<string, unknown>) => {
        try {
          return ok(await tool.run(args as never, ctx));
        } catch (error) {
          return toSafeToolError(error);
        }
      }
    );
  }
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
