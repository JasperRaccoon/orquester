import { z } from "zod";
import { SECRET_BLOBS_DIR_NAME, SECRET_VAULT_INDEX_FILE } from "./secret-files.ts";

export const ORQUESTER_DIR_NAME = ".orquester";
export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 47831;
export const LOCAL_CONNECTION_ID = "local";

export type RuntimePlatform = "win32" | "darwin" | "linux" | string;

/** POSIX-style join used for config locations (keeps `/` separators). */
export function joinPath(...segments: string[]): string {
  const filtered = segments.filter(Boolean);
  if (filtered.length === 0) {
    return "";
  }

  const [first, ...rest] = filtered;
  return [
    first.replace(/[\\/]+$/, ""),
    ...rest.map((segment) => segment.replace(/^[\\/]+/, "").replace(/[\\/]+$/, ""))
  ].join("/");
}

// Variable expansion
//
// Config string values (paths) may reference:
//   $userhome  the OS home directory
//   $user      the OS username
//   $cwd       the process working directory
//   $appdir    the resolved base config dir (~/.orquester or e.g. ./.stage)

export interface ConfigVars {
  user: string;
  userhome: string;
  cwd: string;
  appdir: string;
}

/** Replace `$userhome`/`$user`/`$cwd`/`$appdir` in a string. */
export function expandVars(value: string, vars: ConfigVars): string {
  // `$userhome` is expanded before `$user` so the longer token wins.
  return value
    .replaceAll("$userhome", vars.userhome)
    .replaceAll("$appdir", vars.appdir)
    .replaceAll("$cwd", vars.cwd)
    .replaceAll("$user", vars.user);
}

// Directory layout
//
//   <appdir>/                 (~/.orquester by default, or e.g. ./.stage)
//     app/     app.json, remotes.json, logs/<yyyy-mm-dd>.log
//     daemon/  daemon.json, daemon.sock, sessions.json, todos.json, saved-prompts.json,
//              desktops.json, desktops/<id>/ (per-desktop runtime dir, 0700),
//              plugins.json, plugins/<id>/ (built-in plugin runtime files),
//              logs/<yyyy-mm-dd>.log
//
// Workspaces live wherever daemon.json `workspacesDir` points (default
// `$userhome/workspaces`; the stage sandbox uses `$appdir/workspaces`).

/** Resolve the base config dir. `appdir` (if given) must already be absolute. */
export function resolveBaseDir(homeDir: string, appdir?: string): string {
  return appdir && appdir.length > 0 ? appdir : joinPath(homeDir, ORQUESTER_DIR_NAME);
}

export function appConfigDir(baseDir: string): string {
  return joinPath(baseDir, "app");
}

export function daemonConfigDir(baseDir: string): string {
  return joinPath(baseDir, "daemon");
}

export function appConfigPath(baseDir: string): string {
  return joinPath(appConfigDir(baseDir), "app.json");
}

export function remotesConfigPath(baseDir: string): string {
  return joinPath(appConfigDir(baseDir), "remotes.json");
}

export function daemonConfigPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "daemon.json");
}

export function accountsConfigPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "accounts.json");
}

/** Per-account SSH keys live here (created mode 0700 by the daemon). */
export function keysDir(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "keys");
}

export function workspacesMetaPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "workspaces.json");
}

export function defaultSocketPath(baseDir: string, platform: RuntimePlatform): string {
  if (platform === "win32") {
    return "\\\\.\\pipe\\orquester-daemon";
  }

  return joinPath(daemonConfigDir(baseDir), "daemon.sock");
}

/**
 * Unix socket of the dedicated tmux server that owns session PTYs. Lives beside
 * the daemon socket under <appdir>/daemon so it inherits the same perms/backup
 * and is reachable across daemon restarts (PrivateTmp=false).
 */
export function tmuxSocketPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "tmux.sock");
}

/** On-disk index of sessions (for reattach on boot); see SessionManager. */
export function sessionsIndexPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "sessions.json");
}

export function browsersIndexPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "browsers.json");
}

export function browserProfilesDir(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "browser-profiles");
}

export function desktopsIndexPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "desktops.json");
}

/** Built-in plugin state (enabled workspaces, installed versions); see plugins.json below. */
export function pluginsConfigPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "plugins.json");
}

/** Per-plugin runtime dirs (downloaded binaries, the tsc-rs preload). */
export function pluginsDir(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "plugins");
}

/** `<appdir>/daemon/plugins/ts-rust`: holds preload.cjs, and tsc-rs's versions/<version>/ and .tmp/. */
export function tsRustPluginDir(baseDir: string): string {
  return joinPath(pluginsDir(baseDir), "ts-rust");
}

/** `<appdir>/daemon/plugins/ts-rust/tsrs`: the tsrs engine's versions/<version>/ and .tmp/. */
export function tsrsEngineDir(baseDir: string): string {
  return joinPath(tsRustPluginDir(baseDir), "tsrs");
}

/** The tsc-rs preload every Orquester session loads through NODE_OPTIONS while the plugin is on. */
export function tsRustPreloadPath(baseDir: string): string {
  return joinPath(tsRustPluginDir(baseDir), "preload.cjs");
}

// appendNodeRequireOption lives in ./tooling.ts (re-exported below) beside the per-target env helpers.

/** Ephemeral AI VMs: box records and plugin settings (`boxes.ts`). */
export function boxesStorePath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "boxes.json");
}

/** Ephemeral AI VMs: provider and Tailscale credentials; mode 0600, never sent to clients. */
export function boxSecretsPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "box-secrets.json");
}

/** `<appdir>/daemon/boxes`: per-box sockets, setup logs, orq-agent builds; mode 0700. */
export function boxesDir(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "boxes");
}

/**
 * Local relay socket for one connected box: the agent host (and other local
 * processes) open box channels through it with the same protocol as the box link.
 */
export function boxSocketPath(baseDir: string, boxId: string): string {
  return joinPath(boxesDir(baseDir), "sockets", `${boxId}.sock`);
}

/** One box's setup log (plain text, no secrets). */
export function boxSetupLogPath(baseDir: string, boxId: string): string {
  return joinPath(boxesDir(baseDir), "logs", `${boxId}.log`);
}

/** Built `orq-agent` executables, one per platform (`<platform>/orq-agent[.exe]`). */
export function boxAgentBuildsDir(baseDir: string): string {
  return joinPath(boxesDir(baseDir), "agent-builds");
}

/** Verified plugin tooling archives for boxes, keyed by (tool, version, platform). */
export function boxToolingCacheDir(baseDir: string): string {
  return joinPath(boxesDir(baseDir), "tooling-cache");
}

/**
 * One verified archive in the box tooling cache:
 * `<boxToolingCacheDir>/<tool>/<version>/<os>-<arch>[-<libc>].tgz`. Callers pass
 * plain names (no separators, no `..`); the daemon checks them before use.
 */
export function boxToolingArchivePath(
  baseDir: string,
  key: { tool: string; version: string; os: string; arch: string; libc: string | null }
): string {
  const platform = key.libc ? `${key.os}-${key.arch}-${key.libc}` : `${key.os}-${key.arch}`;
  return joinPath(boxToolingCacheDir(baseDir), key.tool, key.version, `${platform}.tgz`);
}

/** Box → host config-change sets waiting for approval (spec §8.3). */
export function boxConfigChangesPath(baseDir: string): string {
  return joinPath(boxesDir(baseDir), "config-changes.json");
}

// boxes (sync): what config sync last agreed with one box (per-file hashes), so a restart can tell
// a box-made change from a host-made one. A disposable cache: losing it only makes the host win.
export function boxSyncBaselinePath(baseDir: string, boxId: string): string {
  return joinPath(boxesDir(baseDir), "sync", `${boxId}.json`);
}

// boxes (remote/exec): box terminals closed while their box was away, whose shells are still owed
// an end when it reconnects (`{ version: 1, kills: [{ boxId, procId }] }`), so a restart keeps them.
export function boxPendingTerminalKillsPath(baseDir: string): string {
  return joinPath(boxesDir(baseDir), "pending-terminal-kills.json");
}

// boxes: the Agent config servers that run inside a box chat's box (`box-mcp.ts`, spec §8.4).
export function boxMcpSettingsPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "box-mcp.json");
}

/** Parent of every desktop's runtime dir (sockets, cookies, logs); mode 0700. */
export function desktopsRuntimeDir(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "desktops");
}

export function desktopRuntimeDir(baseDir: string, desktopId: string): string {
  return joinPath(desktopsRuntimeDir(baseDir), desktopId);
}

export function todosIndexPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "todos.json");
}

/** Daemon-owned "recently interacted with" project list (shared by all clients). */
export function recentProjectsPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "recent-projects.json");
}

/** Daemon-owned saved-prompt library, global and per project (shared by all clients). */
export function savedPromptsPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "saved-prompts.json");
}

/** Daemon-owned repo identities: a label and icon per git repository (spec 2026-10-18 §2). */
export function repoIdentitiesPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "repo-identities.json");
}

/** The repo identities' image icons, each under a generated file name; mode 0700. */
export function repoIconsDir(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "repo-icons");
}

/** Automated workflow definitions (docs/superpowers/specs/2026-09-28-automated-workflows-design.md §3.1). */
export function workflowsPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "workflows.json");
}

/** Workflow runtime state: schedule/git cursors, account cooldowns (§3.1). */
export function workflowStatePath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "workflow-state.json");
}

/** Workflow secret values; 0600 — values never leave the daemon (§5.7). */
export function workflowSecretsPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "workflow-secrets.json");
}

/** The Secret files vaults (spec 2026-10-19 §3): the index and the content blobs; mode 0700. */
export function secretFilesDir(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "secret-files");
}

/** The vault index; 0600. */
export function secretVaultIndexPath(baseDir: string): string {
  return joinPath(secretFilesDir(baseDir), SECRET_VAULT_INDEX_FILE);
}

/** Secret file contents, each named by its sha256; files 0600. */
export function secretBlobsDir(baseDir: string): string {
  return joinPath(secretFilesDir(baseDir), SECRET_BLOBS_DIR_NAME);
}

/** Parent of every `<runId>/` run directory (§5.8). */
export function workflowRunsDir(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "workflow-runs");
}

/** Agent profile state (docs/superpowers/specs/2026-09-28-agent-profile-design.md §4): stash + backups. */
export function agentProfileDir(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "agent-profile");
}

/** Items turned off where the agent has no native "off" (§4.4): `<agent>/<kind>/<id>/`. */
export function agentProfileStashDir(baseDir: string): string {
  return joinPath(agentProfileDir(baseDir), "stash");
}

/** The previous version of every file the agent profile rewrote (§4.1): `<agent>/…`, a ring per agent. */
export function agentProfileBackupsDir(baseDir: string): string {
  return joinPath(agentProfileDir(baseDir), "backups");
}

/** Import scans in flight (§6): a git clone or an extracted upload per `<importId>/`. */
export function agentProfileImportsDir(baseDir: string): string {
  return joinPath(baseDir, "tmp", "agent-profile-imports");
}

// Agent Profiles (docs/superpowers/specs/2026-10-18-agent-profiles-design.md §4.4, §6.5). Every
// directory below is daemon-owned and 0700; nothing here is ever a symlink target or merge source
// of an account home. Every id-derived segment passes `assertSessionProfileSegment`.
//
//   <appdir>/daemon/session-profiles/
//     profiles/<profileId>/                       one profile's sources (`session-profile-store`)
//     prepared/<profileId>/<agent>/<accountKey>/  one KEY's preparations (daemon `session-profiles/lifecycle.ts`)
//       current.json                              the key's current version, replaced atomically (temp + rename)
//       <version>/                                one immutable preparation: what a profile chat launches from
//     staging/                                    preparations being built, renamed into `prepared/` when published
//     deleted.json                                the names of deleted profiles, by id (a chat's fallback notice)

/** The Agent Profiles root. */
export function sessionProfilesDir(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "session-profiles");
}

/** Parent of every profile's source directory. */
export function sessionProfileSourcesDir(baseDir: string): string {
  return joinPath(sessionProfilesDir(baseDir), "profiles");
}

/** One profile's source directory (manifest, instructions, items, secrets). */
export function sessionProfileDir(baseDir: string, profileId: string): string {
  return joinPath(sessionProfileSourcesDir(baseDir), assertSessionProfileSegment(profileId));
}

