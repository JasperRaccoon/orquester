import { useMemo } from "react";
import { create, type StoreApi } from "zustand";
import { ApiClient, ApiError } from "../lib/api-client";
import { createTransporter } from "../lib/transporters";
import { wakeSessionChannels } from "../lib/transporters/ws-session-channel";
import { wakeBrowserChannels } from "../lib/transporters/ws-browser-channel";
import { toRemoteConfig, toUiConnection } from "../lib/connections";
import {
  buildCredential,
  clearStoredHash,
  clearStoredUsername,
  deriveAuthHash,
  loadStoredHash,
  loadStoredUsername,
  storeHash,
  storeUsername
} from "../lib/auth";
import { loadViewModes, saveViewModes, type ViewMode } from "../lib/view-mode";
import { loadPreferredAccounts, savePreferredAccounts } from "../lib/preferred-account";
import { loadPreferredModels, savePreferredModels } from "../lib/preferred-model";
import {
  clampTerminalFontSize,
  loadTerminalFontSize,
  saveTerminalFontSize
} from "../lib/terminal-font";
import {
  loadThemePrefs,
  resolveMode,
  saveThemePrefs,
  type ColorScheme,
  type ResolvedMode,
  type ThemeMode
} from "../lib/theme";
import {
  clampPaneSize,
  clampSidebarWidth,
  loadGridTracks,
  loadPaneSizes,
  loadSidebarWidth,
  normalizeGridTracks,
  persistGridTracks,
  persistGridTracksReset,
  persistPaneSize,
  persistPaneSizeReset,
  saveGridTracks,
  savePaneSizes,
  saveSidebarWidth,
  SIDEBAR_DEFAULT,
  type GridTracks,
  type PaneSizeKey,
  type PaneSizes
} from "../lib/panel-sizes";
import { normalizeAgentPrefs, normalizeUsagePrefs, type AppConfigAdapter } from "../lib/app-config";
import { ProjectSetupError } from "../lib/project-setup-error";
import { invalidateProjectIndex } from "../lib/project-index";
import type { HttpClient } from "../lib/http-client";
import type { Transporter } from "../lib/transporter";
import { workspaceService } from "../services";
import type {
  AccountSummary,
  AccountTestResult,
  ConnectionStatus,
  CreateAccountRequest,
  CreateProjectRequest,
  EventMessage,
  OwnerSummary,
  ProjectSummary,
  RegistryEntry,
  RegistryKind,
  RegistryResponse,
  RepoSummary,
  SessionSummary,
  UiConnection,
  WorkspaceSummary
} from "../types";
import type {
  AgentAccountsResponse,
  AgentConversationSummary,
  BrowserSummary,
  CliProxyMutationRefusal,
  CliProxyProviderStatus,
  CliProxyRouterProviderRequest,
  CliProxySeedRequest,
  CliProxyStatus,
  CliProxyUnseedRequest,
  RecentProjectSummary,
  SessionActivity,
  SessionActivityEvent,
  TodoListRecord,
  TodoScope,
  UsageResponse,
  UsageTokensResponse
} from "@orquester/api";
import type { AgentPrefs, UsagePrefs } from "@orquester/config";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Pending reconnect-backoff waits that a wake (tab visible/online) short-circuits. */
let wakeWaiters: Array<() => void> = [];

/**
 * Like {@link delay}, but resolves early when {@link wakeReconnectWaiters} fires.
 * Used for reconnect backoff only: a hidden tab's setTimeout is throttled/frozen,
 * so on tab return the wake path must be able to retry NOW instead of waiting
 * out a thawed backoff timer.
 */
const wakeableDelay = (ms: number) =>
  new Promise<void>((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      wakeWaiters = wakeWaiters.filter((w) => w !== wake);
      resolve();
    }, ms);
    wakeWaiters.push(wake);
  });

/** Short-circuit every pending {@link wakeableDelay}. */
function wakeReconnectWaiters(): void {
  const waiters = wakeWaiters;
  wakeWaiters = [];
  for (const wake of waiters) {
    wake();
  }
}

/**
 * When the last /events line (any event or the daemon's 15s heartbeat) arrived.
 * A frozen tab's dead stream may never error (silent stall), so staleness — not
 * just onEnd — must count as a disconnect signal.
 */
let lastEventAt = 0;
/** /events heartbeats every 15s; three misses ⇒ the stream is dead. */
const EVENTS_STALE_MS = 45_000;

/** Last wakeConnections run — visibilitychange/pageshow/focus/online fire together. */
let lastWakeAt = 0;

const EMPTY_REGISTRY: RegistryResponse = {
  shells: [],
  agents: [],
  ides: [],
  fileExplorers: [],
  browsers: []
};

const DEFAULT_USAGE_PREFS: UsagePrefs = {
  enabled: true,
  agents: {},
  chip: "busiest"
};

const DEFAULT_AGENT_PREFS: AgentPrefs = { claudeTimeoutMinutes: 30 };

/**
 * Stable empty pane-sizes object for the {@link usePaneSizes} fallback. A fresh
 * `{}` per render would change the zustand snapshot identity every time and loop
 * React (the #185 trap documented on {@link useCurrentContext}); this shared
 * frozen ref keeps the selector referentially stable when a project has no
 * stored sizes.
 */
const EMPTY_PANE_SIZES: PaneSizes = Object.freeze({});

/**
 * Forget the cached conversation list for one project. Deleting the key (rather
 * than writing `[]`) restores the "never fetched" state, so the next consumer
 * shows a loading state and re-scans instead of rendering a stale empty list.
 */
function dropConversationCache(
  cache: Record<string, AgentConversationSummary[]>,
  projectPath: string
): Record<string, AgentConversationSummary[]> {
  if (!projectPath || !(projectPath in cache)) {
    return cache;
  }
  const next = { ...cache };
  delete next[projectPath];
  return next;
}

/**
 * In-flight `loadAgentConversations` scans, keyed by project path. The scan is
 * ~1s of daemon work and several surfaces ask for the same project in the same
 * frame (the overview plus one section per agent in the "+" menu), so they share
 * one promise instead of stampeding the daemon.
 */
const conversationScans = new Map<string, Promise<AgentConversationSummary[]>>();

/**
 * Is this recents row behind the archive curtain? `isArchived` is absent on
 * daemons predating the field, which means "not archived" (the daemon-side
 * default), so the fallback is deliberately permissive.
 */
export function isArchivedRecent(recent: RecentProjectSummary): boolean {
  return recent.isArchived === true;
}

/** Replace a registry entry (matched by id within its kind) with a fresh copy. */
function applyRegistryEntry(registry: RegistryResponse, entry: RegistryEntry): RegistryResponse {
  const key = (
    {
      shell: "shells",
      agent: "agents",
      ide: "ides",
      "file-explorer": "fileExplorers",
      browser: "browsers"
    } as const
  )[entry.kind];
  const list = registry[key];
  const index = list.findIndex((e) => e.id === entry.id);
  const next = index === -1 ? [...list, entry] : list.map((e) => (e.id === entry.id ? entry : e));
  return { ...registry, [key]: next };
}

/** Module-level handle so we can drop the events subscription on reconnect. */
let eventsUnsubscribe: (() => void) | null = null;
/** Generation guard so a stale events stream's onEnd doesn't trigger reconnect. */
let eventsGen = 0;
/** Periodic health probe that detects a dropped/restarted transport. */
let healthTimer: ReturnType<typeof setInterval> | null = null;
/** Pending delayed reconnect (e.g. after a 429 lockout); cleared before re-arming. */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** Guards against overlapping reconnect loops. */
let reconnecting = false;
/**
 * Generation guard for the reconnect flow, mirroring {@link eventsGen}. Every
 * reconnect path (the backoff loop, the locked-reconnect path, and the
 * reconnect-driven branch of establish) captures the current value and bails
 * after each `await` if it changed. Bumped by stopReconnect/connect/
 * scheduleLockedReconnect so a new flow preempts any old loop suspended on an
 * untracked `delay()` timer (whose setTimeout we cannot clear directly).
 */
let reconnectGen = 0;
/** Consecutive 429 lockout cycles; resets on any successful connect. */
let lockedCycles = 0;

/** After this many back-to-back lockouts, stop auto-polling and let the user act. */
const MAX_LOCKED_CYCLES = 4;
/** Base delay (ms) for the locked-cycle exponential fallback (no Retry-After). */
const LOCKED_FALLBACK_BASE_MS = 8000;
/** Cap (ms) for the locked-cycle exponential fallback. */
const LOCKED_FALLBACK_CAP_MS = 120000;

/** Capped exponential backoff (ms) for reconnect attempt N (1-based). */
function backoffMs(attempt: number): number {
  return Math.min(attempt * 1000, 8000);
}

/**
 * Capped exponential fallback (ms) for the Nth consecutive locked cycle
 * (0-based) when a 429 carries no Retry-After. Avoids an unbounded fixed 8s
 * poll: `min(base * 2 ** n, cap)`.
 */
function lockedFallbackMs(cycle: number): number {
  return Math.min(LOCKED_FALLBACK_BASE_MS * 2 ** cycle, LOCKED_FALLBACK_CAP_MS);
}

function stopHealthProbe(): void {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

/** Clear any pending delayed reconnect so timers never stack. */
function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

/**
 * Tear down every reconnect mechanism (probe, loop, pending timer). Bumping
 * reconnectGen preempts any loop/establish suspended on an untracked delay() so
 * it returns instead of resuming a now-stale flow.
 */
function stopReconnect(): void {
  stopHealthProbe();
  clearReconnectTimer();
  reconnecting = false;
  reconnectGen += 1;
}

/**
 * Enter the rate-limited (429) state: surface a clear locked message + the
 * lockout deadline, then schedule a SINGLE delayed reconnect after Retry-After
 * (or a capped exponential fallback). Tears down probes/timers first so backoffs
 * never stack and we never tight-loop on the 429.
 *
 * Guards against an unbounded locked cycle (scheduleLockedReconnect →
 * handleDisconnect → establish → 429 → …): consecutive cycles grow the fallback
 * exponentially, and after {@link MAX_LOCKED_CYCLES} we STOP auto-polling and
 * drop to a terminal state (re-prompt credentials + a Retry affordance) so a
 * client with a wrong stored credential isn't stuck cycling forever.
 *
 * Bumps reconnectGen (mirroring stopReconnect) so any loop/establish suspended
 * on an untracked delay() is preempted rather than resuming into a stale flow.
 */
function scheduleLockedReconnect(
  get: StoreApi<AppState>["getState"],
  set: StoreApi<AppState>["setState"],
  retryAfterSeconds: number | null
): void {
  stopHealthProbe();
  clearReconnectTimer();
  reconnecting = false;
  reconnectGen += 1;

  const cycle = lockedCycles;
  lockedCycles += 1;

  // Too many back-to-back lockouts: stop polling and drop to a terminal state so
  // a client with a wrong stored credential isn't stuck cycling forever. When
  // auth is in play, re-prompt (AuthModal); otherwise leave authPrompt cleared so
  // the ConnectionStatusToast's Retry button is the escape hatch. Both paths run
  // connect() (resetting lockedCycles) on the user's next action. lockedUntil is
  // cleared because nothing is scheduled to fire.
  if (cycle >= MAX_LOCKED_CYCLES) {
    const api = get().api;
    const authInPlay = get().authSalt != null && api != null;
    set({
      connectionStatus: "error",
      reconnectAttempt: 0,
      connectionError: authInPlay
        ? "Too many attempts — locked out. Re-enter your credentials to retry."
        : "Too many attempts — locked out. Press Retry to try again.",
      lockedUntil: null,
      authPrompt: authInPlay ? { connectionId: api.connection.id } : get().authPrompt
    });
    return;
  }

  // Honor Retry-After; otherwise grow the fallback exponentially (capped) so a
  // 429 without a header doesn't degenerate into a flat fixed-interval poll.
  const seconds = retryAfterSeconds ?? Math.round(lockedFallbackMs(cycle) / 1000);
  set({
    connectionStatus: "error",
    reconnectAttempt: 0,
    connectionError: `Too many attempts — locked out, retry in ${seconds}s.`,
    lockedUntil: Date.now() + seconds * 1000
  });
  const gen = reconnectGen;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (gen === reconnectGen && get().api) {
      get().handleDisconnect();
    }
  }, seconds * 1000);
}

/** Intentionally drop the events subscription (bumps gen so its onEnd is ignored). */
function closeEvents(): void {
  eventsGen += 1;
  eventsUnsubscribe?.();
  eventsUnsubscribe = null;
}

/** Host-provided connection wiring, set once via initConnections(). */
interface ConnectionSetup {
  localConnection: UiConnection;
  /** Injected transport for the local connection (desktop unix socket). */
  localTransporter?: Transporter;
  /** Custom HTTP client for remote transporters (rarely needed). */
  httpClient?: HttpClient;
  /**
   * App-config persistence. Web injects a localStorage adapter; desktop omits
   * it, so app config is read/written on the daemon (app.json), while remotes
   * always live on the daemon (shared).
   */
  appConfigAdapter?: AppConfigAdapter;
  /** Fallback for useTitlebar when app config doesn't specify it. */
  defaultUseTitlebar: boolean;
}

let setup: ConnectionSetup | null = null;

/**
 * The "home" daemon (the initial/local connection). App config and the remote
 * server list are persisted here so every client of this daemon shares them,
 * independent of which connection is currently active.
 */
let homeApi: ApiClient | null = null;

export interface UiAppConfig {
  useTitlebar: boolean;
  runInBackground: boolean;
  confirmCloseSession: boolean;
  usage: UsagePrefs;
  agents: AgentPrefs;
}

/** Persist the remote-server list to the home daemon (shared across clients). */
async function persistRemotes(connections: UiConnection[]): Promise<void> {
  await homeApi
    ?.saveRemotes(connections.filter((c) => c.kind === "remote").map(toRemoteConfig))
    .catch(() => undefined);
}

