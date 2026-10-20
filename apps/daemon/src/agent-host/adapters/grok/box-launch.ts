/**
 * Grok adapter — `grok agent stdio` in a box (spec 2026-10-19 §7, §8.4, §8.5).
 *
 * - The launch (`boxes/index.ts`): the System account refused, the account
 *   home (or the profile's prepared home) synced, the session's files pushed
 *   for a `session/load`, the box's `grok` resolved or installed.
 * - Login: no credential file — `orq-agent token grok --account <id>`, run by
 *   Grok itself whenever it needs a token (`launch.ts`,
 *   `GROK_AUTH_PROVIDER_COMMAND` and the overlay's `[auth]` table). The
 *   overlay is written into the box, beside the host's at the same path.
 * - MCP: Grok loads the servers of its config files (its own `config.toml`,
 *   the Claude-compat `.claude.json`/`.mcp.json`) — read by `grok inspect
 *   --json` IN the box, their definitions read from those files on the host
 *   (the source of truth; the box's are copies) or, for a project's own file,
 *   in the box. Each one that must run here becomes a same-named ACP stdio
 *   entry of the bridge, which REPLACES the config's server (session-tools.ts).
 */

import { readFile } from "node:fs/promises";

import { boxToHostPath } from "@orquester/api";
import { parse as parseToml } from "@decimalturn/toml-patch";

import type { AdapterContext, StartSessionInput } from "../../adapter.ts";
import { requireBoxes, type BoxLaunch } from "../../boxes/index.ts";
import { runInBox } from "../../boxes/box-tools.ts";
import { claudeMcpSpec, tomlMcpSpec, type McpServerSpec } from "../../boxes/mcp-plan.ts";
import type { McpServer } from "./acp/_generated/schema.ts";
import type { GrokBoxMcpServers } from "./session-tools.ts";

/** What `GrokSession` gets for a box start. */
export interface GrokBoxLaunch {
  launch: BoxLaunch;
  /** Removed from `orq-agent`'s own environment. */
  envUnset: readonly string[];
  /** The bridged servers and our own server's bridge, for `session/new` / `session/load`. */
  mcp: GrokBoxMcpServers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A Grok cursor's session id (`{schemaVersion, sessionId}`), for the transcript push. */
function grokSessionRef(cursor: unknown): string | null {
  if (!isRecord(cursor) || typeof cursor.sessionId !== "string" || cursor.sessionId.length === 0) return null;
  return cursor.sessionId;
}

export async function launchGrokInBox(
  context: AdapterContext,
  input: StartSessionInput & { box: NonNullable<StartSessionInput["box"]> },
  configRoot: string | undefined
): Promise<BoxLaunch> {
  return requireBoxes(context).launch({
    threadId: input.threadId,
    agent: "grok",
    box: input.box,
    home: input.home,
    cwd: input.cwd,
    ...(input.profile !== undefined ? { profile: input.profile } : {}),
    ...(configRoot !== undefined ? { configRoot } : {}),
    resumeSessionRef: grokSessionRef(input.resumeCursor),
    signal: context.signal,
    onProgress: (message) => context.logger.info(`grok: ${message}`, { threadId: input.threadId })
  });
}

/** A config file's text: the host's copy when it has one (the source of truth), else the box's. */
async function readConfigSource(launch: BoxLaunch, boxPath: string): Promise<string | null> {
  const hostPath = boxToHostPath(launch.paths, boxPath);
  if (hostPath !== null) {
    try {
      return await readFile(hostPath, "utf8");
    } catch {
      // Not on the host: a project's own file, which lives in the box.
    }
  }
  try {
    const stream = await launch.connection.readFile(boxPath);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return null;
  }
}

/** One server's definition out of the file `grok inspect` named as its source. */
function definitionIn(text: string, path: string, name: string, cwd: string, env: Record<string, string>): McpServerSpec | null {
  if (path.endsWith(".toml")) {
    try {
      const doc = parseToml(text) as unknown;
      const servers = isRecord(doc) ? doc.mcp_servers : undefined;
      return isRecord(servers) ? tomlMcpSpec(name, servers[name], env) : null;
    } catch {
      return null;
    }
  }
  try {
    const doc = JSON.parse(text) as unknown;
    if (!isRecord(doc)) return null;
    const top = isRecord(doc.mcpServers) ? doc.mcpServers[name] : undefined;
    if (top !== undefined) return claudeMcpSpec(name, top);
    const project = isRecord(doc.projects) ? doc.projects[cwd] : undefined;
    const local = isRecord(project) && isRecord(project.mcpServers) ? project.mcpServers[name] : undefined;
    return local !== undefined ? claudeMcpSpec(name, local) : null;
  } catch {
    return null;
  }
}

/**
 * The servers Grok would load in the box, planned and registered for the bridge. A failing
 * inspect leaves every server as the box's config has it (logged): the session still starts.
 */
export async function grokBoxMcpServers(input: {
  launch: BoxLaunch;
  env: Record<string, string>;
  envUnset: readonly string[];
  /** Host cwd. */
  cwd: string;
  logger: AdapterContext["logger"];
}): Promise<McpServer[]> {
  const { launch } = input;
  let listed: unknown;
  try {
    const result = await runInBox(launch.connection, {
      command: launch.bin,
      args: ["inspect", "--json"],
      env: input.env,
      envUnset: input.envUnset,
      cwd: launch.toBox(input.cwd),
      timeoutMs: 30_000,
      maxOutputBytes: 8 * 1024 * 1024,
      label: "grok inspect in the box"
    });
    listed = result.code === 0 ? (JSON.parse(result.stdout) as unknown) : null;
  } catch (error) {
    input.logger.warn("grok: could not list the box's MCP servers; they run in the box as configured there", error);
    return [];
  }
  const servers = isRecord(listed) && Array.isArray(listed.mcpServers) ? listed.mcpServers : [];
  const specs: McpServerSpec[] = [];
  const texts = new Map<string, string | null>();
  for (const entry of servers) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue;
    const source = isRecord(entry.source) ? entry.source : {};
    // A plugin's servers live with the plugin (synced into the box); they run there.
    if (source.type === "plugin" || typeof source.path !== "string") continue;
    if (!texts.has(source.path)) texts.set(source.path, await readConfigSource(launch, source.path));
    const text = texts.get(source.path) ?? null;
    if (text === null) continue;
    const spec = definitionIn(text, source.path, entry.name, input.cwd, input.env);
    if (spec !== null) specs.push(spec);
  }
  const plan = await launch.bridgeMcpServers(specs);
  return plan.bridged.map((server) => ({ name: server.name, command: server.command, args: server.args, env: [] }));
}