/** Parent of every prepared directory. */
export function sessionProfilePreparedRootDir(baseDir: string): string {
  return joinPath(sessionProfilesDir(baseDir), "prepared");
}

/** Every prepared version of one profile, for every agent and account. */
export function sessionProfilePreparedProfileDir(baseDir: string, profileId: string): string {
  return joinPath(sessionProfilePreparedRootDir(baseDir), assertSessionProfileSegment(profileId));
}

/**
 * The directory of the KEY `(profileId, agent, accountKey)`: its {@link SESSION_PROFILE_PREPARED_CURRENT_FILE}
 * pointer and its immutable version directories ({@link sessionProfilePreparedDir}). `accountKey`
 * comes from {@link sessionProfileAccountKey}; an agent whose prepared files do not depend on the
 * account uses {@link SESSION_PROFILE_SHARED_ACCOUNT_KEY}. Never launch from it.
 */
export function sessionProfilePreparedKeyDir(baseDir: string, profileId: string, agent: string, accountKey: string): string {
  return joinPath(
    sessionProfilePreparedProfileDir(baseDir, profileId),
    assertSessionProfileSegment(agent),
    assertSessionProfileSegment(accountKey)
  );
}

/** The key's pointer file inside {@link sessionProfilePreparedKeyDir}: `{"schema": 1, "version": "<version>"}`. */
export const SESSION_PROFILE_PREPARED_CURRENT_FILE = "current.json";

/**
 * One published preparation of the key — what a profile chat of that agent launches from (spec §6)
 * and keeps using until its agent restarts. Never modified after it is published; a version name
 * is never reused.
 */
export function sessionProfilePreparedDir(
  baseDir: string,
  profileId: string,
  agent: string,
  accountKey: string,
  version: string
): string {
  return joinPath(sessionProfilePreparedKeyDir(baseDir, profileId, agent, accountKey), assertSessionProfileSegment(version));
}

/** The names of deleted profiles, by id (`deleted.json`): what a chat's fallback notice names (spec §5.6). */
export function sessionProfileDeletedFile(baseDir: string): string {
  return joinPath(sessionProfilesDir(baseDir), "deleted.json");
}

/** Where preparations are built before they are renamed into `prepared/` (same filesystem). */
export function sessionProfileStagingDir(baseDir: string): string {
  return joinPath(sessionProfilesDir(baseDir), "staging");
}

/** The account key of the daemon user's own login (no managed account; spec §6.2 "System account"). */
export const SESSION_PROFILE_SYSTEM_ACCOUNT_KEY = "system";
/** The account key of a prepared directory that is the same for every account of its agent. */
export const SESSION_PROFILE_SHARED_ACCOUNT_KEY = "shared";

/** A managed account id as-is; the system identity (`""`, `"system"`, absent) as {@link SESSION_PROFILE_SYSTEM_ACCOUNT_KEY}. */
export function sessionProfileAccountKey(accountId: string | null | undefined): string {
  return accountId && accountId !== SESSION_PROFILE_SYSTEM_ACCOUNT_KEY ? assertSessionProfileSegment(accountId) : SESSION_PROFILE_SYSTEM_ACCOUNT_KEY;
}

/** `segment` when it is safe as ONE path segment (letters, digits, `_`, `-`, `.` inside; ≤ 128); otherwise throws. */
export function assertSessionProfileSegment(segment: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(segment) || segment.includes("..")) {
    throw new Error(`"${segment.slice(0, 40)}" is not a valid Agent Profiles path segment.`);
  }
  return segment;
}

/** Web Push state (VAPID keypair + browser subscriptions); 0600 — holds the private key. */
export function pushConfigPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "push.json");
}

/**
 * Merge-backs waiting for a busy parent thread (spec 2026-10-14 §6): each is
 * delivered as an ordinary `/turn` once the parent is idle. 0600, the daemon's
 * own file, read tolerantly ({@link parseMergeOutbox}).
 */
export function agentChatMergeOutboxFile(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "agent-merge-outbox.json");
}

/**
 * Reply subscriptions and their deliveries (unified MCP design 2026-10-15 §8.3): a
 * `send_message`/`create_session` with `reply: "wait" | "notify"` is written here BEFORE its turn
 * is posted or queued. 0600, the daemon's own file, read tolerantly ({@link parseReplyOutbox}).
 */
export function agentChatReplyOutboxFile(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "agent-reply-outbox.json");
}

/**
 * The in-chat Orquester tools' settings, chat toolset overrides, toolset declines and approval
 * grants (unified MCP design 2026-10-15 §9.6). 0600, read tolerantly ({@link parseAgentToolsFile}).
 */
export function agentToolsFile(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "agent-tools.json");
}

/**
 * The ids of Orquester approval cards open right now (unified MCP design 2026-10-15 §7.4, §13), so
 * a daemon that died with cards pending resolves each as `cancelled` at its next boot. Only ids,
 * kinds and times — never a title, preview, argument or value. 0600, beside `agent-tools.json`.
 */
export function agentToolApprovalsJournalFile(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "agent-tool-approvals.json");
}

/** Cached token/cost scan (Claude JSONL + Codex sessions); 0600. */
export function usageTokensCacheFile(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "usage-tokens.json");
}

/**
 * The Claude usage sources' persisted state — each account's last reading and
 * when its rate-limited usage endpoint was last asked; 0600.
 */
export function usageStateFile(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "usage-state.json");
}

/** Auto mode's current subagent prompt-cache decision and when it is next checked; 0600. */
export function subagentCacheTtlStateFile(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "subagent-cache-ttl.json");
}

// --- agent chat: the host-owned thread store (spec §5.1) -------------------
//
//   <appdir>/daemon/agent/
//     threads/<sessionId>/
//       meta.json          ThreadHead, rewritten atomically every 50 events
//       events.ndjson      append-only domain events, per-thread monotonic seq
//       raw.ndjson         provider frames, rotated (§3.1)
//       attachments/<id>.<ext>
//   <appdir>/daemon/agent-host.sock    the host's HTTP-over-unix-socket API
//   <appdir>/daemon/agent-host.token   0600 shared secret, daemon <-> host
//
// `raw.ndjson` is as sensitive as the repository it watched (§10) and lives
// under the same permissions as the rest of `daemon/`.

/** Root of the agent host's own state. */
export function agentChatDir(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "agent");
}

/** Parent of every per-thread directory. */
export function agentChatThreadsDir(baseDir: string): string {
  return joinPath(agentChatDir(baseDir), "threads");
}

/** One thread's directory. `threadId` equals the session id. */
export function agentChatThreadDir(baseDir: string, threadId: string): string {
  return joinPath(agentChatThreadsDir(baseDir), threadId);
}

/** The thread head. Rewritten atomically (tmp + rename), never appended to. */
export function agentChatThreadMetaPath(baseDir: string, threadId: string): string {
  return joinPath(agentChatThreadDir(baseDir, threadId), "meta.json");
}

/** The durable domain-event log. Not rotated — it is the record (§3.1). */
export function agentChatThreadEventsPath(baseDir: string, threadId: string): string {
  return joinPath(agentChatThreadDir(baseDir, threadId), "events.ndjson");
}

/** Attachment bytes. Never in an event and never inline on the wire (§5.1). */
export function agentChatThreadAttachmentsDir(baseDir: string, threadId: string): string {
  return joinPath(agentChatThreadDir(baseDir, threadId), "attachments");
}

/**
 * The user's work a provider's earlier launches of the thread left running —
 * each launch's task sessions, under its launch marker — kept until the user
 * ends the thread's session, which sweeps them (0600, rewritten atomically;
 * the adapter's own file, never `binding.json`).
 */
export function agentChatThreadLeftoverWorkPath(baseDir: string, threadId: string): string {
  return joinPath(agentChatThreadDir(baseDir, threadId), "leftover-work.json");
}

/**
 * A transcript-handoff fork's context (spec 2026-10-14 §6): the parent's
 * conversation up to the fork point, which the host hands the provider
 * together with the child's first ordinary message. The record is kept for
 * the child's lifetime (`deliveredTurnId` says which turn carried it): that
 * turn failing, or a rewind dropping it, re-arms the handoff for the next
 * message. 0600, written atomically; only a provider without a native fork
 * has one.
 */
export function agentChatThreadForkHandoffPath(baseDir: string, threadId: string): string {
  return joinPath(agentChatThreadDir(baseDir, threadId), "fork-handoff.json");
}

/**
 * The fold snapshot: the thread's folded state as of one `seq`, rewritten
 * atomically every N events so a cold load folds only the log's tail. A cache
 * of the log, never an authority — a missing, corrupt or older-version file is
 * simply ignored and the log is folded from the top.
 */
export function agentChatThreadStatePath(baseDir: string, threadId: string): string {
  return joinPath(agentChatThreadDir(baseDir, threadId), "state.json");
}

/**
 * The host-wide thread index (SQLite): turn boundaries, item positions and
 * full text, all derived from the per-thread logs. Disposable by
 * construction — it is deleted and rebuilt on any schema or corruption
 * problem, so it is outside every deploy rollback boundary.
 */
export function agentChatIndexPath(baseDir: string): string {
  return joinPath(agentChatDir(baseDir), "index.sqlite");
}

/** The agent host's control socket (named pipe on Windows). */
export function agentHostSocketPath(baseDir: string, platform: RuntimePlatform): string {
  if (platform === "win32") {
    return "\\\\.\\pipe\\orquester-agent-host";
  }
  return joinPath(daemonConfigDir(baseDir), "agent-host.sock");
}

/**
 * The 0600 token file the daemon and the host authenticate with. Regenerated
 * only when no host is alive (§3.1) — a live host's token must keep working
 * across a daemon restart, which is the whole point of adoption.
 */
export function agentHostTokenPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "agent-host.token");
}

/** `yyyy-mm-dd` in local time. */
export function localDateStamp(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dailyLogFile(logsDir: string, date = new Date()): string {
  return joinPath(logsDir, `${localDateStamp(date)}.log`);
}

// daemon.json

export const httpTransportSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().min(1).default(DEFAULT_HTTP_HOST),
  port: z.coerce.number().int().min(1).max(65535).default(DEFAULT_HTTP_PORT),
  /**
   * The username half of the credential. The wire bearer is
   * base64("<username>:<passwordHash>"); the server compares this (normalized:
   * trim + lowercase) in constant time. Defaults to "mapacho".
   */
  username: z
    .string()
    .min(1)
    .transform((value) => value.trim().toLowerCase())
    .default("mapacho"),
  /** Transient plaintext input (env / settings). Migrated to `passwordHash`. */
  password: z.string().min(8).optional(),
  /** bcrypt hash of the password — what's persisted at rest. */
  passwordHash: z.string().optional(),
  /**
   * Filesystem-browser sandbox root: `/api/fs/*` rejects paths whose realpath
   * is outside this dir. Optional here; the daemon defaults it to the resolved
   * workspaces dir when unset (see resolved.fsRoot).
   */
  fsRoot: z.string().min(1).optional()
});

export const daemonConfigSchema = z.object({
  version: z.literal(1).default(1),
  // May contain $vars; expand with expandVars() before use.
  workspacesDir: z.string().min(1),
  logsDir: z.string().min(1),
  /**
   * "Protect archived data": the UI asks for the (retyped, non-autofilled)
   * password before showing archived workspaces/projects. A client-side
   * curtain, not a server boundary — archived items still appear (flagged)
   * in API responses. Writable via PUT /api/config/daemon/protect-archived,
   * which unlike the full config PUT is allowed over remote HTTP.
   */
  protectArchivedData: z.boolean().default(false),
  // Only the external HTTP transport is configurable here; the local unix
  // socket is always present and resolved at runtime (see resolveDaemonPaths).
  transports: z
    .object({
      http: httpTransportSchema.default({ enabled: false })
    })
    .default({ http: { enabled: false } })
});

export type DaemonConfig = z.infer<typeof daemonConfigSchema>;
export type HttpTransportConfig = z.infer<typeof httpTransportSchema>;

/** Runtime-only daemon paths resolved from home/platform/appdir (not persisted). */
export interface DaemonPaths {
  homeDir: string;
  baseDir: string;
  daemonDir: string;
  configPath: string;
  socketPath: string;
  vars: ConfigVars;
}

