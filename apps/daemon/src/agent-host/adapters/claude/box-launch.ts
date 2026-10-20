/**
 * Claude adapter — a session whose CLI runs in a box (spec 2026-10-19 §7,
 * §8.4, §8.5).
 *
 * The SDK still runs here and still builds the command line; its
 * `spawnClaudeCodeProcess` hook starts that command in the box
 * (`boxes/claude-process.ts`). What differs from a host launch is decided
 * here, once per start:
 *
 * - the box's `claude` (resolved — or installed — in the box), the box cwd and
 *   the box env (`boxes/box-env.ts`: no `ANTHROPIC_*`, no
 *   `CLAUDE_CODE_OAUTH_TOKEN`, which switches the default model to Sonnet);
 * - its login: a brokered ACCESS token in a refresh-token-free
 *   `<box config dir>/.credentials.json` (0600, atomic), which the running CLI
 *   re-reads on its next request — so it is rewritten with a fresh grant
 *   whenever the token has under 30 minutes left: before and after a turn, and
 *   by a timer mid-turn (`token-policy.ts`), with no restart (spikes doc (a));
 * - the MCP servers of the account's own config (user and local scope of its
 *   `.claude.json`) and a profile's `--mcp-config`, rewritten so every server
 *   that must run here is reached through `orq-agent mcp-bridge` under the same
 *   name (dynamic `mcpServers` replace a same-named server of another scope); a
 *   "Run in box" server keeps running in the box, its env and header secrets
 *   moved into the CLI's process env (`${VAR}` in the file, the value in env);
 * - attachments are copied into the box at their own (mapped) path when a
 *   turn names them (`BoxLaunch.adapterContext`).
 *
 * Host-side readers (history, the goal transcript, forks) keep reading the
 * host's account home, which the transcript mirror keeps current after every
 * turn (spec §8.5).
 */

import { readFile } from "node:fs/promises";

import type { ClaudeNamesFs } from "../../../agent-isolation/claude-names.ts";
import { BoxProjectFs } from "../../../boxes/remote/fs/project-fs.ts";
import type { AdapterContext, StartSessionInput } from "../../adapter.ts";
import { requireBoxes, type BoxLaunch } from "../../boxes/index.ts";
import { claudeMcpSpec, type McpBridgePlan, type McpServerSpec } from "../../boxes/mcp-plan.ts";
import { BoxLaunchError } from "../../boxes/errors.ts";
import { joinBoxPath } from "../../boxes/launch-info.ts";
import type { AgentTokenGrant } from "../../../boxes/contracts.ts";
import { claudeConfigDir, claudeJsonPath } from "./config-dir.ts";
import { claudeVersionGateMessage, meetsMinimumClaudeVersion, parseClaudeVersion } from "./models.ts";
import type { ClaudeProfileLaunch, ClaudeProfileLaunchFiles } from "./profile-launch.ts";

type Doc = Record<string, unknown>;

/** Everything a box start hands `ClaudeSession`. */
export interface ClaudeBoxSession {
  launch: BoxLaunch;
  /** The BOX cwd the SDK starts the CLI in. */
  cwd: string;
  /** The box's `claude`. */
  executablePath: string;
  /** The box env, the brokered token in it. Never logged. */
  env: Record<string, string>;
  /** Removed from `orq-agent`'s own environment. */
  envUnset: string[];
  /** Bridged servers that replace the account's own same-named ones (SDK `mcpServers`). */
  mcpServers: Record<string, Doc>;
  /** The profile's launch with its servers rewritten for the box; absent for a Global chat. */
  profileLaunch?: ClaudeProfileLaunch;
}

function isRecord(value: unknown): value is Doc {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The account's user- and local-scope servers (`.claude.json`), the host copy being the source of
 * truth: each one's spec, and its definition as the file has it (secrets included — the box's
 * copy has them blanked).
 */
async function accountMcpServers(claudeJson: string, cwd: string): Promise<{ specs: McpServerSpec[]; defs: Record<string, Doc> }> {
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(claudeJson, "utf8")) as unknown;
  } catch {
    return { specs: [], defs: {} };
  }
  if (!isRecord(doc)) return { specs: [], defs: {} };
  const byName = new Map<string, McpServerSpec>();
  const defs: Record<string, Doc> = {};
  const add = (servers: unknown): void => {
    if (!isRecord(servers)) return;
    for (const [name, def] of Object.entries(servers)) {
      const spec = claudeMcpSpec(name, def);
      if (spec === null || !isRecord(def)) continue;
      byName.set(name, spec);
      defs[name] = def;
    }
  };
  add(doc.mcpServers);
  // Local scope wins over user scope, as in the CLI.
  const project = isRecord(doc.projects) ? doc.projects[cwd] : undefined;
  if (isRecord(project)) add(project.mcpServers);
  return { specs: [...byName.values()], defs };
}

/** Without an expiry from the broker, the file says one hour; the CLI does not refresh either way. */
const UNKNOWN_EXPIRY_MS = 60 * 60_000;

