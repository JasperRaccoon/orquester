import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { DaemonApi } from "./daemon-api.ts";
import type { AnyOrquesterTool } from "./catalog/contract.ts";
import { catalogFor } from "./catalog/index.ts";
import { audienceDescription, audienceSchema, audienceShape, executeToolCall } from "./executor.ts";
import { argumentProblems, clipText, MAX_ECHO_CHARS } from "./result.ts";

export { argumentProblems };

/** 16 MiB: room for inline base64 attachments (spec §8.2). */
const MCP_BODY_LIMIT = 16 * 1024 * 1024;

export interface McpDeps {
  /** Built per request with the caller's own `Authorization` header, so every daemon call is authorised as the caller (spec §4.2). */
  createApi: (authorization: string | undefined) => DaemonApi;
  /**
   * The external principal's `credentialId` for an authenticated request (`./principal.ts`
   * `externalCredentialId`): every daemon call a tool makes acts as `{kind: "external",
   * credentialId}`. Absent: `{kind: "external"}` without one.
   */
  credentialId?: (authorization: string | undefined) => string | undefined;
}

const SERVER_VERSION = "2.0.0";

/**
 * ≤ 2 KB: Claude Code truncates server instructions around there (and surfaces them only with tool
 * search on), so every load-bearing rule is also in the description of the tool it governs.
 */
const SERVER_INSTRUCTIONS = `Orquester MCP drives Orquester's agent chat sessions (Claude Code, Codex, OpenCode, Grok) like the chat GUI. A session is a tab: a chat with an agent, or a terminal (listed and closable only). Addressing: sessions by sessionId (list_sessions); projects by absolute path or "workspace/project" (list_projects). Call list_agents for the valid models, options (effort…), permission modes and accounts before create_session or update_session. create_session opens a chat tab, or resumes a conversation from list_conversations; send_message talks to it — wait:true (default) returns the reply or the question/approval it stopped on; while a turn runs, a message steers it. get_session shows status (status/attention/reason), pending questions and approvals with their ids and options, the proposed plan, subagents and the context meter; read_transcript shows what was said and done (agentId drills into a subagent), read_tool_output a tool row's whole output (its outputItemId); search_sessions finds words across every chat. answer_question / resolve_approval / dismiss_question act on pending requests; implement_plan is the GUI's Implement button. update_session changes model, effort/options, permission mode, account or title. fork_session branches a chat from a turn into a new tab; merge_back_session sends the fork's result back to its parent (queued while the parent is busy); get_session_lineage lists parent and children. wait_for_session blocks until a session needs you — pass its cursor back as \`after\`; never poll in a loop. Attachments are inline ({path} in the sandbox or {name, base64}). get_usage percentages are % USED. Automated workflows: list_workflow_block_types first, then create_workflow; edit with update_workflow ops (revision from get_workflow); preview_expression checks a {{ }} template against a past run's or pinned data without running; run_workflow, get_workflow_run. Agent profiles (each CLI's global MCP servers, skills, plugins, hooks, commands, instruction file): list_agent_profiles, get_agent_profile first; MCP secret values are write-only. GUI desktops: desktop_host_status first. Errors carry a code (SESSION_BUSY, PENDING_REQUEST, INVALID_ARGUMENT…) and a message naming the fix.`;

/** Every external tool, in tools/list order: the catalog's `external` audience (unified MCP design 2026-10-15 §3.1). */
function externalTools(): readonly AnyOrquesterTool[] {
  return catalogFor("external");
}

/** Every tool name this server serves, in tools/list order. */
export function externalMcpToolNames(): string[] {
  return externalTools().map((tool) => tool.name);
}

/** A tool's highest chat tier, as `_meta` reports it (a per-call tier reports its widest: Admin). */
function metaTier(tool: AnyOrquesterTool): string {
  return typeof tool.tier === "function" ? "admin" : tool.tier;
}

/**
 * A per-request McpServer with every tool bound to the caller's DaemonApi. The registrations are what `tools/list`
 * serves; `tools/call` is our own handler, installed over the SDK's through its public `server.setRequestHandler`: the
 * SDK answers an argument the schema refuses with its own text, outside spec §4.5's envelope. Ours parses the
 * arguments once (defaults applied; an unknown key refused; no `arguments` at all is `{}`),
 * answers a refusal as INVALID_ARGUMENT naming the fields, and turns anything `run` throws into a coded isError result.
 * An unknown tool is deliberately the JSON-RPC InvalidParams error (−32602), as the MCP spec has it: SDK 1.29's own
 * handler raises the same error but catches it into an `isError` tool result. What else that handler checks is skipped
 * on purpose: a tool's `enabled` flag (no tool is ever disabled), task support and output schemas (no tool declares
 * either).
 */
function buildServer(deps: McpDeps, authorization: string | undefined, signal: AbortSignal): McpServer {
  const server = new McpServer({ name: "orquester", version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const api = deps.createApi(authorization);
  const credentialId = deps.credentialId?.(authorization);
  const principal = { kind: "external" as const, ...(credentialId ? { credentialId } : {}) };
  const tools = new Map<string, AnyOrquesterTool>();
  for (const tool of externalTools()) {
    tools.set(tool.name, tool);
    // Match tools/list's additionalProperties:false; reject misspelled keys instead of silently taking defaults.
    const shape = audienceShape(tool, "external");
    // The SDK lists an empty shape as a bare `{type: "object"}`; the strict object keeps additionalProperties:false.
    const inputSchema = Object.keys(shape).length > 0 ? shape : audienceSchema(tool, "external");
    // Never invoked — the tools/call handler below replaces the SDK's.
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: audienceDescription(tool, "external"),
        inputSchema,
        annotations: tool.annotations,
        _meta: { "orquester/tier": metaTier(tool), "orquester/toolset": tool.toolset }
      },
      () => ({ content: [] })
    );
  }
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.get(request.params.name);
    // The name is the caller's text, of any length: quoted back capped, as every refusal quotes a caller's value.
    if (!tool) throw new McpError(ErrorCode.InvalidParams, `Tool ${clipText(request.params.name, MAX_ECHO_CHARS)} not found`);
    return executeToolCall(
      {},
      { name: tool.name, arguments: request.params.arguments },
      { caller: { kind: "external" }, api, signal, principal }
    );
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
    // A client gone before this point has had its 'close' already, and it never fires again: nothing would abort a wait
    // started for it, and nothing will read the answer. Do no work for it (hijacked, so Fastify sends nothing either).
    if (reply.raw.destroyed) {
      reply.hijack();
      return;
    }
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