export function resolveDaemonPaths(input: {
  homeDir: string;
  platform: RuntimePlatform;
  cwd: string;
  /** Absolute base config dir, or undefined for the default ~/.orquester. */
  appdir?: string;
  env?: Record<string, string | undefined>;
}): DaemonPaths {
  const env = input.env ?? {};
  const baseDir = resolveBaseDir(input.homeDir, input.appdir);
  const user = env.USER ?? env.USERNAME ?? lastSegment(input.homeDir);

  return {
    homeDir: input.homeDir,
    baseDir,
    daemonDir: daemonConfigDir(baseDir),
    configPath: env.ORQUESTER_DAEMON_CONFIG ?? daemonConfigPath(baseDir),
    socketPath: env.ORQUESTER_UNIX_SOCKET ?? defaultSocketPath(baseDir, input.platform),
    vars: { user, userhome: input.homeDir, cwd: input.cwd, appdir: baseDir }
  };
}

export function createDefaultDaemonConfig(input: {
  env?: Record<string, string | undefined>;
}): DaemonConfig {
  const env = input.env ?? {};

  return parseDaemonConfig({
    version: 1,
    workspacesDir: "$userhome/workspaces",
    logsDir: "$appdir/daemon/logs",
    transports: {
      http: {
        enabled: env.ORQUESTER_HTTP_ENABLED === "true",
        host: env.ORQUESTER_HTTP_HOST ?? DEFAULT_HTTP_HOST,
        port: env.ORQUESTER_HTTP_PORT ?? String(DEFAULT_HTTP_PORT),
        username: env.ORQUESTER_HTTP_USERNAME,
        password: env.ORQUESTER_HTTP_PASSWORD
      }
    }
  });
}

export function parseDaemonConfig(value: unknown): DaemonConfig {
  return daemonConfigSchema.parse(value);
}

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

// Connections

export const localConnectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.literal("local"),
  socketPath: z.string().min(1)
});

export const remoteConnectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.literal("remote"),
  baseUrl: z.string().url(),
  password: z.string().optional()
});

export type LocalConnectionConfig = z.infer<typeof localConnectionSchema>;
export type RemoteConnectionConfig = z.infer<typeof remoteConnectionSchema>;

export function createLocalConnection(socketPath: string): LocalConnectionConfig {
  return { id: LOCAL_CONNECTION_ID, name: "Local daemon", kind: "local", socketPath };
}

// app.json (desktop app config)

export const usagePrefsSchema = z
  .object({
    /** Master switch for the top-bar usage widget (also gates daemon polling). */
    enabled: z.boolean().default(true),
    // Legacy per-agent booleans (pre-record). Optional; folded into `agents`.
    claude: z.boolean().optional(),
    codex: z.boolean().optional(),
    agents: z.record(z.string(), z.boolean()).default({}),
    /** Which agent drives the collapsed chip. */
    chip: z.enum(["busiest", "claude", "codex", "grok"]).default("busiest")
  })
  .transform((p) => {
    const agents = { ...p.agents };
    if (p.claude !== undefined && agents.claude === undefined) agents.claude = p.claude;
    if (p.codex !== undefined && agents.codex === undefined) agents.codex = p.codex;
    return { enabled: p.enabled, agents, chip: p.chip };
  });
export type UsagePrefs = z.infer<typeof usagePrefsSchema>;

export function usageAgentEnabled(prefs: UsagePrefs, id: string): boolean {
  return prefs.enabled && (prefs.agents[id] ?? true);
}

/**
 * Agent-harness runtime preferences. Daemon-side and per-VPS: the daemon reads
 * them at session launch, so every client that launches a session gets the same
 * value. The parent group's `.default({})` on appConfigSchema is what lets a
 * freshly provisioned VPS inherit these with no migration step.
 */
export const agentPrefsSchema = z.object({
  /**
   * Claude harness stream/API timeout, in minutes. Injected at every Claude
   * launch. 30 is Claude Code's own hard clamp on the idle watchdogs (ODh =
   * 1800000) — a larger value is silently floored by the harness, so it is
   * rejected here rather than displayed as a number that does nothing.
   */
  claudeTimeoutMinutes: z.number().int().min(1).max(30).default(30),
  /**
   * Prompt-cache lifetime for Claude subagents, injected at every Claude
   * launch. A 1h cache write costs 2x input instead of 1.25x, so it only pays
   * off when subagents sit idle past 5 minutes often enough; `auto` lets the
   * daemon decide from recent usage (see subagentCacheTtlStateSchema).
   */
  claudeSubagentCacheTtl: z.enum(["auto", "1h", "5m"]).default("auto"),
  /**
   * Agent chat §3.3: after the host restarts, whether a thread whose turn was
   * interrupted is continued from its saved provider resume cursor. Host-wide
   * default, **off** — "pick up where you left off" is wrong for a project
   * where a turn was halfway through a destructive operation.
   */
  continueThreadsAfterRestart: z.boolean().default(false),
  /**
   * Per-project override of the flag above, keyed by absolute project path.
   * Resolved per the thread's project over the host-wide default; an absent
   * entry means "use the default".
   */
  continueThreadsByProject: z.record(z.string(), z.boolean()).default({})
});
export type AgentPrefs = z.infer<typeof agentPrefsSchema>;

/**
 * Whether an interrupted turn in this project is continued after a host
 * restart (agent chat §3.3). The single resolution point, so the host, the
 * Settings panel and any future surface cannot disagree.
 */
export function continueThreadsForProject(prefs: AgentPrefs, projectPath: string): boolean {
  return prefs.continueThreadsByProject[projectPath] ?? prefs.continueThreadsAfterRestart;
}

export type SubagentCacheTtlMode = AgentPrefs["claudeSubagentCacheTtl"];

// subagent-cache-ttl.json (auto mode's decision; daemon-side)

/**
 * What auto mode last decided for `claudeSubagentCacheTtl`. Derived from the
 * transcripts, so a file that cannot be trusted is dropped and decided again.
 */
export const subagentCacheTtlStateSchema = z.object({
  version: z.literal(1),
  /** The lifetime Claude launches get until the next check. */
  ttl: z.enum(["1h", "5m"]),
  /** Epoch ms of the check that produced `ttl`, and of the next one. */
  checkedAt: z.number().finite(),
  nextCheckAt: z.number().finite(),
  /** `hold`: within the margin, the previous choice stayed. `insufficient`: too few requests to judge. */
  outcome: z.enum(["1h", "5m", "hold", "insufficient"]),
  /** Subagent requests the check looked at. */
  requests: z.number().finite(),
  /** Estimated cache cost of 1h relative to 5m, in percent; null when not judged. */
  changePct: z.number().finite().nullable()
});
export type SubagentCacheTtlState = z.infer<typeof subagentCacheTtlStateSchema>;

export function parseSubagentCacheTtlState(value: unknown): SubagentCacheTtlState | null {
  const parsed = subagentCacheTtlStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// agent-accounts.json (managed per-agent accounts; daemon-side)

export const agentAccountSchema = z.object({
  id: z.string(),
  agent: z.enum(["claude", "codex", "grok"]),
  label: z.string(),
  email: z.string().nullable().default(null),
  plan: z.string().nullable().default(null),
  needsReauth: z.boolean().default(false),
  createdAt: z.string(),
  importedAt: z.string()
});
export const agentAccountsSchema = z.object({
  accounts: z.array(agentAccountSchema).default([]),
  defaults: z
    .object({
      claude: z.string().nullable().default(null),
      codex: z.string().nullable().default(null),
      grok: z.string().nullable().default(null)
    })
    .default({ claude: null, codex: null, grok: null })
});
export type AgentAccountRecord = z.infer<typeof agentAccountSchema>;
export type AgentAccountsIndex = z.infer<typeof agentAccountsSchema>;

export function parseAgentAccounts(raw: unknown): AgentAccountsIndex {
  return agentAccountsSchema.parse(raw);
}
export function createDefaultAgentAccounts(): AgentAccountsIndex {
  return { accounts: [], defaults: { claude: null, codex: null, grok: null } };
}
export function agentAccountsFile(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "agent-accounts.json");
}
export function agentAccountsDir(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "agent-accounts");
}

