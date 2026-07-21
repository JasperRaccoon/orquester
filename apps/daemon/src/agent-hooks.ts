import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, { encoding: "utf8", mode });
  await chmod(tmp, mode).catch(() => undefined);
  await rename(tmp, path);
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

  private async installCodex(): Promise<void> {
    // Task 6
  }

  private async installOpenCode(): Promise<void> {
    // Task 7
  }
}
