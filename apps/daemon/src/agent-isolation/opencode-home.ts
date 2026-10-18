/**
 * Agent isolation — OpenCode's `$HOME/.opencode` (spec §6.4, §12).
 *
 * Verified with OpenCode 1.18.34 (its bundled source and the real binary):
 * - Its config dirs are `$XDG_CONFIG_HOME/opencode`, the project's `.opencode`
 *   dirs, `<home>/.opencode` and `OPENCODE_CONFIG_DIR`. `<home>` is
 *   `Global.Path.home` = `process.env.OPENCODE_TEST_HOME ?? os.homedir()`, so
 *   neither `XDG_CONFIG_HOME` nor `OPENCODE_CONFIG_DIR` keeps `~/.opencode`
 *   (its `opencode.json[c]`, MCP servers, commands, agents, plugins…) out.
 * - `OPENCODE_TEST_HOME` (undocumented, a test hook) moves only that `<home>`:
 *   the XDG dirs (auth and the session DB under `XDG_DATA_HOME`), `{file:~/…}`
 *   and the `permission` `~`/`$HOME` expansion keep using the real HOME. It
 *   also moves the `~/.claude/CLAUDE.md` fallback and the `~/.claude` /
 *   `~/.agents` skill scans, which a profile server switches off anyway.
 *
 * Being undocumented, the variable is probed against the installed binary
 * ({@link probeOpencodeTestHome}) and a caller refuses a profile launch when
 * `~/.opencode` holds config ({@link opencodeHomeConfigItems}) and the probe
 * did not prove the override effective.
 */

import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withDeadline } from "../agent-host/support/deadline.ts";
import { describeExit, spawnProviderChild } from "../agent-host/support/spawn.ts";

/** The variable that moves the home OpenCode reads `.opencode` from (OpenCode 1.18.34). */
export const OPENCODE_TEST_HOME_ENV = "OPENCODE_TEST_HOME";

/** The config files OpenCode reads from a `.opencode` dir. */
export const OPENCODE_HOME_CONFIG_FILES = ["opencode.json", "opencode.jsonc"] as const;

/** The item dirs OpenCode scans in every config dir (`{agent,agents}/**`, `{tool,tools}/*`, …). */
export const OPENCODE_HOME_ITEM_DIRS = [
  "agent",
  "agents",
  "command",
  "commands",
  "mode",
  "modes",
  "plugin",
  "plugins",
  "skill",
  "skills",
  "tool",
  "tools"
] as const;

/**
 * What `<home>/.opencode` holds that OpenCode would load as config: each config file that exists
 * (a dangling link does not) and each item dir with at least one entry (`"command/"`), sorted.
 * `bin/`, `package.json`, `node_modules/` and the like (written by OpenCode or its installer) are
 * not config. `[]` when the directory is missing.
 */
