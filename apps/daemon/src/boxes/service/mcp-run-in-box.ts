/**
 * "Run in box" for the agents' own MCP servers (Agent config, Global; spec 2026-10-19 §8.4):
 * `boxRoutes.mcpRunInBox`. The servers are the ones Agent config lists for Claude, Codex and Grok
 * (their config files stay the only source of truth); the switch lives in `box-mcp.json`
 * (`packages/config` box-mcp.ts), which the agent host reads at every box chat launch. A server
 * without the switch runs on the host behind `orq-agent mcp-bridge`.
 *
 * GET is a read; PUT is refused while the plugin is off, like the plugin's other writes.
 */

import { readFile } from "node:fs/promises";

import {
  boxRoutes,
  type AgentProfileAgentId,
  type BoxMcpRunInBoxResponse,
  type BoxMcpRunInBoxEntry,
  type SetBoxMcpRunInBoxRequest
} from "@orquester/api";
import { runInBoxServerNames, withRunInBox } from "@orquester/config";
import type { FastifyInstance } from "fastify";

import { BoxError } from "./errors.ts";
import { sendBoxError } from "./routes.ts";

/** The agents whose chats run in boxes (OpenCode has no box support). */
const BOX_MCP_AGENTS = ["claude", "codex", "grok"] as const satisfies readonly AgentProfileAgentId[];
const MAX_NAME = 256;

export interface BoxMcpRunInBoxDeps {
  /** `<appdir>/daemon/box-mcp.json` (`boxMcpSettingsPath`). */
  file: string;
  /** Agent config's view of one agent (`AgentProfileService.snapshot`): its MCP servers are the `mcp` items. */
  snapshot(agent: AgentProfileAgentId): Promise<{ installed: boolean; items: readonly { kind: string; name: string }[] }>;
  /** Atomic JSON write (the daemon's `writeJsonFile`). */
  writeJson(file: string, value: unknown): Promise<void>;
  enabled(): boolean;
  logger?: Pick<Console, "warn">;
}

/** The stored switches; a missing file is none, an unreadable one is none too (every server then runs on the host). */
async function readSettings(deps: BoxMcpRunInBoxDeps): Promise<unknown> {
  try {
    return JSON.parse(await readFile(deps.file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") deps.logger?.warn("box-mcp.json does not read; every MCP server runs on the host", (error as Error).message);
    return {};
  }
}

function parseSetRunInBox(body: unknown): SetBoxMcpRunInBoxRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const { agent, name, runInBox } = body as Record<string, unknown>;
  if (typeof agent !== "string" || !(BOX_MCP_AGENTS as readonly string[]).includes(agent)) return null;
  if (typeof name !== "string" || name.trim().length === 0 || name.length > MAX_NAME || /[\u0000-\u001f]/.test(name)) return null;
  if (typeof runInBox !== "boolean") return null;
  return { agent, name, runInBox };
}

export function registerBoxMcpRunInBoxRoutes(app: FastifyInstance, deps: BoxMcpRunInBoxDeps): void {
  // Writes are serialized: each one reads, changes one switch and writes the whole file.
  let writes: Promise<unknown> = Promise.resolve();

  const response = async (): Promise<BoxMcpRunInBoxResponse> => {
    const settings = await readSettings(deps);
    const servers: BoxMcpRunInBoxEntry[] = [];
    for (const agent of BOX_MCP_AGENTS) {
      const snapshot = await deps.snapshot(agent).catch((error: unknown) => {
        deps.logger?.warn(`Agent config of ${agent} does not read`, error instanceof Error ? error.message : String(error));
        return null;
      });
      if (!snapshot?.installed) continue;
      const on = runInBoxServerNames(settings, agent);
      const seen = new Set<string>();
      for (const item of snapshot.items) {
        if (item.kind !== "mcp" || seen.has(item.name)) continue;
        seen.add(item.name);
        servers.push({ name: item.name, agent, runInBox: on.has(item.name) });
      }
    }
    return { servers };
  };

  app.get(boxRoutes.mcpRunInBox, async (_request, reply) => {
    try {
      return await response();
    } catch (error) {
      return sendBoxError(reply, error);
    }
  });

  app.put<{ Body: SetBoxMcpRunInBoxRequest }>(boxRoutes.mcpRunInBox, async (request, reply) => {
    try {
      if (!deps.enabled()) throw new BoxError(409, "BOXES_DISABLED", "Ephemeral AI VMs is turned off in Settings → Plugins.");
      const body = parseSetRunInBox(request.body);
      if (!body) throw new BoxError(400, "BOX_INVALID_REQUEST", "Send `{ agent, name, runInBox }` for a Claude, Codex or Grok MCP server.");
      const write = writes.then(async () => deps.writeJson(deps.file, withRunInBox(await readSettings(deps), body.agent, body.name, body.runInBox)));
      writes = write.catch(() => undefined);
      await write;
      return await response();
    } catch (error) {
      return sendBoxError(reply, error);
    }
  });
}
