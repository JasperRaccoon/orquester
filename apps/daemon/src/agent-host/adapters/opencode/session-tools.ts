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
 *     { permission: "orquester-*",          action: "deny"  }   // every thread's tools…
 *     { permission: "orquester-<own key>_*", action: "allow" }  // …but this thread's own
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
 * that ends revokes its credential and disconnects its server, best-effort.
 *
 * Instructions ride the per-turn `system` addendum (`session.ts`), which
 * OpenCode keeps on the message's `system` field, never in its parts.
 */

import { createHash } from "node:crypto";

import { OPENCODE_SESSION_TOOLS_SERVER_PATTERN } from "@orquester/api/agent-chat";

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
  revoke(): void;
}

/** The thread's own server name on a shared OpenCode server. */
export function openCodeSessionToolsServerName(threadId: string): string {
  const name = `orquester-${createHash("sha256").update(threadId, "utf8").digest("hex").slice(0, 16)}`;
  if (!OPENCODE_SESSION_TOOLS_SERVER_PATTERN.test(name)) {
    throw new Error("unreachable: a sha256 prefix is 16 hex digits");
  }
  return name;
}

/**
 * `ruleset` with the isolation rules appended (last, so they win). Without
 * session tools the ruleset is returned untouched.
 */
export function withSessionToolRules(
  ruleset: OpenCodePermissionRuleset,
  launch: Pick<OpenCodeSessionToolsLaunch, "serverName"> | undefined
): OpenCodePermissionRuleset {
  if (launch === undefined) {
    return ruleset;
  }
  return [
    ...ruleset,
    { permission: "orquester-*", pattern: "*", action: "deny" },
    { permission: `${launch.serverName}_*`, pattern: "*", action: "allow" }
  ];
}

/** `POST /mcp` — register (or re-register) the thread's server on its directory's instance. */
export async function registerOpenCodeSessionTools(
  client: OpenCodeClient,
  launch: OpenCodeSessionToolsLaunch
): Promise<void> {
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
        enabled: true
      }
    }
  });
}

/** `POST /mcp/{name}/disconnect` — best-effort, bounded, never throws. */
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
