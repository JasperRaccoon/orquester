/**
 * Ephemeral AI VMs — which of the agents' own (Global, Agent config) MCP servers run INSIDE a
 * box chat's box (spec 2026-10-19 §8.4, "Run in box"). Everything else a box chat's CLI is
 * configured with runs on the host behind `orq-agent mcp-bridge`.
 *
 * The agents' config files stay the only source of truth for the servers themselves (Agent
 * config); this file holds only Orquester's switch, by agent and server name:
 *
 *   <appdir>/daemon/box-mcp.json   (`boxMcpSettingsPath`, index.ts)
 *   { "version": 1, "agents": { "claude": { "<server>": { "runInBox": true } } } }
 *
 * Agent Profile servers carry the same switch on their own item (`session-profiles.ts`).
 * Tolerant: unknown fields, agents and servers survive a rewrite.
 */

import { z } from "zod";

export const BOX_MCP_SETTINGS_VERSION = 1;

export const boxMcpServerSettingSchema = z.object({ runInBox: z.boolean().optional() }).passthrough();

export const boxMcpSettingsSchema = z
  .object({
    version: z.number().int().optional(),
    agents: z.record(z.record(z.unknown())).optional()
  })
  .passthrough();

export type BoxMcpSettings = z.infer<typeof boxMcpSettingsSchema>;

/** The server names `agent` runs in the box; an unreadable entry runs on the host. */
export function runInBoxServerNames(settings: unknown, agent: string): Set<string> {
  const parsed = boxMcpSettingsSchema.safeParse(settings);
  const names = new Set<string>();
  if (!parsed.success) return names;
  for (const [name, value] of Object.entries(parsed.data.agents?.[agent] ?? {})) {
    const entry = boxMcpServerSettingSchema.safeParse(value);
    if (entry.success && entry.data.runInBox === true) names.add(name);
  }
  return names;
}

/** `settings` with one server's switch set (others, and unknown fields, kept). */
export function withRunInBox(settings: unknown, agent: string, server: string, runInBox: boolean): BoxMcpSettings {
  const parsed = boxMcpSettingsSchema.safeParse(settings);
  const base: BoxMcpSettings = parsed.success ? parsed.data : {};
  const agents = { ...(base.agents ?? {}) };
  const servers = { ...(agents[agent] ?? {}) };
  const current = boxMcpServerSettingSchema.safeParse(servers[server]);
  servers[server] = { ...(current.success ? current.data : {}), runInBox };
  agents[agent] = servers;
  return { ...base, version: BOX_MCP_SETTINGS_VERSION, agents };
}
