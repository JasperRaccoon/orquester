/**
 * Codex adapter — the `orquester` session-tool server (design 2026-10-14
 * §1.2–§1.4).
 *
 * - **Transport.** Thread config over app-server JSON-RPC, on `thread/start`
 *   AND `thread/resume` (both carry `config`, `_generated/protocol/v2/
 *   Thread{Start,Resume}Params.ts`): `mcp_servers.orquester` = the host's
 *   loopback endpoint with `bearer_token_env_var`. The credential itself is
 *   only in the `codex app-server` child's env (one child per thread) — never
 *   in argv or in a frame, so `raw.ndjson` never sees it either. The key is
 *   the dotted path, so the override sets that one server and leaves the
 *   user's own `mcp_servers` table alone.
 * - **Approvals.** `default_tools_approval_mode = "approve"`: Codex never
 *   raises an elicitation for these tools.
 * - **Instructions.** `turn/start`'s `additionalContext` with kind
 *   `application` (`_generated/protocol/v2/TurnStartParams.ts`) — an additive
 *   context fragment that replaces nothing: `developer_instructions` stays
 *   null (`modes.ts`), and the user's input items are untouched.
 *
 * Verified against codex-cli 0.159.0 in a scratch `CODEX_HOME` (report
 * `task-1-report.md`): the server reaches `ready`, the env bearer is what
 * arrives at the endpoint, `mcp list` accepts the keys (`approve` is one of
 * `auto|prompt|writes|approve`), and `config/mcpServer/reload` — which the
 * adapter sends before a turn once it has seen an MCP server — keeps it.
 * - **The list** is the thread's manifest (unified MCP §9.4), served per request by the endpoint.
 *   Codex 0.159.0 ignores `notifications/tools/list_changed` and a reload does not reconnect the
 *   thread's server (Task 6 probe): a changed list reaches it through a session restart.
 * - **Denials (§12.1).** Each MCP server the manifest denies is switched off for this thread:
 *   `mcp_servers.<name>.enabled = false` in the same thread config (probed on 0.159.0: the user's
 *   server is never contacted). Only a name the thread's config HAS may be sent — Codex refuses
 *   `thread/start` for an `enabled`-only entry ("invalid transport", probed) — which the manifest
 *   guarantees (the thread's own account home and project). Our own `orquester` entry replaces a
 *   user's same-named one outright, so that name is never denied here.
 */

import { SESSION_TOOLS_SERVER_NAME } from "@orquester/api/agent-chat";

import { SESSION_TOOL_CALL_TIMEOUT_MS } from "../../../session-tools/contract.ts";
import type { CodexProtocol } from "./_generated/index.ts";

/** The child env var the credential rides in. Its `_TOKEN` suffix also gets it masked in stderr. */
export const CODEX_SESSION_TOOLS_TOKEN_ENV = "ORQUESTER_SESSION_TOOLS_TOKEN";

/** The `additionalContext` key the instruction block is filed under. */
export const CODEX_SESSION_TOOLS_CONTEXT_KEY = "orquester";

/** What a Codex session is given when session tools are on. */
export interface CodexSessionToolsLaunch {
  /** The loopback endpoint. */
  url: string;
  /** The "Orquester" instruction block; "" for none. */
  instructions: string;
  /** MCP servers to switch off in this thread (§12.1), by their config names. */
  deny?: readonly string[];
}

/** A server name Codex can address as a dotted config key. */
const CODEX_SERVER_KEY = /^[A-Za-z0-9_-]+$/;

/** `thread/start`'s (and `thread/resume`'s) `config` map. */
type ThreadConfig = NonNullable<CodexProtocol.v2.ThreadStartParams["config"]>;

/**
 * The `mcp_servers.<name>.enabled = false` keys for a thread's denials (§12.1). A name that is not
 * a bare config key (`[A-Za-z0-9_-]`) cannot be addressed as a dotted override and is returned in
 * `dropped` — the caller logs it (Codex itself only creates bare names through `codex mcp add`).
 * Our own `orquester` is never denied: the thread entry replaces a user's same-named one.
 */
export function codexDeniedServerKeys(deny: readonly string[] = []): { keys: string[]; dropped: string[] } {
  const keys: string[] = [];
  const dropped: string[] = [];
  for (const name of new Set(deny)) {
    if (name === SESSION_TOOLS_SERVER_NAME) continue;
    if (CODEX_SERVER_KEY.test(name)) keys.push(`mcp_servers.${name}.enabled`);
    else dropped.push(name);
  }
  return { keys, dropped };
}

/** The thread `config` that switches the denied servers off — also without our own server (no grant). */
export function codexDenyConfig(deny: readonly string[] = []): ThreadConfig {
  return Object.fromEntries(codexDeniedServerKeys(deny).keys.map((key) => [key, false]));
}

/** The thread `config` overrides that attach the server. Names an env var, never the credential. */
export function codexSessionToolsConfig(launch: CodexSessionToolsLaunch): ThreadConfig {
  return {
    [`mcp_servers.${SESSION_TOOLS_SERVER_NAME}`]: {
      url: launch.url,
      bearer_token_env_var: CODEX_SESSION_TOOLS_TOKEN_ENV,
      default_tools_approval_mode: "approve",
      // Codex gives up on an MCP call after 60 s by default; a session tool
      // that waits for the user (`request_secret`) ends its own wait first.
      tool_timeout_sec: SESSION_TOOL_CALL_TIMEOUT_MS / 1000
    },
    ...codexDenyConfig(launch.deny)
  };
}

/** `turn/start`'s `additionalContext` for the instruction block, or undefined for none. */
export function codexSessionToolsContext(
  launch: CodexSessionToolsLaunch | undefined
): { [key: string]: CodexProtocol.v2.AdditionalContextEntry } | undefined {
  if (launch === undefined || launch.instructions.length === 0) {
    return undefined;
  }
  return { [CODEX_SESSION_TOOLS_CONTEXT_KEY]: { kind: "application", value: launch.instructions } };
}
