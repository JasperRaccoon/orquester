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

/** 3.0.0: the unified catalog (design 2026-10-15 §11) — 41 tools, renamed and merged from the 72-tool 2.x surface. */
export const SERVER_VERSION = "3.0.0";

/**
 * ≤ 2 KB: Claude Code truncates server instructions around there (and surfaces them only with tool
 * search on), so every load-bearing rule is also in the description of the tool it governs. Every
 * tool it names is an external catalog tool (`catalog/registry.test.ts`).
 */
export const SERVER_INSTRUCTIONS = `Orquester MCP drives Orquester's agent chats (Claude Code, Codex, OpenCode, Grok) like its GUI. A session is a tab: an agent chat, or a terminal (listed and closable only). Address sessions by sessionId (list_sessions) and projects by absolute path or "workspace/project" (list_projects). list_agents gives the valid agents, models, options, permission modes and accounts for create_session and update_session.
create_session opens a chat (or resumes one from list_conversations), optionally with a first prompt. send_message talks to a chat: reply "wait" (default) returns the reply of the turn it causes, queued behind a working chat; reply "none" returns at once, steering a working chat. get_session shows status, pending requests, plan, lineage and context; read_transcript what was said and done; read_tool_output a tool row's whole output; get_turn_diff a turn's diff; search_sessions searches chats. respond_to_request answers (or dismisses) a question or decides a tool approval. control_session interrupts, stops, compacts, rewinds or closes. fork_session branches a chat; merge_back_session sends a fork's result back. wait_for_session blocks until a session needs you: pass its cursor back as \`after\`; never poll. Attachments are inline ({path} in the sandbox or {name, base64}).
Read only: read_file, get_git_state, get_usage (percentages are % used). Notes: list_todos, update_todos, list_saved_prompts, update_saved_prompts. notify_user pushes to the user's devices.
Workflows: list_workflow_block_types first, then create_workflow (dryRun validates); edit with update_workflow ops (revision from get_workflow); preview_expression checks a {{ }} template; run_workflow takes the revision; get_workflow_runs shows runs. Agent profiles (each CLI's MCP servers, skills, plugins, hooks, commands, instructions): get_agent_profile, then edit_agent_profile; secret values are write-only. Desktops: get_desktops, control_desktop.
Errors carry a code (SESSION_BUSY, PENDING_REQUEST, INVALID_ARGUMENT…) and a message naming the fix.`;

/** Every external tool, in tools/list order: the catalog's `external` audience (unified MCP design 2026-10-15 §3.1). */
function externalTools(): readonly AnyOrquesterTool[] {
  return catalogFor("external");
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