export const appConfigSchema = z.object({
  version: z.literal(1).default(1),
  /** Connection opened on launch. "local" is always available. */
  activeConnectionId: z.string().min(1).default(LOCAL_CONNECTION_ID),
  /** Render the custom frameless titlebar with window controls. */
  useTitlebar: z.boolean().default(true),
  /** Desktop: keep the daemon running in a tray when the window is closed. */
  runInBackground: z.boolean().default(false),
  /** Confirm before closing a live terminal/agent session tab (it ends the session). */
  confirmCloseSession: z.boolean().default(true),
  /** Top-bar agent-usage widget preferences. */
  usage: usagePrefsSchema.default({}),
  /** Agent-harness runtime preferences (see agentPrefsSchema). */
  agents: agentPrefsSchema.default({})
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export function createDefaultAppConfig(): AppConfig {
  return appConfigSchema.parse({});
}

export function parseAppConfig(value: unknown): AppConfig {
  return appConfigSchema.parse(value);
}

// remotes.json (user-added remote servers; local is implicit)

export const remotesConfigSchema = z.object({
  version: z.literal(1).default(1),
  remotes: z.array(remoteConnectionSchema).default([])
});

export type RemotesConfig = z.infer<typeof remotesConfigSchema>;

export function createDefaultRemotesConfig(): RemotesConfig {
  return remotesConfigSchema.parse({ remotes: [] });
}

export function parseRemotesConfig(value: unknown): RemotesConfig {
  return remotesConfigSchema.parse(value);
}

// accounts.json (connected git-hosting accounts; daemon-side).
//
// Each account owns a server-side ed25519 key (private key at `keyPath`, never
// returned by any API) and a git identity. A scoped provider token may also be
// persisted (for REST: list/create repos); like the private key it is stored at
// rest (`0600`) and NEVER returned by any API — clients only see `repoAccess`.

export const gitProviderIdSchema = z.enum(["github", "bitbucket-cloud", "bitbucket-server"]);
export type GitProviderId = z.infer<typeof gitProviderIdSchema>;

export const accountSchema = z.object({
  id: z.string(),
  /** User-facing label (e.g. "work", "personal"). */
  label: z.string().min(1),
  /** Which forge this account belongs to. Legacy records default to github. */
  provider: gitProviderIdSchema.default("github"),
  /** Provider login (GitHub login, Bitbucket nickname, DC username). */
  login: z.string(),
  /** Secondary id some APIs need: BB Cloud account UUID (braces included), DC user slug. */
  loginRef: z.string().optional(),
  /** BB Cloud only: Atlassian account email (REST Basic auth username). */
  email: z.string().optional(),
  /** bitbucket-server only: instance base URL including any context path. */
  baseUrl: z.string().optional(),
  /** bitbucket-server only: absolute path to a PEM CA bundle under keys/. */
  caCertPath: z.string().optional(),
  /** Resolved SSH endpoint, "host" or "host:port" (e.g. "ssh.bitbucket.org", "bb.corp.com:7999"). */
  sshHost: z.string().optional(),
  /** ISO expiry of the stored token (Bitbucket tokens always expire; user-entered). */
  tokenExpiresAt: z.string().optional(),
  /** `git config user.name` for this account (editable in the UI). */
  gitName: z.string(),
  /** `git config user.email` for this account (editable in the UI). */
  gitEmail: z.string(),
  /** OpenSSH public key (safe to expose). */
  publicKey: z.string(),
  /** Absolute path to the private key on the daemon host. NEVER exposed by any API. */
  keyPath: z.string(),
  /** Id of the uploaded key on the provider (GitHub numeric id / BB key UUID), for later removal. */
  remoteKeyId: z.string().optional(),
  /** True while a DC instance rejected token key-upload and the user must paste the key manually. */
  keyUploadPending: z.boolean().optional(),
  /**
   * Scoped provider token for REST (list/create repos). Persisted at rest (`0600`);
   * NEVER exposed by any API / never crosses the wire — only
   * `AccountSummary.repoAccess` reflects its presence. On a bound workspace it
   * is additionally written to local 0600 files (a git-credentials store + gh
   * hosts.yml) so that workspace's terminals/agents can use HTTPS git + `gh`.
   * Absent until captured at connect-time or set via the token route.
   */
  token: z.string().optional(),
  createdAt: z.string()
});

/** Migrates pre-provider records: githubLogin→login, githubKeyId→remoteKeyId (stringified). */
const legacyAccountPreprocess = z.preprocess((value) => {
  if (!value || typeof value !== "object") return value;
  const rec = { ...(value as Record<string, unknown>) };
  if (typeof rec.githubLogin === "string" && typeof rec.login !== "string") {
    rec.login = rec.githubLogin;
  }
  delete rec.githubLogin;
  if (typeof rec.githubKeyId === "number" && rec.remoteKeyId === undefined) {
    rec.remoteKeyId = String(rec.githubKeyId);
  }
  delete rec.githubKeyId;
  return rec;
}, accountSchema);

export const accountsConfigSchema = z.object({
  version: z.literal(1).default(1),
  accounts: z.array(legacyAccountPreprocess).default([])
});

export type Account = z.infer<typeof accountSchema>;
export type AccountsConfig = z.infer<typeof accountsConfigSchema>;

export function createDefaultAccountsConfig(): AccountsConfig {
  return accountsConfigSchema.parse({ accounts: [] });
}

export function parseAccountsConfig(value: unknown): AccountsConfig {
  return accountsConfigSchema.parse(value);
}

/**
 * Serialize for persistence. On `github` records, mirrors the legacy
 * `githubLogin`/`githubKeyId` fields alongside the new shape so the file stays
 * parseable by PRE-provider daemons (whose schema required them) — a deploy
 * rollback must not wipe connected GitHub accounts. `githubKeyId` was a number
 * in the old schema, so it is only mirrored when `remoteKeyId` is numeric.
 * `parseAccountsConfig` strips the mirrors again on load (round-trip safe).
 * Bitbucket records get no mirrors: an old daemon cannot represent them.
 */
export function serializeAccountsConfig(config: AccountsConfig): unknown {
  return {
    ...config,
    accounts: config.accounts.map((account) => {
      if (account.provider !== "github") return account;
      const numericKeyId =
        account.remoteKeyId !== undefined && /^\d+$/.test(account.remoteKeyId)
          ? Number(account.remoteKeyId)
          : undefined;
      return {
        ...account,
        githubLogin: account.login,
        ...(numericKeyId !== undefined ? { githubKeyId: numericKeyId } : {})
      };
    })
  };
}

// workspaces.json (daemon-side per-workspace metadata; keyed by workspace NAME)
//
// A lightweight side-table layered onto the filesystem listing of
// `workspacesDir`. The filesystem stays the source of truth for which
// workspaces exist; this only carries extra metadata (the bound git account id
// + creation time) for names that have it. Lives at <appdir>/daemon/workspaces.json.

export const workspaceMetaSchema = z.object({
  /** Workspace directory name — the stable identifier (paths contain $vars). */
  name: z.string().min(1),
  /** Git account this workspace is bound to; undefined = default identity. */
  gitAccountId: z.string().optional(),
  /** ISO timestamp the workspace was created through orquester. */
  createdAt: z.string(),
  /** Hidden from the sidebar lists; purely cosmetic — nothing on disk changes. */
  isArchived: z.boolean().default(false),
  /** Project dir names under this workspace that are archived. */
  archivedProjects: z.array(z.string()).default([])
});

export const workspacesConfigSchema = z.object({
  version: z.literal(1).default(1),
  workspaces: z.array(workspaceMetaSchema).default([])
});

export type WorkspaceMeta = z.infer<typeof workspaceMetaSchema>;
export type WorkspacesConfig = z.infer<typeof workspacesConfigSchema>;

export function createDefaultWorkspacesConfig(): WorkspacesConfig {
  return workspacesConfigSchema.parse({ workspaces: [] });
}

export function parseWorkspacesConfig(value: unknown): WorkspacesConfig {
  return workspacesConfigSchema.parse(value);
}

// plugins.json — built-in plugin state (docs/superpowers/specs/2026-10-14-plugins-ts-rust-design.md §5.1).
// Keyed by plugin id. Tolerant like the other stores: unknown fields and unknown
// plugin ids written by other app versions are preserved on rewrite. The tsc-rs
// preload reads this file too, so it must stay plain JSON.

export const pluginInstalledVersionSchema = z
  .object({
    version: z.string().min(1),
    /** npm `dist.integrity` (sha512-…) of the platform tarball this version came from. */
    integrity: z.string().min(1),
    /** ISO timestamp the version was installed. */
    installedAt: z.string()
  })
  .passthrough();

export const pluginLastErrorSchema = z
  .object({
    at: z.string(),
    /** Which install step failed, e.g. "registry", "download", "integrity", "extract", "smoke-test". */
    step: z.string(),
    message: z.string()
  })
  .passthrough();

/** One engine's installed versions and update-check record. */
const pluginEngineVersionsShape = {
  current: pluginInstalledVersionSchema.optional(),
  previous: pluginInstalledVersionSchema.optional(),
  /** Set by rollback; a check stops at this version until `latest` moves past it. */
  skippedVersion: z.string().optional(),
  lastCheckAt: z.string().optional(),
  lastError: pluginLastErrorSchema.optional()
};

export const pluginEngineVersionsSchema = z.object(pluginEngineVersionsShape).passthrough();

/** The engines "Better TS Typecheck" can run (`TsCheckerEngine` in `@orquester/api`). */
export const TS_CHECKER_ENGINE_IDS = ["tsrs", "tsc-rs"] as const;
export type StoredTsCheckerEngine = (typeof TS_CHECKER_ENGINE_IDS)[number];

/**
 * The plugin's own record. For ts-rust the top-level version fields are
 * tsc-rs's (as every older build wrote them) and `tsrs` holds tsrs's.
 */
export const pluginStateSchema = z
  .object({
    /** The plugin's on/off for the whole server; absent is off. */
    enabled: z.boolean().optional(),
    /**
     * Legacy: the workspaces an older build turned tsc-rs on for. Read only to
     * turn such a record on (`enabled`) once; kept in the file for those builds.
     */
    enabledWorkspaces: z.array(z.string()).optional(),
    ...pluginEngineVersionsShape,
    /**
     * ts-rust: the engine chosen, "tsrs" or "tsc-rs"; absent is the platform's
     * default. Any other value (a newer build's engine) is kept as it is and
     * read as absent ({@link storedTsCheckerEngine}), never as a malformed record.
     */
    engine: z.unknown().optional(),
    /** ts-rust: the tsrs engine's versions and checks. */
    tsrs: pluginEngineVersionsSchema.optional()
  })
  .passthrough();

export const pluginsConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    /**
     * Keyed by plugin id. Entries are NOT validated here: a record another app
     * version wrote for a plugin this one does not know is kept verbatim, whatever
     * its shape. A known plugin's record is validated where it is read, by
     * `pluginStateOf`.
     */
    plugins: z.record(z.string(), z.unknown()).default({})
  })
  .passthrough();

export type PluginInstalledVersion = z.infer<typeof pluginInstalledVersionSchema>;
export type PluginLastError = z.infer<typeof pluginLastErrorSchema>;
export type PluginEngineVersions = z.infer<typeof pluginEngineVersionsSchema>;
export type PluginState = z.infer<typeof pluginStateSchema>;
export type PluginsConfig = z.infer<typeof pluginsConfigSchema>;

export function createDefaultPluginsConfig(): PluginsConfig {
  return pluginsConfigSchema.parse({});
}

export function parsePluginsConfig(value: unknown): PluginsConfig {
  return pluginsConfigSchema.parse(value);
}

/**
 * A plugin's state, validated, or the empty default when the file has no record
 * for it. Throws (a ZodError) when the record is malformed: the caller must
 * treat that plugin's state as unreadable and never write over it. The result
 * is a fresh object; unknown fields of the record are kept.
 */
export function pluginStateOf(config: PluginsConfig, id: string): PluginState {
  return pluginStateSchema.parse(config.plugins[id] ?? {});
}

/** The engine a ts-rust record names, or undefined when it names none this build knows. */
export function storedTsCheckerEngine(state: PluginState): StoredTsCheckerEngine | undefined {
  return (TS_CHECKER_ENGINE_IDS as readonly unknown[]).includes(state.engine)
    ? (state.engine as StoredTsCheckerEngine)
    : undefined;
}

// sessions.json — the daemon's index of live tmux-backed sessions, used to
// reattach PTYs after a restart. The tmux server is the source of truth for
// "is the command still running?"; this file remembers tab metadata (title /
// order / project) that tmux doesn't track.

/**
 * Which home dir an agent-chat thread's provider child runs under. Mirrors
 * `AgentConversationHome` in the resume picker. Agent chat spec §5.2. A record
 * written while the removed model proxy existed may say `"cliproxy"`; it reads
 * as the system home so the tab and its head still load.
 */
export const agentChatHomeSchema = z.preprocess(
  (value) => (value === "cliproxy" ? "system" : value),
  z.enum(["system", "account"])
);
export type AgentChatHome = z.infer<typeof agentChatHomeSchema>;

/**
 * The agent-chat block on a tab record (spec §5.2). `sessions.json` stays tab
 * metadata only; the agent host is the source of truth for thread state, so
 * this holds just enough to re-bind the tab to its thread after a restart.
 */
export const sessionChatRecordSchema = z.object({
  /** Equals the session id; kept explicit for clarity. */
  threadId: z.string().min(1),
  accountId: z.string(),
  home: agentChatHomeSchema,
  /** Last sequence this tab is known to have been rendered at. */
  lastSeq: z.number().int().nonnegative().default(0),
  /**
   * A fork tab opened under a `commandId` (spec 2026-10-14 §6): the fork point that key asked
   * for, so a repeat after a restart is told from a reuse exactly. Opaque to everything else;
   * one that does not read is none.
   */
  forkFingerprint: z.string().max(2_000).optional().catch(undefined),
  /**
   * A fork tab whose host fork has not answered yet — in flight, or its answer lost. The daemon
   * reconciles it with the host once it can (the child confirmed, or the tab taken back when the
   * host never created it); cleared once the host's answer is in. Anything else reads as absent.
   */
  forkUnconfirmed: z.literal(true).optional().catch(undefined),
  /**
   * A plain chat tab whose host create has not answered yet. Persisted so a daemon restart in
   * between still shows it as starting (not gone) until the daemon reconciles it with the host:
   * confirmed when the host holds the thread, taken back when it never got it. Anything else
   * reads as absent.
   */
  createUnconfirmed: z.literal(true).optional().catch(undefined),
  /**
   * The Agent Profile the chat launches with (`session-profiles.ts`). Absent = Global, as on
   * every record an older build wrote; a value that does not read is dropped (Global), never
   * the record. An older daemon strips the key on rollback, which relaunches the chat Global.
   */
  profileId: z.string().min(1).max(128).optional().catch(undefined),
  /**
   * An unattended chat (an MCP `create_session` or a workflow run, `CreateAgentChatSessionFields
   * .unattended`): a profile that is missing or not ready FAILS its agent's (re)start — it never
   * falls back to Global with a notice, because nobody is there to read it (spec 2026-10-18
   * §5.5). Anything else reads as absent (interactive).
   */
  unattended: z.literal(true).optional().catch(undefined)
});
export type SessionChatRecord = z.infer<typeof sessionChatRecordSchema>;

/**
 * The automated workflow run that started a chat tab (workflows spec §5.10). Mirrors
 * `WorkflowSessionOwner` in `@orquester/api`. The daemon validates a create request's `owner`
 * against this same schema (400 `INVALID_OWNER`), so what reaches `sessions.json` always parses.
 */
const ownerIdSchema = z.string().max(200).regex(/\S/, "must not be blank");
export const workflowSessionOwnerSchema = z.object({
  kind: z.literal("workflow"),
  workflowId: ownerIdSchema,
  runId: ownerIdSchema,
  nodeId: ownerIdSchema
});
export type WorkflowSessionOwnerRecord = z.infer<typeof workflowSessionOwnerSchema>;

/**
 * A chat thread's parent (spec 2026-10-14 §6). Mirrors `ThreadLineage` in
 * `@orquester/api` (`parseThreadLineage`, the same rules). Read with `.catch`
 * wherever it is persisted: a lineage that does not parse is dropped, never
 * the record that carries it.
 */
