/**
 * OpenCode adapter — the session-tool server on a SHARED `opencode serve`
 * (design 2026-10-14 §1.2–§1.4).
 *
 * A project's threads share one server (§3.2), and an MCP registration is
 * the server's (per directory), not a session's. So each thread registers a
 * server of its OWN, named `orquester-<16 hex of sha256(threadId)>`, through
 * `POST /mcp` with its credential in the registration's `headers` — and each
 * thread's session permission ruleset ends with
 *
 *     { permission: "orquester-????????????????_*", action: "deny"  }  // every thread's tools…
 *     { permission: "orquester-<own key>_*",        action: "allow" }  // …but this thread's own
 *
 * (`OPENCODE_SESSION_TOOLS_DENY`: OpenCode's `?` matches any one character, so
 * the deny names only the per-thread spelling — 16 characters, then `_` — and
 * leaves a user's own `orquester…` server alone, see `docs/orquester-mcp.md`.
 * The deny is sent whenever the host has session tools, the allow only with a
 * grant of the thread's own.)
 *
 * Why that isolates threads, from OpenCode 1.18.34's own bundle (report
 * `task-1-report.md`): an MCP tool's id is `<server>_<tool>`, each sanitised
 * to `[a-zA-Z0-9_-]`; before every step the session drops every tool whose
 * LAST matching rule of `merge(agent.permission, session.permission)` is a
 * `"*"`-pattern deny (`Permission.disabled`), so thread A's model is never
 * offered thread B's tools at all; and a subagent's child session inherits
 * only its parent's DENY rules, so it is offered none (subagents get no
 * session tools on OpenCode). The 16-hex key is fixed-width, so one thread's
 * allow pattern can never match another's server. The allow rule is also the
 * pre-approval of §1.3: OpenCode never asks for these tools.
 *
 * The registration lives in the server's memory only (`MCP.add` writes no
 * config; verified: no header on disk, `GET /config` does not show it). It is
 * made on every session start — a recycled or restarted server starts empty
 * — and re-registering the same name replaces the old credential. A session
 * that ends revokes its credential and disconnects its server, best-effort
 * but awaited, so the thread's next start registers after it.
 *
 * The list is the thread's manifest (unified MCP §9.4), served per request by the endpoint.
 * OpenCode 1.18.34 re-lists on `notifications/tools/list_changed` (Task 6 probe), but the loopback
 * endpoint is stateless and pushes nothing: a changed list reaches it through a session restart.
 *
 * Denials (§12.1): each MCP server the manifest denies is DISCONNECTED on the session's instance
 * (`POST /mcp/{name}/disconnect` — every session there is an Orquester chat with the same config,
 * so the same denials) and gets a LAST rule `{permission: "<name>_*", action: "deny"}` (the name
 * sanitised as OpenCode builds tool ids), so OpenCode drops every tool of it before each step. A
 * tool id is `<server>_<tool>` and OpenCode's globs have only `*` and `?`, so `remote_*` would
 * also hide another configured server `remote_api`: where such a server exists (`GET /mcp`), the
 * rule is left out and the disconnect alone denies `remote` — exact. Only when that disconnect
 * failed too is the over-wide rule kept (fail closed) and the overlap logged.
 *
 * Instructions ride the per-turn `system` addendum (`session.ts`), which
 * OpenCode keeps on the message's `system` field, never in its parts.
 */

import { createHash } from "node:crypto";

import { SESSION_TOOL_CALL_TIMEOUT_MS } from "../../../session-tools/contract.ts";
import { AGENT_HOST_DEADLINES } from "../../support/deadline.ts";
import type { OpenCodeClient } from "./http.ts";
import type { OpenCodePermissionRuleset } from "./ruleset.ts";
import { openCodeRoutes } from "./routes.ts";

/** What an OpenCode session is given when session tools are on. */
export interface OpenCodeSessionToolsLaunch {
  /** `orquester-<16 hex>`. */
  serverName: string;
  url: string;
  /** `Bearer <credential>`. */
  authorization: string;
  /** The "Orquester" instruction block; "" for none. */
  instructions: string;
  /** MCP servers to deny in this thread's session (§12.1), by their config names. */
  deny?: readonly string[];
  revoke(): void;
  /**
   * boxes (spec 2026-10-19 §8.4): the server runs in a box, so ours registers as a LOCAL server
   * there — `orq-agent mcp-bridge <serverId>`, whose host side holds `url` and `authorization` —
   * and no credential reaches the box.
   */
  bridge?: { command: string[] };
}