/** Rebuild an ApiClient for the same connection but with a bearer credential. */
function apiWithCredential(api: ApiClient, credential: string): ApiClient {
  const connection: UiConnection = { ...api.connection, password: credential };
  return new ApiClient(connection, buildTransporter(connection));
}

/** Build the transporter for a connection: local uses the injected one. */
function buildTransporter(connection: UiConnection): Transporter {
  if (setup && connection.id === setup.localConnection.id && setup.localTransporter) {
    return setup.localTransporter;
  }
  return createTransporter(connection, { httpClient: setup?.httpClient });
}

/** A client-local, non-PTY tab (e.g. the file browser). */
export interface FileTab {
  id: string;
  projectPath: string;
  title: string;
}

/** A client-local Git tab (GitHub-Desktop-style), one per project. */
export interface GitTab {
  id: string;
  projectPath: string;
  title: string;
}

/** A client-local to-do tab. Bound to a TodoListRecord by `todoId`; `title` mirrors
 *  the record's name (kept in sync by the todo.* event handler + rename). */
export interface TodoTab {
  id: string;         // tab id
  contextKey: string; // project path or workspace name (the map key)
  todoId: string;
  title: string;
}

/** A tab in the current project: a daemon session or a local tool tab. */
export type ProjectTab =
  | { id: string; type: "session"; session: SessionSummary }
  | { id: string; type: "files"; title: string }
  | { id: string; type: "git"; title: string }
  | { id: string; type: "todo"; todoId: string; title: string }
  | { id: string; type: "browser"; browser: BrowserSummary };

/** What the tab strip + MainView are showing. A project (full tab set) or a
 *  workspace (to-do tabs only). The `key` is the map key for all per-context tab state:
 *  project path (never collides with) workspace name (names have no "/"; paths are absolute). */
export type TabContext =
  | { kind: "project"; key: string; project: ProjectSummary }
  | { kind: "workspace"; key: string; workspace: string };

/** Resolve the active context from navigation. Project wins when both are set. */
export function currentContext(state: Pick<AppState, "currentProject" | "currentWorkspace">): TabContext | null {
  if (state.currentProject) {
    return { kind: "project", key: state.currentProject.path, project: state.currentProject };
  }
  if (state.currentWorkspace) {
    return { kind: "workspace", key: state.currentWorkspace, workspace: state.currentWorkspace };
  }
  return null;
}

/** The (scope, refKey) a to-do list gets in a given context. */
export function todoRefOf(ctx: TabContext): { scope: TodoScope; refKey: string } {
  return ctx.kind === "project"
    ? { scope: "project", refKey: ctx.key }
    : { scope: "workspace", refKey: ctx.key };
}

// Monotonic sequence bumped on every "session.activity" event. `loadSessions`
// snapshots the counter before its (awaited) fetch, then refuses to let the
// snapshot overwrite any activity entry an event freshened *while the fetch was
// in flight* — otherwise a "needs your input" dot that arrived mid-fetch would
// revert to the older listSessions state until the next event. Module-level (the
// store is a singleton) and read at set-time, so overlapping loadSessions calls
// each compare against their own start marker and race safely.
let activityEventSeq = 0;
const activityEventSeqById = new Map<string, number>();

function bumpActivityEventSeq(id: string): number {
  activityEventSeq += 1;
  activityEventSeqById.set(id, activityEventSeq);
  return activityEventSeq;
}

/** Drop a session's activity entry (returns the same ref when absent → no-op set). */
function dropActivity(
  activityById: Record<string, SessionActivity>,
  id: string
): Record<string, SessionActivity> {
  // A session id is a UUID (never reused), so a leftover seq entry can't cause a
  // false "keep" later; we prune here only to bound the map's growth.
  activityEventSeqById.delete(id);
  if (!(id in activityById)) {
    return activityById;
  }
  const next = { ...activityById };
  delete next[id];
  return next;
}

function upsertSession(sessions: SessionSummary[], next: SessionSummary): SessionSummary[] {
  const index = sessions.findIndex((s) => s.id === next.id);
  if (index === -1) {
    return [...sessions, next];
  }
  const copy = [...sessions];
  copy[index] = { ...copy[index], ...next };
  return copy;
}

function upsertBrowser(browsers: BrowserSummary[], browser: BrowserSummary): BrowserSummary[] {
  const at = browsers.findIndex((b) => b.id === browser.id);
  if (at === -1) return [...browsers, browser];
  const next = browsers.slice();
  next[at] = browser;
  return next;
}

/** Replace a to-do record by id (or append if new). */
function upsertTodo(todos: TodoListRecord[], next: TodoListRecord): TodoListRecord[] {
  const index = todos.findIndex((t) => t.id === next.id);
  if (index === -1) {
    return [...todos, next];
  }
  const copy = [...todos];
  copy[index] = next;
  return copy;
}

/** Retitle any open to-do tab bound to `todoId` (across every context). */
function renameTodoTabs(
  todoTabsByContext: Record<string, TodoTab[]>,
  todoId: string,
  title: string
): Record<string, TodoTab[]> {
  let changed = false;
  const next: Record<string, TodoTab[]> = {};
  for (const [key, tabs] of Object.entries(todoTabsByContext)) {
    const hit = tabs.some((t) => t.todoId === todoId && t.title !== title);
    next[key] = hit ? tabs.map((t) => (t.todoId === todoId ? { ...t, title } : t)) : tabs;
    if (hit) changed = true;
  }
  // Preserve object/array identity when nothing actually changed, so useProjectTabs' memo
  // doesn't recompute on todo events for lists with no matching open tab (the common case).
  return changed ? next : todoTabsByContext;
}

export interface AppState {
  api: ApiClient | null;
  connectionStatus: ConnectionStatus;
  /** >0 while auto-reconnecting (drives the "Reconnecting… attempt N" toast). */
  reconnectAttempt: number;
  /** Human-readable reason for an errored/locked connection (UI message). */
  connectionError: string | null;
  /** Epoch ms until which we're rate-limited (429); reconnect waits past this. */
  lockedUntil: number | null;

  // connections (local daemon + user-added remotes)
  connections: UiConnection[];
  activeConnectionId: string | null;

  // app config + settings modal
  appConfig: UiAppConfig;
  settingsOpen: boolean;
  /** Tab id awaiting a close-confirm prompt (null = no prompt open). */
  pendingCloseTabId: string | null;
  /** Mobile off-canvas sidebar drawer. */
  sidebarDrawerOpen: boolean;

  // auth (web → password-protected HTTP daemon)
  authPrompt: { connectionId: string } | null;
  authSalt: string | null;
  /** Whether the active connection's auth needs a username (UI hint). */
  authRequiresUsername: boolean;

  // navigation
  currentWorkspace: string | null;
  currentProject: ProjectSummary | null;

  // data
  registry: RegistryResponse;
  usage: UsageResponse | null;
  usageTokens: UsageTokensResponse | null;
  agentAccounts: AgentAccountsResponse | null;
  /** Managed model-proxy status (claudex/claudemix backing), or null before first load. */
  cliproxy: CliProxyStatus | null;
  /** The proxy's live model catalog + its snapshot time, or null before first load. */
  cliproxyModels: { models: string[]; asOf: string | null } | null;
  workspaces: WorkspaceSummary[];
  /** "Protect archived data" daemon flag (UI curtain; loaded on connect). */
  protectArchived: boolean;
  /**
   * Whether `protectArchived` reflects a value actually read from this daemon.
   * False while the connect-time fetch is in flight and after a failed fetch —
   * consumers must treat "not yet known" as protected (fail closed) rather than
   * as off, and may re-run `loadProtectArchived()` to self-heal.
   */
  protectArchivedLoaded: boolean;
  accounts: AccountSummary[];
  workspacesLoading: boolean;
  projects: ProjectSummary[];
  projectsLoading: boolean;
  /** Daemon-owned recent-projects list (newest first); live via `recentProjects.changed`. */
  recentProjects: RecentProjectSummary[];
  /**
   * Past agent conversations per project path. A missing key means "never
   * fetched" (the scan is ~1s, so consumers render a loading state for it); an
   * empty array means "fetched, none". Invalidated when a session is opened or
   * closed in that project.
   */
  agentConversationsByProject: Record<string, AgentConversationSummary[]>;

  /** All daemon sessions; a project's sessions are its tabs. */
  sessions: SessionSummary[];
  /** All server-side browser tabs; a project's browsers are its tabs (after sessions). */
  browsers: BrowserSummary[];
  /** Client-derived working/idle + attention per session id (drives the status dot). */
  activityById: Record<string, SessionActivity>;
  /**
   * Transient launch-time notice: models a just-launched claudex/claudemix
   * session referenced but the live proxy catalog lacked
   * (SessionSummary.missingModels — a create-response-only snapshot). Advisory,
   * dismissible, never persisted; cleared on dismiss or the next launch.
   */
  modelWarning: { title: string; models: string[] } | null;
  /**
   * Transient notice for a refused resume: the daemon answered
   * `RESUME_UNAVAILABLE` (the conversation id is unusable, or this agent has no
   * resume flag), so NO session was created. Carries what's needed to offer a
   * fresh session instead. Advisory, dismissible, never persisted.
   */
  resumeError: {
    agentId: string;
    agentName: string;
    message: string;
    /**
     * The exact launch parameters of the refused attempt. "Start fresh" replays
     * them (same identity, same project) instead of inheriting whatever happens
     * to be current when the user clicks — a resume refused in project A must
     * not silently open a session in project B.
     */
    accountId?: string;
    model?: string;
    projectPath: string;
  } | null;
  /**
   * Transient after-the-fact notice with no action of its own (e.g. "the
   * project was created, but its setup command could not be started"). Rendered
   * by the shared toast stack; advisory, dismissible, never persisted.
   */
  notice: { title?: string; message: string } | null;
  /** Client-local tool tabs (file browser) per project path. */
  fileTabsByProject: Record<string, FileTab[]>;
  /** Client-local Git tabs (GitHub-Desktop-style) per project path. */
  gitTabsByProject: Record<string, GitTab[]>;
  /** Client-local to-do tabs per context key (project path *or* workspace name). */
  todoTabsByContext: Record<string, TodoTab[]>;
  /** Server cache of to-do records (all loaded scopes/refs). */
  todos: TodoListRecord[];
  /**
   * Client-local active tab id per **context key** — a project path *or* a
   * workspace name (they can't collide: paths are absolute, names have no "/").
   */
  activeTabByProject: Record<string, string | null>;
  /** Per-project layout choice (tab view vs grid view); persisted client-side. */
  viewModeByProject: Record<string, ViewMode>;
  /** Last account chosen per agent in the launcher (client-local, persisted). */
  preferredAccountByAgent: Record<string, string>;
  /** Last backing model chosen per agent (claudex/claudemix) in the launcher (client-local, persisted). */
  preferredModelByAgent: Record<string, string>;
  /** Global terminal font size (px); persisted client-side, per device. */
  terminalFontSize: number;
  /** Colour scheme; persisted client-side, per device. See lib/theme.ts. */
  colorScheme: ColorScheme;
  /** Light/dark preference (may be "system"/"dynamic"); persisted client-side. */
  themeMode: ThemeMode;
  /** {@link themeMode} collapsed to the two values the CSS knows. Not persisted. */
  resolvedMode: ResolvedMode;
  /** Global sidebar width (px); persisted client-side, per device. */
  sidebarWidth: number;
  /** Per-project pane-split widths (px); persisted client-side, per device. */
  paneSizesByProject: Record<string, PaneSizes>;
  /** Per-project grid-view track fraction weights; persisted client-side, per device. */
  gridTracksByProject: Record<string, GridTracks>;

  setApi: (api: ApiClient) => void;
  connect: () => Promise<void>;
  /** Establish a connected session on an ApiClient (auth, load, subscribe, probe). */
  establish: (api: ApiClient) => Promise<void>;
  /** Called when the transport drops; runs the reconnect loop. */
  handleDisconnect: () => void;
  /**
   * The page regained visibility/focus/network (tab return, PWA resume, radio
   * back). Mobile browsers freeze hidden tabs and kill their connections, so
   * every timer-driven recovery path stalls until now — probe/short-circuit
   * everything immediately instead of waiting for thawed backoff timers.
   */
  wakeConnections: () => void;

  // connection management
  initConnections: (setup: ConnectionSetup) => Promise<void>;
  selectConnection: (id: string) => Promise<void>;
  addRemote: (input: { name: string; baseUrl: string }) => Promise<string>;
  removeRemote: (id: string) => Promise<void>;
  loadRemotes: () => Promise<void>;

  // git accounts (daemon-persisted; shared across clients of this daemon)
  loadAccounts: () => Promise<void>;
  /** Connect a provider account (GitHub PAT, Bitbucket Cloud/DC token). */
  addAccount: (input: CreateAccountRequest) => Promise<AccountSummary>;
  removeAccount: (id: string) => Promise<void>;
  testAccount: (id: string) => Promise<AccountTestResult>;
  /** Repos the account can reach (for the clone picker). */
  listRepos: (accountId: string) => Promise<RepoSummary[]>;
  /** Owners the account can create repos under (for the create-owner picker). */
  listOwners: (accountId: string) => Promise<OwnerSummary[]>;
  /**
   * Persist a token (enables repo access); refetches accounts so repoAccess
   * flips. `tokenExpiresAt` is user-entered (Bitbucket tokens always expire).
   */
  setAccountToken: (accountId: string, token: string, tokenExpiresAt?: string) => Promise<void>;
  /** Bitbucket DC manual-key flow: verify the pasted key landed; refetches accounts. */
  confirmAccountKey: (accountId: string) => Promise<void>;

  // app config + settings
  loadAppConfig: () => Promise<void>;
  setSettingsOpen: (open: boolean) => void;
  setSidebarDrawer: (open: boolean) => void;
  updateAppConfig: (patch: Partial<UiAppConfig>) => Promise<void>;
  /** Read `appConfig.agents` from the connected daemon (see updateAgentPrefs). */
  loadAgentPrefs: () => Promise<void>;
  /** Persist `appConfig.agents` to the connected daemon (see updateAgentPrefs). */
  updateAgentPrefs: (next: AgentPrefs) => Promise<void>;