const lineageIdSchema = z.string().min(1).max(200).regex(/\S/, "must not be blank");
export const threadLineageRecordSchema = z.object({
  parentThreadId: lineageIdSchema,
  // `opened`: a chat another chat opened through `create_session` without `delegate` (unified MCP
  // design 2026-10-15 §4.1). An older build rejects it and drops the lineage, never the record.
  relation: z.enum(["fork", "delegate", "opened"]),
  forkedFrom: z
    .object({ messageId: lineageIdSchema, turnId: lineageIdSchema })
    .optional()
    .catch(undefined),
  createdAt: z.string().catch(""),
  // Delegate links above and including this thread (`ThreadLineage.delegationDepth`); a bad
  // value is dropped on its own, never the lineage.
  delegationDepth: z.number().int().min(0).max(64).optional().catch(undefined),
  // Set when a chat tool created this child (`ThreadLineage.agentCreated`, §13 c): only such
  // children are the parent agent's own. Anything but `true` is dropped on its own.
  agentCreated: z.literal(true).optional().catch(undefined),
  // Inherited workflow ownership (`ThreadLineage.workflowOwned`, §5.4), stamped at creation.
  // Anything but `true` is dropped on its own.
  workflowOwned: z.literal(true).optional().catch(undefined)
});
export type ThreadLineageRecord = z.infer<typeof threadLineageRecordSchema>;

export const sessionRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  order: z.number().int(),
  projectPath: z.string(),
  refId: z.string(),
  kind: z.enum(["shell", "agent", "agent-chat", "ide", "file-explorer", "browser"]),
  cwd: z.string(),
  createdAt: z.string(),
  // Managed agent account the session was launched under (the EFFECTIVE resolved
  // id — explicit selection or the per-agent default), if any. Persisted so a
  // daemon restart's reattach keeps the account pin: liveAccountIds() must still
  // see it (else the idle-account refresher could rotate a live account's
  // single-use refresh token) and the tab keeps its account badge.
  // Optional: absent for System/host-identity sessions and pre-field records.
  accountId: z.string().optional(),
  // Last known PTY size, persisted so a daemon restart reattaches each session at
  // its real size instead of the 80×24 default — otherwise a running full-screen
  // TUI (agent) repaints into a small corner until the client re-sends a resize.
  // Optional: records written before this field existed simply fall back.
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  // Agent-chat tabs only (kind "agent-chat"). Absent for terminals. See
  // parseSessionsConfig: a bad chat block drops that ONE session, never the
  // index — an unparseable index disables orphan reaping for every terminal.
  chat: sessionChatRecordSchema.optional(),
  // Set when an automated workflow run started this (chat) tab (workflows spec §5.10).
  // Tolerant: a malformed owner — a newer shape, a hand edit — is DROPPED, never the record
  // (`.catch`), so a bad owner can't cost the user a tab. An older daemon strips the key on
  // rollback, which only loses the Workflow chip.
  owner: workflowSessionOwnerSchema.optional().catch(undefined),
  // Agent-chat tabs: the thread this one was forked from or delegated by (spec 2026-10-14 §6).
  // Tolerant like `owner`: a malformed lineage is dropped, never the record; an older daemon
  // strips the key, which only loses the lineage chip.
  lineage: threadLineageRecordSchema.optional().catch(undefined),
  // boxes: a terminal running in a box (Ephemeral AI VMs spec §8.8): its shell is a detached
  // `orq-agent` process (procId = the session id) the daemon reattaches to after a restart.
  // An older daemon strips the key, sees no tmux pane and forgets the tab.
  boxId: z.string().min(1).optional().catch(undefined)
});

export const sessionsConfigSchema = z.object({
  version: z.literal(1).default(1),
  sessions: z.array(sessionRecordSchema).default([]),
  /**
   * Agent-chat threads whose tab is gone but whose host-side delete has not
   * been acknowledged (chat spec §6.1's cascade).
   *
   * The delete is one hop over the host socket, and the host can be down at the
   * moment the user closes a tab. Without this the `thread.deleted` event is
   * never written, and §3.3's reconcile then finds an orphan with a cursor and
   * a continuation marker and RESUMES it — a provider child and tokens spent
   * for a tab nobody is looking at. Queued here so the retry survives the
   * daemon restart that is most likely to happen in between, and replayed the
   * moment a host is adopted.
   */
  pendingThreadDeletes: z.array(z.string().min(1)).default([])
});

export type SessionRecord = z.infer<typeof sessionRecordSchema>;
export type SessionsConfig = z.infer<typeof sessionsConfigSchema>;

// --- agent chat: persisted thread head + receipt ring (spec §5.1) ----------
//
// These schemas mirror `ThreadHead` / `CommandReceipt` in `@orquester/api`'s
// `agent-chat` module. `@orquester/config` cannot import `@orquester/api`
// (the dependency runs the other way), so the two must be kept in step by
// hand; the api types carry the doc comments, these carry the validation.
//
// ROLLBACK BOUNDARY (§8): rolling the deploy back rolls back code, never
// `<appdir>/daemon/agent/threads/`. Add optional fields, never required ones,
// and never repurpose a name — a head written by a newer host must still
// decode here.

/** Permission mode. Mirrors `AgentRuntimeMode` in `@orquester/api`. */
export const agentRuntimeModeSchema = z.enum([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access"
]);
export type AgentRuntimeMode = z.infer<typeof agentRuntimeModeSchema>;

/** The four chat adapters (spec §5.3). */
export const agentAdapterIdSchema = z.enum(["claude", "codex", "opencode", "grok"]);
export type AgentAdapterId = z.infer<typeof agentAdapterIdSchema>;

export const agentModelSelectionSchema = z.object({
  instanceId: z.string().optional(),
  model: z.string(),
  options: z
    .array(z.object({ id: z.string(), value: z.union([z.string(), z.boolean()]) }))
    .optional()
});
export type AgentModelSelection = z.infer<typeof agentModelSelectionSchema>;

/** `idle` exists only on the head — a thread that has no session yet. */
export const agentThreadSessionStatusSchema = z.enum([
  "idle",
  "starting",
  "ready",
  "running",
  "stopped",
  "error"
]);

export const agentThreadSessionSchema = z.object({
  status: agentThreadSessionStatusSchema,
  /** Adapter-owned blob; a cursor failing its own shape check means "no resume". */
  resumeCursor: z.unknown().optional(),
  providerThreadId: z.string().optional(),
  activeTurnId: z.string().nullable().default(null),
  lastError: z.string().optional()
});

/**
 * `meta.json`. `continueAfterRestart` is a TURN ID, never a boolean (§3.3), so
 * a marker left over from an older turn is ignored rather than replaying the
 * wrong work.
 *
 * `resumeGoalAfterRestart` (agent goals §5.5) is the deploy handover's mark on
 * a thread whose goal was continuing: the next host resumes its provider
 * session. Additive — an older build strips it — and read with a fallback: a
 * malformed value is no mark, never an unreadable thread.
 *
 * `goalHeldForHandover` (agent goals §5.7) is the same kind of mark for a goal
 * a deploy's drain paused between its turns: the next host resumes the session
 * AND the goal. Additive and read with the same fallback.
 */
export const agentThreadHeadSchema = z.object({
  id: z.string().min(1),
  projectPath: z.string(),
  cwd: z.string(),
  title: z.string(),
  adapter: agentAdapterIdSchema,
  refId: z.string(),
  accountId: z.string(),
  home: agentChatHomeSchema,
  modelSelection: agentModelSelectionSchema,
  runtimeMode: agentRuntimeModeSchema,
  session: agentThreadSessionSchema,
  turnCount: z.number().int().nonnegative().default(0),
  seq: z.number().int().nonnegative().default(0),
  // `markedAt` must be listed: a zod object strips unknown keys, and a stamp
  // lost on load would make every marker read as an older host's (§3.3). A
  // stamp that is not a string reads as none — the marker an older host wrote,
  // under its older rule — never as a head nothing can read, like the goal
  // marks below.
  continueAfterRestart: z
    .object({
      turnId: z.string().min(1),
      prepared: z.boolean().optional(),
      markedAt: z.string().optional().catch(undefined)
    })
    .optional(),
  resumeGoalAfterRestart: z.literal(true).optional().catch(undefined),
  goalHeldForHandover: z.literal(true).optional().catch(undefined),
  // Spec 2026-10-14 §6, as `thread.created` recorded it. Must be listed (zod strips unknown
  // keys); a malformed one reads as none, never as a head nothing can read.
  lineage: threadLineageRecordSchema.optional().catch(undefined),
  // How a fork was carried over; head-only. Unreadable reads as none: the host then falls
  // back to the `thread.forked` row the fold still holds.
  forkStrategy: z.enum(["native", "transcript", "empty", "unavailable"]).optional().catch(undefined),
  // The Agent Profile the thread launches with (`ThreadHead.profileId`). Must be listed (zod
  // strips unknown keys); absent or unreadable = Global, never a head nothing can read.
  profileId: z.string().min(1).max(128).optional().catch(undefined),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type AgentThreadHead = z.infer<typeof agentThreadHeadSchema>;

/**
 * `fork-handoff.json` (spec 2026-10-14 §6): the conversation a transcript-handoff fork owes
 * its provider with the first message. `null` for anything that does not read — the fork then
 * runs without it, which the host reports rather than guessing. Unknown fields a newer build
 * wrote survive a rewrite (`passthrough`).
 */
export const forkHandoffSchema = z.object({
  version: z.literal(1),
  parentThreadId: z.string().min(1),
  transcript: z.string().min(1),
  createdAt: z.string(),
  /**
   * The turn that carried the transcript. The record is kept for the child's lifetime: that
   * turn failing, or a rewind dropping it, re-arms the handoff for the next message. A value
   * that does not read is no delivery — the transcript is sent again rather than lost.
   */
  deliveredTurnId: z.string().min(1).optional().catch(undefined)
}).passthrough();
export type ForkHandoffRecord = z.infer<typeof forkHandoffSchema>;

export function parseForkHandoff(value: unknown): ForkHandoffRecord | null {
  const parsed = forkHandoffSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * `agent-merge-outbox.json` (spec 2026-10-14 §6): merge-backs queued for a busy parent. Entries
 * are read one by one: a malformed entry is kept aside as it was (`unreadable`) and written back
 * unchanged, never dropped, and unknown fields of a good entry survive a rewrite (`passthrough`),
 * so a newer daemon's queue outlives a rollback.
 */
export const mergeOutboxEntrySchema = z
  .object({
    mergeId: z.string().min(1).max(200),
    parentSessionId: z.string().min(1),
    childSessionId: z.string().min(1),
    /** The whole `/turn` input, header included. */
    input: z.string().min(1),
    queuedAt: z.string(),
    /** `failed`: the parent refused it; it waits for the user's deliver or discard. */
    state: z.enum(["queued", "failed"]).catch("queued").default("queued"),
    /** Refused deliveries so far. */
    attempts: z.number().int().nonnegative().catch(0).default(0),
    /** The last refusal, in the parent's words. */
    error: z.string().max(2_000).optional().catch(undefined),
    /** The parent's turn mode (`MergeBackRequest.interactionMode`); absent: default. */
    interactionMode: z.enum(["default", "plan"]).optional().catch(undefined),
    /**
     * What the queued turn is (`PendingMergeBack.kind`, unified MCP design 2026-10-15 §8.3): a
     * fork's `merge` (absent = merge, as every entry written before the field), a `reply`
     * delivered to the requester (`parentSessionId`) from the chat that replied
     * (`childSessionId`), or a queued `message` sent with `reply: "wait" | "notify"` to the busy
     * target (`parentSessionId`) by the sender (`childSessionId`). A kind this build does not
     * know makes the entry unreadable: kept verbatim, never delivered as something else.
     */
    kind: z.enum(["merge", "reply", "message"]).optional(),
    /** The exchange the queued turn belongs to (`TurnCommandBody.causedBy`, §8.4). */
    causedBy: z
      .object({ threadId: z.string().min(1), exchangeId: z.string().min(1).max(200), hop: z.number().int().min(1) })
      .optional()
      .catch(undefined),
    /** `reply` / `message`: the reply subscription (`agent-reply-outbox.json`) the entry belongs to. */
    subscriptionId: z.string().min(1).max(200).optional().catch(undefined),
    /** `message`: the context chips the turn carries (the thread-message chip); absent for a merge. */
    context: z
      .array(z.object({ kind: z.string(), label: z.string(), ref: z.string().optional() }).passthrough())
      .optional()
      .catch(undefined)
  })
  .passthrough();
export type MergeOutboxEntry = z.infer<typeof mergeOutboxEntrySchema>;

export interface MergeOutbox {
  entries: MergeOutboxEntry[];
  /** Entries this build cannot read, kept verbatim for the next rewrite. */
  unreadable: unknown[];
  /** Every top-level key but `version` and `entries`, exactly as found (a newer build's). */
  extra?: Record<string, unknown>;
}

/**
 * The merge outbox. Tolerant of what a newer build of the same version wrote (unknown entries in
 * `unreadable`, unknown top-level keys in `extra`), and THROWS on anything that is not a version-1
 * outbox — another `version`, a non-object, `entries` not a list — so the caller moves it aside
 * instead of overwriting it.
 */
export function parseMergeOutbox(value: unknown): MergeOutbox {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Not a merge outbox (not an object)");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== undefined && record.version !== 1) {
    throw new Error(`Not a version-1 merge outbox (version ${JSON.stringify(record.version)})`);
  }
  if (record.entries !== undefined && !Array.isArray(record.entries)) {
    throw new Error("Not a merge outbox (entries is not a list)");
  }
  const raw = (record.entries as unknown[] | undefined) ?? [];
  const entries: MergeOutboxEntry[] = [];
  const unreadable: unknown[] = [];
  for (const entry of raw) {
    const parsed = mergeOutboxEntrySchema.safeParse(entry);
    if (parsed.success) entries.push(parsed.data);
    else unreadable.push(entry);
  }
  const extra = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "version" && key !== "entries"));
  return { entries, unreadable, extra };
}

