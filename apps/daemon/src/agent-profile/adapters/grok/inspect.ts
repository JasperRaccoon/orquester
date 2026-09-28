/**
 * `grok inspect --json` — what Grok itself says it loads (Grok 1.0.34). The
 * adapter reads its own files directly; it asks Grok only for what lives
 * elsewhere and is Grok's own merge: MCP servers inherited from `~/.claude.json`,
 * Cursor and trusted plugins, the discovered plugins, and plugin-provided
 * skills and commands.
 *
 * Observed on this host with a temp `GROK_HOME` (and in
 * `test/fixtures/grok/12-cli-text/grok-inspect.json`):
 * - it never starts an MCP server (a server command that logs its start was
 *   not run);
 * - `mcpServers[].source.type` is `configToml`, `claudeJson` or `plugin`
 *   (`plugin_name` beside it); a server named in `disabled_mcp_servers` is
 *   still listed, with no flag — a `[mcp_servers.x] enabled = false` one is not;
 * - `skills[]` carries flat `commands/*.md` files too (their `source.path`
 *   ends in `.md` under a `commands/` directory) and `disabled: true` for a
 *   name in `[skills] disabled`;
 * - `plugins[].enabled` stays `true` for a plugin in `[plugins] disabled`, so
 *   the adapter computes on/off from `config.toml` itself.
 */

export interface InspectMcpServer {
  name: string;
  transport?: string;
  sourceType: string;
  sourcePath?: string;
  pluginName?: string;
}

export interface InspectSkill {
  name: string;
  description?: string;
  sourceType: string;
  path?: string;
  pluginName?: string;
}

export interface InspectPlugin {
  name: string;
  scope?: string;
  path?: string;
  provides?: { skills?: number; agents?: number; hooks?: boolean; mcpServers?: number };
}

export interface GrokInspect {
  mcpServers: InspectMcpServer[];
  skills: InspectSkill[];
  plugins: InspectPlugin[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function source(entry: Record<string, unknown>): { sourceType: string; sourcePath?: string; pluginName?: string } {
  const src = record(entry.source);
  const sourcePath = text(src?.path);
  const pluginName = text(src?.plugin_name);
  return {
    sourceType: text(src?.type) ?? "unknown",
    ...(sourcePath !== undefined ? { sourcePath } : {}),
    ...(pluginName !== undefined ? { pluginName } : {})
  };
}

/** The parts of the report the adapter uses; `null` when `stdout` is not an inspect report. */
export function parseGrokInspect(stdout: string): GrokInspect | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const root = record(parsed);
  if (root === null || !Array.isArray(root.mcpServers) || !Array.isArray(root.skills)) {
    return null;
  }
  const mcpServers: InspectMcpServer[] = [];
  for (const raw of root.mcpServers) {
    const entry = record(raw);
    const name = text(entry?.name);
    if (entry === null || name === undefined) continue;
    const transport = text(entry.transport);
    mcpServers.push({ name, ...(transport !== undefined ? { transport } : {}), ...source(entry) });
  }
  const skills: InspectSkill[] = [];
  for (const raw of root.skills) {
    const entry = record(raw);
    const name = text(entry?.name);
    if (entry === null || name === undefined) continue;
    const { sourceType, sourcePath, pluginName } = source(entry);
    const description = text(entry.description);
    skills.push({
      name,
      sourceType,
      ...(sourcePath !== undefined ? { path: sourcePath } : {}),
      ...(pluginName !== undefined ? { pluginName } : {}),
      ...(description !== undefined ? { description } : {})
    });
  }
  const plugins: InspectPlugin[] = [];
  for (const raw of Array.isArray(root.plugins) ? root.plugins : []) {
    const entry = record(raw);
    const name = text(entry?.name);
    if (entry === null || name === undefined) continue;
    const provides = record(entry.provides);
    const scope = text(entry.scope);
    const path = text(entry.path);
    plugins.push({
      name,
      ...(scope !== undefined ? { scope } : {}),
      ...(path !== undefined ? { path } : {}),
      ...(provides !== null
        ? {
            provides: {
              skills: count(provides.skills),
              agents: count(provides.agents),
              hooks: provides.hooks === true,
              mcpServers: count(provides.mcpServers)
            }
          }
        : {})
    });
  }
  return { mcpServers, skills, plugins };
}
