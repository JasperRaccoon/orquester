import type { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { FsSandboxError } from "@orquester/config/fs";
import { SessionError } from "../sessions.ts";
import { AmbiguousTab, TabNotFound, TerminalControl, ToolError } from "./terminal-control.ts";

const MCP_BODY_LIMIT = 8 * 1024 * 1024;

/** Map any thrown error to an MCP isError result with a SAFE message (no path/stack leak). */
export function toSafeToolError(err: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  let message: string;
  if (err instanceof TabNotFound || err instanceof AmbiguousTab || err instanceof ToolError) {
    message = err.message; // terminal-control's own — crafted safe (titles/ids, limits)
  } else if (err instanceof SessionError) {
    message = err.message; // e.g. 'Registry entry "claude" is not available.' — safe
  } else if (err instanceof FsSandboxError) {
    message = "Path is not allowed (outside the sandbox)."; // NEVER the raw path
  } else {
    console.error("[mcp] unexpected tool error", err); // detail server-side only
    message = "Internal error handling the tool call.";
  }
  return { content: [{ type: "text", text: message }], isError: true };
}

/** JSON text content for a successful tool result. */
function ok(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

const sel = {
  workspace: z.string().optional(),
  project: z.string().optional(),
  tab: z.string().optional(),
  tabId: z.string().optional(),
};
const PROMPT_HINT =
  " For interactive prompts (menus): read the screen regardless of `settled`, prefer a number/letter shortcut via write_input, else send ONE arrow via send_keys and re-read; confirm with Enter.";

/** Build a per-request McpServer with all 11 tools bound to `control`. */
function buildServer(control: TerminalControl, signal: AbortSignal): McpServer {
  const server = new McpServer({ name: "orquester", version: "1.0.0" });
  const tool = (
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    run: (args: any) => unknown | Promise<unknown>
  ) =>
    server.registerTool(name, { description, inputSchema: schema }, async (args: any) => {
      try {
        return ok(await run(args));
      } catch (e) {
        return toSafeToolError(e);
      }
    });

  tool("list_workspaces", "List workspaces.", {}, async () =>
    (await control.listWorkspacesProjected()).map((w) => ({ name: w.name, projectCount: w.projectCount }))
  );
  tool("list_projects", "List a workspace's projects.", { workspace: z.string() }, async (a) =>
    (await control.listProjectsProjected(a.workspace)).map((p) => ({ name: p.name, path: p.path }))
  );
  tool("list_tabs", "List a project's tabs (sessions).", { workspace: z.string(), project: z.string() }, (a) =>
    control.listTabs({ workspace: a.workspace, project: a.project })
  );
  tool("list_launchers", "List launchable shells/agents (valid refIds for create_tab).", {}, () =>
    control.listLaunchers()
  );
  tool("read_terminal", "Read a tab's clean rendered screen text." + PROMPT_HINT,
    { ...sel, lines: z.number().int().optional() },
    (a) => control.readTerminal(a, { lines: a.lines })
  );
  tool("write_input", "Type text into a tab; submit:true appends Enter. Use for literal shortcut keys (1, y)." + PROMPT_HINT,
    { ...sel, data: z.string(), submit: z.boolean().optional() },
    (a) => control.writeInput(a, a.data, { submit: a.submit })
  );
  tool("send_keys", "Send named/control keys to a tab (Enter, C-c, Up, Space, Tab, Escape…). One key at a time; read between." + PROMPT_HINT,
    { ...sel, keys: z.array(z.string()) },
    (a) => control.sendKeys(a, a.keys)
  );
  tool("send_and_wait", "Write input, then block until the pane is quiet (or timeout). Inspect `text` for a prompt regardless of `settled`." + PROMPT_HINT,
    { ...sel, data: z.string(), submit: z.boolean().optional(), idleMs: z.number().int().optional(), timeoutMs: z.number().int().optional(), lines: z.number().int().optional() },
    (a) => control.sendAndWait(a, a.data, { submit: a.submit, idleMs: a.idleMs, timeoutMs: a.timeoutMs, lines: a.lines, signal })
  );
  tool("wait_for_idle", "Block until the pane is quiet (no write). The re-invoke path after a settled:false." + PROMPT_HINT,
    { ...sel, idleMs: z.number().int().optional(), timeoutMs: z.number().int().optional(), lines: z.number().int().optional() },
    (a) => control.waitForIdle(a, { idleMs: a.idleMs, timeoutMs: a.timeoutMs, lines: a.lines, signal })
  );
  tool("create_tab", "Launch a new tab (shell/agent from list_launchers) in a project. cwd is sandboxed.",
    { workspace: z.string(), project: z.string(), refId: z.string(), title: z.string().optional(), cwd: z.string().optional() },
    (a) => control.createTab({ workspace: a.workspace, project: a.project }, { refId: a.refId, title: a.title, cwd: a.cwd })
  );
  tool("close_tab", "Close a tab.", sel, (a) => control.closeTab(a));

  return server;
}

/** Mount POST /mcp (Streamable-HTTP, stateless). Caller registers this ONLY on the HTTP transport. */
export function registerMcp(app: FastifyInstance, control: TerminalControl): void {
  app.post("/mcp", { bodyLimit: MCP_BODY_LIMIT }, async (request, reply) => {
    const ctrl = new AbortController(); // cancels in-flight waits on disconnect
    const server = buildServer(control, ctrl.signal);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
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
}