/** The outbox as written: unknown top-level keys, then readable entries, then the unreadable ones as they came. */
export function serializeMergeOutbox(outbox: MergeOutbox): string {
  return JSON.stringify(
    { ...(outbox.extra ?? {}), version: 1, entries: [...outbox.entries, ...outbox.unreadable] },
    null,
    2
  );
}

// --- agent chat: reply subscriptions (unified MCP design 2026-10-15 §8.3) -----------------
//
// `agent-reply-outbox.json`. A subscription is written BEFORE the turn it binds to is posted or
// queued; every state transition is persisted (serialized writes) before its effect. Exactly one
// consumer claims a settled reply: the ReplyRouter (`waiting|notify -> claimed-by-router`) or the
// waiter (`waiting -> notify` on timeout / needs-input, or `waiting -> claimed-by-waiter` when the
// router hands it the reply). A delivery is the reply (or a notice) bound for the requester, kept
// here until the delivery queue has it under its fixed `commandId`.

/** A subscription's state (§8.3). Order matters only for reading: `done` is final. */
export const REPLY_SUBSCRIPTION_STATES = ["waiting", "notify", "claimed-by-waiter", "claimed-by-router", "done"] as const;
export type ReplySubscriptionState = (typeof REPLY_SUBSCRIPTION_STATES)[number];

/**
 * How a `done` subscription ended (`ended`): its reply `delivered` as a message, handed to its
 * `waiter`, the target `closed`, `dropped` (the requester closed), `refused` (nothing was posted or
 * queued), or its message `discarded` from the target's queue. A newer build's value is kept as is.
 */
export const REPLY_SUBSCRIPTION_ENDINGS = ["delivered", "waiter", "closed", "dropped", "refused", "discarded"] as const;
export type ReplySubscriptionEnding = (typeof REPLY_SUBSCRIPTION_ENDINGS)[number];

const replyExchangeSchema = z.object({
  /** The exchange id (`CausedBy.exchangeId`). */
  id: z.string().min(1).max(200),
  /** The hop of the turn this subscription's message causes (`CausedBy.hop`). */
  hop: z.number().int().min(1)
});

/**
 * One reply subscription. An unknown `state` (a newer build's) makes the entry unreadable: kept
 * verbatim and never acted on, rather than guessed at.
 */
export const replySubscriptionSchema = z
  .object({
    id: z.string().min(1).max(200),
    /** The requester: the chat whose tool sent the message and gets the reply. */
    fromThreadId: z.string().min(1).max(200),
    /** The target: the chat whose turn answers. */
    toThreadId: z.string().min(1).max(200),
    /** The fixed `/turn` command id the message is (or will be) posted under. */
    commandId: z.string().min(1).max(200),
    /** The bound turn, once the host receipt mapped `commandId` to it. */
    turnId: z.string().min(1).max(200).optional(),
    state: z.enum(REPLY_SUBSCRIPTION_STATES),
    /** The requester's interaction mode when it asked: the delivery's turn mode (plan if it plans when it lands). */
    interactionMode: z.enum(["default", "plan"]).catch("default").default("default"),
    exchange: replyExchangeSchema,
    /** How the message came (`ThreadMessageOrigin` of its header); absent: `sent`. */
    origin: z.enum(["sent", "opened", "delegated"]).optional().catch(undefined),
    /** `ReplySubscriptionRequest.idempotencyKey`: a repeat with the same requester and key answers this subscription. */
    idempotencyKey: z.string().min(1).max(200).optional(),
    /**
     * The delivery-queue entry (`agent-merge-outbox.json` `mergeId`, kind `message`) holding the
     * message while the target is busy. Stable across retries — a retry posts `<queueEntryId>:<n>`,
     * so the bound turn is found by this id (and `commandId` for an immediate post), never by an
     * attempt's command id alone.
     */
    queueEntryId: z.string().min(1).max(200).optional(),
    /**
     * The post that landed: its command id, the host receipt's `seq`, and the user message it
     * opened (binds the reply turn when no turn id is known). Absent until then. A malformed one
     * makes the entry unreadable (kept verbatim, never acted on) rather than taken for "not posted".
     */
    posted: z
      .object({ commandId: z.string().min(1).max(200), seq: z.number().int().min(0), messageId: z.string().min(1).max(200).optional() })
      .passthrough()
      .optional(),
    /** How a `done` subscription ended ({@link REPLY_SUBSCRIPTION_ENDINGS}; any string kept). */
    ended: z.string().min(1).max(40).optional().catch(undefined),
    /** The target's tab title when subscribed: names it in a notice after the tab closed. */
    toTitle: z.string().max(1000).optional().catch(undefined),
    createdAt: z.string(),
    updatedAt: z.string().optional().catch(undefined)
  })
  .passthrough();
export type ReplySubscriptionRecord = z.infer<typeof replySubscriptionSchema>;

/** What a delivery carries: the final reply, or one of the §8.3 / §13 d notices. */
export const REPLY_DELIVERY_OUTCOMES = ["reply", "empty", "failed", "interrupted", "closed", "exchange-limit"] as const;
export type ReplyDeliveryOutcome = (typeof REPLY_DELIVERY_OUTCOMES)[number];

/** A delivery to the requester (§8.3), persisted before it is handed to the delivery queue. */
export const replyDeliverySchema = z
  .object({
    id: z.string().min(1).max(200),
    subscriptionId: z.string().min(1).max(200),
    /** The requester, who receives it. */
    toThreadId: z.string().min(1).max(200),
    /** The chat whose turn produced it. */
    fromThreadId: z.string().min(1).max(200),
    /** The fixed `/turn` command id of its first post (host receipts dedupe a re-post). */
    commandId: z.string().min(1).max(200),
    /** Once queued: the delivery-queue entry (`mergeId`, kind `reply`); a retry posts `<queueEntryId>:<n>`. */
    queueEntryId: z.string().min(1).max(200).optional(),
    /** The bound turn whose reply it carries, when known. */
    turnId: z.string().min(1).max(200).optional(),
    outcome: z.enum(REPLY_DELIVERY_OUTCOMES),
    /** The whole `/turn` input, the `[Reply from …]` header included. */
    input: z.string().min(1),
    interactionMode: z.enum(["default", "plan"]).catch("default").default("default"),
    causedBy: z.object({ threadId: z.string().min(1), exchangeId: z.string().min(1).max(200), hop: z.number().int().min(1) }),
    /** `pending`: persisted, not yet queued; `queued`: in the delivery queue; `delivered` / `dropped`: final. */
    state: z.enum(["pending", "queued", "delivered", "dropped"]),
    createdAt: z.string(),
    deliveredAt: z.string().optional().catch(undefined)
  })
  .passthrough();
export type ReplyDeliveryRecord = z.infer<typeof replyDeliverySchema>;

export interface ReplyOutbox {
  subscriptions: ReplySubscriptionRecord[];
  deliveries: ReplyDeliveryRecord[];
  /** Entries this build cannot read, kept verbatim for the next rewrite. */
  unreadableSubscriptions: unknown[];
  unreadableDeliveries: unknown[];
  /** Every top-level key but `version`, `subscriptions` and `deliveries`, exactly as found. */
  extra?: Record<string, unknown>;
}

export function createDefaultReplyOutbox(): ReplyOutbox {
  return { subscriptions: [], deliveries: [], unreadableSubscriptions: [], unreadableDeliveries: [] };
}

/**
 * The reply outbox (the merge-outbox pattern): entry-wise tolerant — a malformed or newer-shaped
 * entry is kept aside verbatim, unknown fields of a good one survive (`passthrough`) — and THROWS on
 * anything that is not a version-1 outbox (not an object, another `version`, a list that is not a
 * list) so the caller moves it aside instead of overwriting it.
 */
export function parseReplyOutbox(value: unknown): ReplyOutbox {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Not a reply outbox (not an object)");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== undefined && record.version !== 1) {
    throw new Error(`Not a version-1 reply outbox (version ${JSON.stringify(record.version)})`);
  }
  for (const key of ["subscriptions", "deliveries"] as const) {
    if (record[key] !== undefined && !Array.isArray(record[key])) {
      throw new Error(`Not a reply outbox (${key} is not a list)`);
    }
  }
  const read = <T>(list: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>): { good: T[]; bad: unknown[] } => {
    const good: T[] = [];
    const bad: unknown[] = [];
    const ids = new Set<string>();
    for (const entry of (list as unknown[] | undefined) ?? []) {
      const parsed = schema.safeParse(entry);
      const id = parsed.success ? (parsed.data as { id: string }).id : undefined;
      if (parsed.success && id !== undefined && !ids.has(id)) {
        ids.add(id);
        good.push(parsed.data);
      } else {
        bad.push(entry);
      }
    }
    return { good, bad };
  };
  const subscriptions = read(record.subscriptions, replySubscriptionSchema);
  const deliveries = read(record.deliveries, replyDeliverySchema);
  const extra = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== "version" && key !== "subscriptions" && key !== "deliveries")
  );
  return {
    subscriptions: subscriptions.good,
    deliveries: deliveries.good,
    unreadableSubscriptions: subscriptions.bad,
    unreadableDeliveries: deliveries.bad,
    ...(Object.keys(extra).length > 0 ? { extra } : {})
  };
}

/** The outbox as written: unknown top-level keys, then the readable entries, then the unreadable ones as they came. */
export function serializeReplyOutbox(outbox: ReplyOutbox): string {
  return JSON.stringify(
    {
      ...(outbox.extra ?? {}),
      version: 1,
      subscriptions: [...outbox.subscriptions, ...outbox.unreadableSubscriptions],
      deliveries: [...outbox.deliveries, ...outbox.unreadableDeliveries]
    },
    null,
    2
  );
}

/**
 * A thread directory that fails to parse marks THAT thread `error` with the
 * parse message; it never affects other threads or host startup (§5.1). So
 * this returns null rather than throwing.
 */