  // auth
  submitCredentials: (username: string, password: string) => Promise<void>;
  signOut: () => void;

  loadWorkspaces: () => Promise<void>;
  createWorkspace: (name: string, gitAccountId?: string) => Promise<void>;
  deleteWorkspace: (name: string) => Promise<void>;
  openWorkspace: (name: string) => Promise<void>;
  closeWorkspace: () => void;

  loadProjects: () => Promise<void>;
  createProject: (req: CreateProjectRequest) => Promise<void>;
  /**
   * Create the project, open it, then TYPE `command` into a fresh shell tab in
   * its directory. The scaffolder/clone runs in front of the user (interactive
   * prompts included) — the daemon never executes it.
   */
  createProjectWithCommand: (req: CreateProjectRequest, command: string) => Promise<void>;
  deleteProject: (project: ProjectSummary) => Promise<void>;
  openProject: (project: ProjectSummary) => void;
  /** Fetch the daemon-owned recent-projects list into the store. */
  loadRecentProjects: () => Promise<void>;
  /**
   * Record an interaction with `project` (defaults to the current one). The
   * single choke point every navigation path funnels through — fire-and-forget,
   * never blocks or fails a navigation.
   */
  markProjectInteracted: (project?: ProjectSummary | { path: string }) => void;
  /** Navigate to a recent entry: select its workspace, then open the project. */
  openRecentProject: (recent: RecentProjectSummary) => Promise<void>;
  /** Cached per project; pass `force` to bypass the cache (e.g. a manual refresh). */
  loadAgentConversations: (
    projectPath: string,
    force?: boolean
  ) => Promise<AgentConversationSummary[]>;
  setWorkspaceArchived: (name: string, isArchived: boolean) => Promise<void>;
  setProjectArchived: (project: ProjectSummary, isArchived: boolean) => Promise<void>;
  loadProtectArchived: () => Promise<void>;
  setProtectArchived: (enabled: boolean) => Promise<void>;

  loadSessions: () => Promise<void>;
  loadRegistry: () => Promise<void>;
  loadUsage: (force?: boolean) => Promise<void>;
  loadUsageTokens: (force?: boolean) => Promise<void>;
  loadAgentAccounts: () => Promise<void>;
  /** Fetch the managed model-proxy status + model catalog into the store. */
  loadCliProxy: () => Promise<void>;
  enableCliProxy: () => Promise<void>;
  disableCliProxy: (force?: boolean) => Promise<{ ok: boolean; affectedSessions?: number }>;
  seedCliProxyAccount: (req: CliProxySeedRequest) => Promise<CliProxyProviderStatus>;
  unseedCliProxyAccount: (req: CliProxyUnseedRequest) => Promise<CliProxyProviderStatus>;
  /** Create or update a router provider (id is its identity; key set separately). */
  putCliProxyRouterProvider: (
    id: string,
    cfg: CliProxyRouterProviderRequest,
    force?: boolean
  ) => Promise<CliProxyStatus | CliProxyMutationRefusal>;
  deleteCliProxyRouterProvider: (
    id: string,
    force?: boolean
  ) => Promise<CliProxyStatus | CliProxyMutationRefusal>;
  setCliProxyRouterKey: (
    id: string,
    key: string,
    force?: boolean
  ) => Promise<{ ok: boolean; affectedSessions?: number }>;
  clearCliProxyRouterKey: (
    id: string,
    force?: boolean
  ) => Promise<{ ok: boolean; affectedSessions?: number }>;
  /** Read-only: the models a keyed router advertises upstream (models picker). */
  getCliProxyRouterCatalog: (id: string) => Promise<{ models: string[] }>;
  setCliProxyConfig: (
    cfg: {
      defaultModel?: string;
      backgroundModel?: string;
      claudeDefaultModel?: string;
      modelOverrides?: Record<
        string,
        { contextWindow?: number; compactWindow?: number; compactPct?: number }
      >;
    },
    force?: boolean
  ) => Promise<CliProxyStatus | CliProxyMutationRefusal>;
  installAgent: (id: string) => Promise<void>;
  updateAgent: (id: string) => Promise<void>;
  /**
   * Launch a tab in the current project.
   *
   * `resumeConversationId` resumes a past conversation instead of starting a
   * fresh one; the daemon refuses (400 `RESUME_UNAVAILABLE`) rather than
   * silently starting a fresh one when the id is unusable — surfaced as
   * `resumeError`. `initialCommand` is typed into the new session's PTY by the
   * **daemon** right after spawn (see `createProjectWithCommand`).
   *
   * Resolves to the created session, or `undefined` when nothing launched (no
   * api, or a refused resume).
   */
  openTab: (
    kind: RegistryKind,
    refId: string,
    title?: string,
    accountId?: string,
    model?: string,
    resumeConversationId?: string,
    initialCommand?: string
  ) => Promise<SessionSummary | undefined>;
  /** Dismiss the transient missing-models launch notice. */
  dismissModelWarning: () => void;
  /** Dismiss the transient refused-resume notice. */
  dismissResumeError: () => void;
  /**
   * Act on `resumeError`: start a FRESH session with the same agent, account and
   * model, in the project the refused resume targeted (navigating there first
   * when the user has moved on since).
   */
  startFreshFromResumeError: () => Promise<void>;
  /** Raise the transient after-the-fact notice (replaces any current one). */
  setNotice: (notice: { title?: string; message: string }) => void;
  /** Dismiss the transient after-the-fact notice. */
  dismissNotice: () => void;
  openFileBrowser: () => void;
  openGit: () => void;
  openBrowser: (url?: string) => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  /** Guarded close: opens a confirm for live sessions (returns true), else closes now. */
  requestCloseTab: (id: string) => boolean;
  confirmCloseTab: () => void;
  cancelCloseTab: () => void;
  activateTab: (id: string) => void;
  setViewMode: (mode: ViewMode) => void;
  setPreferredAccount: (agent: string, accountId: string) => void;
  setPreferredModel: (agent: string, model: string) => void;
  setTerminalFontSize: (size: number) => void;
  nudgeTerminalFontSize: (delta: number) => void;
  setColorScheme: (scheme: ColorScheme) => void;
  setThemeMode: (mode: ThemeMode) => void;
  /** Called by useTheme() once the settable mode has been resolved. */
  setResolvedMode: (mode: ResolvedMode) => void;
  /**
   * Set the sidebar width (clamped). Pass `persist=false` for live drag frames
   * (store-only, no localStorage write); the default `true` commits + persists.
   */
  setSidebarWidth: (px: number, persist?: boolean) => void;
  /** Reset the sidebar to its default width and persist. */
  resetSidebarWidth: () => void;
  /**
   * Set one pane split for a project (clamped). Pass `persist=false` for live
   * drag frames; the default `true` commits + persists.
   */
  setPaneSize: (projectPath: string, key: PaneSizeKey, px: number, persist?: boolean) => void;
  /** Clear one pane split for a project (falls back to its default) and persist. */
  resetPaneSize: (projectPath: string, key: PaneSizeKey) => void;
  /**
   * Set a project's grid-view track weights. Pass `persist=false` for live drag
   * frames; the default `true` commits + persists.
   */
  setGridTracks: (projectPath: string, tracks: GridTracks, persist?: boolean) => void;
  /** Clear a project's grid tracks (falls back to uniform) and persist. */
  resetGridTracks: (projectPath: string) => void;
  renameTab: (id: string, title: string) => Promise<void>;
  reorderTabs: (orderedSessionIds: string[]) => Promise<void>;

  // to-do lists (daemon-owned, synced; scoped to a workspace name or project path)
  loadTodos: (scope: TodoScope, refKey: string) => Promise<void>;
  createTodo: (scope: TodoScope, refKey: string, name?: string) => Promise<void>;
  openTodo: (rec: TodoListRecord) => void;
  renameTodo: (id: string, name: string) => Promise<void>;
  saveTodoBody: (id: string, body: string) => Promise<void>;
  deleteTodo: (id: string) => Promise<void>;

  /** Locally acknowledge a session's attention (focus-on-tab; server clears on input). */
  clearSessionAttention: (id: string) => void;

  applyEvent: (event: EventMessage) => void;
}

// Read once at module load so the initial render already has the right scheme
// (useTheme only stamps the attributes; it never picks a different value).
const initialThemePrefs = loadThemePrefs();

