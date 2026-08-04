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

/** Cached token/cost scan (Claude JSONL + Codex sessions); 0600. */
export function usageTokensCacheFile(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "usage-tokens.json");
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
    chip: z.enum(["busiest", "claude", "codex"]).default("busiest")
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
   * Claude harness stream/API timeout, in minutes. Injected at session launch
   * for every claude-family launcher (claude/claudex/claudemix). 30 is Claude
   * Code's own hard clamp on the idle watchdogs (ODh = 1800000) — a larger
   * value is silently floored by the harness, so it is rejected here rather
   * than displayed as a number that does nothing.
   */
  claudeTimeoutMinutes: z.number().int().min(1).max(30).default(30)
});
export type AgentPrefs = z.infer<typeof agentPrefsSchema>;

// agent-accounts.json (managed per-agent accounts; daemon-side)

export const agentAccountSchema = z.object({
  id: z.string(),
  agent: z.enum(["claude", "codex"]),
  label: z.string(),
  email: z.string().nullable().default(null),
  plan: z.string().nullable().default(null),
  needsReauth: z.boolean().default(false),
  /** Once the CLIProxyAPI proxy holds a seeded copy of this account's OAuth
   *  credential, the proxy becomes its sole token refresher; the account service
   *  stops refreshing it (dual-refresher owner rule). Un-seeding clears this. */
  proxyOwned: z.boolean().optional(),
  createdAt: z.string(),
  importedAt: z.string()
});
export const agentAccountsSchema = z.object({
  accounts: z.array(agentAccountSchema).default([]),
  defaults: z
    .object({
      claude: z.string().nullable().default(null),
      codex: z.string().nullable().default(null)
    })
    .default({ claude: null, codex: null })
});
export type AgentAccountRecord = z.infer<typeof agentAccountSchema>;
export type AgentAccountsIndex = z.infer<typeof agentAccountsSchema>;

