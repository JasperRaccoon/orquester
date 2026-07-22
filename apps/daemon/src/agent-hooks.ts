import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface Logger {
  error(...args: unknown[]): void;
}

/** Bump when the script body changes so existing installs get rewritten. */
const SCRIPT_VERSION = 2;

/** POSIX single-quote: safe against every shell metacharacter, incl. embedded quotes. */
function shellQuotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Upper bound on how long a session launch waits for hook installation. The
 * install itself keeps running (and stays coalesced in the in-flight map);
 * this only stops a wedged filesystem on a config home from blocking
 * session creation.
 */
const INSTALL_LAUNCH_TIMEOUT_MS = 5000;

function withLaunchTimeout(run: Promise<void>): Promise<void> {
  return Promise.race([
    run,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, INSTALL_LAUNCH_TIMEOUT_MS);
      timer.unref?.();
    })
  ]);
}

/** Command strings of a Claude/Codex-shaped hook group ({ hooks: [{command}] }). */
function groupCommands(group: unknown): string[] {
  const hooks = (group as { hooks?: unknown })?.hooks;
  if (!Array.isArray(hooks)) {
    return [];
  }
  return hooks
    .map((h) => (h as { command?: unknown })?.command)
    .filter((c): c is string => typeof c === "string");
}

/**
 * Managed-group marker: match by the managed script's file name (like Orca's
 * installer sweep) via STRUCTURED extraction, not JSON.stringify substring —
 * shell quoting and JSON escaping would break a raw-path substring match for
 * exotic appdir paths, and a moved appdir should still sweep stale entries.
 */
function isManagedGroup(group: unknown): boolean {
  return groupCommands(group).some((c) => c.includes("agent-hook.sh"));
}

/**
 * POSIX hook transport: no-op without a session id (agent launched outside
 * Orquester), otherwise POST the stdin payload to the daemon's unix socket.
 * Always exits 0 — a hook failure must never surface inside the agent.
 */
function hookScript(): string {
  return `#!/bin/sh
# orquester-managed agent hook v${SCRIPT_VERSION} — do not edit (rewritten by the daemon)
[ -n "$ORQUESTER_SESSION_ID" ] || exit 0
[ -n "$ORQUESTER_DAEMON_SOCK" ] || exit 0
command -v curl >/dev/null 2>&1 || exit 0
source="$1"
event="$2"
payload=$(cat 2>/dev/null || printf '{}')
[ -n "$payload" ] || payload='{}'
printf '{"source":"%s","event":"%s","payload":%s}' "$source" "$event" "$payload" | \\
  curl -sS -X POST --unix-socket "$ORQUESTER_DAEMON_SOCK" \\
    --connect-timeout 0.5 --max-time 1.5 \\
    -H "Content-Type: application/json" \\
    --data-binary @- \\
    "http://localhost/api/sessions/$ORQUESTER_SESSION_ID/agent-event" >/dev/null 2>&1
exit 0
`;
}

/**
 * Atomic write that PRESERVES an existing target's permission bits by default —
 * user configs (Claude settings.json, Codex config.toml) can be 0600 and hold
 * secrets; replacing them must not widen access. `defaultMode` applies only to
 * newly created files (or always, with `preserveExistingMode: false`, for the
 * executable hook script whose mode must stay 0755).
 */
async function writeFileAtomic(
  path: string,
  content: string,
  defaultMode: number,
  preserveExistingMode = true
): Promise<void> {
  // Write THROUGH symlinks: users symlink agent configs into dotfiles repos,
  // and rename() onto the link path would replace the link with a regular
  // file — silently severing the dotfiles setup. realpath resolves to the
  // final target; a missing/broken path keeps the given one.
  let target = path;
  try {
    target = await realpath(path);
  } catch {
    // ENOENT (new file, or broken link) → write at the given path
  }
  let mode = defaultMode;
  if (preserveExistingMode) {
    try {
      mode = (await stat(target)).mode & 0o777;
    } catch {
      // new file → defaultMode
    }
  }
  await mkdir(dirname(target), { recursive: true });
  // Unique temp name per write: concurrent installers share agent-hook.sh, so a
  // fixed `${path}.tmp` would collide — the first rename wins and unlinks the
  // tmp, and the loser's rename throws ENOENT (aborting its per-agent config).
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, content, { encoding: "utf8", mode });
    await chmod(tmp, mode).catch(() => undefined);
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Installs managed status hooks into agent configs at launch time. Everything
 * here is best-effort: any failure logs and the session simply stays on the
 * bell/quiescence fallback. Never throws into the session-create path.
 */