/**
 * The box's `.credentials.json` for a grant (spikes doc (a)): the access token, its expiry and
 * the non-secret `scopes` (space-separated in `extra`), `subscriptionType` and `rateLimitTier`
 * that give the CLI its subscription defaults. NEVER a `refreshToken`: without one the CLI cannot
 * refresh, so it can never race the host's refresher.
 */
export function claudeBoxCredentials(grant: AgentTokenGrant, now: number): { claudeAiOauth: Record<string, unknown> } {
  const extra = grant.extra ?? {};
  const scopes = (extra.scopes ?? "").split(/\s+/).filter((scope) => scope.length > 0);
  return {
    claudeAiOauth: {
      accessToken: grant.accessToken,
      expiresAt: grant.expiresAt ?? now + UNKNOWN_EXPIRY_MS,
      scopes,
      ...(extra.subscriptionType !== undefined ? { subscriptionType: extra.subscriptionType } : {}),
      ...(extra.rateLimitTier !== undefined ? { rateLimitTier: extra.rateLimitTier } : {})
    }
  };
}

/** A bridged server as a Claude stdio entry. */
function bridgedEntry(command: string, args: string[]): Doc {
  return { type: "stdio", command, args };
}

/**
 * A "Run in box" server's secrets out of the file and into the CLI's env: each env value and
 * header becomes `${ORQ_MCP_<n>_<KEY>}`, which the CLI expands when it loads `--mcp-config`.
 */
