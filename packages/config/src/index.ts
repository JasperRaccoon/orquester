import { z } from "zod";

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
//     daemon/  daemon.json, daemon.sock, sessions.json, todos.json, logs/<yyyy-mm-dd>.log
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

export function appLogsDir(baseDir: string): string {
  return joinPath(appConfigDir(baseDir), "logs");
}

export function daemonLogsDir(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "logs");
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
 * and (per Phase 0's PrivateTmp=false) is reachable across daemon restarts.
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

export function todosIndexPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "todos.json");
}

/** Web Push state (VAPID keypair + browser subscriptions); 0600 — holds the private key. */
export function pushConfigPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "push.json");
}

/**
 * Orquester-owned TeamClaude toggle/settings mirror. Account OAuth material stays
 * in TeamClaude's own config (`~/.config/teamclaude.json`) — never duplicated here.
 * Written 0600 by the daemon.
 */
export function teamclaudeConfigPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "teamclaude.json");
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

export const usagePrefsSchema = z.object({
  /** Master switch for the top-bar usage widget (also gates daemon polling). */
  enabled: z.boolean().default(true),
  claude: z.boolean().default(true),
  codex: z.boolean().default(true),
  /** Which agent drives the collapsed chip. */
  chip: z.enum(["busiest", "claude", "codex"]).default("busiest"),
  /**
   * How to render multi-account Claude usage (TeamClaude): pooled aggregate bars
   * or a per-account breakdown.
   */
  view: z.enum(["aggregate", "accounts"]).default("aggregate")
});

export type UsagePrefs = z.infer<typeof usagePrefsSchema>;

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
  usage: usagePrefsSchema.default({})
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

// accounts.json (connected GitHub/git accounts; daemon-side).
//
// Each account owns a server-side ed25519 key (private key at `keyPath`, never
// returned by any API) and a git identity. A scoped GitHub PAT may also be
// persisted (for REST: list/create repos); like the private key it is stored at
// rest (`0600`) and NEVER returned by any API — clients only see `repoAccess`.

export const accountSchema = z.object({
  id: z.string(),
  /** User-facing label (e.g. "work", "personal"). */
  label: z.string().min(1),
  /** GitHub login the PAT authenticated as. */
  githubLogin: z.string(),
  /** `git config user.name` for this account (editable in the UI). */
  gitName: z.string(),
  /** `git config user.email` for this account (editable in the UI). */
  gitEmail: z.string(),
  /** OpenSSH public key (safe to expose). */
  publicKey: z.string(),
  /** Absolute path to the private key on the daemon host. NEVER exposed by any API. */
  keyPath: z.string(),
  /** Id of the key on GitHub (for later removal); absent if the upload id was unknown. */
  githubKeyId: z.number().optional(),
  /**
   * Scoped GitHub PAT for REST (list/create repos). Persisted at rest (`0600`);
   * NEVER exposed by any API / never crosses the wire — only
   * `AccountSummary.repoAccess` reflects its presence. On a bound workspace it
   * is additionally written to local 0600 files (a git-credentials store + gh
   * hosts.yml) so that workspace's terminals/agents can use HTTPS git + `gh`.
   * Absent until captured at connect-time or set via the token route.
   */
  token: z.string().optional(),
  createdAt: z.string()
});

export const accountsConfigSchema = z.object({
  version: z.literal(1).default(1),
  accounts: z.array(accountSchema).default([])
});

export type Account = z.infer<typeof accountSchema>;
export type AccountsConfig = z.infer<typeof accountsConfigSchema>;

export function createDefaultAccountsConfig(): AccountsConfig {
  return accountsConfigSchema.parse({ accounts: [] });
}

export function parseAccountsConfig(value: unknown): AccountsConfig {
  return accountsConfigSchema.parse(value);
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
  /** Git account this workspace is bound to (Phase 4); undefined = default identity. */
  gitAccountId: z.string().optional(),
  /** ISO timestamp the workspace was created through orquester. */
  createdAt: z.string()
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

// sessions.json — the daemon's index of live tmux-backed sessions, used to
// reattach PTYs after a restart. The tmux server is the source of truth for
// "is the command still running?"; this file remembers tab metadata (title /
// order / project) that tmux doesn't track.

export const sessionRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  order: z.number().int(),
  projectPath: z.string(),
  refId: z.string(),
  kind: z.enum(["shell", "agent", "ide", "file-explorer", "browser"]),
  cwd: z.string(),
  createdAt: z.string(),
  // Last known PTY size, persisted so a daemon restart reattaches each session at
  // its real size instead of the 80×24 default — otherwise a running full-screen
  // TUI (agent) repaints into a small corner until the client re-sends a resize.
  // Optional: records written before this field existed simply fall back.
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional()
});

