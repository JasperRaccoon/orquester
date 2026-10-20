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
 * - **Denying a server the thread's config does not define** (probed on 0.159.0): `enabled = false`
 *   alone fails `thread/start` ("invalid transport"); a COMPLETE disabled entry does not, but only
 *   with the defined server's own transport — a `url` stub merged into a stdio server (or a
 *   `command` stub into a URL one) fails ("url is not supported for stdio"), and no single stub
 *   fits both. So the session reads the thread's effective config (`config/read` with its cwd) and
 *   sends `enabled = false` for a defined server and a disabled `url` stub
 *   ({@link CODEX_DENIED_STUB_URL}) for an undefined one: every denial is harmless by
 *   construction, other servers untouched. Without that read, `enabled = false` is sent, and a
 *   refusal names the server.
 * - **A user's own `orquester`** (probed on 0.159.0): the override is MERGED into a same-named
 *   server of the thread's config, so a user's stdio `orquester` plus our `url` fails `thread/start`
 *   ("url is not supported for stdio"), and an HTTP one would lend ours its headers. The session
 *   reads the thread's effective config first (`config/read` with its cwd: the account home and
 *   every trusted project layer) and, where `orquester` is taken, registers ours as
 *   `orquester_session` (`_2`, … while taken; {@link codexSessionToolsServerName}). The user's server
 *   is then denied by name only when it points at this daemon (the manifest says so); otherwise
 *   it is left alone. Rows name which server is ours (`data.sessionToolsServer`), and the
 *   instruction block says the chat's name for it.
 */

import { CODEX_SESSION_TOOLS_ALTERNATE_NAME, SESSION_TOOLS_SERVER_NAME } from "@orquester/api/agent-chat";

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
  /** The name ours is registered under in this thread (default `orquester`). */
  serverName?: string;
  /** The servers the thread's effective config defines (`config/read`), when read. */
  configured?: ReadonlySet<string>;
  /**
   * boxes (spec 2026-10-19 §8.4): the CLI runs in a box, so ours is a stdio server there —
   * `orq-agent mcp-bridge <serverId>`, whose host side holds the endpoint and its credential —
   * instead of `url` + `bearer_token_env_var` (no token reaches the box).
   */
  bridge?: { command: string; args: string[] };
}

/** `thread/start`'s (and `thread/resume`'s) `config` map, exported for the box overrides. */
export type CodexThreadConfig = NonNullable<CodexProtocol.v2.ThreadStartParams["config"]>;
/** One `mcp_servers` override value. */
export type CodexConfigValue = NonNullable<CodexThreadConfig[string]>;

/** Where a stub that denies a server the thread's config does not define points: never contacted. */
export const CODEX_DENIED_STUB_URL = "http://127.0.0.1:9/orquester-denied";

/**
 * The name our server takes in a thread whose effective config has `configured` servers:
 * `orquester`, unless taken — then `orquester_session`, `orquester_session_2`, … (never a taken one).
 */
export function codexSessionToolsServerName(configured: Iterable<string>): string {
  const taken = new Set(configured);
  if (!taken.has(SESSION_TOOLS_SERVER_NAME)) return SESSION_TOOLS_SERVER_NAME;
  if (!taken.has(CODEX_SESSION_TOOLS_ALTERNATE_NAME)) return CODEX_SESSION_TOOLS_ALTERNATE_NAME;
  for (let n = 2; ; n += 1) {
    const name = `${CODEX_SESSION_TOOLS_ALTERNATE_NAME}_${n}`;
    if (!taken.has(name)) return name;
  }
}

/** `thread/start`'s (and `thread/resume`'s) `config` map. */
type ThreadConfig = NonNullable<CodexProtocol.v2.ThreadStartParams["config"]>;
type ConfigValue = NonNullable<ThreadConfig[string]>;

/** The `mcp_servers` entries a thread's config overrides: ours, and `{enabled: false}` per denial. */
function codexServerOverrides(
  launch: CodexSessionToolsLaunch | undefined,
  deny: readonly string[],
  ours: string,
  configured: ReadonlySet<string> | undefined
): Map<string, ConfigValue> {
  const entries = new Map<string, ConfigValue>();
  if (launch !== undefined) {
    entries.set(ours, {
      // boxes: a box CLI reaches ours through the bridge; its credential stays on the host.
      ...(launch.bridge !== undefined
        ? { command: launch.bridge.command, args: launch.bridge.args }
        : { url: launch.url, bearer_token_env_var: CODEX_SESSION_TOOLS_TOKEN_ENV }),
      default_tools_approval_mode: "approve",
      // Codex gives up on an MCP call after 60 s by default; a session tool
      // that waits for the user (`request_secret`) ends its own wait first.
      tool_timeout_sec: SESSION_TOOL_CALL_TIMEOUT_MS / 1000
    });
  }
  for (const name of deny) {
    // Ours is never denied. Under `orquester` it replaces a user's same-named one (there is none:
    // the session renamed ours when the config has one); a user's `orquester` beside ours, under its
    // alternate name, is denied like any server when it points at this daemon.
    if (name === ours || name.length === 0) continue;
    // A name the thread's config does not define gets a complete, disabled stub (a valid
    // transport, never contacted): `enabled = false` alone would fail the thread ("invalid
    // transport", probed). A defined one is merged with `enabled = false` (keeps its transport).
    entries.set(name, configured !== undefined && !configured.has(name) ? { url: CODEX_DENIED_STUB_URL, enabled: false } : { enabled: false });
  }
  return entries;
}