export const useAppStore = create<AppState>((set, get) => ({
  api: null,
  connectionStatus: "connecting",
  reconnectAttempt: 0,
  connectionError: null,
  lockedUntil: null,
  connections: [],
  activeConnectionId: null,
  appConfig: {
    useTitlebar: false,
    runInBackground: false,
    confirmCloseSession: true,
    usage: DEFAULT_USAGE_PREFS,
    agents: DEFAULT_AGENT_PREFS
  },
  settingsOpen: false,
  pendingCloseTabId: null,
  sidebarDrawerOpen: false,
  authPrompt: null,
  authSalt: null,
  authRequiresUsername: false,
  currentWorkspace: null,
  currentProject: null,
  registry: EMPTY_REGISTRY,
  usage: null,
  usageTokens: null,
  agentAccounts: null,
  cliproxy: null,
  cliproxyModels: null,
  workspaces: [],
  protectArchived: false,
  protectArchivedLoaded: false,
  accounts: [],
  workspacesLoading: false,
  projects: [],
  projectsLoading: false,
  recentProjects: [],
  agentConversationsByProject: {},
  sessions: [],
  browsers: [],
  activityById: {},
  modelWarning: null,
  resumeError: null,
  notice: null,
  fileTabsByProject: {},
  gitTabsByProject: {},
  todoTabsByContext: {},
  todos: [],
  activeTabByProject: {},
  viewModeByProject: loadViewModes(),
  preferredAccountByAgent: loadPreferredAccounts(),
  preferredModelByAgent: loadPreferredModels(),
  terminalFontSize: loadTerminalFontSize(),
  colorScheme: initialThemePrefs.scheme,
  themeMode: initialThemePrefs.mode,
  resolvedMode: resolveMode(initialThemePrefs.mode),
  sidebarWidth: loadSidebarWidth(),
  paneSizesByProject: loadPaneSizes(),
  gridTracksByProject: loadGridTracks(),

  setApi: (api) => set({ api }),

  connect: async () => {
    const initial = get().api;
    if (!initial) {
      return;
    }
    // A manual connect (or fresh credentials) clears any lockout/backoff state.
    // stopReconnect() bumps reconnectGen, preempting any loop suspended on an
    // untracked delay(); reset the locked-cycle counter so a fresh attempt
    // starts from a clean exponential fallback.
    stopReconnect();
    lockedCycles = 0;
    set({ connectionStatus: "connecting", reconnectAttempt: 0, connectionError: null, lockedUntil: null });

    // The embedded daemon is spawned asynchronously: poll /health first.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (get().api !== initial) {
        return;
      }
      try {
        await initial.health();
        break;
      } catch {
        await delay(500);
        if (attempt === 59) {
          set({ connectionStatus: "error" });
          return;
        }
        continue;
      }
    }

    try {
      await get().establish(initial);
    } catch {
      // A network error during establish (after /health came back) is a
      // transient disconnect: hand off to the exponential-backoff reconnect.
      // 401/429 are handled inside establish() and never reach here.
      get().handleDisconnect();
    }
  },

  establish: async (api) => {
    // Reconnect-generation guard (mirrors eventsGen): capture the current gen and
    // bail after every await if a newer flow (Retry/credentials/teardown) bumped
    // it. This is what lets connect()/stopReconnect()/scheduleLockedReconnect()
    // preempt an establish that was kicked off by a reconnect loop suspended on an
    // untracked delay() — without it, the resumed loop would run a SECOND
    // establish (duplicate fan-out + double events subscription).
    const reconnectGenAtStart = reconnectGen;
    // Auth gate: derive/restore the bearer credential (web) or prompt.
    let active = api;
    const info = await active.authInfo().catch(() => null);
    if (reconnectGenAtStart !== reconnectGen) {
      return;
    }
    set({ authSalt: info?.salt ?? null, authRequiresUsername: info?.requiresUsername ?? false });
    if (info?.authRequired) {
      // The bearer is base64("<username>:<hash>"). Prefer one already on the
      // connection; else rebuild it from the per-endpoint stored username+hash.
      const endpoint = active.connection.endpoint;
      const storedHash = loadStoredHash(endpoint);
      const storedUser = loadStoredUsername(endpoint);
      const credential =
        active.connection.password ??
        (storedHash ? buildCredential(storedUser ?? "", storedHash) : undefined);
      if (!credential) {
        stopReconnect();
        set({
          connectionStatus: "error",
          reconnectAttempt: 0,
          connectionError: null,
          lockedUntil: null,
          authPrompt: { connectionId: active.connection.id }
        });
        return;
      }
      if (active.connection.password !== credential) {
        active = apiWithCredential(active, credential);
        set({ api: active });
      }
    }

    // CREDENTIAL PRE-CHECK: one lightweight authenticated request (GET /api/info)
    // *before* the parallel fan-out. A bad/stale credential then yields a single
    // 401 (not five), and a locked-out client a single 429 — and we never enter
    // the reconnect loop on either. Only network errors fall through to retry.
    try {
      await active.info();
    } catch (error) {
      // A newer flow preempted us while the pre-check was in flight: don't act on
      // this stale response (no creds-clear, no reschedule, no rethrow-to-retry).
      if (reconnectGenAtStart !== reconnectGen) {
        return;
      }
      if (error instanceof ApiError && error.status === 401) {
        // Wrong credentials: drop the stored hash/username and re-prompt. Do NOT
        // fan out and do NOT reconnect.
        stopReconnect();
        clearStoredHash(active.connection.endpoint);
        clearStoredUsername(active.connection.endpoint);
        set({
          connectionStatus: "error",
          reconnectAttempt: 0,
          connectionError: "Incorrect username or password.",
          lockedUntil: null,
          authPrompt: { connectionId: active.connection.id }
        });
        return;
      }
      if (error instanceof ApiError && error.status === 429) {
        // Rate-limited (too many failed attempts): back off until Retry-After
        // (or a capped exponential fallback) — never tight-loop.
        scheduleLockedReconnect(get, set, error.retryAfterSeconds);
        return;
      }
      // Transient/network error: rethrow so the caller routes it to the
      // exponential-backoff reconnect (handleDisconnect's loop, or connect()).
      // Rethrowing — rather than calling handleDisconnect() here — keeps this
      // safe when establish() is itself invoked from inside that loop.
      throw error;
    }

    // Pre-check passed: still our flow? If a newer one preempted us, bail before
    // claiming "connected" / fanning out.
    if (reconnectGenAtStart !== reconnectGen) {
      return;
    }
    // Successful connect resets the consecutive-lockout counter.
    lockedCycles = 0;
    // agentConversationsByProject: a (re)connect may be a restarted or upgraded
    // daemon, and the cache is the only place a failed scan settles as "none" —
    // dropping it here is what makes that recoverable.
    set({ connectionStatus: "connected", reconnectAttempt: 0, connectionError: null, lockedUntil: null, authPrompt: null, agentConversationsByProject: {} });

    // Live event sync — opened BEFORE the snapshot fan-out, buffering into a
    // queue until the snapshots are installed. The broadcaster has no replay,
    // so subscribing after the fan-out loses any transition emitted between
    // "snapshot generated" and "subscription open" (e.g. a session flipping to
    // waiting), leaving stale state until the next event. Events that arrive
    // during the fan-out are same-age or newer than the snapshots, so a
    // post-install replay converges. The stream ending unexpectedly is the
    // primary disconnect signal.
    closeEvents();
    const gen = eventsGen;
    lastEventAt = Date.now();
    let eventBuffer: EventMessage[] | null = [];
    eventsUnsubscribe = active.openEvents(
      (event) => {
        lastEventAt = Date.now();
        if (eventBuffer) {
          eventBuffer.push(event);
        } else {
          get().applyEvent(event);
        }
      },
      () => {
        if (gen === eventsGen) {
          get().handleDisconnect();
        }
      }
    );

    await Promise.all([
      get().loadWorkspaces(),
      get().loadRecentProjects(),
      get().loadProtectArchived(),
      get().loadSessions(),
      // Browser tabs are optional (older daemons return 404) — tolerate absence.
      active.listBrowsers().then((browsers) => set({ browsers })).catch(() => set({ browsers: [] })),
      get().loadRegistry(),
      get().loadUsage(),
      get().loadAgentAccounts(),
      get().loadCliProxy(),
      // Daemon-side agent prefs (Claude stream timeout). Loaded per connect so the
      // panel shows the value of the daemon that will actually launch the session
      // — including after a connection switch or a daemon restart.
      get().loadAgentPrefs(),
      // Reload git accounts on every (re)connect too — otherwise a daemon
      // restart leaves `accounts` stale (it was only filled by the one-time
      // initConnections path), so the workspace/project pickers go empty until
      // Settings → GitHub refills it. (project-repo-linking bug fix.)
      get().loadAccounts(),
      // App config + remotes moved here from initConnections' unauthenticated
      // path (each pre-auth 401 burst counted against the login throttle);
      // both are fail-soft and cheap, so per-connect is fine.
      get().loadAppConfig(),
      get().loadRemotes()
    ]);
    // Preempted during the fan-out. A newer establish() tears our stream down
    // via closeEvents(), but stopReconnect()/scheduleLockedReconnect() bump
    // reconnectGen WITHOUT closing — that would leave this stream live,
    // pushing into a buffer nobody ever flushes. Drop the buffer and, if our
    // subscription is still the current one, close it ourselves.
    if (reconnectGenAtStart !== reconnectGen) {
      eventBuffer = null;
      if (gen === eventsGen) {
        closeEvents();
      }
      return;
    }

    // Snapshots installed: replay events buffered during the fan-out, then
    // switch the stream to direct delivery.
    const buffered = eventBuffer;
    eventBuffer = null;
    for (const event of buffered) {
      get().applyEvent(event);
    }

    // Health probe: detect a dropped/restarted transport and auto-reconnect.
    // A silently stalled /events stream (killed while the tab was frozen, no
    // error ever delivered) counts as dropped too: /health can succeed while
    // the stream is dead, so heartbeat staleness is checked first.
    stopHealthProbe();
    healthTimer = setInterval(() => {
      const current = get().api;
      if (!current) {
        return;
      }
      if (Date.now() - lastEventAt > EVENTS_STALE_MS) {
        get().handleDisconnect();
        return;
      }
      void current.health().catch(() => get().handleDisconnect());
    }, 4000);
  },

  handleDisconnect: () => {
    // Tear down the probe + any pending delayed reconnect so a stream `onEnd`
    // can't stack a second loop/timer; a single backoff loop owns reconnection.
    stopHealthProbe();
    clearReconnectTimer();
    if (reconnecting || get().api === null) {
      return;
    }
    reconnecting = true;

    const loop = async () => {
      // Own this reconnect generation (mirrors eventsGen). Any newer flow
      // (Retry/credentials/teardown/locked) bumps reconnectGen; after each await
      // we bail so a loop resumed from an untracked delay() can't run a SECOND
      // establish concurrently with the new flow.
      const gen = ++reconnectGen;
      for (let attempt = 1; ; attempt += 1) {
        const current = get().api;
        if (!current) {
          break;
        }
        // Respect an active lockout (429): wait past it before probing again so
        // we don't hammer the rate-limited daemon.
        const lockedUntil = get().lockedUntil;
        if (lockedUntil && lockedUntil > Date.now()) {
          await delay(Math.min(lockedUntil - Date.now(), 8000));
          if (gen !== reconnectGen) {
            return;
          }
          continue;
        }
        set({ connectionStatus: "connecting", reconnectAttempt: attempt, connectionError: null });
        try {
          await current.health();
          if (gen !== reconnectGen) {
            return;
          }
          // Daemon is back: rebuild the client so terminals + event streams
          // re-subscribe to the (intact) sessions, then re-establish. establish()
          // runs its own auth pre-check — a 401 re-prompts and a 429 reschedules
          // its own backoff, so either way we stop looping here.
          const fresh = apiWithCredential(current, current.connection.password ?? "");
          set({ api: fresh });
          await get().establish(fresh);
          break;
        } catch (error) {
          if (gen !== reconnectGen) {
            return;
          }
          // Even /health can 429 if the limiter is broadened: honor Retry-After.
          if (error instanceof ApiError && error.status === 429) {
            reconnecting = false;
            scheduleLockedReconnect(get, set, error.retryAfterSeconds);
            return;
          }
          // Wakeable: a tab-return/online event short-circuits the backoff so
          // the next probe runs immediately instead of when the timer thaws.
          await wakeableDelay(backoffMs(attempt));
          if (gen !== reconnectGen) {
            return;
          }
        }
      }
      reconnecting = false;
    };
    void loop();
  },

  wakeConnections: () => {
    // visibilitychange + pageshow + focus (+ online) typically fire together on
    // tab return — run the probe once, not four times.
    const now = Date.now();
    if (now - lastWakeAt < 1000) {
      return;
    }
    lastWakeAt = now;

    // Terminal WS: redial a dead socket now, ping-probe a half-dead one (mobile
    // kills sockets without a close event; readyState lies).
    wakeSessionChannels();
    // Browser screencast WS: same redial/ping-probe on visibility regain.
    wakeBrowserChannels();

    const api = get().api;
    if (!api) {
      return;
    }
    if (reconnecting) {
      // A backoff loop is mid-wait: retry NOW instead of when its timer thaws.
      wakeReconnectWaiters();
      return;
    }
    const status = get().connectionStatus;
    if (status === "connected") {
      // The tab may have been frozen: the /events stream can be dead without its
      // onEnd having been delivered yet. Probe immediately rather than waiting
      // for the 4s interval (throttled to ≥60s while hidden) to notice.
      if (now - lastEventAt > EVENTS_STALE_MS) {
        get().handleDisconnect();
      } else {
        void api.health().catch(() => get().handleDisconnect());
      }
      return;
    }
    if (status === "error") {
      // Auto-retry the transient give-up state, but never past an auth prompt
      // (needs the user) or an active 429 lockout (would hammer the limiter).
      const lockedUntil = get().lockedUntil;
      if (get().authPrompt || (lockedUntil && lockedUntil > Date.now())) {
        return;
      }
      void get().connect();
    }
    // "connecting": connect()'s own poll loop resumed with the page — let it run.
  },

  initConnections: async (nextSetup) => {
    setup = nextSetup;
    homeApi = new ApiClient(nextSetup.localConnection, buildTransporter(nextSetup.localConnection));
    set({
      connections: [nextSetup.localConnection],
      activeConnectionId: nextSetup.localConnection.id,
      appConfig: {
        useTitlebar: nextSetup.defaultUseTitlebar,
        runInBackground: false,
        confirmCloseSession: true,
        usage: DEFAULT_USAGE_PREFS,
        agents: DEFAULT_AGENT_PREFS
      },
      api: homeApi
    });
    await get().connect();
    // App config + remote servers are shared (persisted on the home daemon) —
    // but only fetch them once actually authenticated. Before sign-in these
    // requests 401 and every 401 burst feeds the daemon's per-IP login
    // throttle: enough unauthenticated page loads (e.g. the deploy smoke
    // test's fixture sweep) lock the IP out for 15 minutes. The connect
    // fan-out re-runs these loads after a successful sign-in.
    if (get().connectionStatus === "connected") {
      await Promise.all([get().loadAppConfig(), get().loadRemotes(), get().loadAccounts()]);
    }
  },

  loadAppConfig: async () => {
    try {
      const adapter = setup?.appConfigAdapter;
      const config = adapter ? await adapter.load() : await homeApi?.getAppConfig();
      if (config) {
        set((state) => ({
          appConfig: {
            useTitlebar: config.useTitlebar ?? state.appConfig.useTitlebar,
            runInBackground: config.runInBackground ?? state.appConfig.runInBackground,
            confirmCloseSession: config.confirmCloseSession ?? state.appConfig.confirmCloseSession,
            usage: normalizeUsagePrefs(config.usage, state.appConfig.usage),
            // `agents` is deliberately NOT taken from `config`: it is daemon-side
            // (the daemon reads app.json at session launch), so it is owned by
            // loadAgentPrefs/updateAgentPrefs against the connected daemon, never
            // by the per-client adapter. Reading the adapter's copy here would
            // clobber the authoritative value fetched during connect.
            agents: state.appConfig.agents
          }
        }));
      }
    } catch {
      /* keep defaults */
    }
  },

  // The `agents` group is the one app-config field the DAEMON consumes: it reads
  // app.json when launching a Claude session. The other fields are client-local
  // and on web are persisted to localStorage by an AppConfigAdapter that cannot
  // reach the daemon at all — so this group gets its own load/save pair, routed
  // over the API of the currently connected daemon (the one that will run the
  // session), not through the adapter and not through `homeApi` (which is built
  // before auth and carries no credential on web).
  loadAgentPrefs: async () => {
    const api = get().api;
    if (!api) {
      return;
    }
    try {
      const config = await api.getAppConfig();
      set((state) => ({
        appConfig: {
          ...state.appConfig,
          agents: normalizeAgentPrefs(config.agents, DEFAULT_AGENT_PREFS)
        }
      }));
    } catch {
      /* keep current (older daemon / transient failure) */
    }
  },

  updateAgentPrefs: async (next) => {
    const api = get().api;
    const previous = get().appConfig.agents;
    set((state) => ({ appConfig: { ...state.appConfig, agents: next } }));
    try {
      // The PUT merges `{...current, ...body}` server-side, so sending just this
      // group leaves every other app.json field untouched.
      await api?.updateAppConfig({ agents: next });
    } catch {
      // Don't leave the UI showing a value the daemon never accepted.
      set((state) => ({ appConfig: { ...state.appConfig, agents: previous } }));
    }
  },

  loadRemotes: async () => {
    if (!homeApi || !setup) {
      return;
    }
    try {
      const remotes = (await homeApi.listRemotes()).map(toUiConnection);
      set({ connections: [setup.localConnection, ...remotes] });
    } catch {
      /* keep local only */
    }
  },

  setSettingsOpen: (open) => set({ settingsOpen: open }),


  setSidebarDrawer: (open) => set({ sidebarDrawerOpen: open }),

  updateAppConfig: async (patch) => {
    const appConfig = { ...get().appConfig, ...patch };
    set({ appConfig });
    const adapter = setup?.appConfigAdapter;
    const full = {
      version: 1 as const,
      activeConnectionId: get().activeConnectionId ?? "local",
      ...appConfig
    };
    // `agents` belongs to the CONNECTED daemon (loadAgentPrefs/updateAgentPrefs
    // own it), while `homeApi` is the local one. Sending it here would copy a
    // remote's claudeTimeoutMinutes into the local app.json whenever any other
    // app setting is toggled while connected to that remote. The adapter branch
    // keeps it as the documented write-only cache (nothing reads it back).
    const { agents: _agents, ...localPersisted } = appConfig;
    const result = adapter ? adapter.save(full) : homeApi?.updateAppConfig(localPersisted);
    await result?.catch(() => undefined);
  },

  submitCredentials: async (username, password) => {
    const api = get().api;
    const salt = get().authSalt;
    if (!api || !salt) {
      return;
    }
    // Derive the same bcrypt hash the daemon stores; persist the hash + the
    // plain username (never the plaintext password). The wire bearer is
    // base64("<username>:<hash>").
    const normalizedUser = username.trim().toLowerCase();
    const hash = deriveAuthHash(password, salt);
    const credential = buildCredential(normalizedUser, hash);
    storeHash(api.connection.endpoint, hash);
    storeUsername(api.connection.endpoint, normalizedUser);
    set({ api: apiWithCredential(api, credential), authPrompt: null });
    await get().connect();
  },

  signOut: () => {
    const api = get().api;
    if (api) {
      stopReconnect();
      closeEvents();
      clearStoredHash(api.connection.endpoint);
      clearStoredUsername(api.connection.endpoint);
      invalidateProjectIndex();
      set({
        api: apiWithCredential(api, ""),
        connectionStatus: "error",
        reconnectAttempt: 0,
        connectionError: null,
        lockedUntil: null,
        // Drop the signed-in daemon's data with the credential (same reset
        // `selectConnection` does). Otherwise the sidebar keeps rendering the
        // previous session's workspaces/projects behind the auth prompt — and
        // the archived-items curtain has no stored hash left to verify against.
        currentWorkspace: null,
        currentProject: null,
        workspaces: [],
        projects: [],
        recentProjects: [],
        agentConversationsByProject: {},
        // Transient per-daemon notices: they name a session/project of the
        // daemon we just left, and their actions would launch into it.
        resumeError: null,
        modelWarning: null,
        notice: null,
        protectArchived: false,
        protectArchivedLoaded: false,
        authPrompt: { connectionId: api.connection.id }
      });
    }
  },

  selectConnection: async (id) => {
    const connection = get().connections.find((c) => c.id === id);
    if (!connection || id === get().activeConnectionId) {
      return;
    }
    stopReconnect();
    closeEvents();
    // The verified project index is daemon-scoped too, and it lives outside the
    // store (module cache) — reset it by hand with the rest.
    invalidateProjectIndex();
    // Reset all daemon-scoped state: a different server has its own data.
    set({
      api: new ApiClient(connection, buildTransporter(connection)),
      activeConnectionId: id,
      currentWorkspace: null,
      currentProject: null,
      workspaces: [],
      projects: [],
      recentProjects: [],
      agentConversationsByProject: {},
      // Transient per-daemon notices (see signOut): they reference the previous
      // daemon's session/project, so they must not survive the switch.
      resumeError: null,
      modelWarning: null,
      notice: null,
      // Per-daemon flag: never let one server's curtain setting apply to the
      // next one. connect() reloads it from the newly selected daemon.
      protectArchived: false,
      protectArchivedLoaded: false,
      sessions: [],
      browsers: [],
      accounts: []
    });
    await get().connect();
  },

  addRemote: async (input) => {
    // No credential is captured at add-time: `connection.password` is the wire
    // bearer base64("<username>:<hash>"), and the raw password must never leave
    // the client (nor be persisted to remotes.json). The AuthModal derives the
    // hash and builds the credential on first connect, exactly like the
    // seeded-VPS remote (apps/desktop/src/main.ts).
    const connection: UiConnection = {
      id: crypto.randomUUID(),
      name: input.name.trim() || input.baseUrl,
      kind: "remote",
      endpoint: input.baseUrl.trim().replace(/\/$/, ""),
      status: "disconnected"
    };
    const connections = [...get().connections, connection];
    set({ connections });
    await persistRemotes(connections);
    return connection.id;
  },

  removeRemote: async (id) => {
    const connections = get().connections.filter((c) => c.id !== id);
    set({ connections });
    await persistRemotes(connections);
    if (get().activeConnectionId === id && setup) {
      await get().selectConnection(setup.localConnection.id);
    }
  },

  loadAccounts: async () => {
    const api = get().api;
    if (!api) {
      return;
    }
    try {
      set({ accounts: await api.listAccounts() });
    } catch {
      /* keep current (e.g. transport without the endpoint) */
    }
  },

  addAccount: async (input) => {
    const api = get().api;
    if (!api) {
      throw new Error("Not connected.");
    }
    // Trim the fields every variant shares; provider-specific fields (email,
    // baseUrl, username, CA PEM, expiry) pass through as the caller built them.
    const account = await api.createAccount({
      ...input,
      label: input.label.trim(),
      token: input.token.trim()
    });
    await get().loadAccounts();
    return account;
  },

  removeAccount: async (id) => {
    await get().api?.removeAccount(id);
    await get().loadAccounts();
  },

  testAccount: async (id) => {
    const api = get().api;
    if (!api) {
      return { ok: false, message: "Not connected." };
    }
    return api.testAccount(id);
  },

  listRepos: async (accountId) => {
    const api = get().api;
    if (!api) {
      throw new Error("Not connected.");
    }
    return api.listRepos(accountId);
  },

  listOwners: async (accountId) => {
    const api = get().api;
    if (!api) {
      throw new Error("Not connected.");
    }
    return api.listOwners(accountId);
  },

  setAccountToken: async (accountId, token, tokenExpiresAt) => {
    const api = get().api;
    if (!api) {
      throw new Error("Not connected.");
    }
    await api.setAccountToken(accountId, token.trim(), tokenExpiresAt);
    // Refetch so repoAccess flips in the UI (no broadcast; single-user).
    await get().loadAccounts();
  },

  confirmAccountKey: async (accountId) => {
    const api = get().api;
    if (!api) {
      throw new Error("Not connected.");
    }
    await api.confirmAccountKey(accountId);
    // Refetch so the pending-key banner clears (no broadcast; single-user).
    await get().loadAccounts();
  },

  loadWorkspaces: async () => {
    const api = get().api;
    if (!api) {
      return;
    }
    set({ workspacesLoading: true });
    try {
      set({ workspaces: await workspaceService.list(api) });
    } catch (error) {
      // A wrong/stale token surfaces here — clear it and re-prompt. (Normally the
      // establish() pre-check catches this first; this is the defensive fallback
      // for a credential revoked mid-fan-out.)
      if (error instanceof ApiError && error.status === 401) {
        stopReconnect();
        clearStoredHash(api.connection.endpoint);
        clearStoredUsername(api.connection.endpoint);
        set({
          connectionStatus: "error",
          connectionError: "Incorrect username or password.",
          lockedUntil: null,
          authPrompt: { connectionId: api.connection.id }
        });
      } else {
        console.error("[orquester] failed to load workspaces", error);
      }
    } finally {
      set({ workspacesLoading: false });
    }
  },

  createWorkspace: async (name, gitAccountId) => {
    const api = get().api;
    if (!api) {
      return;
    }
    await workspaceService.create(api, name, gitAccountId);
    await get().loadWorkspaces();
  },

  deleteWorkspace: async (name) => {
    const api = get().api;
    if (!api) {
      return;
    }
    // The deleted workspace's directory prefix; every project path under it is
    // `<wsPath>/<project>`. Used to purge path-keyed client-local tab state.
    const ws = get().workspaces.find((w) => w.name === name);
    const prefix = ws?.path;
    await workspaceService.delete(api, name);
    if (get().currentWorkspace === name) {
      get().closeWorkspace();
    }
    if (prefix) {
      const match = (path: string) => path === prefix || path.startsWith(`${prefix}/`);
      set((state) => {
        const next = clearProjectLocalState(state, match);
        // If the open project lived under the deleted workspace, drop it from
        // the main view (closeWorkspace keeps currentProject sticky, and the
        // delete can fire while currentWorkspace is already null).
        if (state.currentProject && match(state.currentProject.path)) {
          next.currentProject = null;
        }
        return next;
      });
    }
    await get().loadWorkspaces();
  },

  openWorkspace: async (name) => {
    set({ currentWorkspace: name, projects: [] });
    // Fire-and-forget: workspace-scoped to-do lists for the sidebar + "+" menu.
    void get().loadTodos("workspace", name);
    await get().loadProjects();
  },

  closeWorkspace: () => set({ currentWorkspace: null, projects: [] }),

  loadProjects: async () => {
    const api = get().api;
    const workspace = get().currentWorkspace;
    if (!api || !workspace) {
      set({ projects: [], projectsLoading: false });
      return;
    }
    set({ projectsLoading: true });
    try {
      set({ projects: await workspaceService.listProjects(api, workspace) });
    } catch (error) {
      console.error("[orquester] failed to load projects", error);
    } finally {
      set({ projectsLoading: false });
    }
  },

  createProject: async (req) => {
    const api = get().api;
    const workspace = get().currentWorkspace;
    if (!api || !workspace) {
      return;
    }
    await workspaceService.createProject(api, workspace, req);
    await get().loadProjects();
  },

  createProjectWithCommand: async (req, command) => {
    const api = get().api;
    const workspace = get().currentWorkspace;
    if (!api || !workspace) {
      return;
    }
    // Phase 1 — the directory. A failure here is a plain create failure and
    // propagates as-is (nothing exists yet, so the caller may retry).
    const project = await workspaceService.createProject(api, workspace, req);
    await get().loadProjects();
    get().openProject(project);

    // Phase 2 — the setup tab. From here the project EXISTS: every failure is
    // wrapped so the caller can say so instead of "could not create the
    // project", and must never be retried as a create.
    try {
      // Scaffold/clone commands are POSIX shell syntax, so prefer a POSIX shell
      // over whatever happens to be first in `registry.shells`: nushell/fish/pwsh
      // parse `--`, quoting and `&&` differently and would mangle them.
      const enabled = get().registry.shells.filter((s) => s.enabled);
      const shellId =
        ["bash", "zsh", "sh"].find((id) => enabled.some((s) => s.id === id)) ?? enabled[0]?.id;
      if (!shellId) {
        throw new Error("no shell is available on the server");
      }
      // The command is TYPED, not executed: the user watches the scaffolder and
      // answers its prompts. The daemon does the typing (`initialCommand`) right
      // after the spawn — that removes the old client-side race entirely (a
      // fixed sleep guessing when the shell has drawn its prompt, then an input
      // frame the WS channel could drop on a reconnect).
      const session = await get().openTab(
        "shell",
        shellId,
        "Setup",
        undefined,
        undefined,
        undefined,
        command
      );
      if (!session) {
        throw new Error("the setup terminal could not be opened");
      }
    } catch (error) {
      const reason =
        (error instanceof ApiError ? error.serverMessage : null) ??
        (error instanceof Error ? error.message : null) ??
        "the setup command could not be started";
      throw new ProjectSetupError(reason, project);
    }
  },

  deleteProject: async (project) => {
    const api = get().api;
    if (!api) {
      return;
    }
    await workspaceService.deleteProject(api, project.workspace, project.name);
    set((state) => {
      const next = clearProjectLocalState(state, (path) => path === project.path);
      // If the open project was deleted, drop it from the main view.
      if (state.currentProject?.path === project.path) {
        next.currentProject = null;
      }
      return next;
    });
    await get().loadProjects();
  },

  // Archive = navigation reset only. Unlike delete, do NOT call
  // clearProjectLocalState: tab layout, pane sizes, and view mode must survive
  // an unarchive (spec decision). Sessions keep running server-side.
  setWorkspaceArchived: async (name, isArchived) => {
    const api = get().api;
    if (!api) {
      return;
    }
    const ws = get().workspaces.find((w) => w.name === name);
    await workspaceService.setWorkspaceArchived(api, name, isArchived);
    if (isArchived) {
      if (get().currentWorkspace === name) {
        get().closeWorkspace();
      }
      const prefix = ws?.path;
      const current = get().currentProject;
      if (prefix && current && (current.path === prefix || current.path.startsWith(`${prefix}/`))) {
        set({ currentProject: null });
      }
    }
    invalidateProjectIndex();
    await Promise.all([get().loadWorkspaces(), get().loadRecentProjects()]);
  },

  setProjectArchived: async (project, isArchived) => {
    const api = get().api;
    if (!api) {
      return;
    }
    await workspaceService.setProjectArchived(api, project.workspace, project.name, isArchived);
    if (isArchived && get().currentProject?.path === project.path) {
      set({ currentProject: null });
    }
    // The curtain moved: drop the verified project index (attention center,
    // command palette) and re-pull recents, which the daemon does not touch on
    // an archive and so would keep showing the row until something else did.
    invalidateProjectIndex();
    await Promise.all([get().loadProjects(), get().loadRecentProjects()]);
  },

  loadProtectArchived: async () => {
    const api = get().api;
    if (!api) {
      return;
    }
    try {
      const config = await api.getDaemonConfig();
      // An older daemon simply omits the field — that (and only that) is the
      // documented default-off case.
      set({
        protectArchived: config.protectArchivedData ?? false,
        protectArchivedLoaded: true
      });
    } catch {
      // The request itself failed (throttle, 5xx, network blip). Leave the
      // value at the daemon default (off) so it can never drift ahead of
      // daemon.json — the Settings switch renders this value — but keep
      // `protectArchivedLoaded` false: consumers treat "unknown" as protected,
      // so the curtain still does not drop open, and they can retry the load.
      set({ protectArchived: false, protectArchivedLoaded: false });
    }
  },

  setProtectArchived: async (enabled) => {
    const api = get().api;
    if (!api) {
      return;
    }
    const config = await api.setProtectArchived(enabled);
    set({
      protectArchived: config.protectArchivedData ?? enabled,
      protectArchivedLoaded: true
    });
  },

  openProject: (project) => {
    // Re-selecting the project that is already open is not a new interaction:
    // marking it again would POST (and reshuffle the shared recents list) on
    // every stray click of the row that is already active.
    const alreadyOpen = get().currentProject?.path === project.path;
    set((state) => {
      const active = state.activeTabByProject[project.path];
      const fallback = firstTabId(
        state.sessions,
        state.browsers,
        state.fileTabsByProject,
        state.gitTabsByProject,
        state.todoTabsByContext,
        project.path
      );
      return {
        currentProject: project,
        // Opening a project reveals the main view — close the mobile drawer.
        sidebarDrawerOpen: false,
        activeTabByProject: {
          ...state.activeTabByProject,
          [project.path]: active ?? fallback
        }
      };
    });
    // Fire-and-forget (keeps openProject synchronous): project-scoped to-do lists.
    void get().loadTodos("project", project.path);
    // Every client navigation path into a project funnels through here (sidebar,
    // recents, command palette, project switcher), so this is the one place the
    // daemon needs told about a pure-navigation interaction. Session create is
    // marked daemon-side already.
    if (!alreadyOpen) {
      get().markProjectInteracted(project);
    }
  },

  loadRecentProjects: async () => {
    const api = get().api;
    if (!api) {
      return;
    }
    // Generation guard (see establish): a list fetched from daemon A must never
    // land in daemon B's state after a selectConnection/signOut in flight.
    const gen = reconnectGen;
    try {
      const list = await api.listRecentProjects();
      if (gen === reconnectGen) {
        set({ recentProjects: list });
      }
    } catch {
      // Best-effort surface: an older daemon 404s here, and a blip must not
      // block the connect fan-out. Leave whatever we had.
    }
  },

  markProjectInteracted: (project) => {
    const api = get().api;
    const target = project ?? get().currentProject;
    if (!api || !target?.path) {
      return;
    }
    // The daemon broadcasts `recentProjects.changed` too; applying the response
    // just makes our own click feel instant. Generation-guarded like every other
    // post-await write (this one can land seconds after a connection switch).
    const gen = reconnectGen;
    void api
      .markProjectInteracted(target.path)
      .then((list) => {
        if (gen === reconnectGen) {
          set({ recentProjects: list });
        }
      })
      .catch(() => undefined);
  },

  openRecentProject: async (recent) => {
    // An archived project is hidden from every navigable surface (the sidebar
    // reveals it only behind the archived curtain), so a stale recents row must
    // not be a way around that.
    if (isArchivedRecent(recent)) {
      return;
    }
    // Re-verify with the daemon BEFORE anything navigational: the row may have
    // been archived since it was painted, and `openWorkspace` would then strand
    // the user in a switched-to workspace with nothing to open — a dead end the
    // archived curtain is supposed to prevent, not create. An older daemon
    // (no such route) leaves the list untouched and stays permissive.
    await get().loadRecentProjects();
    const fresh = get().recentProjects.find((r) => r.path === recent.path);
    if (!fresh || isArchivedRecent(fresh)) {
      return;
    }
    // Switching workspaces reloads `projects`; the entry we want is only in the
    // store after that await. Also load when the workspace is already current
    // but the list doesn't hold the path yet (first paint, or a stale list).
    const find = () => get().projects.find((p) => p.path === recent.path);
    if (get().currentWorkspace !== recent.workspace || !find()) {
      await get().openWorkspace(recent.workspace);
    }
    // A path that no longer resolves to a listed project (deleted, or archived
    // out from under the list) just leaves its workspace open — no error state
    // to invent, the sidebar now shows what actually exists.
    const project = find();
    if (project && !project.isArchived) {
      get().openProject(project);
    }
  },

  loadAgentConversations: async (projectPath, force) => {
    const cached = get().agentConversationsByProject[projectPath];
    if (cached && !force) {
      return cached;
    }
    const api = get().api;
    if (!api || !projectPath) {
      return cached ?? [];
    }
    // Dedup: the overview and every open "+"-menu resume section ask for the
    // same project at once, and the scan is ~1s of daemon work per call.
    const inFlight = conversationScans.get(projectPath);
    if (inFlight && !force) {
      return inFlight;
    }
    const gen = reconnectGen;
    const scan = (async () => {
      let conversations: AgentConversationSummary[] = [];
      try {
        conversations = (await api.listAgentConversations(projectPath)).conversations;
      } catch {
        // Best-effort (the daemon already swallows per-agent scan failures), and a
        // daemon predating the route 404s outright. Cache the empty result anyway
        // so consumers settle into their quiet empty state instead of showing a
        // loading skeleton forever; connect() drops the whole map, and any session
        // open/close in the project drops this key, so a retry is never far off.
      }
      // Same generation guard as the other loaders: one daemon's conversations
      // must never be cached under another's project path.
      if (gen === reconnectGen) {
        set((state) => ({
          agentConversationsByProject: {
            ...state.agentConversationsByProject,
            [projectPath]: conversations
          }
        }));
      }
      return conversations;
    })();
    conversationScans.set(projectPath, scan);
    try {
      return await scan;
    } finally {
      // Only clear our own entry: a `force` scan started later owns the slot.
      if (conversationScans.get(projectPath) === scan) {
        conversationScans.delete(projectPath);
      }
    }
  },

  loadSessions: async () => {
    const api = get().api;
    if (!api) {
      return;
    }
    // Capture the activity-event counter *before* the awaited fetch: any
    // "session.activity" event applied during the await is fresher than this
    // snapshot and must survive it.
    const fetchStartSeq = activityEventSeq;
    try {
      const sessions = await api.listSessions();
      // REBUILD the activity map solely from the snapshots the daemon ships on
      // running sessions (dots correct on first paint / reload). Never copy the
      // old map wholesale: a session that exited while we were disconnected
      // arrives without `activity`, and a carried-over entry would show it
      // working or waiting forever. But for a session an event freshened *during*
      // this fetch, keep the current (event-driven) entry instead of the older
      // snapshot value.
      set((state) => {
        const activityById: Record<string, SessionActivity> = {};
        for (const s of sessions) {
          const eventSeq = activityEventSeqById.get(s.id) ?? 0;
          if (eventSeq > fetchStartSeq && s.id in state.activityById) {
            activityById[s.id] = state.activityById[s.id];
          } else if (s.activity) {
            activityById[s.id] = s.activity;
          }
        }
        return { sessions, activityById };
      });
    } catch (error) {
      console.error("[orquester] failed to load sessions", error);
    }
  },

  loadRegistry: async () => {
    const api = get().api;
    if (!api) {
      return;
    }
    try {
      set({ registry: await api.listRegistry() });
    } catch {
      /* keep current */
    }
  },

  loadUsage: async (force) => {
    const api = get().api;
    if (!api) {
      return;
    }
    try {
      set({ usage: await api.getUsage(force) });
    } catch {
      /* keep current */
    }
  },

  loadUsageTokens: async (force) => {
    const api = get().api;
    if (!api) {
      return;
    }
    try {
      set({ usageTokens: await api.getUsageTokens(force) });
    } catch {
      /* keep current */
    }
  },

  loadAgentAccounts: async () => {
    const api = get().api;
    if (!api) {
      return;
    }
    try {
      set({ agentAccounts: await api.getAgentAccounts() });
    } catch {
      /* keep current */
    }
  },

  loadCliProxy: async () => {
    const api = get().api;
    if (!api) {
      return;
    }
    // Status and the model catalog are fetched independently: a failed model
    // fetch must NOT blank a good status (the panel still shows the persisted
    // defaultModel), and vice versa.
    try {
      set({ cliproxy: await api.getCliProxyStatus() });
    } catch {
      /* keep current */
    }
    try {
      set({ cliproxyModels: await api.getCliProxyModels() });
    } catch {
      /* keep current */
    }
  },

  enableCliProxy: async () => {
    const api = get().api;
    if (!api) {
      return;
    }
    // Optimistically adopt the returned status; the live "cliproxy.changed"
    // stream keeps refining it through the download/build/start substages.
    const status = await api.enableCliProxy();
    set({ cliproxy: status });
  },

  disableCliProxy: async (force) => {
    const api = get().api;
    if (!api) {
      return { ok: false };
    }
    const res = await api.disableCliProxy(force);
    await get().loadCliProxy();
    return res;
  },

  seedCliProxyAccount: async (req) => {
    const api = get().api;
    if (!api) {
      throw new Error("not connected");
    }
    const provider = await api.seedCliProxyAccount(req);
    await get().loadCliProxy();
    return provider;
  },

  unseedCliProxyAccount: async (req) => {
    const api = get().api;
    if (!api) {
      throw new Error("not connected");
    }
    const provider = await api.unseedCliProxyAccount(req);
    await get().loadCliProxy();
    return provider;
  },

  putCliProxyRouterProvider: async (id, cfg, force) => {
    const api = get().api;
    if (!api) {
      return { ok: false, affectedSessions: 0 };
    }
    const res = await api.putCliProxyRouterProvider(id, cfg, force);
    // A refusal ({ ok:false, affectedSessions }) passes straight through to the
    // caller's force-confirm flow and must NOT be adopted as a status.
    if ("ok" in res) return res;
    // Adopt the returned status immediately, then reload: provider models change
    // the proxy's model catalog too, and only loadCliProxy refreshes that.
    set({ cliproxy: res });
    await get().loadCliProxy();
    return res;
  },

  deleteCliProxyRouterProvider: async (id, force) => {
    const api = get().api;
    if (!api) {
      return { ok: false, affectedSessions: 0 };
    }
    const res = await api.deleteCliProxyRouterProvider(id, force);
    if ("ok" in res) return res;
    set({ cliproxy: res });
    await get().loadCliProxy();
    return res;
  },

  setCliProxyRouterKey: async (id, key, force) => {
    const api = get().api;
    if (!api) {
      return { ok: false, affectedSessions: 0 };
    }
    // The key routes return { ok, affectedSessions } (they write projections but
    // may not emit a status event), so refresh the status explicitly afterward.
    const res = await api.setCliProxyRouterKey(id, key, force);
    await get().loadCliProxy();
    return res;
  },

  clearCliProxyRouterKey: async (id, force) => {
    const api = get().api;
    if (!api) {
      return { ok: false, affectedSessions: 0 };
    }
    const res = await api.clearCliProxyRouterKey(id, force);
    await get().loadCliProxy();
    return res;
  },

  getCliProxyRouterCatalog: async (id) => {
    const api = get().api;
    if (!api) {
      throw new Error("not connected");
    }
    return api.getCliProxyRouterCatalog(id);
  },

  setCliProxyConfig: async (cfg, force) => {
    const api = get().api;
    if (!api) {
      return { ok: false, affectedSessions: 0 };
    }
    const res = await api.setCliProxyConfig(cfg, force);
    if ("ok" in res) return res;
    set({ cliproxy: res });
    return res;
  },

  installAgent: async (id) => {
    // Status (installing/installed/error) arrives via the "registry" event bus.
    await get().api?.installRegistryEntry(id).catch(() => undefined);
  },

  updateAgent: async (id) => {
    await get().api?.updateRegistryEntry(id).catch(() => undefined);
  },

  openTab: async (kind, refId, title, accountId, model, resumeConversationId, initialCommand) => {
    const api = get().api;
    if (!api) {
      return;
    }
    const project = get().currentProject;
    let session: SessionSummary;
    try {
      session = await api.createSession({
        kind,
        refId,
        title,
        projectPath: project?.path ?? "",
        cwd: project?.path,
        accountId,
        model,
        resumeConversationId,
        initialCommand
      });
    } catch (error) {
      // A refused RESUME is the one create failure with a useful recovery ("open
      // a fresh one instead"), and the daemon guarantees no session was created,
      // so it becomes a toast rather than an unhandled rejection in the
      // fire-and-forget callers. Every other failure keeps the old behaviour.
      const code =
        error instanceof ApiError && error.body && typeof error.body === "object"
          ? (error.body as { code?: unknown }).code
          : undefined;
      if (code === "RESUME_UNAVAILABLE") {
        set({
          resumeError: {
            agentId: refId,
            agentName: title ?? refId,
            message:
              (error as ApiError).serverMessage ??
              "That conversation cannot be resumed with this agent.",
            // Replay material for "Start fresh": the identity and the project
            // this attempt targeted, not whatever is current when it is clicked.
            accountId,
            model,
            projectPath: project?.path ?? ""
          }
        });
        // The refusal means our cached list offered an id the daemon rejects —
        // the transcript is gone or moved. Re-scan so the stale row disappears
        // instead of inviting the same failure again.
        if (project?.path) {
          void get().loadAgentConversations(project.path, true);
        }
        return;
      }
      throw error;
    }
    set((state) => ({
      sessions: upsertSession(state.sessions, session),
      activeTabByProject: project
        ? { ...state.activeTabByProject, [project.path]: session.id }
        : state.activeTabByProject,
      // Surface the daemon's launch-time pre-flight: a claudex/claudemix session
      // whose referenced models the live catalog lacked. Advisory only — the
      // launch still happened — so it's a dismissible toast, not a blocker.
      modelWarning:
        session.missingModels && session.missingModels.length > 0
          ? { title: session.title, models: session.missingModels }
          : state.modelWarning,
      resumeError: null,
      // The agent this just launched is about to write a new conversation (or
      // extend the resumed one), so the cached list for its project is stale.
      agentConversationsByProject: dropConversationCache(
        state.agentConversationsByProject,
        session.projectPath
      )
    }));
    return session;
  },

  dismissModelWarning: () => set({ modelWarning: null }),

  dismissResumeError: () => set({ resumeError: null }),

  startFreshFromResumeError: async () => {
    const error = get().resumeError;
    if (!error) {
      return;
    }
    // Clear first: openTab clears it on success anyway, but a second failure
    // must be able to install a fresh one.
    set({ resumeError: null });
    const { projectPath } = error;
    if (projectPath && get().currentProject?.path !== projectPath) {
      // The user navigated away between the refusal and the click. Go back to
      // the project the conversation belongs to — a fresh session anywhere else
      // is not what the button offered.
      let project = get().projects.find((p) => p.path === projectPath);
      if (!project) {
        const workspace = get().workspaces.find(
          (w) => projectPath === w.path || projectPath.startsWith(`${w.path}/`)
        );
        if (!workspace) {
          return;
        }
        await get().openWorkspace(workspace.name);
        project = get().projects.find((p) => p.path === projectPath);
      }
      if (!project) {
        return;
      }
      get().openProject(project);
    }
    await get().openTab("agent", error.agentId, error.agentName, error.accountId, error.model);
  },

  setNotice: (notice) => set({ notice }),

  dismissNotice: () => set({ notice: null }),

  openFileBrowser: () =>
    set((state) => {
      const project = state.currentProject;
      if (!project) {
        return state;
      }
      const tab: FileTab = { id: crypto.randomUUID(), projectPath: project.path, title: "Files" };
      return {
        fileTabsByProject: {
          ...state.fileTabsByProject,
          [project.path]: [...(state.fileTabsByProject[project.path] ?? []), tab]
        },
        activeTabByProject: { ...state.activeTabByProject, [project.path]: tab.id }
      };
    }),

  // A Git tab is a singleton per project: reuse the existing one if present,
  // otherwise create it (unlike the file browser, which allows multiple).
  openGit: () =>
    set((state) => {
      const project = state.currentProject;
      if (!project) {
        return state;
      }
      const existing = state.gitTabsByProject[project.path]?.[0];
      if (existing) {
        return { activeTabByProject: { ...state.activeTabByProject, [project.path]: existing.id } };
      }
      const tab: GitTab = { id: crypto.randomUUID(), projectPath: project.path, title: "Git" };
      return {
        gitTabsByProject: {
          ...state.gitTabsByProject,
          [project.path]: [tab]
        },
        activeTabByProject: { ...state.activeTabByProject, [project.path]: tab.id }
      };
    }),

  openBrowser: async (url) => {
    const { api, currentProject } = get();
    if (!api || !currentProject) return;
    // Browser tabs stream frames over the WS browser channel; a transport without
    // it (the desktop unix socket) would create a dead blank tab. Refuse rather
    // than open one with no way to render.
    if (!api.browserChannel()) return;
    try {
      const browser = await api.createBrowser({ projectPath: currentProject.path, url });
      set((state) => ({
        browsers: upsertBrowser(state.browsers, browser),
        activeTabByProject: { ...state.activeTabByProject, [currentProject.path]: browser.id }
      }));
    } catch (error) {
      // Callers fire-and-forget (void openBrowser()); don't leak an unhandled
      // rejection. The daemon's 409 carries a useful message (no chromium on
      // host) — log it so the failure is at least diagnosable.
      console.error("Browser tab create failed:", error);
    }
  },

  closeTab: async (id) => {
    const api = get().api;
    const session = get().sessions.find((s) => s.id === id);
    const isSession = Boolean(session);
    const isBrowser = !isSession && get().browsers.some((b) => b.id === id);
    set((state) => {
      const next = isSession
        ? removeSession(state, id)
        : isBrowser
          ? removeBrowser(state, id)
          : removeLocalTab(state, id);
      // The agent it just ran most likely wrote/extended a conversation on disk
      // — drop the cache so the next overview/menu open re-scans. Same `set` as
      // the removal so the tab and its stale cache never disagree mid-render.
      if (session?.kind === "agent") {
        return {
          ...next,
          agentConversationsByProject: dropConversationCache(
            next.agentConversationsByProject ?? state.agentConversationsByProject,
            session.projectPath
          )
        };
      }
      return next;
    });
    if (isSession) {
      await api?.closeSession(id).catch(() => undefined);
    } else if (isBrowser) {
      await api?.closeBrowser(id).catch(() => undefined);
    }
  },

  requestCloseTab: (id) => {
    const state = get();
    const isSession = state.sessions.some((s) => s.id === id);
    // Only live sessions are worth confirming — closing one kills the process.
    if (isSession && state.appConfig.confirmCloseSession) {
      set({ pendingCloseTabId: id });
      return true;
    }
    void state.closeTab(id);
    return false;
  },

  confirmCloseTab: () => {
    const id = get().pendingCloseTabId;
    set({ pendingCloseTabId: null });
    if (id) {
      void get().closeTab(id);
    }
  },

  cancelCloseTab: () => set({ pendingCloseTabId: null }),

  activateTab: (id) =>
    set((state) => {
      // Context key: project path, else workspace name (workspace-context to-do tabs).
      const key = state.currentProject?.path ?? state.currentWorkspace ?? null;
      if (!key) {
        return state;
      }
      return { activeTabByProject: { ...state.activeTabByProject, [key]: id } };
    }),

  setViewMode: (mode) =>
    set((state) => {
      const project = state.currentProject;
      if (!project) {
        return state;
      }
      const viewModeByProject = { ...state.viewModeByProject, [project.path]: mode };
      saveViewModes(viewModeByProject);
      return { viewModeByProject };
    }),

  setPreferredAccount: (agent, accountId) =>
    set((state) => {
      const preferredAccountByAgent = { ...state.preferredAccountByAgent, [agent]: accountId };
      savePreferredAccounts(preferredAccountByAgent);
      return { preferredAccountByAgent };
    }),

  setPreferredModel: (agent, model) =>
    set((state) => {
      const preferredModelByAgent = { ...state.preferredModelByAgent, [agent]: model };
      savePreferredModels(preferredModelByAgent);
      return { preferredModelByAgent };
    }),

  setTerminalFontSize: (size) =>
    set(() => {
      const next = clampTerminalFontSize(size);
      saveTerminalFontSize(next);
      return { terminalFontSize: next };
    }),

  nudgeTerminalFontSize: (delta) =>
    set((state) => {
      const next = clampTerminalFontSize(state.terminalFontSize + delta);
      saveTerminalFontSize(next);
      return { terminalFontSize: next };
    }),

  setColorScheme: (scheme) =>
    set((state) => {
      saveThemePrefs({ scheme, mode: state.themeMode });
      return { colorScheme: scheme };
    }),

  setThemeMode: (mode) =>
    set((state) => {
      saveThemePrefs({ scheme: state.colorScheme, mode });
      return { themeMode: mode };
    }),

  setResolvedMode: (mode) =>
    set((state) => (state.resolvedMode === mode ? {} : { resolvedMode: mode })),

  setSidebarWidth: (px, persist = true) =>
    set(() => {
      const sidebarWidth = clampSidebarWidth(px);
      if (persist) {
        saveSidebarWidth(sidebarWidth);
      }
      return { sidebarWidth };
    }),

  resetSidebarWidth: () =>
    set(() => {
      saveSidebarWidth(SIDEBAR_DEFAULT);
      return { sidebarWidth: SIDEBAR_DEFAULT };
    }),

  setPaneSize: (projectPath, key, px, persist = true) =>
    set((state) => {
      const current = state.paneSizesByProject[projectPath];
      const paneSizesByProject = {
        ...state.paneSizesByProject,
        [projectPath]: { ...current, [key]: clampPaneSize(px) }
      };
      // Persist via a read-merge-write so a commit here can't clobber another
      // tab's freshly-persisted field for the same project.
      if (persist) {
        persistPaneSize(projectPath, key, px);
      }
      return { paneSizesByProject };
    }),

  resetPaneSize: (projectPath, key) =>
    set((state) => {
      const current = state.paneSizesByProject[projectPath];
      if (!current || current[key] === undefined) {
        return state;
      }
      const entry = { ...current };
      delete entry[key];
      const paneSizesByProject = { ...state.paneSizesByProject };
      if (Object.keys(entry).length === 0) {
        delete paneSizesByProject[projectPath];
      } else {
        paneSizesByProject[projectPath] = entry;
      }
      persistPaneSizeReset(projectPath, key);
      return { paneSizesByProject };
    }),

  setGridTracks: (projectPath, tracks, persist = true) =>
    set((state) => {
      // On commit, normalize so stored magnitudes stay bounded (mean 1) no matter
      // how many drags accumulate; the preview (persist=false) keeps raw weights
      // and renders identically (weights are normalized at render either way).
      const entry = persist ? normalizeGridTracks(tracks) : tracks;
      const gridTracksByProject = { ...state.gridTracksByProject, [projectPath]: entry };
      if (persist) {
        persistGridTracks(projectPath, tracks);
      }
      return { gridTracksByProject };
    }),

  resetGridTracks: (projectPath) =>
    set((state) => {
      if (!state.gridTracksByProject[projectPath]) {
        return state;
      }
      const gridTracksByProject = { ...state.gridTracksByProject };
      delete gridTracksByProject[projectPath];
      persistGridTracksReset(projectPath);
      return { gridTracksByProject };
    }),

  renameTab: async (id, title) => {
    const trimmed = title.trim();
    // Optimistic only when non-empty; an empty title is resolved to the default
    // name on the daemon and arrives back via the session.updated broadcast.
    if (trimmed) {
      set((state) => ({
        sessions: state.sessions.map((s) => (s.id === id ? { ...s, title: trimmed } : s))
      }));
    }
    try {
      const updated = await get().api?.renameSession(id, trimmed);
      if (updated) {
        set((state) => ({ sessions: upsertSession(state.sessions, updated) }));
      }
    } catch {
      await get().loadSessions();
    }
  },

  reorderTabs: async (orderedSessionIds) => {
    const project = get().currentProject;
    if (!project) {
      return;
    }
    // Optimistic: assign order by index for this project's sessions.
    set((state) => ({
      sessions: state.sessions.map((s) => {
        const index = orderedSessionIds.indexOf(s.id);
        return s.projectPath === project.path && index !== -1 ? { ...s, order: index } : s;
      })
    }));
    try {
      await get().api?.reorderSessions(project.path, orderedSessionIds);
    } catch {
      await get().loadSessions();
    }
  },

  loadTodos: async (scope, refKey) => {
    const api = get().api;
    if (!api) {
      return;
    }
    try {
      const fetched = await api.listTodos(scope, refKey);
      // Replace any cached records for this (scope, refKey); keep all others.
      set((state) => ({
        todos: [...state.todos.filter((t) => !(t.scope === scope && t.refKey === refKey)), ...fetched]
      }));
    } catch {
      /* keep current cache (never throw into navigation) */
    }
  },

  createTodo: async (scope, refKey, name) => {
    const api = get().api;
    if (!api) {
      return;
    }
    const rec = await api.createTodo({ scope, refKey, name });
    set((state) => ({ todos: upsertTodo(state.todos, rec) }));
    get().openTodo(rec);
  },

  // A to-do tab is a singleton per record: reuse the existing tab for this
  // todoId if present, otherwise create it (modeled on openGit).
  openTodo: (rec) =>
    set((state) => {
      const key = rec.refKey;
      // Workspace-scoped lists live in the workspace context. If a project is open, the
      // workspace main view is hidden behind it, so deselect the project (its tabs are
      // preserved — reopening the project restores them) to bring the list into view.
      const nav = rec.scope === "workspace" && state.currentProject ? { currentProject: null } : {};
      const existing = state.todoTabsByContext[key]?.find((t) => t.todoId === rec.id);
      if (existing) {
        return { ...nav, activeTabByProject: { ...state.activeTabByProject, [key]: existing.id } };
      }
      const tab: TodoTab = {
        id: crypto.randomUUID(),
        contextKey: key,
        todoId: rec.id,
        title: rec.name
      };
      return {
        ...nav,
        todoTabsByContext: {
          ...state.todoTabsByContext,
          [key]: [...(state.todoTabsByContext[key] ?? []), tab]
        },
        activeTabByProject: { ...state.activeTabByProject, [key]: tab.id }
      };
    }),

  renameTodo: async (id, name) => {
    const api = get().api;
    if (!api) {
      return;
    }
    const trimmed = name.trim();
    const record = get().todos.find((t) => t.id === id);
    // Optimistic: update the cached record's name + any open tab's title.
    set((state) => ({
      todos: state.todos.map((t) => (t.id === id ? { ...t, name: trimmed || "Untitled" } : t)),
      todoTabsByContext: renameTodoTabs(state.todoTabsByContext, id, trimmed || "Untitled")
    }));
    try {
      await api.updateTodo(id, { name });
    } catch {
      // Roll back to the server's truth for this record's scope/ref.
      if (record) {
        await get().loadTodos(record.scope, record.refKey);
      }
    }
  },

  saveTodoBody: async (id, body) => {
    const api = get().api;
    if (!api) {
      return;
    }
    const record = get().todos.find((t) => t.id === id);
    // Optimistic: the component already shows the new items; mirror into the cache.
    set((state) => ({
      todos: state.todos.map((t) =>
        t.id === id ? { ...t, body, updatedAt: new Date().toISOString() } : t
      )
    }));
    try {
      await api.updateTodo(id, { body });
    } catch {
      // A failed save shouldn't leave a stale optimistic body in the cache: reload the
      // server's truth (the editor reconciles to it, since no save is pending).
      if (record) {
        await get().loadTodos(record.scope, record.refKey);
      }
    }
  },

  deleteTodo: async (id) => {
    const api = get().api;
    if (!api) {
      return;
    }
    await api.deleteTodo(id);
    set((state) => removeTodoEverywhere(state, id));
  },

  clearSessionAttention: (id) => {
    // The daemon clears attention on input; focusing a tab sends no input, so
    // acknowledgment-on-focus is client-local. Null out the local rendering — a
    // later server event overwrites it with the authoritative snapshot.
    const current = get().activityById[id];
    if (!current || current.attention === null) {
      return;
    }
    set((state) => ({
      activityById: { ...state.activityById, [id]: { ...current, attention: null } }
    }));
  },

  applyEvent: (event) => {
    if (event.channel === "usage") {
      set({ usage: event.payload as UsageResponse });
      return;
    }
    if (event.channel === "agent-accounts") {
      set({ agentAccounts: event.payload as AgentAccountsResponse });
      return;
    }
    if (event.channel === "registry" && event.type === "registry.changed") {
      const entry = event.payload as RegistryEntry;
      set((state) => ({ registry: applyRegistryEntry(state.registry, entry) }));
      return;
    }
    if (event.channel === "cliproxy") {
      // "cliproxy.changed" carries the full status; other cliproxy events (e.g.
      // "cliproxy.crashed") also imply the status shifted — refetch to be safe.
      if (event.type === "cliproxy.changed") {
        set({ cliproxy: event.payload as CliProxyStatus });
      } else {
        void get().loadCliProxy();
      }
      return;
    }
    if (event.channel === "todos") {
      const rec = event.payload as TodoListRecord;
      if (event.type === "todo.created" || event.type === "todo.updated") {
        set((state) => applyTodoUpsert(state, rec)); // upsert cache + sync any open tab's title
      } else if (event.type === "todo.deleted") {
        set((state) => removeTodoEverywhere(state, rec.id)); // drop from cache + close the tab
      }
      return;
    }
    if (event.channel === "projects" && event.type === "recentProjects.changed") {
      // The daemon marks interactions itself (session create) as well as on our
      // POST, so this event — not the POST response — is the authoritative feed.
      // Guard the shape: an older/newer daemon must not put a non-array here.
      // A malformed payload is IGNORED rather than applied as an empty list —
      // clearing a good list because one event was garbage is strictly worse
      // than keeping the last known-good one until the next event/refetch.
      const list = event.payload;
      if (Array.isArray(list)) {
        set({ recentProjects: list as RecentProjectSummary[] });
      }
      return;
    }
    if (event.channel === "browser") {
      if (event.type === "browser.created" || event.type === "browser.updated") {
        const summary = event.payload as BrowserSummary;
        set((state) => ({ browsers: upsertBrowser(state.browsers, summary) }));
      } else if (event.type === "browser.closed") {
        const { id } = event.payload as { id: string };
        set((state) => removeBrowser(state, id));
      }
      return;
    }
    if (event.channel !== "sessions") {
      return;
    }
    if (event.type === "session.activity") {
      const { id, activity } = event.payload as SessionActivityEvent;
      // Mark this entry as event-freshened so an in-flight loadSessions snapshot
      // can't revert it (see activityEventSeq).
      bumpActivityEventSeq(id);
      set((state) => ({ activityById: { ...state.activityById, [id]: activity } }));
      return;
    }
    if (
      event.type === "session.created" ||
      event.type === "session.exited" ||
      event.type === "session.updated"
    ) {
      const summary = event.payload as SessionSummary;
      // Reset activity on exit: the `session.exited` summary deliberately
      // carries none (the daemon drops it for a non-running session), so a
      // working/waiting entry left behind would keep a live-looking dot on a
      // dead session. This is NOT the end of the story — the daemon re-stamps
      // `attention: "finished"` immediately after this broadcast, and that
      // `session.activity` event lands here next and puts the session in the
      // Attention Center's Finished group. Dropping first is what makes the
      // re-stamp's `needsAttentionAt` the moment of the exit.
      if (event.type === "session.exited") {
        set((state) => ({
          sessions: upsertSession(state.sessions, summary),
          activityById: dropActivity(state.activityById, summary.id)
        }));
        return;
      }
      // Seed the activity snapshot the daemon ships on the summary (running
      // sessions only); server "session.activity" events keep it fresh after.
      set((state) => ({
        sessions: upsertSession(state.sessions, summary),
        ...(summary.activity
          ? { activityById: { ...state.activityById, [summary.id]: summary.activity } }
          : {})
      }));
    } else if (event.type === "session.closed") {
      const { id } = event.payload as { id: string };
      set((state) => removeSession(state, id));
    }
  }
}));

