/**
 * Claude's plugin bookkeeping, read-only: `plugins/installed_plugins.json`
 * (v2), `plugins/known_marketplaces.json`, each plugin's manifest and what it
 * ships. Installing, uninstalling and marketplace changes go through the
 * `claude plugin` CLI (the adapter), never through these files.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MarketplaceSource } from "@orquester/api";
import { readTextIfExists } from "../../infra/index.ts";
import { isRecord, parseJsonText } from "./settings.ts";

/** One user-scope record of `installed_plugins.json`. */
export interface InstalledPlugin {
  /** `name@marketplace`. */
  id: string;
  name: string;
  marketplace: string;
  installPath: string;
  version?: string;
  /** The raw record (display and revision). */
  record: Record<string, unknown>;
}

/**
 * The user-scope plugins of an `installed_plugins.json` text (global only —
 * project/local records are another scope). Throws an `Error` when the file
 * does not parse or is not the v2 shape.
 */
export function parseInstalledPlugins(text: string): InstalledPlugin[] {
  const doc = parseJsonText(text);
  if (!isRecord(doc) || !isRecord(doc.plugins)) {
    throw new Error('expected {"version": 2, "plugins": {…}}');
  }
  const out: InstalledPlugin[] = [];
  for (const [id, records] of Object.entries(doc.plugins)) {
    if (!Array.isArray(records)) continue;
    const record = records.find((r) => isRecord(r) && r.scope === "user" && typeof r.installPath === "string");
    if (!isRecord(record)) continue;
    const at = id.lastIndexOf("@");
    out.push({
      id,
      name: at > 0 ? id.slice(0, at) : id,
      marketplace: at > 0 ? id.slice(at + 1) : "",
      installPath: record.installPath as string,
      ...(typeof record.version === "string" ? { version: record.version } : {}),
      record
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** One `known_marketplaces.json` entry. */
export interface KnownMarketplace {
  name: string;
  /** Claude's own source object (`{source: "github", repo}`, …). */
  source: Record<string, unknown>;
  installLocation?: string;
}

/** Throws an `Error` when the text does not parse or is not an object. */
export function parseKnownMarketplaces(text: string): KnownMarketplace[] {
  const doc = parseJsonText(text);
  if (!isRecord(doc)) {
    throw new Error("the top level is not a JSON object");
  }
  const out: KnownMarketplace[] = [];
  for (const [name, entry] of Object.entries(doc)) {
    if (!isRecord(entry)) continue;
    out.push({
      name,
      source: isRecord(entry.source) ? entry.source : {},
      ...(typeof entry.installLocation === "string" ? { installLocation: entry.installLocation } : {})
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Claude's marketplace source object as the wire's `MarketplaceSource`. */
export function toMarketplaceSource(source: Record<string, unknown>): MarketplaceSource {
  const ref = typeof source.ref === "string" ? { ref: source.ref } : {};
  switch (source.source) {
    case "github":
      return { type: "github", repo: String(source.repo ?? ""), ...ref };
    case "directory":
    case "file":
      return { type: "path", path: String(source.path ?? "") };
    default:
      // "git" and "url" (a hosted marketplace.json) both name a URL.
      return { type: "git", url: String(source.url ?? ""), ...ref };
  }
}

/**
 * The source argument `claude plugin marketplace add` parses (2.1.280):
 * `owner/repo[#ref]`, a git URL `[#ref]`, or an absolute path.
 */
export function marketplaceSourceArg(source: MarketplaceSource): string {
  switch (source.type) {
    case "github":
      return source.ref ? `${source.repo}#${source.ref}` : source.repo;
    case "git":
      return source.ref ? `${source.url}#${source.ref}` : source.url;
    case "path":
      return source.path;
  }
}

/** A marketplace's catalogue: `<installLocation>/.claude-plugin/marketplace.json` `plugins[]`. */
export async function readMarketplaceCatalog(
  installLocation: string
): Promise<{ name: string; description?: string; version?: string }[]> {
  const text = await readFile(join(installLocation, ".claude-plugin", "marketplace.json"), "utf8");
  const doc: unknown = JSON.parse(text);
  if (!isRecord(doc) || !Array.isArray(doc.plugins)) {
    throw new Error("marketplace.json has no plugins list");
  }
  const out: { name: string; description?: string; version?: string }[] = [];
  for (const entry of doc.plugins) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue;
    out.push({
      name: entry.name,
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      ...(typeof entry.version === "string" ? { version: entry.version } : {})
    });
  }
  return out;
}

/** `<installPath>/.claude-plugin/plugin.json`; `null` when missing or unreadable. */
export async function readPluginManifest(installPath: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readTextIfExists(join(installPath, ".claude-plugin", "plugin.json"));
    if (text === null) return null;
    const doc: unknown = JSON.parse(text);
    return isRecord(doc) ? doc : null;
  } catch {
    return null;
  }
}

/**
 * The MCP servers a plugin ships: `<installPath>/.mcp.json` (either
 * `{mcpServers: {…}}` or the servers map itself) plus an inline
 * `mcpServers` object in the manifest. Unreadable files contribute nothing.
 */
export async function readPluginMcpServers(
  installPath: string,
  manifest: Record<string, unknown> | null
): Promise<Record<string, Record<string, unknown>>> {
  const servers: Record<string, Record<string, unknown>> = {};
  const add = (map: unknown): void => {
    if (!isRecord(map)) return;
    for (const [name, def] of Object.entries(map)) {
      if (isRecord(def) && (typeof def.command === "string" || typeof def.url === "string")) {
        servers[name] = def;
      }
    }
  };
  try {
    const text = await readTextIfExists(join(installPath, ".mcp.json"));
    if (text !== null) {
      const doc: unknown = JSON.parse(text);
      add(isRecord(doc) && isRecord(doc.mcpServers) ? doc.mcpServers : doc);
    }
  } catch {
    // A plugin's broken file is the plugin's problem; nothing to list.
  }
  add(manifest?.mcpServers);
  return servers;
}

async function countMarkdown(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

async function countHookHandlers(installPath: string): Promise<number> {
  try {
    const text = await readTextIfExists(join(installPath, "hooks", "hooks.json"));
    if (text === null) return 0;
    const doc: unknown = JSON.parse(text);
    const hooks = isRecord(doc) && isRecord(doc.hooks) ? doc.hooks : null;
    if (hooks === null) return 0;
    let count = 0;
    for (const groups of Object.values(hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (isRecord(group) && Array.isArray(group.hooks)) count += group.hooks.length;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

export type PluginProvides = Partial<Record<"skills" | "commands" | "hooks" | "mcpServers" | "agents", number>>;

/**
 * What a plugin ships: the skill, command and MCP counts the caller already
 * scanned, plus its agents and hook handlers counted from its directory. Zero
 * counts are left out.
 */
export async function pluginProvides(
  installPath: string,
  scanned: { skills: number; commands: number; mcpServers: number }
): Promise<PluginProvides> {
  const counts: PluginProvides = {
    ...scanned,
    agents: await countMarkdown(join(installPath, "agents")),
    hooks: await countHookHandlers(installPath)
  };
  for (const key of Object.keys(counts) as (keyof PluginProvides)[]) {
    if (!counts[key]) delete counts[key];
  }
  return counts;
}