export function parseAgentThreadHead(value: unknown): AgentThreadHead | null {
  const parsed = agentThreadHeadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * `binding.json` — the durable provider-session binding beside `meta.json`
 * (§3.3, §4.1). Mirrors `ProviderSessionBinding` in `@orquester/api`.
 *
 * It is deliberately NOT part of the event log: a `thread.session-set` names
 * the whole session block, so an event that omits the cursor can erase it. This
 * file is only ever merged field-wise, so nothing can.
 *
 * Same rollback boundary as the head: optional fields only, and a file that
 * does not decode means "no binding" (fall back to the head's cursor), never an
 * error.
 */
export const agentProviderSessionBindingSchema = z.object({
  version: z.literal(1).default(1),
  threadId: z.string().min(1),
  adapter: agentAdapterIdSchema,
  adapterKey: z.string().nullable().default(null),
  runtimeMode: agentRuntimeModeSchema.nullable().default(null),
  providerInstanceId: z.string().nullable().default(null),
  status: z.enum(["starting", "ready", "running", "stopped", "error"]).default("stopped"),
  /** Adapter-owned blob. `null` is "no resumable session", never "unknown". */
  resumeCursor: z.unknown().optional(),
  providerThreadId: z.string().nullable().default(null),
  lastSeenAt: z.string()
});
export type AgentProviderSessionBinding = z.infer<typeof agentProviderSessionBindingSchema>;

/** A binding that does not decode is treated as absent (§8), never as an error. */
export function parseAgentProviderSessionBinding(
  value: unknown
): AgentProviderSessionBinding | null {
  const parsed = agentProviderSessionBindingSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const agentCommandReceiptStatusSchema = z.enum(["accepted", "rejected"]);

/**
 * One command receipt. A receipt proves only that THIS exact command was
 * handled, which is why `threadId` is recorded: the same `commandId` against a
 * different thread is a hard conflict, never a replay (§6.2).
 */
export const agentCommandReceiptSchema = z.object({
  commandId: z.string().min(1),
  threadId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  status: agentCommandReceiptStatusSchema,
  acceptedAt: z.string(),
  /** The recorded rejection, replayed verbatim on a retry rather than re-run. */
  error: z
    .object({ code: z.string(), message: z.string(), detail: z.unknown().optional() })
    .optional()
});
export type AgentCommandReceipt = z.infer<typeof agentCommandReceiptSchema>;

/** `receipts.json` holds at most this many entries, oldest evicted first. */
export const AGENT_RECEIPTS_RING_SIZE = 500;

export const agentReceiptsFileSchema = z.object({
  version: z.literal(1).default(1),
  receipts: z.array(agentCommandReceiptSchema).default([])
});
export type AgentReceiptsFile = z.infer<typeof agentReceiptsFileSchema>;

export function createDefaultAgentReceiptsFile(): AgentReceiptsFile {
  return { version: 1, receipts: [] };
}

/**
 * Entry-wise tolerant, and falls back to empty on an unusable file: a receipt
 * ring is a de-duplication cache, so losing it costs at most one replayed
 * command — never a thread.
 */
export function parseAgentReceiptsFile(value: unknown): AgentReceiptsFile {
  const outer = z
    .object({ version: z.literal(1).default(1), receipts: z.array(z.unknown()).default([]) })
    .safeParse(value);
  if (!outer.success) {
    return createDefaultAgentReceiptsFile();
  }
  const receipts: AgentCommandReceipt[] = [];
  for (const entry of outer.data.receipts) {
    const parsed = agentCommandReceiptSchema.safeParse(entry);
    if (parsed.success) {
      receipts.push(parsed.data);
    }
  }
  return { version: 1, receipts: receipts.slice(-AGENT_RECEIPTS_RING_SIZE) };
}

export const agentDomainEventMetadataSchema = z
  .object({
    providerTurnId: z.string().optional(),
    providerItemId: z.string().optional(),
    adapterKey: z.string().optional(),
    requestId: z.string().optional(),
    ingestedAt: z.string().optional()
  })
  .passthrough();

/**
 * **`type` is an open string, deliberately (§8).** The thread log is outside
 * every rollback: events appended by a NEWER host stay on disk and the older
 * host must still fold them. A closed enum here made an event type this build
 * has never heard of indistinguishable from a corrupt line, so an older host
 * silently dropped the entire tail of the log after it — items, activities,
 * checkpoints, the roster — and, when that event was the last line, seeded its
 * sequence behind it and re-used a `seq` already on disk.
 *
 * So: the ENVELOPE is validated (it is what a reader needs to order, filter and
 * replay), the type is not constrained, and a type this build does not know
 * folds to a no-op that still advances `seq`. Truncation is reserved for
 * genuinely malformed JSON or a missing envelope field (§5.1).
 */
export const agentDomainEventEnvelopeSchema = z.object({
  seq: z.number().int().positive(),
  eventId: z.string().min(1),
  threadId: z.string().min(1),
  type: z.string().min(1),
  payload: z.unknown(),
  occurredAt: z.string(),
  commandId: z.string().nullable().default(null),
  causationEventId: z.string().nullable().default(null),
  metadata: agentDomainEventMetadataSchema.default({})
});
export type AgentDomainEventEnvelope = z.infer<typeof agentDomainEventEnvelopeSchema>;

/**
 * Returns null rather than throwing: a malformed line TRUNCATES the fold at
 * that point (spec §5.1), it never discards the file and never fails the host.
 *
 * An unknown `type` is NOT malformed — it decodes, and the fold ignores it
 * (§8). Only a line that is not JSON, or whose envelope fields are missing or
 * the wrong shape, comes back null.
 */
export function parseAgentDomainEvent(value: unknown): AgentDomainEventEnvelope | null {
  const parsed = agentDomainEventEnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** One persisted browser tab. The Chromium PROCESS does not survive a daemon
 *  restart (it is a daemon child, unlike tmux) — only the tab record does;
 *  first subscribe after boot relaunches and re-navigates. */
export const browserRecordSchema = z.object({
  id: z.string().min(1),
  projectPath: z.string(),
  url: z.string(),
  title: z.string().default(""),
  viewportMode: z.enum(["desktop", "mobile"]).default("desktop"),
  order: z.number(),
  createdAt: z.string()
});

export const browsersFileSchema = z.object({
  version: z.literal(1),
  browsers: z.array(browserRecordSchema).default([])
});

export type BrowserRecord = z.infer<typeof browserRecordSchema>;
export type BrowsersFile = z.infer<typeof browsersFileSchema>;

export function parseBrowsersFile(value: unknown): BrowsersFile {
  return browsersFileSchema.parse(value);
}

export function createDefaultBrowsersFile(): BrowsersFile {
  return { version: 1, browsers: [] };
}

/** Desktop display size bounds (Xvnc geometry). */
export const DESKTOP_MIN_WIDTH = 320;
export const DESKTOP_MAX_WIDTH = 7680;
export const DESKTOP_MIN_HEIGHT = 240;
export const DESKTOP_MAX_HEIGHT = 4320;
export const DESKTOP_DEFAULT_SIZE = { width: 1280, height: 800 } as const;
export const DESKTOP_DEFAULT_RENDER_THREADS = 4;
/** Exited apps kept per desktop; recent launches kept per project. */
export const DESKTOP_MAX_EXITED_APPS = 20;
export const DESKTOP_MAX_RECENT_LAUNCHES = 20;

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export const desktopSizeSchema = z
  .object({ width: z.number(), height: z.number() })
  .transform((size) => ({
    width: clampInt(size.width, DESKTOP_MIN_WIDTH, DESKTOP_MAX_WIDTH),
    height: clampInt(size.height, DESKTOP_MIN_HEIGHT, DESKTOP_MAX_HEIGHT)
  }));

/**
 * One app launched into a desktop. `status` and `pgid` are hints for boot
 * reconciliation only — the live state comes from tmux and the exit files.
 */
export const desktopAppRecordSchema = z
  .object({
    id: z.string().min(1),
    desktopId: z.string().min(1),
    /** Shell command line, run as `sh -c 'exec <command>'`. */
    command: z.string(),
    cwd: z.string(),
    /** User-entered variables only (not the desktop wiring). */
    env: z.record(z.string()).default({}),
    status: z.enum(["starting", "running", "exited"]).catch("exited"),
    exitCode: z.number().int().nullable().default(null),
    pgid: z.number().int().nullable().default(null),
    startedAt: z.string(),
    exitedAt: z.string().nullable().default(null)
  })
  .passthrough();

export type DesktopAppRecord = z.infer<typeof desktopAppRecordSchema>;

export const desktopRecordSchema = z
  .object({
    id: z.string().min(1),
    /** The project path as the client spells it (the UI's project key, like sessions and browsers). */
    projectPath: z.string().min(1),
    /** Its realpath inside the fs root: cascades and recent launches match on this. */
    projectRealPath: z.string().nullable().default(null),
    title: z.string().default("Desktop"),
    order: z.number().default(0),
    createdAt: z.string(),
    display: z.number().int().nullable().default(null),
    size: desktopSizeSchema.default({ ...DESKTOP_DEFAULT_SIZE }),
    renderThreads: z.number().int().min(1).default(DESKTOP_DEFAULT_RENDER_THREADS),
    /** Set only when sockets live in the short tmp fallback dir (path length). */
    socketDir: z.string().nullable().default(null),
    /** The host was started with PulseAudio (decided at create time). */
    audio: z.boolean().optional(),
    apps: z.array(z.unknown()).catch([]).default([])
  })
  .passthrough()
  // Entry-wise tolerant apps: one entry this build cannot read (another version's
  // shape) must not wipe the list — it is kept verbatim in `rejectedApps` and
  // written back by serializeDesktopsFile.
  .transform((record) => {
    const apps: DesktopAppRecord[] = [];
    const previous = (record as { rejectedApps?: unknown }).rejectedApps;
    const rejectedApps: unknown[] = Array.isArray(previous) ? [...previous] : [];
    for (const entry of record.apps) {
      const parsed = desktopAppRecordSchema.safeParse(entry);
      if (parsed.success) apps.push(parsed.data);
      else rejectedApps.push(entry);
    }
    return { ...record, apps, rejectedApps };
  });

export const recentLaunchSchema = z
  .object({
    command: z.string(),
    cwd: z.string(),
    env: z.record(z.string()).default({}),
    lastUsedAt: z.string()
  })
  .passthrough();

export type DesktopRecord = z.infer<typeof desktopRecordSchema>;
export type RecentLaunchRecord = z.infer<typeof recentLaunchSchema>;

/**
 * A read `desktops.json`, plus everything this build cannot use kept VERBATIM
 * so every rewrite puts it back unchanged (the saved-prompts pattern).
 */
export interface DesktopsFile {
  version: 1;
  desktops: DesktopRecord[];
  /** projectPath → launches, newest first. */
  recent: Record<string, RecentLaunchRecord[]>;
  /** projectPath → launch entries this build cannot read, kept verbatim and written back. */
  recentRejected?: Record<string, unknown[]>;
  /** `desktops` entries that failed the schema or duplicated an id, as found. */
  rejected: unknown[];
  /** Every top-level key but `version`, `desktops` and `recent`, as found. */
  extra: Record<string, unknown>;
}

export function createDefaultDesktopsFile(): DesktopsFile {
  return { version: 1, desktops: [], recent: {}, recentRejected: {}, rejected: [], extra: {} };
}

/**
 * Entry-wise tolerant. The OUTER shape still throws (a `version` other than 1
 * included): the daemon reads a throw as "not mine to rewrite" and quarantines
 * the file instead of writing an empty list over it.
 */
export function parseDesktopsFile(raw: unknown): DesktopsFile {
  const outer = z
    .object({
      version: z.literal(1).default(1),
      desktops: z.array(z.unknown()).default([]),
      recent: z.record(z.unknown()).catch({}).default({})
    })
    .safeParse(raw);
  if (!outer.success) {
    const issue = outer.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join(".") : "the file";
    throw new Error(`Not a version-1 desktops file (${where}: ${issue?.message ?? "invalid"})`);
  }
  const desktops: DesktopRecord[] = [];
  const rejected: unknown[] = [];
  const ids = new Set<string>();
  for (const entry of outer.data.desktops) {
    const parsed = desktopRecordSchema.safeParse(entry);
    if (parsed.success && !ids.has(parsed.data.id)) {
      ids.add(parsed.data.id);
      desktops.push(parsed.data);
    } else {
      rejected.push(entry);
    }
  }
  // `recent` is a convenience list: a `recent` that is not an object at all is
  // dropped (.catch above), but unreadable entries inside it are kept verbatim.
  const recent: Record<string, RecentLaunchRecord[]> = {};
  const recentRejected: Record<string, unknown[]> = {};
  for (const [projectPath, list] of Object.entries(outer.data.recent)) {
    if (!Array.isArray(list)) {
      recentRejected[projectPath] = [list];
      continue;
    }
    const launches: RecentLaunchRecord[] = [];
    for (const item of list) {
      const parsed = recentLaunchSchema.safeParse(item);
      if (parsed.success) launches.push(parsed.data);
      else (recentRejected[projectPath] ??= []).push(item);
    }
    if (launches.length > 0) recent[projectPath] = launches.slice(0, DESKTOP_MAX_RECENT_LAUNCHES);
  }
  const extra = Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      ([key]) => key !== "version" && key !== "desktops" && key !== "recent"
    )
  );
  return { version: 1, desktops, recent, recentRejected, rejected, extra };
}

/** The on-disk JSON for a DesktopsFile: live records first, then rejected ones. */
export function serializeDesktopsFile(file: DesktopsFile): Record<string, unknown> {
  const recent: Record<string, unknown[]> = { ...file.recent };
  for (const [projectPath, entries] of Object.entries(file.recentRejected ?? {})) {
    recent[projectPath] = [...(recent[projectPath] ?? []), ...entries];
  }
  return {
    ...file.extra,
    version: 1,
    desktops: [
      ...file.desktops.map(({ rejectedApps, ...record }) => ({
        ...record,
        apps: [...record.apps, ...(rejectedApps ?? [])]
      })),
      ...file.rejected
    ],
    recent
  };
}

export function createDefaultSessionsConfig(): SessionsConfig {
  return sessionsConfigSchema.parse({ sessions: [] });
}

/**
 * Entry-wise tolerant (the `parseRecentProjectsConfig` pattern, spec §5.2): a
 * record that fails its schema — a malformed `chat` block written by a newer
 * or a half-migrated bundle — drops that ONE session and the rest of the index
 * survives. The OUTER shape still throws, because `sessions.ts` reads a throw
 * here as "index unreadable, skip orphan reaping" and that caution is the
 * right answer to a truncated file.
 */
export function parseSessionsConfig(value: unknown): SessionsConfig {
  const outer = z
    .object({
      version: z.literal(1).default(1),
      sessions: z.array(z.unknown()).default([]),
      pendingThreadDeletes: z.array(z.unknown()).default([])
    })
    .parse(value);
  const sessions: SessionRecord[] = [];
  for (const entry of outer.sessions) {
    const parsed = sessionRecordSchema.safeParse(entry);
    if (parsed.success) {
      sessions.push(parsed.data);
    }
  }
  // Entry-wise tolerant too: a malformed id drops that one retry, never the
  // whole queue (and never the index).
  const pendingThreadDeletes = outer.pendingThreadDeletes.filter(
    (id): id is string => typeof id === "string" && id.length > 0
  );
  return { version: 1, sessions, pendingThreadDeletes };
}

// todos.json — the daemon's index of synced to-do lists. One record per list;
// the checklist body is GitHub task-list markdown. Scoped to a workspace
// (refKey = workspace name) or a project (refKey = project path).

export const todoScopeSchema = z.enum(["workspace", "project"]);

export const todoRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  scope: todoScopeSchema,
  refKey: z.string().min(1),
  body: z.string().default(""),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type TodoRecord = z.infer<typeof todoRecordSchema>;

export const todosConfigSchema = z.object({
  version: z.literal(1).default(1),
  todos: z.array(todoRecordSchema).default([])
});
export type TodosConfig = z.infer<typeof todosConfigSchema>;

export function parseTodosConfig(raw: unknown): TodosConfig {
  return todosConfigSchema.parse(raw);
}

// recent-projects.json — the daemon-owned "recently interacted with" list, so
// every client/device sees the same ordering instead of a per-browser one. The
// filesystem stays the source of truth for which projects exist; a stale entry
// (deleted/archived project) is dropped when the list is read.

export const recentProjectSchema = z.object({
  /** Project directory name. */
  name: z.string().min(1),
  /** Owning workspace directory name. */
  workspace: z.string().min(1),
  /** Absolute project path — the identity of the entry. */
  path: z.string().min(1),
  /** ISO-8601 instant; a malformed stamp drops just this entry (see below). */
  lastInteractedAt: z.string().datetime({ offset: true }),
  interactionCount: z.number().int().nonnegative().default(1)
});

export const recentProjectsConfigSchema = z.object({
  version: z.literal(1).default(1),
  projects: z.array(recentProjectSchema).default([])
});

export type RecentProject = z.infer<typeof recentProjectSchema>;
export type RecentProjectsConfig = z.infer<typeof recentProjectsConfigSchema>;

/** Newest first, capped — the list only ever grows by re-marking a project. */
export const MAX_RECENT_PROJECTS = 30;

export function createDefaultRecentProjectsConfig(): RecentProjectsConfig {
  return { version: 1, projects: [] };
}

/**
 * Tolerant read: a whole-file failure falls back to an empty list, and any
 * individual entry a pre-migration (or hand-edited) file got wrong is dropped
 * rather than taking the list — and the daemon boot — down with it.
 */
export function parseRecentProjectsConfig(raw: unknown): RecentProjectsConfig {
  const outer = z
    .object({ version: z.literal(1).default(1), projects: z.array(z.unknown()).default([]) })
    .safeParse(raw);
  if (!outer.success) {
    return createDefaultRecentProjectsConfig();
  }
  const projects: RecentProject[] = [];
  for (const entry of outer.data.projects) {
    const parsed = recentProjectSchema.safeParse(entry);
    if (parsed.success) {
      projects.push(parsed.data);
    }
  }
  return { version: 1, projects };
}

// saved-prompts.json — the right rail's prompt library (`SavedPrompt` in
// @orquester/api), global and per project, owned by the daemon so every client
// shares one list. The file's mere EXISTENCE is the "starter prompts were
// seeded" marker, so a user who deletes the starters never gets them back.

/**
 * `SavedPrompt.createdBy` in `@orquester/api`. Open on purpose (`kind` any string, unknown fields
 * passed through) so a newer build's value survives this build's rewrite verbatim; a kind other
 * than `agent` reads as the user's (fail closed: an agent's edit of it needs approval). `null`
 * reads as absent; a non-null value that is not even this shape makes its record unreadable —
 * kept verbatim in `rejected`, as any malformed record is.
 */
export const savedPromptCreatedBySchema = z
  .object({
    kind: z.string().min(1),
    /** The chat whose agent created it. */
    threadId: z.string().optional(),
    /** That chat's agent (`AgentAdapterId`), for the "by <agent>" badge. */
    agent: z.string().optional(),
    /** That chat's title when it created the prompt. */
    title: z.string().optional()
  })
  .passthrough();
export type SavedPromptCreatedByRecord = z.infer<typeof savedPromptCreatedBySchema>;

/** Whether a stored `createdBy` marks an agent-created prompt (anything else — absent, another kind — is the user's). */
export function isAgentCreatedPrompt(createdBy: SavedPromptCreatedByRecord | undefined): boolean {
  return createdBy?.kind === "agent";
}

/**
 * One stored prompt. Deliberately checks SHAPE, never the editor's limits
 * (title/body/tag lengths, the tag count): those are enforced when a prompt is
 * written, and a read that re-applied them would hide a prompt a build with
 * other limits stored. `passthrough` for the same reason: a field a newer build
 * added survives a rollback's rewrite. A record that fails this schema is not
 * lost either — the daemon writes it back verbatim (`rejected` below).
 *
 * **Any change to an existing field's TYPE or MEANING must bump the file
 * `version`.** A new field is safe (an older build passes it through), and a
 * record an older build cannot parse is kept untouched — but a record it CAN
 * parse under the old meaning would be served and rewritten wrongly. A bumped
 * version makes an older build quarantine the file instead (moved aside, never
 * written over).
 */
export const savedPromptRecordSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    description: z.string().default(""),
    body: z.string(),
    tags: z.array(z.string()).default([]),
    /** `null` = global; else the project directory's path as the client spells it. */
    projectPath: z.string().min(1).nullable().default(null),
    /** Repository scope added without replacing the original project path. */
    repoKey: z.string().min(1).nullable().optional(),
    pinned: z.boolean().default(false),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    lastUsedAt: z.string().datetime({ offset: true }).nullable().default(null),
    useCount: z.number().int().nonnegative().default(0),
    /**
     * Who created the prompt (`SavedPrompt.createdBy`, unified MCP design 2026-10-15 D-16). Absent
     * or `null`: the user (a `null` reads, and is rewritten, as absent). Any object of the open
     * {@link savedPromptCreatedBySchema} is kept verbatim; only a structurally invalid non-null
     * value (a string, a list, an object without `kind`) sets the record aside (`rejected`, kept
     * verbatim).
     */
    createdBy: z.preprocess((value) => (value === null ? undefined : value), savedPromptCreatedBySchema.optional())
  })
  .passthrough();