/** First remaining tab id for a context (session, then browser, then file, then git, then to-do). */
function firstTabId(
  sessions: SessionSummary[],
  browsers: BrowserSummary[],
  fileTabs: Record<string, FileTab[]>,
  gitTabs: Record<string, GitTab[]>,
  todoTabs: Record<string, TodoTab[]>,
  path: string
): string | null {
  return (
    sessions.find((s) => s.projectPath === path)?.id ??
    browsers.find((b) => b.projectPath === path)?.id ??
    fileTabs[path]?.[0]?.id ??
    gitTabs[path]?.[0]?.id ??
    todoTabs[path]?.[0]?.id ??
    null
  );
}

function reassignActive(
  activeTabByProject: Record<string, string | null>,
  removedId: string,
  sessions: SessionSummary[],
  browsers: BrowserSummary[],
  fileTabs: Record<string, FileTab[]>,
  gitTabs: Record<string, GitTab[]>,
  todoTabs: Record<string, TodoTab[]>
): Record<string, string | null> {
  const next = { ...activeTabByProject };
  for (const [path, activeId] of Object.entries(next)) {
    if (activeId === removedId) {
      next[path] = firstTabId(sessions, browsers, fileTabs, gitTabs, todoTabs, path);
    }
  }
  return next;
}