export const sessionsConfigSchema = z.object({
  version: z.literal(1).default(1),
  sessions: z.array(sessionRecordSchema).default([])
});

export type SessionRecord = z.infer<typeof sessionRecordSchema>;
export type SessionsConfig = z.infer<typeof sessionsConfigSchema>;

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

export function createDefaultSessionsConfig(): SessionsConfig {
  return sessionsConfigSchema.parse({ sessions: [] });
}

export function parseSessionsConfig(value: unknown): SessionsConfig {
  return sessionsConfigSchema.parse(value);
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

export function createDefaultTodosConfig(): TodosConfig {
  return { version: 1, todos: [] };
}

export function parseTodosConfig(raw: unknown): TodosConfig {
  return todosConfigSchema.parse(raw);
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

// teamclaude.json — Orquester-side enablement of the TeamClaude multi-account
// proxy addon. Tokens live in TeamClaude's own config; this only stores whether
// Orquester should route Claude Code sessions through the local proxy and a few
// non-secret knobs mirrored into TeamClaude's config when changed.

export const teamclaudeStormRampSchema = z.object({
  enabled: z.boolean().default(true),
  startConc: z.coerce.number().int().min(1).default(1),
  stepConc: z.coerce.number().int().min(1).default(1),
  stepMs: z.coerce.number().int().min(1).default(250),
  windowMs: z.coerce.number().int().min(0).default(30000)
});

export const teamclaudeConfigSchema = z.object({
  version: z.literal(1).default(1),
  /** Master switch: when true, new Claude Code sessions launch via the proxy. */
  enabled: z.boolean().default(false),
  /** Local TeamClaude proxy port (default matches TeamClaude's 3456). */
  port: z.coerce.number().int().min(1).max(65535).default(3456),
  /** Quota utilization (0–1) at which TeamClaude rotates accounts. */
  switchThreshold: z.coerce.number().min(0).max(1).default(0.98),
  /** Background quotaprobe interval seconds (`0` = off). */
  quotaProbeSeconds: z.coerce.number().int().min(0).default(0),
  /** Keep-warm interval seconds (`0` = off). */
  warmupSeconds: z.coerce.number().int().min(0).default(0),
  autoUpdate: z.boolean().default(true),
  upstream: z.string().min(1).default("https://api.anthropic.com"),
  stormRamp: teamclaudeStormRampSchema.default({}),
  sxMode: z.enum(["always", "429", "off"]).default("off")
});

export type TeamClaudeConfig = z.infer<typeof teamclaudeConfigSchema>;

export function createDefaultTeamClaudeConfig(): TeamClaudeConfig {
  return teamclaudeConfigSchema.parse({});
}

export function parseTeamClaudeConfig(raw: unknown): TeamClaudeConfig {
  return teamclaudeConfigSchema.parse(raw);
}

export const teamclaudeSettingsUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    port: z.coerce.number().int().min(1).max(65535).optional(),
    switchThreshold: z.coerce.number().min(0).max(1).optional(),
    quotaProbeSeconds: z.coerce.number().int().min(0).optional(),
    warmupSeconds: z.coerce.number().int().min(0).optional(),
    autoUpdate: z.boolean().optional(),
    upstream: z.string().trim().min(1).optional(),
    stormRamp: teamclaudeStormRampSchema.partial().strict().optional(),
    sxMode: z.enum(["always", "429", "off"]).optional(),
    sxApiKey: z.string().optional()
  })
  .strict();

export type ParsedTeamClaudeSettingsUpdate = z.infer<typeof teamclaudeSettingsUpdateSchema>;

export function parseTeamClaudeSettingsUpdate(raw: unknown): ParsedTeamClaudeSettingsUpdate {
  return teamclaudeSettingsUpdateSchema.parse(raw);
}

// ClientConfig — what the daemon reports about how to reach itself.}

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