/** A server name as OpenCode spells it inside tool ids (`[a-zA-Z0-9_-]`, anything else `_`). */
export function openCodeServerRuleName(server: string): string {
  return server.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** The thread's own server name on a shared OpenCode server. */
export function openCodeSessionToolsServerName(threadId: string): string {
  return `orquester-${createHash("sha256").update(threadId, "utf8").digest("hex").slice(0, 16)}`;
}

/**
 * The deny that hides every thread's session tools: exactly the per-thread
 * naming, `orquester-` + 16 characters + `_` + the tool (OpenCode's wildcard
 * maps `?` to ONE character of any kind; it has no character classes). A
 * user's own server whose name merely starts with `orquester-` keeps every
 * tool whose id does not put a `_` exactly there — which some may; so
 * `docs/orquester-mcp.md` suggests `orquester_remote` for the external `/mcp`,
 * a name the literal `orquester-` prefix can never match.
 */
const OPENCODE_SESSION_TOOLS_DENY = `orquester-${"?".repeat(16)}_*`;

/**
 * `ruleset` with the isolation rules appended (last, so they win): the deny
 * whenever the host HAS session tools — a thread whose own grant failed must
 * still be kept off its co-tenants' servers — and the allow of the thread's
 * own server when it has one. Without session tools at all (`isolate`
 * false and no server), the ruleset is returned untouched.
 */
export function withSessionToolRules(
  ruleset: OpenCodePermissionRuleset,
  isolation: {
    isolate: boolean;
    own?: Pick<OpenCodeSessionToolsLaunch, "serverName">;
    /** Server names (config spelling) whose `<name>_*` rule is exact here (`resolveOpenCodeDenials`). */
    deny?: readonly string[];
  }
): OpenCodePermissionRuleset {
  const denied = [...new Set((isolation.deny ?? []).map(openCodeServerRuleName))].filter((name) => name.length > 0);
  if (!isolation.isolate && isolation.own === undefined && denied.length === 0) {
    return ruleset;
  }
  return [
    ...ruleset,
    ...(isolation.isolate || isolation.own !== undefined ? [{ permission: OPENCODE_SESSION_TOOLS_DENY, pattern: "*", action: "deny" as const }] : []),
    ...(isolation.own !== undefined
      ? [{ permission: `${isolation.own.serverName}_*`, pattern: "*", action: "allow" as const }]
      : []),
    // §12.1, last so nothing above re-allows them: every tool of a denied server.
    ...denied.map((name) => ({ permission: `${name}_*`, pattern: "*", action: "deny" as const }))
  ];
}

/** Of `deny`, the names whose `<name>_*` rule would also hide ANOTHER configured server's tools. */
function overlappingDenials(deny: readonly string[], configured: readonly string[]): Set<string> {
  const overlapping = new Set<string>();
  for (const name of deny) {
    const prefix = `${openCodeServerRuleName(name)}_`;
    if (configured.some((other) => other !== name && openCodeServerRuleName(other).startsWith(prefix))) overlapping.add(name);
  }
  return overlapping;
}

/**
 * Deny `deny` on the session's instance (§12.1): disconnect each (best effort, bounded) and answer
 * which names take the `<name>_*` rule — every one, except an overlapping name whose disconnect
 * worked (the rule would hide another server's tools; the disconnect alone is exact). Never throws.
 */
export async function resolveOpenCodeDenials(
  client: OpenCodeClient,
  deny: readonly string[],
  logger?: { warn(message: string, detail?: unknown): void }
): Promise<string[]> {
  const names = [...new Set(deny)].filter((name) => name.length > 0);
  if (names.length === 0) return [];
  let configured: string[] = [];
  try {
    const status = await client.get<Record<string, unknown>>(openCodeRoutes.mcp, { timeoutMs: AGENT_HOST_DEADLINES.probeMs });
    configured = status !== null && typeof status === "object" ? Object.keys(status) : [];
  } catch {
    configured = [];
  }
  const overlapping = overlappingDenials(names, configured);
  const ruled: string[] = [];
  for (const name of names) {
    let disconnected = false;
    try {
      await client.post<unknown>(openCodeRoutes.mcpDisconnect(name), { timeoutMs: AGENT_HOST_DEADLINES.probeMs });
      disconnected = true;
    } catch {
      disconnected = false;
    }
    if (!overlapping.has(name) || !disconnected) ruled.push(name);
    if (overlapping.has(name) && !disconnected) {
      logger?.warn("opencode: a denied MCP server could not be disconnected; its deny rule also hides a server whose name extends it", { name });
    }
  }
  return ruled;
}

/** `POST /mcp` — register (or re-register) the thread's server on its directory's instance. */
export async function registerOpenCodeSessionTools(
  client: OpenCodeClient,
  launch: OpenCodeSessionToolsLaunch
): Promise<void> {
  if (launch.bridge !== undefined) {
    // boxes: a local server in the box; the bridge's host side carries the credential.
    await client.post<unknown>(openCodeRoutes.mcp, {
      timeoutMs: AGENT_HOST_DEADLINES.sessionOpenMs,
      body: {
        name: launch.serverName,
        config: { type: "local", command: launch.bridge.command, enabled: true, timeout: SESSION_TOOL_CALL_TIMEOUT_MS }
      }
    });
    return;
  }
  await client.post<unknown>(openCodeRoutes.mcp, {
    timeoutMs: AGENT_HOST_DEADLINES.sessionOpenMs,
    body: {
      name: launch.serverName,
      config: {
        type: "remote",
        url: launch.url,
        headers: { Authorization: launch.authorization },
        // Never probe the loopback endpoint for OAuth: the bearer is the auth.
        oauth: false,
        enabled: true,
        // Per-request timeout, tool calls included (OpenCode 1.18.34: the
        // server's own `timeout`, else `experimental.mcp_timeout`, else the
        // MCP SDK's 60 s). A session tool that waits for the user
        // (`request_secret`) ends its own wait first.
        timeout: SESSION_TOOL_CALL_TIMEOUT_MS
      }
    }
  });
}

/**
 * `POST /mcp/{name}/disconnect` — best-effort, bounded, never throws. Awaited
 * by the session's stop: a relaunch of the thread re-registers the SAME name,
 * and only the ordering (stop, then start) keeps a late disconnect from
 * disabling the fresh registration.
 */
export async function disconnectOpenCodeSessionTools(client: OpenCodeClient, serverName: string): Promise<void> {
  try {
    await client.post<unknown>(openCodeRoutes.mcpDisconnect(serverName), {
      timeoutMs: AGENT_HOST_DEADLINES.probeMs
    });
  } catch {
    // The credential is already revoked; a server that cannot be told only
    // keeps a dead connection until it is recycled.
  }
}

/** The per-turn `system` addendum with the instruction block appended. */
export function withSessionToolInstructions(system: string, launch: OpenCodeSessionToolsLaunch | undefined): string {
  return launch !== undefined && launch.instructions.length > 0 ? `${system}\n\n${launch.instructions}` : system;
}