export class AgentHooks {
  /** One in-flight install per entry+target; concurrent launches share it. */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly daemonDir: string,
    private readonly homeDir: string,
    private readonly logger: Logger = console
  ) {}

  private get scriptPath(): string {
    return join(this.daemonDir, "hooks", "agent-hook.sh");
  }

  /**
   * Install (or revalidate) the managed hooks for one agent + config-dir
   * target. AWAITED by the session managers before the agent spawns, so a
   * first launch can't read its config before the hooks are on disk. Runs on
   * every launch (installs are idempotent), which also repairs hooks removed
   * or edited during the daemon's lifetime; concurrent launches of the same
   * target coalesce onto one in-flight install. Never rejects — any failure
   * logs and the session degrades to the bell/quiescence fallback.
   *
   * `launchEnv` is the session's resolved addon env: account-bound sessions
   * run with CLAUDE_CONFIG_DIR / CODEX_HOME pointing at a per-account home
   * (agent-accounts), and the hooks must land where THAT agent process
   * actually reads its config — not in the daemon user's default home.
   */
  ensureForEntry(entryId: string, launchEnv: Record<string, string> = {}): Promise<void> {
    if (process.platform === "win32") {
      return Promise.resolve();
    }
    const target = this.configTarget(entryId, launchEnv);
    if (!target) {
      return Promise.resolve();
    }
    const key = `${entryId}:${target}`;
    const existing = this.inflight.get(key);
    if (existing) {
      return withLaunchTimeout(existing);
    }
    const run = this.install(entryId, target)
      .catch((error) => {
        this.logger.error(`agent-hooks: install failed for ${entryId} (${target})`, error);
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, run);
    return withLaunchTimeout(run);
  }

  /** The directory the launched agent process reads its config from. */
  private configTarget(entryId: string, launchEnv: Record<string, string>): string | null {
    switch (entryId) {
      case "claude":
        return launchEnv.CLAUDE_CONFIG_DIR || join(this.homeDir, ".claude");
      case "codex":
        return launchEnv.CODEX_HOME || join(this.homeDir, ".codex");
      case "opencode":
        return launchEnv.OPENCODE_CONFIG_DIR || join(this.homeDir, ".config", "opencode");
      default:
        return null;
    }
  }

  private async install(entryId: string, targetDir: string): Promise<void> {
    await writeFileAtomic(this.scriptPath, hookScript(), 0o755, false);
    if (entryId === "claude") {
      await this.installClaude(targetDir);
    } else if (entryId === "codex") {
      await this.installCodex(targetDir);
    } else {
      await this.installOpenCode(targetDir);
    }
  }

  // --- claude: managed hooks block in ~/.claude/settings.json ---------------

  private async installClaude(configDir: string): Promise<void> {
    const settingsPath = join(configDir, "settings.json");
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
      if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
        throw new Error("settings.json is not an object");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Malformed user file: never clobber it.
        throw error;
      }
    }
    // Deep-validate before mutating: an unrecognized hooks shape (string,
    // array, …) must abort untouched, not be silently replaced.
    if (
      "hooks" in settings &&
      (typeof settings.hooks !== "object" || settings.hooks === null || Array.isArray(settings.hooks))
    ) {
      throw new Error("settings.json has an unrecognized hooks shape; leaving it untouched");
    }
    const hooks = (settings.hooks as Record<string, unknown> | undefined) ?? {};
    const events: Array<{ event: string; matcher?: string }> = [
      { event: "UserPromptSubmit" },
      { event: "PreToolUse", matcher: "*" },
      { event: "PostToolUse", matcher: "*" },
      { event: "PermissionRequest", matcher: "*" },
      { event: "Notification" },
      { event: "Stop" }
    ];
    for (const { event } of events) {
      if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
        throw new Error(`settings.json hooks.${event} is not an array; leaving it untouched`);
      }
    }
    let changed = false;
    for (const { event, matcher } of events) {
      const command = `${shellQuotePosix(this.scriptPath)} claude ${event}`;
      const managed = {
        ...(matcher !== undefined ? { matcher } : {}),
        hooks: [{ type: "command", command, timeout: 10 }]
      };
      const groups = (hooks[event] as unknown[] | undefined) ?? [];
      // Replace stale managed versions in place; append when absent; leave
      // user hooks untouched.
      const withoutOurs = groups.filter((g) => !isManagedGroup(g));
      const current = groups.find(isManagedGroup);
      if (JSON.stringify(current) !== JSON.stringify(managed)) {
        hooks[event] = [...withoutOurs, managed];
        changed = true;
      }
    }
    if (changed) {
      settings.hooks = hooks;
      // 0600 default for a NEW file (settings can hold secrets); an existing
      // file keeps its own mode via writeFileAtomic's stat-preserve.
      await writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 0o600);
    }
  }

  // --- codex: hooks.json + config.toml trust entries ------------------------
  //
  // Codex >= 0.129 silently drops any hook without a matching
  // [hooks.state."<key>"] trust block whose trusted_hash equals Codex's own
  // canonical-JSON sha256 of the hook definition. We replicate that hash
  // (mirrors codex-rs command_hook_hash via Orca's config-toml-trust.ts).
  // Accepted risk: Codex owns the algorithm — if it drifts, hooks stop firing
  // and sessions degrade to quiescence; the log hint tells the user to run
  // /hooks in Codex to approve manually.

  private async installCodex(codexHome: string): Promise<void> {
    const hooksJsonPath = join(codexHome, "hooks.json");
    const configTomlPath = join(codexHome, "config.toml");

    // Read config.toml FIRST and refuse multiline-string files BEFORE touching
    // hooks.json — the line-based trust upsert can't parse full TOML, and a
    // multiline string's content can contain table-header-looking lines.
    // Guarding up front leaves BOTH files untouched (no half-installed inert
    // hooks, no error-log churn from rewriting an already-current hooks.json).
    let toml = "";
    try {
      toml = await readFile(configTomlPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (toml.includes('"""') || toml.includes("'''")) {
      throw new Error(
        "config.toml contains multiline strings; skipping managed hooks (run /hooks in Codex to approve manually)"
      );
    }

    const CODEX_EVENTS: Array<{ name: string; label: string; matcher?: string }> = [
      { name: "SessionStart", label: "session_start" },
      { name: "UserPromptSubmit", label: "user_prompt_submit" },
      { name: "PreToolUse", label: "pre_tool_use", matcher: "*" },
      { name: "PermissionRequest", label: "permission_request", matcher: "*" },
      { name: "PostToolUse", label: "post_tool_use", matcher: "*" },
      { name: "Stop", label: "stop" }
    ];

    // 1) hooks.json — Claude-shaped { hooks: { Event: [group…] } }. Preserve
    // the user's whole document (Codex documents top-level metadata like
    // `description`); we only mutate the `hooks` member. Deep-validate before
    // mutating — an unrecognized shape aborts untouched.
    let doc: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(await readFile(hooksJsonPath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("hooks.json is not an object; leaving it untouched");
      }
      doc = parsed as Record<string, unknown>;
      if (
        "hooks" in doc &&
        (typeof doc.hooks !== "object" || doc.hooks === null || Array.isArray(doc.hooks))
      ) {
        throw new Error("hooks.json has an unrecognized hooks shape; leaving it untouched");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error; // malformed user file — do not clobber
      }
    }
    const docHooks = (doc.hooks as Record<string, unknown> | undefined) ?? {};
    for (const event of CODEX_EVENTS) {
      if (docHooks[event.name] !== undefined && !Array.isArray(docHooks[event.name])) {
        throw new Error(`hooks.json hooks.${event.name} is not an array; leaving it untouched`);
      }
    }
    const hooksDoc = { hooks: docHooks as Record<string, unknown[]> };

    const managedFor = (event: { name: string; matcher?: string }) => ({
      ...(event.matcher !== undefined ? { matcher: event.matcher } : {}),
      hooks: [
        {
          type: "command",
          command: `${shellQuotePosix(this.scriptPath)} codex ${event.name}`,
          timeout: 10
        }
      ]
    });
    let changed = false;
    // Trust identity depends on the group index — compute AFTER the final
    // array shape is known.
    const trustTargets: Array<{ label: string; matcher?: string; groupIndex: number; command: string }> = [];
    for (const event of CODEX_EVENTS) {
      const managed = managedFor(event);
      const groups = Array.isArray(hooksDoc.hooks[event.name])
        ? hooksDoc.hooks[event.name]
        : [];
      const withoutOurs = groups.filter((g) => !isManagedGroup(g));
      const current = groups.find(isManagedGroup);
      const next = [...withoutOurs, managed]; // append: user group indices stay stable
      if (JSON.stringify(current) !== JSON.stringify(managed) || groups.length !== next.length) {
        hooksDoc.hooks[event.name] = next;
        changed = true;
      } else {
        hooksDoc.hooks[event.name] = groups;
      }
      // Key the trust block to the managed group's ACTUAL position in the final
      // array. The `changed` branch appends managed (last), but the else branch
      // preserves the user's original order, where the managed group can sit
      // anywhere — a length-1 assumption would trust the wrong index and Codex
      // would silently drop the hook.
      const finalGroups = hooksDoc.hooks[event.name] as unknown[];
      trustTargets.push({
        label: event.label,
        matcher: event.matcher,
        groupIndex: finalGroups.findIndex(isManagedGroup),
        command: (managed.hooks[0] as { command: string }).command
      });
    }
    if (changed) {
      doc.hooks = hooksDoc.hooks;
      await writeFileAtomic(hooksJsonPath, `${JSON.stringify(doc, null, 2)}\n`, 0o600);
    }

    // 2) config.toml trust blocks — written LAST so a half-write can't point
    // at a nonexistent hook. (Multiline-string guard already ran up top.)
    let tomlNext = toml;
    for (const t of trustTargets) {
      const key = `${hooksJsonPath}:${t.label}:${t.groupIndex}:0`;
      const hash = codexTrustHash(t.label, t.command, t.matcher);
      tomlNext = upsertCodexTrustBlock(tomlNext, key, hash);
    }
    if (tomlNext !== toml) {
      await writeFileAtomic(configTomlPath, tomlNext, 0o600);
    }
  }

  // --- opencode: status plugin in the global plugin dir ---------------------

  private async installOpenCode(configDir: string): Promise<void> {
    const pluginPath = join(configDir, "plugin", "orquester-status.js");
    const source = openCodePluginSource();
    let current = "";
    try {
      current = await readFile(pluginPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (current !== source) {
      await writeFileAtomic(pluginPath, source, 0o644);
    }
  }
}

/** Recursively sort object keys (Codex's canonical_json); arrays keep order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Mirrors codex-rs command_hook_hash: sha256 over canonical JSON of
 * { event_name, hooks: [handler], matcher? }. Codex drops matchers on
 * user_prompt_submit/stop before hashing (codex-rs matcher_pattern_for_event),
 * so including one there would yield a hash Codex never writes.
 */
function codexTrustHash(eventLabel: string, command: string, matcher?: string): string {
  const handler = { type: "command", command, timeout: 10, async: false };
  const identity: Record<string, unknown> = { event_name: eventLabel, hooks: [handler] };
  const effectiveMatcher =
    eventLabel === "user_prompt_submit" || eventLabel === "stop" ? undefined : matcher;
  if (effectiveMatcher !== undefined) {
    identity.matcher = effectiveMatcher;
  }
  const serialized = JSON.stringify(canonicalize(identity));
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

function escapeTomlString(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\b", "\\b")
    .replaceAll("\f", "\\f")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
}

/**
 * Upsert one [hooks.state."<key>"] block (enabled + trusted_hash), replacing an
 * existing block for the same key. Line-based: a block ends at the next table
 * header or EOF. Preserves a user-set `enabled = false`.
 */
function upsertCodexTrustBlock(content: string, key: string, hash: string): string {
  const header = `[hooks.state."${escapeTomlString(key)}"]`;
  const lines = content.length === 0 ? [] : content.split("\n");
  const headerIdx = lines.findIndex((line) => line.trim() === header);
  if (headerIdx === -1) {
    const block = [header, "enabled = true", `trusted_hash = "${escapeTomlString(hash)}"`];
    const out = [...lines];
    if (out.length > 0 && out[out.length - 1].trim() !== "") {
      out.push("");
    }
    out.push(...block, "");
    return out.join("\n");
  }
  let end = headerIdx + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) {
    end++;
  }
  const block = lines.slice(headerIdx, end);
  // Don't consume the blank separator / trailing EOF line before the next
  // header — leave it in the tail so the rewrite is byte-identical on re-run.
  let blockEnd = end;
  while (blockEnd > headerIdx + 1 && lines[blockEnd - 1].trim() === "") {
    blockEnd--;
  }
  const disabled = block.some((l) => /^\s*enabled\s*=\s*false\s*$/.test(l));
  const replacement = [
    header,
    `enabled = ${!disabled}`,
    `trusted_hash = "${escapeTomlString(hash)}"`
  ];
  return [...lines.slice(0, headerIdx), ...replacement, ...lines.slice(blockEnd)].join("\n");
}

/**
 * OpenCode status plugin. Runs inside OpenCode's own runtime, so transport is
 * node:http over the daemon's unix socket (no curl). Design notes:
 *  - no-ops without ORQUESTER_SESSION_ID/ORQUESTER_DAEMON_SOCK (runs outside
 *    Orquester, or on Windows);
 *  - opaque ctx, no destructuring — OpenCode may invoke the factory with
 *    undefined during startup;
 *  - child-session guard: a tool-spawned child session's busy/idle must not
 *    flip the pane; parent lookup fails CLOSED (assume child);
 *  - no message-part subscription at all (state transitions only).
 */
function openCodePluginSource(): string {
  return `// orquester-managed status plugin v${SCRIPT_VERSION} — do not edit (rewritten by the daemon)
import http from "node:http";

const SESSION_ID = process.env.ORQUESTER_SESSION_ID || "";
const SOCK = process.env.ORQUESTER_DAEMON_SOCK || "";

function post(event, payload) {
  if (!SESSION_ID || !SOCK) return;
  try {
    const body = JSON.stringify({ source: "opencode", event, payload: payload || {} });
    const req = http.request(
      {
        socketPath: SOCK,
        path: "/api/sessions/" + SESSION_ID + "/agent-event",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 1500
      },
      (res) => res.resume()
    );
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
    req.end(body);
  } catch {
    // never let status reporting break the agent
  }
}

export const OrquesterStatusPlugin = async (ctx) => {
  const client = ctx && ctx.client ? ctx.client : null;
  const childCache = new Map();

  async function isChildSession(sessionID) {
    if (!sessionID) return true; // fail closed
    if (childCache.has(sessionID)) return childCache.get(sessionID);
    try {
      if (client && client.session && typeof client.session.get === "function") {
        const info = await client.session.get({ path: { id: sessionID } });
        const data = info && (info.data || info);
        if (data && typeof data === "object") {
          const child = Boolean(data.parentID);
          childCache.set(sessionID, child); // cache SUCCESSFUL lookups only
          return child;
        }
      }
    } catch {
      // fall through: fail closed for this event, but retry on the next one —
      // a cached transient failure would suppress the session's status forever
    }
    return true;
  }

  let lastStatus = "";

  return {
    event: async (input) => {
      const event = input && input.event ? input.event : null;
      if (!event || !event.type) return;
      const props = event.properties || {};
      if (event.type === "permission.asked") {
        post("PermissionRequest", {});
        return;
      }
      if (event.type === "question.asked") {
        post("AskUserQuestion", {});
        return;
      }
      if (event.type === "session.status" || event.type === "session.idle" || event.type === "session.error") {
        const sessionID = props.sessionID || (props.status && props.status.sessionID) || "";
        if (await isChildSession(sessionID)) return;
        const statusType =
          event.type === "session.status" && props.status && props.status.type
            ? props.status.type
            : "idle";
        const busy = statusType === "busy" || statusType === "retry";
        const next = busy ? "SessionBusy" : "SessionIdle";
        if (next === lastStatus) return;
        lastStatus = next;
        post(next, {});
      }
    }
  };
};
`;
}
