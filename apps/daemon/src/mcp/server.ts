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
/**
 * Global playbook surfaced to the driving client in the `initialize` result (the
 * one place it's guaranteed to read — it never sees the .md doc). Teaches the three
 * on-screen states because the #1 failure is treating a real select-menu like the
 * normal input box: the agent sends Escape to "clear" it, but the menu's own hint
 * says "Esc to cancel" — so it dismisses the question and the next write lands in
 * the composer as a stray message.
 */
export const SERVER_INSTRUCTIONS = `Orquester terminal-control — observe and drive Orquester's terminal & coding-agent tabs, addressed as (workspace, project, tab) or by tabId. Always read_terminal (or the returned \`text\`) before AND after acting; a live spinner keeps settled:false even while the tab waits for you, so judge from \`text\`, not \`settled\` — and after a submit, settled:true only means the pane went quiet, so glance at \`text\` to confirm your message actually left the input box. Send ONE key per send_keys and read between.

Three on-screen states, each answered differently:

1. INTERACTIVE MENU — numbered options with a \`❯\` cursor on the selected row and a hint line like "Enter to select · Tab/Arrow keys to navigate · Esc to cancel". Answer it by the option NUMBER: write_input the number (e.g. "2"), no submit — that selects it. For a "Type something"/write-your-own option, send its number, then write_input your text, then send_keys ["Enter"]. Or navigate: send_keys ONE ["Down"]/["Up"], re-read, confirm by the \`❯\`/label (not the row), then send_keys ["Enter"]. NEVER send ["Escape"] to a menu you intend to answer — the hint literally says "Esc to cancel"; Escape dismisses the whole widget and drops the agent to its normal input box, so your next write becomes a stray chat message — and in a multi-question batch Escape declines EVERY question at once, so never Escape to "reset" or retry; if you're unsure, re-read and continue. A fresh menu has nothing to "clear" first. MULTI-QUESTION widgets show "Question N of M" and a top tab bar (one box per question: ☐ = unanswered, ☒ = answered, ending in "✔ Submit"). Answer ALL M before submitting. A single-select question auto-advances to the next the moment you pick its number. A MULTI-SELECT question (options show "[ ]" checkboxes) works differently: a number (or Space, or Enter on the row) only TOGGLES that checkbox and STAYS — so toggle each option you want, RE-READING after each to confirm its "[ ]"↔"[✔]" flip. To FINISH the question, send_keys ["Tab"] — Tab jumps straight to the finish action — then re-read to see where you landed. Do NOT type a number to finish: the finish action is an UNNUMBERED "Submit"/"Next" row BELOW the numbered options, and the numbered "Type something" just above it is a free-text option, NOT the finish button — confusing those two is the classic multi-select failure. After the last question a "Review your answers → 1. Submit answers / 2. Cancel" screen appears; submit with write_input "1" only when NO ☐ remain. Never submit while a question is still ☐ — if you reach Submit early, send_keys ["Left"] back to the unanswered question and answer it first.

2. NORMAL INPUT BOX — a \`❯\` prompt with NO numbered options. Just write_input your text with submit:true. Do not press Escape or try to clear it first. Greyed placeholder/ghost hints are filtered out of your read, so a lone \`❯\` means the box is EMPTY — the user has not typed anything; do not treat a leftover hint as "the user's prompt".

3. PROSE SUGGESTIONS — a numbered list written inside the agent's reply (no \`❯\` cursor, no "Enter to select" hint) is NOT a menu. Answer by typing a normal message (write_input, submit:true).`;

export const PROMPT_HINT =
  " Interactive MENU (numbered options + `❯` + an 'Esc to cancel' hint)? SINGLE-select: write_input the option NUMBER (or one send_keys arrow, then Enter). MULTI-select ('[ ]' checkboxes): a NUMBER only TOGGLES that option — toggle the ones you want (read between), then send_keys ['Tab'] to reach Submit/Next; the finish row is UNNUMBERED, so never a number and NOT the 'Type something' option. NEVER send Escape to a question you mean to answer: it cancels the whole batch and your next write becomes a stray message. Plain `❯` box (no numbered options): write_input with submit:true. Judge from the screen text, not `settled`.";

/** Build a per-request McpServer with all 11 tools bound to `control`. */
function buildServer(control: TerminalControl, signal: AbortSignal): McpServer {
  const server = new McpServer(
    { name: "orquester", version: "1.0.0" },
    { instructions: SERVER_INSTRUCTIONS }
  );
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
