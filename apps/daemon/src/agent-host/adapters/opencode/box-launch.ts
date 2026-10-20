/**
 * OpenCode adapter — `opencode serve` in a box (spec 2026-10-19 §7, §8.4,
 * §8.5, §17 item 5).
 *
 * - The server runs in the box (`server.ts`, a box entry of the pool): its
 *   port is a free one there, its HTTP is forwarded to a loopback port here
 *   (`BoxConnection.forwardToHost`), and every client, the health check
 *   included, talks to the forwarded port.
 * - Logins: OpenCode in a box works with API-key providers only. The host's
 *   `auth.json` never goes to the box; each API key in it rides the server's
 *   `OPENCODE_CONFIG_CONTENT` (process env) as `provider.<id>.options.apiKey`.
 *   A provider signed in with OAuth refuses the launch with a clear message —
 *   its refresh token must never leave the host.
 * - MCP: the servers of the global config (`opencode.json[c]` under the
 *   config dir) that must run here are bridged through the same
 *   `OPENCODE_CONFIG_CONTENT`, which OpenCode merges over its config files.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";

import type { AdapterContext, StartSessionInput } from "../../adapter.ts";
import { requireBoxes, type BoxLaunch } from "../../boxes/index.ts";
import { BoxLaunchError } from "../../boxes/errors.ts";
import { openCodeMcpSpec } from "../../boxes/mcp-plan.ts";
import { checkMinimumVersion } from "../../orchestration/version-gate.ts";

/** The pieces a box server of the pool starts with. */
export interface OpenCodeBoxServer {
  launch: BoxLaunch;
  /** The server's box env (`boxes/box-env.ts`). */
  env: Record<string, string>;
  envUnset: readonly string[];
  /**
   * Called only when the pool really STARTS a server with these pieces: registers the bridged
   * MCP servers — owned by that server, not by any one thread, since its threads come and go —
   * and answers what to merge into `OPENCODE_CONFIG_CONTENT` (API keys and the bridged servers)
   * plus the release the pool calls when the server is gone.
   */
  configContent(): Promise<{ content: Record<string, unknown>; release: () => Promise<void> }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** OpenCode's own dirs under `env`, as `xdg-basedir` resolves them. */
function openCodeDirs(env: Record<string, string>, home: string): { config: string; data: string } {
  const configHome = env.XDG_CONFIG_HOME ?? join(home, ".config");
  const dataHome = env.XDG_DATA_HOME ?? join(home, ".local", "share");
  return { config: env.OPENCODE_CONFIG_DIR ?? join(configHome, "opencode"), data: join(dataHome, "opencode") };
}

async function readJsonc(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value = parseJsonc(await readFile(path, "utf8")) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The host's `auth.json`: API keys to hand the box's server, or the OAuth providers that refuse
 * a box launch. A missing file is no login at all (the provider env decides).
 */
export async function openCodeBoxLogins(dataDir: string): Promise<{ apiKeys: Record<string, string>; oauth: string[] }> {
  const auth = await readJsonc(join(dataDir, "auth.json"));
  const apiKeys: Record<string, string> = {};
  const oauth: string[] = [];
  for (const [provider, entry] of Object.entries(auth ?? {})) {
    if (!isRecord(entry)) continue;
    if (entry.type === "api" && typeof entry.key === "string" && entry.key.length > 0) apiKeys[provider] = entry.key;
    else if (entry.type === "oauth" || entry.type === "wellknown") oauth.push(provider);
  }
  return { apiKeys, oauth };
}

function openCodeSessionRef(cursor: unknown): string | null {
  return isRecord(cursor) && typeof cursor.sessionId === "string" && cursor.sessionId.length > 0 ? cursor.sessionId : null;
}

/**
 * Launch into the box: sync, the box's `opencode` (installed on first use), its version gate,
 * the API-key logins and the MCP bridge. Throws a {@link BoxLaunchError} the chat shows.
 */
export async function prepareOpenCodeBoxServer(input: {
  context: AdapterContext;
  start: Pick<StartSessionInput, "threadId" | "home" | "cwd" | "profile" | "resumeCursor"> & { box: NonNullable<StartSessionInput["box"]> };
  /** The project's launcher env (`buildEnv`), host-shaped. */
  hostEnv: Record<string, string>;
}): Promise<OpenCodeBoxServer> {
  const { context, start, hostEnv } = input;
  const dirs = openCodeDirs(hostEnv, hostEnv.HOME ?? start.home.path);
  const logins = await openCodeBoxLogins(dirs.data);
  if (logins.oauth.length > 0) {
    throw new BoxLaunchError(
      "BOX_UNSUPPORTED",
      `OpenCode in a box works with API-key providers only, and ${logins.oauth.join(", ")} ${logins.oauth.length === 1 ? "is" : "are"} signed in with OAuth here. Sign ${logins.oauth.length === 1 ? "it" : "them"} in with an API key (opencode auth login), or run this project's chats on the host.`
    );
  }
  const launch = await requireBoxes(context).launch({
    threadId: start.threadId,
    agent: "opencode",
    box: start.box,
    home: start.home,
    cwd: start.cwd,
    ...(start.profile !== undefined ? { profile: start.profile } : {}),
    configRoot: dirs.config,
    resumeSessionRef: openCodeSessionRef(start.resumeCursor),
    signal: context.signal,
    onProgress: (message) => context.logger.info(`opencode: ${message}`, { threadId: start.threadId })
  });
  try {
    const { env, unset } = launch.env(hostEnv);
    const versionLine = (await launch.version(unset)) ?? "";
    const version = /(\d+\.\d+\.\d+[^\s]*)/.exec(versionLine)?.[1] ?? null;
    const gate = checkMinimumVersion({ adapter: "opencode", version });
    if (!gate.ok) {
      throw new BoxLaunchError("BOX_CLI_VERSION", `In the box: ${gate.message ?? "this OpenCode is too old for chat."}`);
    }
    // The global config's MCP servers (the project's own `opencode.json` lives in the box and runs there).
    const config =
      (await readJsonc(join(dirs.config, "opencode.json"))) ?? (await readJsonc(join(dirs.config, "opencode.jsonc"))) ?? {};
    const servers = isRecord(config.mcp) ? config.mcp : {};
    const specs = Object.entries(servers).flatMap(([name, entry]) => {
      const spec = openCodeMcpSpec(name, entry);
      return spec === null ? [] : [spec];
    });
    const provider = Object.fromEntries(Object.entries(logins.apiKeys).map(([id, key]) => [id, { options: { apiKey: key } }]));
    return {
      launch,
      env,
      envUnset: unset,
      configContent: async () => {
        const plan = await launch.bridgeMcpServers(specs, { owner: "caller" });
        const mcp: Record<string, unknown> = {};
        for (const server of plan.bridged) {
          const local = { type: "local", command: [server.command, ...server.args], enabled: true };
          if (server.target.transport === "stdio") {
            // Merged over the config's entry: its environment's values blanked, never carried into the box.
            mcp[server.name] = { ...local, environment: Object.fromEntries(Object.keys(server.target.env).map((key) => [key, ""])) };
          } else {
            // A remote entry cannot become a local one under its own name: off, and bridged beside it.
            mcp[server.name] = { enabled: false };
            mcp[`${server.name}_host`] = local;
          }
        }
        return {
          content: {
            ...(Object.keys(mcp).length > 0 ? { mcp } : {}),
            ...(Object.keys(provider).length > 0 ? { provider } : {})
          },
          release: plan.release
        };
      }
    };
  } catch (error) {
    await launch.close();
    throw error;
  }
}

/** Deep-merge `extra` over a JSON config text (`OPENCODE_CONFIG_CONTENT`); objects merge, the rest replaces. */
export function mergeOpenCodeConfigContent(base: string, extra: Record<string, unknown>): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(base) as unknown;
  } catch {
    parsed = {};
  }
  const merge = (left: unknown, right: unknown): unknown => {
    if (!isRecord(left) || !isRecord(right)) return right;
    const out: Record<string, unknown> = { ...left };
    for (const [key, value] of Object.entries(right)) out[key] = key in out ? merge(out[key], value) : value;
    return out;
  };
  return JSON.stringify(merge(isRecord(parsed) ? parsed : {}, extra));
}
