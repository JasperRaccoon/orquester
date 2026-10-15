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
 * - **Any server name** (probed on 0.159.0, `thread/start` `config`): Codex splits an override key
 *   on every `.` with no quoting — `mcp_servers."a.b".enabled` addresses a server `"a` and fails
 *   the thread ("invalid transport") — but any other character (a space, a quote, a bracket) is
 *   fine in a dotted key. An override VALUE that is a table is merged into the config (a server
 *   keeps its transport and only `enabled` changes), while a key `mcp_servers` beside
 *   `mcp_servers.orquester` replaces the latter. So a name containing `.` is denied by sending the
 *   whole override as ONE `mcp_servers` table (ours and every denial in it); otherwise the dotted
 *   keys are kept.
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

/** `thread/start`'s (and `thread/resume`'s) `config` map. */
type ThreadConfig = NonNullable<CodexProtocol.v2.ThreadStartParams["config"]>;
type ConfigValue = NonNullable<ThreadConfig[string]>;

/** The `mcp_servers` entries a thread's config overrides: ours, and `{enabled: false}` per denial. */
function codexServerOverrides(launch: CodexSessionToolsLaunch | undefined, deny: readonly string[]): Map<string, ConfigValue> {
  const entries = new Map<string, ConfigValue>();
  if (launch !== undefined) {
    entries.set(SESSION_TOOLS_SERVER_NAME, {
      url: launch.url,
      bearer_token_env_var: CODEX_SESSION_TOOLS_TOKEN_ENV,
      default_tools_approval_mode: "approve",
      // Codex gives up on an MCP call after 60 s by default; a session tool
      // that waits for the user (`request_secret`) ends its own wait first.
      tool_timeout_sec: SESSION_TOOL_CALL_TIMEOUT_MS / 1000
    });
  }
  for (const name of deny) {
    // Our own `orquester` is never denied: the thread entry replaces a user's same-named one.
    if (name === SESSION_TOOLS_SERVER_NAME || name.length === 0) continue;
    entries.set(name, { enabled: false });
  }
  return entries;
}

/**
 * The thread `config` for `launch` (none: no server of ours) and the denials (§12.1): dotted keys
 * `mcp_servers.<name>` while every name can be one, else ONE `mcp_servers` table holding them all
 * (see the module header) — never a denial dropped.
 */
function codexThreadConfig(launch: CodexSessionToolsLaunch | undefined, deny: readonly string[]): ThreadConfig {
  const entries = codexServerOverrides(launch, deny);
  if ([...entries.keys()].some((name) => name.includes("."))) {
    return entries.size === 0 ? {} : { mcp_servers: Object.fromEntries(entries) };
  }
  const config: ThreadConfig = {};
  for (const [name, entry] of entries) {
    if (name === SESSION_TOOLS_SERVER_NAME && launch !== undefined) config[`mcp_servers.${name}`] = entry;
    else config[`mcp_servers.${name}.enabled`] = false;
  }
  return config;
}

/** The thread `config` that switches the denied servers off — also without our own server (no grant). */
export function codexDenyConfig(deny: readonly string[] = []): ThreadConfig {
  return codexThreadConfig(undefined, deny);
}

/** The thread `config` overrides that attach the server (and switch the denied ones off). Names an env var, never the credential. */
export function codexSessionToolsConfig(launch: CodexSessionToolsLaunch): ThreadConfig {
  return codexThreadConfig(launch, launch.deny ?? []);
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
