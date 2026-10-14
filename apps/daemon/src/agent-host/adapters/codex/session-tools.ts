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
 */

import { SESSION_TOOLS_SERVER_NAME } from "@orquester/api/agent-chat";

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
}

/** `thread/start`'s (and `thread/resume`'s) `config` map. */
type ThreadConfig = NonNullable<CodexProtocol.v2.ThreadStartParams["config"]>;

/** The thread `config` overrides that attach the server. Names an env var, never the credential. */
export function codexSessionToolsConfig(launch: CodexSessionToolsLaunch): ThreadConfig {
  return {
    [`mcp_servers.${SESSION_TOOLS_SERVER_NAME}`]: {
      url: launch.url,
      bearer_token_env_var: CODEX_SESSION_TOOLS_TOKEN_ENV,
      default_tools_approval_mode: "approve"
    }
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