export type SavedPromptRecord = z.infer<typeof savedPromptRecordSchema>;

export interface SavedPromptsConfig {
  version: 1;
  prompts: SavedPromptRecord[];
}

/**
 * A read `saved-prompts.json`: the library, plus everything in the file this
 * build cannot use, kept VERBATIM so every rewrite puts it back unchanged — a
 * record in a newer shape must survive an older build's next write.
 */
export interface SavedPromptsFile extends SavedPromptsConfig {
  /**
   * The `prompts` entries not in `prompts`, exactly as found, in file order:
   * each one that fails the record schema, and each record whose id an earlier
   * one already has (a hand edit — the first record is the prompt).
   */
  rejected: unknown[];
  /** Every top-level key but `version` and `prompts`, exactly as found. */
  extra: Record<string, unknown>;
}

/**
 * Entry-wise tolerant (the `parseRecentProjectsConfig` pattern): a record that
 * fails its schema — hand-edited, or written by another bundle — is set aside
 * in `rejected` and the rest of the library loads. The OUTER shape still
 * throws, a `version` other than 1 included, because the daemon reads a throw
 * as "this file is not mine to rewrite": it moves the file aside rather than
 * writing an empty library over the user's prompts.
 */
export function parseSavedPromptsConfig(raw: unknown): SavedPromptsFile {
  const outer = z
    .object({ version: z.literal(1).default(1), prompts: z.array(z.unknown()).default([]) })
    .safeParse(raw);
  if (!outer.success) {
    const issue = outer.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join(".") : "the file";
    throw new Error(`Not a version-1 saved prompts file (${where}: ${issue?.message ?? "invalid"})`);
  }
  const prompts: SavedPromptRecord[] = [];
  const rejected: unknown[] = [];
  const ids = new Set<string>();
  for (const entry of outer.data.prompts) {
    const parsed = savedPromptRecordSchema.safeParse(entry);
    if (parsed.success && !ids.has(parsed.data.id)) {
      ids.add(parsed.data.id);
      prompts.push(parsed.data);
    } else {
      rejected.push(entry);
    }
  }
  // `fromEntries`, not assignment: a key such as `__proto__` stays an own key.
  const extra = Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(([key]) => key !== "version" && key !== "prompts")
  );
  return { version: 1, prompts, rejected, extra };
}

// push.json — Web Push state for the PWA: the daemon's VAPID keypair (lazily
// generated on first need) and the browsers subscribed to attention pushes.
// Lives at <appdir>/daemon/push.json, written 0600 — `vapid.privateKey` is
// secret material and is NEVER returned by any API.

export const pushConfigSchema = z.object({
  version: z.literal(1),
  vapid: z
    .object({ publicKey: z.string(), privateKey: z.string(), subject: z.string() })
    .nullable(),
  subscriptions: z.array(
    z.object({
      endpoint: z.string(),
      keys: z.object({ p256dh: z.string(), auth: z.string() }),
      createdAt: z.string(),
      userAgent: z.string().optional()
    })
  )
});

export type PushConfig = z.infer<typeof pushConfigSchema>;
export type PushSubscriptionRecord = PushConfig["subscriptions"][number];

export function createDefaultPushConfig(): PushConfig {
  return { version: 1, vapid: null, subscriptions: [] };
}

export function parsePushConfig(raw: unknown): PushConfig {
  return pushConfigSchema.parse(raw);
}

// ClientConfig — what the daemon reports about how to reach itself.

export const clientConfigSchema = z.object({
  version: z.literal(1).default(1),
  activeConnectionId: z.string().min(1).optional(),
  connections: z
    .array(z.discriminatedUnion("kind", [localConnectionSchema, remoteConnectionSchema]))
    .default([])
});

export type ClientConfig = z.infer<typeof clientConfigSchema>;
export type ConnectionConfig = ClientConfig["connections"][number];

export function createDefaultClientConfig(socketPath: string): ClientConfig {
  return parseClientConfig({
    version: 1,
    activeConnectionId: LOCAL_CONNECTION_ID,
    connections: [createLocalConnection(socketPath)]
  });
}

export function parseClientConfig(value: unknown): ClientConfig {
  return clientConfigSchema.parse(value);
}

/** Reject names that would escape the workspaces directory. */
export function isValidName(name: string | undefined): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    !name.startsWith(".") &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

// assertInsideFsRoot / FsSandboxError moved to ./fs.ts (node-only; see that file).

export * from "./workflows.ts";
export * from "./agent-tools.ts";
export * from "./session-profiles.ts";
export * from "./repo-identities.ts";
export * from "./secret-files.ts";
export * from "./boxes.ts";
export * from "./tooling.ts";
// boxes:
export * from "./box-mcp.ts";