function removeSession(state: AppState, id: string): Partial<AppState> {
  const sessions = state.sessions.filter((s) => s.id !== id);
  return {
    sessions,
    activityById: dropActivity(state.activityById, id),
    activeTabByProject: reassignActive(
      state.activeTabByProject,
      id,
      sessions,
      state.browsers,
      state.fileTabsByProject,
      state.gitTabsByProject,
      state.todoTabsByContext
    )
  };
}

/** Drop a server-side browser tab by id, reassigning the active tab if it was active. */
function removeBrowser(state: AppState, id: string): Partial<AppState> {
  const browsers = state.browsers.filter((b) => b.id !== id);
  return {
    browsers,
    activeTabByProject: reassignActive(
      state.activeTabByProject,
      id,
      state.sessions,
      browsers,
      state.fileTabsByProject,
      state.gitTabsByProject,
      state.todoTabsByContext
    )
  };
}

/** Drop a client-local (non-session) tab — file browser, git, OR to-do — by id. */
function removeLocalTab(state: AppState, id: string): Partial<AppState> {
  const fileTabsByProject: Record<string, FileTab[]> = {};
  for (const [path, tabs] of Object.entries(state.fileTabsByProject)) {
    fileTabsByProject[path] = tabs.filter((t) => t.id !== id);
  }
  const gitTabsByProject: Record<string, GitTab[]> = {};
  for (const [path, tabs] of Object.entries(state.gitTabsByProject)) {
    gitTabsByProject[path] = tabs.filter((t) => t.id !== id);
  }
  const todoTabsByContext: Record<string, TodoTab[]> = {};
  for (const [key, tabs] of Object.entries(state.todoTabsByContext)) {
    todoTabsByContext[key] = tabs.filter((t) => t.id !== id);
  }
  return {
    fileTabsByProject,
    gitTabsByProject,
    todoTabsByContext,
    activeTabByProject: reassignActive(
      state.activeTabByProject,
      id,
      state.sessions,
      state.browsers,
      fileTabsByProject,
      gitTabsByProject,
      todoTabsByContext
    )
  };
}

