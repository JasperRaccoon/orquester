import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface Logger {
  error(...args: unknown[]): void;
}

/** Bump when the script body changes so existing installs get rewritten. */
const SCRIPT_VERSION = 1;

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

async function writeFileAtomic(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Unique temp name per write: concurrent installers share agent-hook.sh, so a
  // fixed `${path}.tmp` would collide — the first rename wins and unlinks the
  // tmp, and the loser's rename throws ENOENT (aborting its per-agent config).
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, content, { encoding: "utf8", mode });
    await chmod(tmp, mode).catch(() => undefined);
    await rename(tmp, path);
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
  private readonly done = new Set<string>();

  constructor(
    private readonly daemonDir: string,
    private readonly homeDir: string,
    private readonly logger: Logger = console
  ) {}

  private get scriptPath(): string {
    return join(this.daemonDir, "hooks", "agent-hook.sh");
  }

  /** Fire-and-forget; deduped per entry id per daemon lifetime. */
  ensureForEntry(entryId: string): void {
    if (this.done.has(entryId) || process.platform === "win32") {
      return;
    }
    this.done.add(entryId);
    void this.install(entryId).catch((error) => {
      this.done.delete(entryId); // retry on the next launch
      this.logger.error(`agent-hooks: install failed for ${entryId}`, error);
    });
  }

  private async install(entryId: string): Promise<void> {
    if (entryId !== "claude" && entryId !== "codex" && entryId !== "opencode") {
      return;
    }
    await writeFileAtomic(this.scriptPath, hookScript(), 0o755);
    if (entryId === "claude") {
      await this.installClaude();
    } else if (entryId === "codex") {
      await this.installCodex();
    } else {
      await this.installOpenCode();
    }
  }

  // --- claude: managed hooks block in ~/.claude/settings.json ---------------

  private async installClaude(): Promise<void> {
    const settingsPath = join(this.homeDir, ".claude", "settings.json");
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
    const hooks =
      settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)
        ? (settings.hooks as Record<string, unknown>)
        : {};
    const events: Array<{ event: string; matcher?: string }> = [
      { event: "UserPromptSubmit" },
      { event: "PreToolUse", matcher: "*" },
      { event: "PostToolUse", matcher: "*" },
      { event: "PermissionRequest", matcher: "*" },
      { event: "Notification" },
      { event: "Stop" }
    ];
    let changed = false;
    for (const { event, matcher } of events) {
      const command = `"${this.scriptPath}" claude ${event}`;
      const managed = {
        ...(matcher !== undefined ? { matcher } : {}),
        hooks: [{ type: "command", command, timeout: 10 }]
      };
      const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
      // Managed marker: any command referencing our hooks dir. Replace stale
      // versions in place; append when absent; leave user hooks untouched.
      const isOurs = (group: unknown): boolean =>
        JSON.stringify(group ?? "").includes(join(this.daemonDir, "hooks"));
      const withoutOurs = groups.filter((g) => !isOurs(g));
      const current = groups.find(isOurs);
      if (JSON.stringify(current) !== JSON.stringify(managed)) {
        hooks[event] = [...withoutOurs, managed];
        changed = true;
      }
    }
    if (changed) {
      settings.hooks = hooks;
      await writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 0o644);
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

  private async installCodex(): Promise<void> {
    const codexHome = join(this.homeDir, ".codex");
    const hooksJsonPath = join(codexHome, "hooks.json");
    const configTomlPath = join(codexHome, "config.toml");

    const CODEX_EVENTS: Array<{ name: string; label: string; matcher?: string }> = [
      { name: "SessionStart", label: "session_start" },
      { name: "UserPromptSubmit", label: "user_prompt_submit" },
      { name: "PreToolUse", label: "pre_tool_use", matcher: "*" },
      { name: "PermissionRequest", label: "permission_request", matcher: "*" },
      { name: "PostToolUse", label: "post_tool_use", matcher: "*" },
      { name: "Stop", label: "stop" }
    ];

    // 1) hooks.json — Claude-shaped { hooks: { Event: [group…] } }. Codex
    // rejects unknown top-level fields, so preserve only "hooks".
    let hooksDoc: { hooks: Record<string, unknown[]> } = { hooks: {} };
    try {
      const parsed = JSON.parse(await readFile(hooksJsonPath, "utf8")) as {
        hooks?: Record<string, unknown[]>;
      };
      if (parsed && typeof parsed === "object" && parsed.hooks && typeof parsed.hooks === "object") {
        hooksDoc = { hooks: parsed.hooks };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error; // malformed user file — do not clobber
      }
    }

    const managedFor = (event: { name: string; matcher?: string }) => ({
      ...(event.matcher !== undefined ? { matcher: event.matcher } : {}),
      hooks: [
        {
          type: "command",
          command: `"${this.scriptPath}" codex ${event.name}`,
          timeout: 10
        }
      ]
    });
    const hooksDirMarker = join(this.daemonDir, "hooks");
    const isOurs = (group: unknown): boolean =>
      JSON.stringify(group ?? "").includes(hooksDirMarker);

    let changed = false;
    // Trust identity depends on the group index — compute AFTER the final
    // array shape is known.
    const trustTargets: Array<{ label: string; matcher?: string; groupIndex: number; command: string }> = [];
    for (const event of CODEX_EVENTS) {
      const managed = managedFor(event);
      const groups = Array.isArray(hooksDoc.hooks[event.name])
        ? hooksDoc.hooks[event.name]
        : [];
      const withoutOurs = groups.filter((g) => !isOurs(g));
      const current = groups.find(isOurs);
      const next = [...withoutOurs, managed]; // append: user group indices stay stable
      if (JSON.stringify(current) !== JSON.stringify(managed) || groups.length !== next.length) {
        hooksDoc.hooks[event.name] = next;
        changed = true;
      } else {
        hooksDoc.hooks[event.name] = groups;
      }
      trustTargets.push({
        label: event.label,
        matcher: event.matcher,
        groupIndex: (hooksDoc.hooks[event.name] as unknown[]).length - 1,
        command: (managed.hooks[0] as { command: string }).command
      });
    }
    if (changed) {
      await writeFileAtomic(hooksJsonPath, `${JSON.stringify(hooksDoc, null, 2)}\n`, 0o644);
    }

    // 2) config.toml trust blocks — written LAST so a half-write can't point
    // at a nonexistent hook.
    let toml = "";
    try {
      toml = await readFile(configTomlPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    let tomlNext = toml;
    for (const t of trustTargets) {
      const key = `${hooksJsonPath}:${t.label}:${t.groupIndex}:0`;
      const hash = codexTrustHash(t.label, t.command, t.matcher);
      tomlNext = upsertCodexTrustBlock(tomlNext, key, hash);
    }
    if (tomlNext !== toml) {
      await writeFileAtomic(configTomlPath, tomlNext, 0o644);
    }
  }

  // --- opencode: status plugin in the global plugin dir ---------------------

  private async installOpenCode(): Promise<void> {
    const pluginPath = join(this.homeDir, ".config", "opencode", "plugin", "orquester-status.js");
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
    let child = true; // fail closed on lookup errors
    try {
      if (client && client.session && typeof client.session.get === "function") {
        const info = await client.session.get({ path: { id: sessionID } });
        const data = info && (info.data || info);
        child = Boolean(data && data.parentID);
      }
    } catch {
      child = true;
    }
    childCache.set(sessionID, child);
    return child;
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