function inBoxEntry(def: Doc, index: number, cliEnv: Record<string, string>): Doc {
  const moved = (section: unknown, kind: "E" | "H"): Record<string, string> | undefined => {
    if (!isRecord(section)) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(section)) {
      if (typeof value !== "string") continue;
      const variable = `ORQ_MCP_${index}_${kind}_${key.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
      cliEnv[variable] = value;
      out[key] = `\${${variable}}`;
    }
    return out;
  };
  const env = moved(def.env, "E");
  const headers = moved(def.headers, "H");
  return { ...def, ...(env !== undefined ? { env } : {}), ...(headers !== undefined ? { headers } : {}) };
}

/** Rewrite one `mcpServers` map with `plan` (bridged replaced, in-box secrets moved, direct kept). */
function rewriteServers(servers: Record<string, Doc>, plan: McpBridgePlan, cliEnv: Record<string, string>): Record<string, Doc> {
  const bridged = new Map(plan.bridged.map((server) => [server.name, server]));
  const inBox = new Set(plan.inBox.map((server) => server.name));
  const out: Record<string, Doc> = {};
  let index = 0;
  for (const [name, def] of Object.entries(servers)) {
    const bridge = bridged.get(name);
    if (bridge !== undefined) {
      out[name] = bridgedEntry(bridge.command, bridge.args);
    } else if (inBox.has(name)) {
      out[name] = inBoxEntry(def, index++, cliEnv);
    } else {
      out[name] = def;
    }
  }
  return out;
}

/** A profile's launch files at their box paths (the host paths, mapped). */
export function boxProfileFiles(files: ClaudeProfileLaunchFiles, launch: BoxLaunch): ClaudeProfileLaunchFiles {
  return { dir: launch.toBox(files.dir), settings: launch.toBox(files.settings), mcpConfig: launch.toBox(files.mcpConfig) };
}

/**
 * Write a profile chat's launch files into the box (0600, under a fresh 0700 directory). After
 * the rewrite they hold no MCP secret of a host-run server; a "Run in box" server's secrets are
 * `${VAR}` references whose values ride the CLI's env.
 */
export async function writeBoxProfileFiles(
  launch: BoxLaunch,
  files: ClaudeProfileLaunchFiles,
  contents: { settings: Doc; mcpConfig?: Doc }
): Promise<void> {
  const box = boxProfileFiles(files, launch);
  await launch.connection.request("fs.rm", { path: box.dir, recursive: true, force: true });
  await launch.connection.request("fs.mkdir", { path: box.dir, recursive: true, mode: 0o700 });
  await launch.writeFile(files.settings, `${JSON.stringify(contents.settings, null, 2)}\n`);
  if (contents.mcpConfig !== undefined) {
    await launch.writeFile(files.mcpConfig, `${JSON.stringify(contents.mcpConfig, null, 2)}\n`);
  }
}

/** Remove them from the box; never throws (a box that is gone took them with it). */
export async function removeBoxProfileFiles(launch: BoxLaunch, files: ClaudeProfileLaunchFiles): Promise<void> {
  await launch.connection
    .request("fs.rm", { path: launch.toBox(files.dir), recursive: true, force: true })
    .catch(() => undefined);
}

/**
 * Prepare a box start: launch (sync, CLI, version gate), token, env, MCP rewrite. Throws a
 * {@link BoxLaunchError} the chat shows; whatever was registered is released on a failure.
 */
export async function prepareClaudeBoxSession(input: {
  context: AdapterContext;
  start: StartSessionInput & { box: NonNullable<StartSessionInput["box"]> };
  hostEnv: Record<string, string>;
  resumeSessionId: string | undefined;
  /**
   * The thread's profile launch (`loadClaudeProfileLaunch`), or `null` for a Global thread —
   * loaded once the launch is up, with the project's files read in the box (`projectFs`) and the
   * project walk stopping at the box's home.
   */
  loadProfileLaunch: (project: { projectFs: ClaudeNamesFs; home: string }) => Promise<ClaudeProfileLaunch | null>;
}): Promise<ClaudeBoxSession> {
  const { context, start, hostEnv } = input;
  const launch = await requireBoxes(context).launch({
    threadId: start.threadId,
    agent: "claude",
    box: start.box,
    home: start.home,
    cwd: start.cwd,
    ...(start.profile !== undefined ? { profile: start.profile } : {}),
    configRoot: claudeConfigDir(hostEnv),
    resumeSessionRef: input.resumeSessionId ?? null,
    signal: context.signal,
    onProgress: (message) => context.logger.info(`claude: ${message}`, { threadId: start.threadId })
  });
  try {
    const { env, unset } = launch.env(hostEnv);
    // A rented box is a throwaway sandbox, and orq-agent runs as root on most VMs: Claude refuses
    // `--dangerously-skip-permissions` (Full access) as root unless `IS_SANDBOX=1` says so.
    if (launch.sys.isRoot && launch.sys.os !== "win32") env.IS_SANDBOX = "1";
    // The version gate runs against the BOX's CLI (§10): never started and told to fail later.
    const version = parseClaudeVersion((await launch.version(unset)) ?? "");
    if (!meetsMinimumClaudeVersion(version)) {
      throw new BoxLaunchError("BOX_CLI_VERSION", `In the box: ${claudeVersionGateMessage(version)}`);
    }
    // The login (spikes doc (a)): a refresh-token-free `.credentials.json` in the box's config
    // dir — `CLAUDE_CODE_OAUTH_TOKEN` would silently switch the default model to Sonnet. The
    // running CLI re-reads the file, so it is rewritten whenever the token runs short.
    const configDir = env.CLAUDE_CONFIG_DIR;
    if (configDir === undefined || configDir.length === 0) {
      throw new BoxLaunchError("BOX_SYSTEM_ACCOUNT", "This chat's Claude account has no config directory, so it cannot run in a box.");
    }
    const credentialsPath = joinBoxPath(launch.sys.os, configDir, ".credentials.json");
    await launch.installCredentials((grant) =>
      launch.connection.writeFile(credentialsPath, `${JSON.stringify(claudeBoxCredentials(grant, Date.now()))}\n`, {
        mode: 0o600,
        mkdirs: true
      })
    );

    const cwd = launch.toBox(start.cwd);
    await launch.ensureDirs([context.attachmentsDir(start.threadId)]);

    // The project's `.mcp.json` servers, settings and `.claude/` entries are the box's: the
    // host's project directory is an empty stub.
    const loadedProfile = await input.loadProfileLaunch({ projectFs: new BoxProjectFs(launch.connection), home: launch.sys.home });

    let mcpServers: Record<string, Doc> = {};
    let profileLaunch: ClaudeProfileLaunch | undefined;
    if (loadedProfile !== null) {
      // A profile chat is strict: its `--mcp-config` is the whole set, rewritten in place.
      const servers = loadedProfile.mcpServers;
      const specs = Object.entries(servers).flatMap(([name, def]) => {
        const spec = claudeMcpSpec(name, def);
        return spec === null ? [] : [spec];
      });
      const plan = await launch.bridgeMcpServers(specs);
      profileLaunch = {
        ...loadedProfile,
        mcpServers: rewriteServers(servers, plan, env),
        plugins: loadedProfile.plugins.map((plugin) => ({ ...plugin, path: launch.toBox(plugin.path) }))
      };
    } else {
      // A Global chat loads the account's own config from the box's synced copy; the bridged
      // servers replace their same-named entries there, and so does each "Run in box" one — the
      // copy has its env and header values blanked, so it is given again from the host's
      // definition with those values moved into the CLI's env (`${VAR}` in the entry).
      const account = await accountMcpServers(claudeJsonPath(hostEnv), start.cwd);
      const plan = await launch.bridgeMcpServers(account.specs);
      const replaced = new Set([...plan.bridged, ...plan.inBox].map((server) => server.name));
      mcpServers = rewriteServers(
        Object.fromEntries(Object.entries(account.defs).filter(([name]) => replaced.has(name))),
        plan,
        env
      );
    }

    return {
      launch,
      cwd,
      executablePath: launch.bin,
      env,
      envUnset: unset,
      mcpServers,
      ...(profileLaunch !== undefined ? { profileLaunch } : {})
    };
  } catch (error) {
    await launch.close();
    throw error;
  }
}