export async function opencodeHomeConfigItems(home: string): Promise<string[]> {
  const dir = join(home, ".opencode");
  const out: string[] = [];
  for (const name of OPENCODE_HOME_CONFIG_FILES) {
    if (await isFile(join(dir, name))) out.push(name);
  }
  for (const name of OPENCODE_HOME_ITEM_DIRS) {
    try {
      if ((await readdir(join(dir, name))).length > 0) out.push(`${name}/`);
    } catch {
      // missing, not a directory, or dangling
    }
  }
  return out.sort();
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export type OpencodeTestHomeProbe = { effective: true } | { effective: false; reason: string };

const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
const PROBE_MAX_BYTES = 8 * 1024 * 1024;
const CANARY = "orquester-test-home-canary";
/** A closed port: OpenCode's plugin-dependency install fails at once, offline. */
const CLOSED_REGISTRY = "http://127.0.0.1:9/";

/**
 * Proves, against the given binary, that `OPENCODE_TEST_HOME` keeps `$HOME/.opencode` out. In
 * `scratchDir` (created, then removed) a fake HOME gets `.opencode/command/<canary>.md`; two
 * `opencode debug config` runs follow, sandboxed (temp XDG dirs, no sign-in, no network
 * registry): the control (no override) must list the canary command, the override run (the
 * variable pointed at an empty dir) must not. Anything else — a failure, a deadline, output that
 * is not JSON, a control without the canary — is `{ effective: false, reason }`. Never throws.
 */
export async function probeOpencodeTestHome(options: {
  opencodeBin: string;
  scratchDir: string;
  /** Prepended to `debug config` (a test runs a fake through `node`). */
  args?: readonly string[];
  /** PATH for the runs; the daemon's by default. */
  path?: string;
  timeoutMs?: number;
}): Promise<OpencodeTestHomeProbe> {
  const { scratchDir } = options;
  try {
    const home = join(scratchDir, "home");
    const empty = join(scratchDir, "empty");
    await mkdir(join(home, ".opencode", "command"), { recursive: true, mode: 0o700 });
    await mkdir(empty, { recursive: true, mode: 0o700 });
    await writeFile(join(home, ".opencode", "command", `${CANARY}.md`), "---\ndescription: canary\n---\ncanary\n");
    const run = async (label: string, extra: Record<string, string>): Promise<{ ok: true; commands: string[] } | { ok: false; error: string }> => {
      const base = join(scratchDir, label);
      const env: Record<string, string> = {
        PATH: options.path ?? process.env.PATH ?? "",
        HOME: home,
        TMPDIR: scratchDir,
        XDG_CONFIG_HOME: join(base, "config"),
        XDG_DATA_HOME: join(base, "data"),
        XDG_CACHE_HOME: join(base, "cache"),
        XDG_STATE_HOME: join(base, "state"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_PURE: "1",
        BUN_CONFIG_REGISTRY: CLOSED_REGISTRY,
        npm_config_registry: CLOSED_REGISTRY,
        ...extra
      };
      return await debugConfigCommands({ ...options, env, cwd: empty });
    };
    const [control, override] = await Promise.all([run("control", {}), run("override", { [OPENCODE_TEST_HOME_ENV]: empty })]);
    if (!control.ok) return { effective: false, reason: control.error };
    if (!override.ok) return { effective: false, reason: override.error };
    if (!control.commands.includes(CANARY)) {
      return { effective: false, reason: "the probe's control run did not load ~/.opencode, so the probe cannot tell" };
    }
    if (override.commands.includes(CANARY)) {
      return { effective: false, reason: `OpenCode still loads ~/.opencode with ${OPENCODE_TEST_HOME_ENV} set` };
    }
    return { effective: true };
  } catch (error) {
    return { effective: false, reason: `the probe failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await rm(scratchDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  }
}

/** `opencode debug config` → the keys of its `command` object. Never throws. */
async function debugConfigCommands(options: {
  opencodeBin: string;
  args?: readonly string[];
  env: Record<string, string>;
  cwd: string;
  timeoutMs?: number;
}): Promise<{ ok: true; commands: string[] } | { ok: false; error: string }> {
  let child;
  try {
    child = spawnProviderChild({
      command: options.opencodeBin,
      args: [...(options.args ?? []), "debug", "config"],
      env: options.env,
      cwd: options.cwd
    });
  } catch (error) {
    return { ok: false, error: `opencode debug config could not start: ${error instanceof Error ? error.message : String(error)}` };
  }
  child.stdin.end();
  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    if (stdoutBytes < PROBE_MAX_BYTES) stdout.push(chunk);
    stdoutBytes += chunk.length;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-2048);
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  let reason;
  try {
    reason = await withDeadline(child.exited, {
      label: "opencode debug config",
      timeoutMs,
      onTimeout: () => {
        void child.kill();
      }
    });
  } catch (error) {
    await child.kill();
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const tail = stderr.trim().split("\n").slice(-3).join("\n");
  if (reason.kind !== "exit" || reason.code !== 0) {
    return { ok: false, error: `opencode debug config ${describeExit(reason)}${tail ? `: ${tail}` : ""}` };
  }
  if (stdoutBytes > PROBE_MAX_BYTES) {
    return { ok: false, error: `opencode debug config printed more than ${PROBE_MAX_BYTES} bytes` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(stdout).toString("utf8"));
  } catch {
    return { ok: false, error: "opencode debug config did not print JSON" };
  }
  const command = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).command : undefined;
  return { ok: true, commands: typeof command === "object" && command !== null ? Object.keys(command) : [] };
}