/**
 * Upsert a to-do record into the cache and keep any open tab's title in sync
 * (a `todo.created`/`todo.updated` event — possibly a rename on another client).
 */
function applyTodoUpsert(state: AppState, rec: TodoListRecord): Partial<AppState> {
  return {
    todos: upsertTodo(state.todos, rec),
    todoTabsByContext: renameTodoTabs(state.todoTabsByContext, rec.id, rec.name)
  };
}

/**
 * Drop a to-do record from the cache and close any open tab bound to it (a
 * `todo.deleted` event, or a local delete/cascade). Non-destructive close path:
 * removeLocalTab also reassigns the active tab.
 */
function removeTodoEverywhere(state: AppState, todoId: string): Partial<AppState> {
  const todos = state.todos.filter((t) => t.id !== todoId);
  // Find any open tab bound to this record and remove it (reassigning active).
  let tabId: string | null = null;
  for (const tabs of Object.values(state.todoTabsByContext)) {
    const hit = tabs.find((t) => t.todoId === todoId);
    if (hit) {
      tabId = hit.id;
      break;
    }
  }
  if (tabId === null) {
    return { todos };
  }
  return { ...removeLocalTab({ ...state, todos }, tabId), todos };
}

/**
 * Purge the client-local, path-keyed tab maps for project paths matching
 * `match` (used after a workspace/project is deleted — the daemon's
 * session.closed events drop sessions, but these maps are client-only).
 */