export function parseAgentAccounts(raw: unknown): AgentAccountsIndex {
  return agentAccountsSchema.parse(raw);
}
export function createDefaultAgentAccounts(): AgentAccountsIndex {
  return { accounts: [], defaults: { claude: null, codex: null } };
}
export function agentAccountsFile(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "agent-accounts.json");
}
export function agentAccountsDir(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "agent-accounts");
}
export function agentAccountHome(baseDir: string, agent: string, id: string): string {
  return joinPath(agentAccountsDir(baseDir), agent, id, "home");
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
  /** Git account this workspace is bound to (Phase 4); undefined = default identity. */
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
  // Effective per-launch model for claudex/claudemix sessions, persisted so a
  // reattach after a daemon restart keeps the tab pinned to the model it was
  // launched with. Optional: absent for every other launcher and pre-field records.
  model: z.string().optional()
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

// cliproxy — managed CLIProxyAPI service state, secrets, and on-disk layout.

/** Allowed characters for a model name (env writer, routes, wrapper `--model`). */
export const MODEL_NAME_RE = /^[A-Za-z0-9._/-]{1,128}$/;

/** Router-provider ids are lowercase slugs; `codex`/`claude` are the OAuth pair. */
export const ROUTER_PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const RESERVED_ROUTER_PROVIDER_IDS = ["codex", "claude"] as const;

export const routerModelSchema = z.object({
  name: z.string().regex(MODEL_NAME_RE),
  alias: z.string().regex(MODEL_NAME_RE).optional(),
  contextWindow: z.number().int().positive().optional(),
  compactWindow: z.number().int().positive().optional(),
  compactPct: z.number().int().min(1).max(100).optional()
});
export type RouterModel = z.infer<typeof routerModelSchema>;

export const routerProviderSchema = z.object({
  id: z.string().regex(ROUTER_PROVIDER_ID_RE),
  label: z.string().min(1).max(64),
  baseUrl: z
    .string()
    .max(512)
    .refine((u) => {
      try {
        const parsed = new URL(u);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    }, "baseUrl must be an http(s) URL"),
  /** Provenance of the create-form prefill only — behavior always comes from the fields. */
  preset: z.enum(["openrouter", "tokenrouter"]).nullable().default(null),
  models: z.array(routerModelSchema).default([]),
  keyVerifiedAt: z.string().nullable().default(null),
  createdAt: z.string()
});
export type RouterProvider = z.infer<typeof routerProviderSchema>;

/** Shipped presets: prefill the Settings create form; plain data afterwards. */
export const ROUTER_PRESETS: readonly {
  preset: "openrouter" | "tokenrouter";
  label: string;
  baseUrl: string;
  models: RouterModel[];
}[] = [
  {
    preset: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      { name: "moonshotai/kimi-k3", alias: "kimi-k3", contextWindow: 1_048_576, compactWindow: 450_000 }
    ]
  },
  {
    preset: "tokenrouter",
    label: "TokenRouter",
    baseUrl: "https://api.tokenrouter.com/v1",
    models: [{ name: "moonshotai/kimi-k3-free", contextWindow: 1_048_576, compactWindow: 450_000 }]
  }
];

/** Cross-provider invariants a single-record zod parse can't see. Returns an
 *  error message, or null when the array is coherent. */
export function validateRouterProviders(providers: RouterProvider[]): string | null {
  const ids = new Set<string>();
  const modelKeys = new Set<string>();
  for (const p of providers) {
    if ((RESERVED_ROUTER_PROVIDER_IDS as readonly string[]).includes(p.id)) {
      return `provider id "${p.id}" is reserved`;
    }
    if (ids.has(p.id)) return `duplicate provider id "${p.id}"`;
    ids.add(p.id);
    for (const m of p.models) {
      for (const key of m.alias ? [m.name, m.alias] : [m.name]) {
        // A router model may not shadow a curated (OAuth-account) model id:
        // resolveRouterModel is the single routing source of truth, so a router
        // model called `gpt-5.6-sol` would silently steal that pick — dropping
        // the acc<hex>/ account prefix, skipping the seeded-account launch gate,
        // and emitting a second config.yaml provider for the same model id.
        if (CURATED_PROXY_MODEL_IDS.includes(key)) {
          return `model "${key}" is a built-in model id and cannot be served by a router`;
        }
        if (modelKeys.has(key)) return `model "${key}" is served by more than one provider`;
        modelKeys.add(key);
      }
    }
  }
  return null;
}

/** Resolve a launch model (bare or acc<hex>/-prefixed, by full name or alias) to
 *  the router provider serving it. Null = not a router model. The single routing
 *  source of truth — it replaced a hardcoded kimi/moonshotai name regex. */
export function resolveRouterModel(
  providers: readonly RouterProvider[],
  model: string
): { providerId: string; provider: RouterProvider; model: RouterModel } | null {
  const bare = model.replace(/^acc[0-9a-fA-F]+\//, "");
  for (const provider of providers) {
    for (const m of provider.models) {
      if (m.name === bare || m.alias === bare) {
        return { providerId: provider.id, provider, model: m };
      }
    }
  }
  return null;
}

/** The id a router model is shown/keyed under (picker chips, overrides). */
export function routerModelDisplayId(m: RouterModel): string {
  return m.alias ?? m.name;
}

/** OpenRouter's dedicated key-info endpoint (precise 401 on a bad key). */
const OPENROUTER_KEY_INFO_URL = "https://openrouter.ai/api/v1/key";

/** True when a base URL actually points at openrouter.ai. */
export function isOpenRouterBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

/**
 * The endpoint a provider's key is verified against: OpenRouter's precise
 * `GET /key` only when the provider is the openrouter preset **and** its baseUrl
 * still points at openrouter.ai; everything else gets an authed
 * `GET {baseUrl}/models`.
 *
 * `preset` is provenance-only and survives a baseUrl edit (the Add-router form
 * lets a preset chip be edited into any gateway), so keying the openrouter.ai
 * endpoint off `preset` alone would transmit a third party's API key to
 * openrouter.ai and stamp `keyVerifiedAt` from a service that never saw the real
 * gateway. The host check is what makes the endpoint choice honest.
 */
export function routerKeyCheckUrl(provider: RouterProvider): string {
  if (provider.preset === "openrouter" && isOpenRouterBaseUrl(provider.baseUrl)) {
    return OPENROUTER_KEY_INFO_URL;
  }
  return `${provider.baseUrl.replace(/\/+$/, "")}/models`;
}

export interface CuratedProxyModel {
  id: string;
  /** Real backend context ceiling → CLAUDE_CODE_MAX_CONTEXT_TOKENS. */
  contextWindow: number;
  /** Proactive compaction window → CLAUDE_CODE_AUTO_COMPACT_WINDOW (default: contextWindow). */
  compactWindow?: number;
  /** Trigger percentage → CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (default: Claude Code's native formula). */
  compactPct?: number;
}

/**
 * The launcher-facing model picks (chips + settings dropdowns) for the OAuth
 * providers, WITH the measured compact metadata (spec
 * 2026-07-25-compact-parity-design.md §3.2). Windows are measured backend
 * ceilings, not marketing numbers. Router-served models are NOT listed here —
 * they come from the user's `routerProviders` (spec 2026-08-04 §1) and the
 * pickers union the two.
 *
 * The live catalog is the *validity* signal, not the menu: it enumerates every
 * model of every seeded account (plus acc-prefixed duplicates and image models),
 * which is noise as a picker. The UI intersects this curated list with the catalog.
 */
export const CURATED_PROXY_MODELS: readonly CuratedProxyModel[] = [
  { id: "gpt-5.6-sol", contextWindow: 200_000, compactPct: 75 },
  { id: "gpt-5.6-terra", contextWindow: 200_000, compactPct: 75 },
  { id: "gpt-5.6-luna", contextWindow: 200_000, compactPct: 75 }
];

export const CURATED_PROXY_MODEL_IDS: readonly string[] = CURATED_PROXY_MODELS.map((m) => m.id);

/**
 * Arming value for Claude-family ids: proactive auto-compaction is gated OFF on
 * non-first-party base URLs (claude-code #65585) unless AUTO_COMPACT_WINDOW is
 * set; Claude Code clamps the value to the model's believed window, so this
 * never shrinks anything — its only job is to defeat the gate.
 */
export const CLAUDE_ARMING_COMPACT_WINDOW = 1_048_576;

export const cliProxyModelOverridesSchema = z.record(
  z.object({
    contextWindow: z.number().int().positive().optional(),
    compactWindow: z.number().int().positive().optional(),
    compactPct: z.number().int().min(1).max(100).optional()
  })
);
export type CliProxyModelOverrides = z.infer<typeof cliProxyModelOverridesSchema>;

export interface CompactEnv {
  maxContextTokens?: number;
  autoCompactWindow: number;
  autoCompactPct?: number;
}

/**
 * Resolve the compact env for a launch model (spec §3.2): strip the acc<hex>/
 * routing prefix; `claude*` ids get the arming value only (native window
 * detection + native trigger formula do the rest); other ids resolve
 * override → router provider → curated → null (unknown ids stay reactive-only,
 * same as today).
 */
export function compactEnvForModel(
  model: string,
  overrides?: CliProxyModelOverrides,
  routerProviders?: readonly RouterProvider[]
): CompactEnv | null {
  const bare = model.replace(/^acc[0-9a-fA-F]+\//, "");
  if (bare.startsWith("claude")) {
    // Claude ids (bare or prefixed) get the arming value only. Never emit
    // MAX_CONTEXT_TOKENS for them: bare ids are natively recognized (no-op),
    // and prefixed ids are claude-family-classified just enough that Claude
    // Code REFUSES the override (verified live) while still window-defaulting
    // to 200k — the window fix for prefixed ids is the [1m] model suffix,
    // applied by cliproxyContributor, not an env override.
    const override = overrides?.[bare];
    const env: CompactEnv = {
      autoCompactWindow: override?.compactWindow ?? CLAUDE_ARMING_COMPACT_WINDOW
    };
    if (override?.compactPct !== undefined) env.autoCompactPct = override.compactPct;
    return env;
  }
  // A router model resolves identically by full name or alias (config.yaml maps
  // name → alias); overrides are keyed by the display id, falling back to the name.
  const routed = routerProviders ? resolveRouterModel(routerProviders, bare) : null;
  if (routed) {
    const override = overrides?.[routerModelDisplayId(routed.model)] ?? overrides?.[routed.model.name];
    const contextWindow = override?.contextWindow ?? routed.model.contextWindow;
    const compactWindow = override?.compactWindow ?? routed.model.compactWindow;
    // "window" and "compact at" are independent optional fields in the Routers
    // model editor. A compact window alone is still actionable — the claude
    // branch above emits exactly that — so don't silently discard it just
    // because the user left the context window blank.
    if (contextWindow === undefined && compactWindow === undefined) return null;
    const env: CompactEnv = {
      autoCompactWindow: compactWindow ?? (contextWindow as number)
    };
    if (contextWindow !== undefined) env.maxContextTokens = contextWindow;
    const pct = override?.compactPct ?? routed.model.compactPct;
    if (pct !== undefined) env.autoCompactPct = pct;
    return env;
  }
  const curated = CURATED_PROXY_MODELS.find((m) => m.id === bare);
  const override = overrides?.[bare];
  const contextWindow = override?.contextWindow ?? curated?.contextWindow;
  if (contextWindow === undefined) return null;
  const env: CompactEnv = {
    maxContextTokens: contextWindow,
    autoCompactWindow: override?.compactWindow ?? curated?.compactWindow ?? contextWindow
  };
  const pct = override?.compactPct ?? curated?.compactPct;
  if (pct !== undefined) env.autoCompactPct = pct;
  return env;
}

export const cliProxyStateSchema = z.object({
  enabled: z.boolean().default(false),
  version: z.string().nullable().default(null),
  versionSha256: z.string().nullable().default(null),
  goVersion: z.string().nullable().default(null),
  goSha256: z.string().nullable().default(null),
  defaultModel: z.string().default("gpt-5.6-sol"),
  /** Default model for the claudemix launcher (the Claude Fable main loop) when a
   *  launch names none. Distinct from `defaultModel` (claudex's Codex/GPT default)
   *  so a Codex-seeded setup never routes claudemix to GPT. */
  claudeDefaultModel: z.string().default("claude-fable-5"),
  backgroundModel: z.string().default("gpt-5.6-luna"),
  /** Last successful verification of the OpenRouter key against openrouter.ai
   *  (null = key never verified, or last verification attempt was inconclusive). */
  openRouterKeyVerifiedAt: z.string().nullable().default(null),
  /** Per-model compact-window overrides (spec §3.2); additive + defaulted. */
  modelOverrides: cliProxyModelOverridesSchema.default({}),
  port: z.number().int().default(8317),
  modelCatalog: z
    .object({ models: z.array(z.string()), asOf: z.string() })
    .nullable()
    .default(null),
  /**
   * Managed accounts seeded into the proxy's `auth/` dir, persisted so a daemon
   * restart rebuilds provider availability (and the launcher coupling) without a
   * re-seed. Only the routing-relevant projection is stored — never token material.
   */
  seededAccounts: z
    .array(
      z.object({
        provider: z.enum(["codex", "claude"]),
        accountId: z.string(),
        label: z.string(),
        prefix: z.string()
      })
    )
    .default([]),
  /** User-defined OpenAI-compatible router providers (spec 2026-08-04 §1). */
  routerProviders: z.array(routerProviderSchema).default([]),
  testedClaudeCliVersion: z.string().nullable().default(null)
});

export type CliProxyState = z.infer<typeof cliProxyStateSchema>;

export function createDefaultCliProxyState(): CliProxyState {
  return cliProxyStateSchema.parse({});
}

/** safeParse + default fallback: an unreadable state file must not brick the daemon. */
export function parseCliProxyState(raw: unknown): CliProxyState {
  const result = cliProxyStateSchema.safeParse(raw);
  return result.success ? result.data : createDefaultCliProxyState();
}

export const cliProxySecretsSchema = z.object({
  apiKey: z.string(),
  managementSecret: z.string(),
  /** LEGACY mirror of routerKeys["openrouter"] — kept at rest one release for
   *  rollback safety; never read after migration. */
  openRouterKey: z.string().nullable().default(null),
  /** providerId → API key for router providers. */
  routerKeys: z.record(z.string()).default({})
});

export type CliProxySecrets = z.infer<typeof cliProxySecretsSchema>;

/**
 * Fail-closed: a schema failure returns the literal `"corrupt"` rather than a
 * default. Callers MUST NOT regenerate on corruption (would orphan a live
 * proxy keyed on the old secret).
 */
export function parseCliProxySecrets(raw: unknown): CliProxySecrets | "corrupt" {
  const result = cliProxySecretsSchema.safeParse(raw);
  return result.success ? result.data : "corrupt";
}

/**
 * One-time legacy migration (spec §1): a pre-router `openRouterKey` becomes the
 * seeded `openrouter` provider + routerKeys entry, preserving today's exact kimi
 * wiring. The legacy fields are left in place as an at-rest mirror. Idempotent.
 */
export function migrateLegacyOpenRouter(
  state: CliProxyState,
  secrets: CliProxySecrets,
  nowIso: string
): { state: CliProxyState; secrets: CliProxySecrets; changed: boolean } {
  let changed = false;
  let nextSecrets = secrets;
  if (secrets.openRouterKey && !secrets.routerKeys["openrouter"]) {
    nextSecrets = {
      ...secrets,
      routerKeys: { ...secrets.routerKeys, openrouter: secrets.openRouterKey }
    };
    changed = true;
  }
  let nextState = state;
  if (
    nextSecrets.routerKeys["openrouter"] &&
    !state.routerProviders.some((p) => p.id === "openrouter")
  ) {
    const seeded: RouterProvider[] = [
      ...state.routerProviders,
      {
        id: "openrouter",
        label: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        preset: "openrouter",
        models: [
          {
            name: "moonshotai/kimi-k3",
            alias: "kimi-k3",
            contextWindow: 1_048_576,
            compactWindow: 450_000
          }
        ],
        keyVerifiedAt: state.openRouterKeyVerifiedAt,
        createdAt: nowIso
      }
    ];
    // Router CRUD works while the proxy is off, but this migration only runs on
    // init()/enable() — so a user who upgraded with the proxy disabled can have
    // already created a provider serving `kimi-k3`. Appending the seeded record
    // blindly would then persist the exact cross-provider collision
    // validateRouterProviders exists to prevent (and renderConfigYaml would emit
    // both). On conflict, skip the seed: the migrated key stays in routerKeys, so
    // nothing is lost and the user's own provider keeps serving the model.
    if (validateRouterProviders(seeded) === null) {
      nextState = { ...state, routerProviders: seeded };
      changed = true;
    }
  }
  return { state: nextState, secrets: nextSecrets, changed };
}

/** The managed CLIProxyAPI directory, given the daemon config directory. */
export function cliproxyDir(daemonDir: string): string {
  return joinPath(daemonDir, "cliproxy");
}
export function cliproxyStateFile(daemonDir: string): string {
  return joinPath(cliproxyDir(daemonDir), "state.json");
}
export function cliproxySecretsFile(daemonDir: string): string {
  return joinPath(cliproxyDir(daemonDir), "secrets.json");
}
export function cliproxyTokenFile(daemonDir: string): string {
  return joinPath(cliproxyDir(daemonDir), "token");
}
/** Per-registry-entry managed Claude home (shared config seeded in). */
export function cliproxyHomeDir(daemonDir: string, entryId: string): string {
  return joinPath(cliproxyDir(daemonDir), "claude-home-" + entryId);
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