/**
 * The thread `config` for `launch` (none: no server of ours) and the denials (§12.1): dotted keys
 * `mcp_servers.<name>` while every name can be one, else ONE `mcp_servers` table holding them all
 * (see the module header) — never a denial dropped.
 */
function codexThreadConfig(
  launch: CodexSessionToolsLaunch | undefined,
  deny: readonly string[],
  ours: string,
  configured: ReadonlySet<string> | undefined,
  extra?: ReadonlyMap<string, ConfigValue>
): ThreadConfig {
  const entries = codexServerOverrides(launch, deny, ours, configured);
  // boxes: the bridged replacements of the thread's own servers; ours and a denial win a name.
  for (const [name, entry] of extra ?? []) {
    if (!entries.has(name)) entries.set(name, entry);
  }
  if ([...entries.keys()].some((name) => name.includes("."))) {
    return entries.size === 0 ? {} : { mcp_servers: Object.fromEntries(entries) };
  }
  const config: ThreadConfig = {};
  for (const [name, entry] of entries) {
    const whole = (name === ours && launch !== undefined) || Object.keys(entry as object).length > 1;
    if (whole) config[`mcp_servers.${name}`] = entry;
    else config[`mcp_servers.${name}.enabled`] = false;
  }
  return config;
}

/**
 * The thread `config` that switches the denied servers off — also without our own server (no
 * grant: `ours` empty, so a daemon-pointing `orquester` of the config is denied like any other).
 */
export function codexDenyConfig(
  deny: readonly string[] = [],
  ours = "",
  configured?: ReadonlySet<string>,
  extra?: ReadonlyMap<string, ConfigValue>
): ThreadConfig {
  return codexThreadConfig(undefined, deny, ours, configured, extra);
}

/** The thread `config` overrides that attach the server (and switch the denied ones off). Names an env var, never the credential. */
export function codexSessionToolsConfig(launch: CodexSessionToolsLaunch, extra?: ReadonlyMap<string, ConfigValue>): ThreadConfig {
  return codexThreadConfig(launch, launch.deny ?? [], launch.serverName ?? SESSION_TOOLS_SERVER_NAME, launch.configured, extra);
}

/**
 * boxes (spec 2026-10-19 §8.4): the overrides that move a box thread's own MCP servers to the
 * host. A bridged stdio server keeps its name and becomes `orq-agent mcp-bridge <serverId>`; its
 * env keys are blanked (an override table is MERGED into the server's, so the box's copy of a
 * value would otherwise ride into the bridge process). A bridged HTTP server (host loopback, or
 * secret headers) cannot turn into a stdio one under its own name (Codex refuses a `url` merged
 * with a `command`): it is switched off and its bridge registered as `<name>_host`.
 */
export function codexBoxMcpOverrides(
  bridged: readonly { name: string; command: string; args: string[]; transport: "stdio" | "http" | "sse"; envKeys: readonly string[] }[]
): Map<string, ConfigValue> {
  const entries = new Map<string, ConfigValue>();
  for (const server of bridged) {
    if (server.transport === "stdio") {
      entries.set(server.name, {
        command: server.command,
        args: server.args,
        env: Object.fromEntries(server.envKeys.map((key) => [key, ""])),
        env_vars: []
      });
    } else {
      entries.set(server.name, { enabled: false });
      entries.set(`${server.name}_host`, { command: server.command, args: server.args });
    }
  }
  return entries;
}

/** `turn/start`'s `additionalContext` for the instruction block, or undefined for none. */
export function codexSessionToolsContext(
  launch: CodexSessionToolsLaunch | undefined
): { [key: string]: CodexProtocol.v2.AdditionalContextEntry } | undefined {
  if (launch === undefined || launch.instructions.length === 0) {
    return undefined;
  }
  const name = launch.serverName ?? SESSION_TOOLS_SERVER_NAME;
  const value =
    name === SESSION_TOOLS_SERVER_NAME
      ? launch.instructions
      : `${launch.instructions}\n\nIn this chat Orquester's MCP server is named \`${name}\`: the tools above are that server's. ${
          (launch.deny ?? []).includes(SESSION_TOOLS_SERVER_NAME)
            ? "The Codex config also has a server named `orquester` that points at Orquester; it is switched off in this chat."
            : "The Codex config also has a server named `orquester`: that one is the user's own, not Orquester's."
        }`;
  return { [CODEX_SESSION_TOOLS_CONTEXT_KEY]: { kind: "application", value } };
}