function clearProjectLocalState(
  state: AppState,
  match: (path: string) => boolean
): Partial<AppState> {
  const fileTabsByProject: Record<string, FileTab[]> = {};
  for (const [path, tabs] of Object.entries(state.fileTabsByProject)) {
    if (!match(path)) {
      fileTabsByProject[path] = tabs;
    }
  }
  const gitTabsByProject: Record<string, GitTab[]> = {};
  for (const [path, tabs] of Object.entries(state.gitTabsByProject)) {
    if (!match(path)) {
      gitTabsByProject[path] = tabs;
    }
  }
  const activeTabByProject: Record<string, string | null> = {};
  for (const [path, id] of Object.entries(state.activeTabByProject)) {
    if (!match(path)) {
      activeTabByProject[path] = id;
    }
  }
  const viewModeByProject: Record<string, ViewMode> = {};
  for (const [path, mode] of Object.entries(state.viewModeByProject)) {
    if (!match(path)) {
      viewModeByProject[path] = mode;
    }
  }
  const paneSizesByProject: Record<string, PaneSizes> = {};
  for (const [path, sizes] of Object.entries(state.paneSizesByProject)) {
    if (!match(path)) {
      paneSizesByProject[path] = sizes;
    }
  }
  const gridTracksByProject: Record<string, GridTracks> = {};
  for (const [path, tracks] of Object.entries(state.gridTracksByProject)) {
    if (!match(path)) {
      gridTracksByProject[path] = tracks;
    }
  }
  // To-do tabs are keyed by context key (project path here); drop matching keys.
  const todoTabsByContext: Record<string, TodoTab[]> = {};
  for (const [key, tabs] of Object.entries(state.todoTabsByContext)) {
    if (!match(key)) {
      todoTabsByContext[key] = tabs;
    }
  }
  // Drop cached records belonging to the removed scope(s) (project refKey = path).
  const todos = state.todos.filter((t) => !match(t.refKey));
  saveViewModes(viewModeByProject);
  savePaneSizes(paneSizesByProject);
  saveGridTracks(gridTracksByProject);
  return {
    fileTabsByProject,
    gitTabsByProject,
    activeTabByProject,
    viewModeByProject,
    paneSizesByProject,
    gridTracksByProject,
    todoTabsByContext,
    todos
  };
}

/**
 * The active {@link TabContext}, referentially stable across renders.
 *
 * Must NOT be written as `useAppStore(currentContext)`: zustand v5 reads the
 * selector through a bare `useSyncExternalStore` with no memoization, and
 * `currentContext` builds a fresh object on every call, so React sees the
 * snapshot change on each render and bails with "Maximum update depth exceeded"
 * (#185) the moment a project/workspace is selected. Selecting the two stable
 * slices and deriving via `useMemo` keeps the result stable until navigation
 * actually changes — same single-slice + `useMemo` pattern as {@link useProjectTabs}.
 */
export function useCurrentContext(): TabContext | null {
  const currentProject = useAppStore((s) => s.currentProject);
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  return useMemo(
    () => currentContext({ currentProject, currentWorkspace }),
    [currentProject, currentWorkspace]
  );
}

/**
 * Combined tabs of the currently open **context** (a project → sessions + file +
 * git + to-do tabs; a workspace → to-do tabs only). Four single-slice selectors +
 * a `useMemo` (per-slice `Object.is` — no custom equality), mirroring the other
 * tab selectors.
 */
export function useProjectTabs(): ProjectTab[] {
  const sessions = useAppStore((s) => s.sessions);
  const browsers = useAppStore((s) => s.browsers);
  const fileTabsByProject = useAppStore((s) => s.fileTabsByProject);
  const gitTabsByProject = useAppStore((s) => s.gitTabsByProject);
  const todoTabsByContext = useAppStore((s) => s.todoTabsByContext);
  const project = useAppStore((s) => s.currentProject);
  const workspace = useAppStore((s) => s.currentWorkspace);
  return useMemo(() => {
    const key = project?.path ?? workspace ?? null; // context key
    if (!key) {
      return [];
    }
    const todoTabs = (todoTabsByContext[key] ?? []).map<ProjectTab>((t) => ({
      id: t.id,
      type: "todo",
      todoId: t.todoId,
      title: t.title
    }));
    if (!project) {
      return todoTabs; // workspace context: to-do only
    }
    const sessionTabs = sessions
      .filter((s) => s.projectPath === key)
      .slice()
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
      .map<ProjectTab>((session) => ({ id: session.id, type: "session", session }));
    const fileTabs = (fileTabsByProject[key] ?? []).map<ProjectTab>((t) => ({
      id: t.id,
      type: "files",
      title: t.title
    }));
    const gitTabs = (gitTabsByProject[key] ?? []).map<ProjectTab>((t) => ({
      id: t.id,
      type: "git",
      title: t.title
    }));
    const browserTabs = browsers
      .filter((b) => b.projectPath === key)
      .slice()
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
      .map<ProjectTab>((browser) => ({ id: browser.id, type: "browser", browser }));
    return [...sessionTabs, ...browserTabs, ...fileTabs, ...gitTabs, ...todoTabs];
  }, [sessions, browsers, fileTabsByProject, gitTabsByProject, todoTabsByContext, project, workspace]);
}

export function useActiveTabId(): string | null {
  return useAppStore((s) => {
    const key = s.currentProject?.path ?? s.currentWorkspace ?? null;
    return key ? (s.activeTabByProject[key] ?? null) : null;
  });
}

export function useViewMode(): ViewMode {
  return useAppStore((s) =>
    s.currentProject ? (s.viewModeByProject[s.currentProject.path] ?? "tabs") : "tabs"
  );
}

export function useTerminalFontSize(): number {
  return useAppStore((s) => s.terminalFontSize);
}

/** The global sidebar width (px). */
export function useSidebarWidth(): number {
  return useAppStore((s) => s.sidebarWidth);
}

/**
 * The active project's pane-split widths (a stable frozen empty object when the
 * project has none stored, or no project is open — safe to select directly).
 */
export function usePaneSizes(): PaneSizes {
  return useAppStore((s) =>
    s.currentProject ? (s.paneSizesByProject[s.currentProject.path] ?? EMPTY_PANE_SIZES) : EMPTY_PANE_SIZES
  );
}

/** The active project's grid tracks, or `null` when absent/no project open. */
export function useGridTracks(): GridTracks | null {
  return useAppStore((s) =>
    s.currentProject ? (s.gridTracksByProject[s.currentProject.path] ?? null) : null
  );
}

/**
 * Subscribe to a single session's activity slice. Only the dot for the session
 * that transitioned re-renders (other entries keep their object identity across
 * an `activityById` update), so this stays cheap on a chatty output stream.
 */
export function useSessionActivity(id: string): SessionActivity | undefined {
  return useAppStore((s) => s.activityById[id]);
}
