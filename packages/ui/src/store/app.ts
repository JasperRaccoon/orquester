import { useMemo } from "react";
import { create, type StoreApi } from "zustand";
import { ApiClient, ApiError } from "../lib/api-client";
import { createTransporter } from "../lib/transporters";
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
import type { AppConfigAdapter } from "../lib/app-config";
import type { HttpClient } from "../lib/http-client";
import type { Transporter } from "../lib/transporter";
import { workspaceService } from "../services";
import type {
  AccountSummary,
  AccountTestResult,
  ConnectionStatus,
  CreateProjectRequest,
  EventMessage,
  ProjectSummary,
  RegistryEntry,
  RegistryKind,
  RegistryResponse,
  RepoSummary,
  SessionSummary,
  UiConnection,
  WorkspaceSummary
} from "../types";
import type { TodoListRecord, TodoScope } from "@orquester/api";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const EMPTY_REGISTRY: RegistryResponse = {
  shells: [],
  agents: [],
  ides: [],
  fileExplorers: [],
  browsers: []
};

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
  | { id: string; type: "todo"; todoId: string; title: string };

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

/**
 * Client-derived per-session activity that drives the status dot. `state`
 * reflects output flow (working = PTY output within the last
 * {@link IDLE_THRESHOLD_MS}; idle = quiet, i.e. waiting for the user).
 * `attention` is raised when an agent rings the terminal bell and is cleared
 * once the user looks at / types into the session.
 */
export interface SessionActivity {
  state: "working" | "idle";
  attention: boolean;
}

/** Silence (ms) after the last PTY output before a session is deemed idle/waiting. */
const IDLE_THRESHOLD_MS = 3000;
/** Per-session quiescence timers (module-level: timers aren't store state). */
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Cancel a session's pending quiescence timer, if any. */
function clearIdleTimer(id: string): void {
  const existing = idleTimers.get(id);
  if (existing) {
    clearTimeout(existing);
    idleTimers.delete(id);
  }
}

/**
 * (Re)arm a session's quiescence timer. Each output chunk pushes the deadline
 * out; after {@link IDLE_THRESHOLD_MS} with no further output the session flips
 * working → idle (its bell-driven `attention` flag is preserved).
 */
function rearmIdleTimer(
  id: string,
  get: StoreApi<AppState>["getState"],
  set: StoreApi<AppState>["setState"]
): void {
  clearIdleTimer(id);
  idleTimers.set(
    id,
    setTimeout(() => {
      idleTimers.delete(id);
      const current = get().activityById[id];
      if (current?.state === "working") {
        set((state) => ({
          activityById: { ...state.activityById, [id]: { state: "idle", attention: current.attention } }
        }));
      }
    }, IDLE_THRESHOLD_MS)
  );
}

/** Drop a session's activity entry (returns the same ref when absent → no-op set). */
function dropActivity(
  activityById: Record<string, SessionActivity>,
  id: string
): Record<string, SessionActivity> {
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
  const next: Record<string, TodoTab[]> = {};
  for (const [key, tabs] of Object.entries(todoTabsByContext)) {
    next[key] = tabs.map((t) => (t.todoId === todoId ? { ...t, title } : t));
  }
  return next;
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
  sidebarCollapsed: boolean;
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
  workspaces: WorkspaceSummary[];
  accounts: AccountSummary[];
  workspacesLoading: boolean;
  projects: ProjectSummary[];
  projectsLoading: boolean;

  /** All daemon sessions; a project's sessions are its tabs. */
  sessions: SessionSummary[];
  /** Client-derived working/idle + attention per session id (drives the status dot). */
  activityById: Record<string, SessionActivity>;
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

  setApi: (api: ApiClient) => void;
  connect: () => Promise<void>;
  /** Establish a connected session on an ApiClient (auth, load, subscribe, probe). */
  establish: (api: ApiClient) => Promise<void>;
  /** Called when the transport drops; runs the reconnect loop. */
  handleDisconnect: () => void;

  // connection management
  initConnections: (setup: ConnectionSetup) => Promise<void>;
  selectConnection: (id: string) => Promise<void>;
  addRemote: (input: { name: string; baseUrl: string }) => Promise<string>;
  removeRemote: (id: string) => Promise<void>;
  loadRemotes: () => Promise<void>;

  // git accounts (daemon-persisted; shared across clients of this daemon)
  loadAccounts: () => Promise<void>;
  addAccount: (input: { label: string; token: string }) => Promise<AccountSummary>;
  removeAccount: (id: string) => Promise<void>;
  testAccount: (id: string) => Promise<AccountTestResult>;
  /** Repos the account can reach (for the clone picker). */
  listRepos: (accountId: string) => Promise<RepoSummary[]>;
  /** Org logins the account belongs to (for the create-owner picker). */
  listOrgs: (accountId: string) => Promise<string[]>;
  /** Persist a token (enables repo access); refetches accounts so repoAccess flips. */
  setAccountToken: (accountId: string, token: string) => Promise<void>;

  // app config + settings
  loadAppConfig: () => Promise<void>;
  setSettingsOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setSidebarDrawer: (open: boolean) => void;
  updateAppConfig: (patch: Partial<UiAppConfig>) => Promise<void>;

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
  deleteProject: (project: ProjectSummary) => Promise<void>;
  openProject: (project: ProjectSummary) => void;

  loadSessions: () => Promise<void>;
  loadRegistry: () => Promise<void>;
  installAgent: (id: string) => Promise<void>;
  updateAgent: (id: string) => Promise<void>;
  openTab: (kind: RegistryKind, refId: string, title?: string) => Promise<void>;
  openFileBrowser: () => void;
  openGit: () => void;
  closeTab: (id: string) => Promise<void>;
  activateTab: (id: string) => void;
  setViewMode: (mode: ViewMode) => void;
  renameTab: (id: string, title: string) => Promise<void>;
  reorderTabs: (orderedSessionIds: string[]) => Promise<void>;

  // to-do lists (daemon-owned, synced; scoped to a workspace name or project path)
  loadTodos: (scope: TodoScope, refKey: string) => Promise<void>;
  createTodo: (scope: TodoScope, refKey: string, name?: string) => Promise<void>;
  openTodo: (rec: TodoListRecord) => void;
  renameTodo: (id: string, name: string) => Promise<void>;
  saveTodoBody: (id: string, body: string) => Promise<void>;
  deleteTodo: (id: string) => Promise<void>;

  /** Record output activity for a session (→ working; re-arms its idle timer). */
  noteSessionActivity: (id: string) => void;
  /** Record a terminal bell for a session (→ idle + attention; awaiting the user). */
  noteSessionBell: (id: string) => void;
  /** Clear a session's attention flag (the user looked at / typed into it). */
  clearSessionAttention: (id: string) => void;

  applyEvent: (event: EventMessage) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  api: null,
  connectionStatus: "connecting",
  reconnectAttempt: 0,
  connectionError: null,
  lockedUntil: null,
  connections: [],
  activeConnectionId: null,
  appConfig: { useTitlebar: false, runInBackground: false },
  settingsOpen: false,
  sidebarCollapsed: false,
  sidebarDrawerOpen: false,
  authPrompt: null,
  authSalt: null,
  authRequiresUsername: false,
  currentWorkspace: null,
  currentProject: null,
  registry: EMPTY_REGISTRY,
  workspaces: [],
  accounts: [],
  workspacesLoading: false,
  projects: [],
  projectsLoading: false,
  sessions: [],
  activityById: {},
  fileTabsByProject: {},
  gitTabsByProject: {},
  todoTabsByContext: {},
  todos: [],
  activeTabByProject: {},
  viewModeByProject: loadViewModes(),

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
    set({ connectionStatus: "connected", reconnectAttempt: 0, connectionError: null, lockedUntil: null, authPrompt: null });
    await Promise.all([
      get().loadWorkspaces(),
      get().loadSessions(),
      get().loadRegistry(),
      // Reload git accounts on every (re)connect too — otherwise a daemon
      // restart leaves `accounts` stale (it was only filled by the one-time
      // initConnections path), so the workspace/project pickers go empty until
      // Settings → GitHub refills it. (project-repo-linking bug fix.)
      get().loadAccounts()
    ]);
    // A newer flow may have preempted us during the fan-out: don't open a
    // duplicate events stream or arm a second health probe.
    if (reconnectGenAtStart !== reconnectGen) {
      return;
    }

    // Live event sync. The stream ending unexpectedly (e.g. the transport was
    // restarted) is the primary disconnect signal.
    closeEvents();
    const gen = eventsGen;
    eventsUnsubscribe = active.openEvents(
      (event) => get().applyEvent(event),
      () => {
        if (gen === eventsGen) {
          get().handleDisconnect();
        }
      }
    );

    // Health probe: detect a dropped/restarted transport and auto-reconnect.
    stopHealthProbe();
    healthTimer = setInterval(() => {
      const current = get().api;
      if (current) {
        void current.health().catch(() => get().handleDisconnect());
      }
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
          await delay(backoffMs(attempt));
          if (gen !== reconnectGen) {
            return;
          }
        }
      }
      reconnecting = false;
    };
    void loop();
  },

  initConnections: async (nextSetup) => {
    setup = nextSetup;
    homeApi = new ApiClient(nextSetup.localConnection, buildTransporter(nextSetup.localConnection));
    set({
      connections: [nextSetup.localConnection],
      activeConnectionId: nextSetup.localConnection.id,
      appConfig: { useTitlebar: nextSetup.defaultUseTitlebar, runInBackground: false },
      api: homeApi
    });
    await get().connect();
    // App config + remote servers are shared (persisted on the home daemon).
    await Promise.all([get().loadAppConfig(), get().loadRemotes(), get().loadAccounts()]);
  },

  loadAppConfig: async () => {
    try {
      const adapter = setup?.appConfigAdapter;
      const config = adapter ? await adapter.load() : await homeApi?.getAppConfig();
      if (config) {
        set((state) => ({
          appConfig: {
            useTitlebar: config.useTitlebar ?? state.appConfig.useTitlebar,
            runInBackground: config.runInBackground ?? state.appConfig.runInBackground
          }
        }));
      }
    } catch {
      /* keep defaults */
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

  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

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
    const result = adapter ? adapter.save(full) : homeApi?.updateAppConfig(appConfig);
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
      set({
        api: apiWithCredential(api, ""),
        connectionStatus: "error",
        reconnectAttempt: 0,
        connectionError: null,
        lockedUntil: null,
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
    // Reset all daemon-scoped state: a different server has its own data.
    set({
      api: new ApiClient(connection, buildTransporter(connection)),
      activeConnectionId: id,
      currentWorkspace: null,
      currentProject: null,
      workspaces: [],
      projects: [],
      sessions: [],
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
    const account = await api.createAccount({ label: input.label.trim(), token: input.token.trim() });
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

  listOrgs: async (accountId) => {
    const api = get().api;
    if (!api) {
      throw new Error("Not connected.");
    }
    return api.listOrgs(accountId);
  },

  setAccountToken: async (accountId, token) => {
    const api = get().api;
    if (!api) {
      throw new Error("Not connected.");
    }
    await api.setAccountToken(accountId, token.trim());
    // Refetch so repoAccess flips in the UI (no broadcast; single-user).
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

  openProject: (project) => {
    set((state) => {
      const active = state.activeTabByProject[project.path];
      const fallback = firstTabId(
        state.sessions,
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
  },

  loadSessions: async () => {
    const api = get().api;
    if (!api) {
      return;
    }
    try {
      set({ sessions: await api.listSessions() });
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

  installAgent: async (id) => {
    // Status (installing/installed/error) arrives via the "registry" event bus.
    await get().api?.installRegistryEntry(id).catch(() => undefined);
  },

  updateAgent: async (id) => {
    await get().api?.updateRegistryEntry(id).catch(() => undefined);
  },

  openTab: async (kind, refId, title) => {
    const api = get().api;
    if (!api) {
      return;
    }
    const project = get().currentProject;
    const session = await api.createSession({
      kind,
      refId,
      title,
      projectPath: project?.path ?? "",
      cwd: project?.path
    });
    set((state) => ({
      sessions: upsertSession(state.sessions, session),
      activeTabByProject: project
        ? { ...state.activeTabByProject, [project.path]: session.id }
        : state.activeTabByProject
    }));
  },

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

  closeTab: async (id) => {
    const api = get().api;
    const isSession = get().sessions.some((s) => s.id === id);
    set((state) => (isSession ? removeSession(state, id) : removeLocalTab(state, id)));
    if (isSession) {
      await api?.closeSession(id).catch(() => undefined);
    }
  },

  activateTab: (id) =>
    set((state) => {
      const project = state.currentProject;
      if (!project) {
        return state;
      }
      return { activeTabByProject: { ...state.activeTabByProject, [project.path]: id } };
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
      const existing = state.todoTabsByContext[key]?.find((t) => t.todoId === rec.id);
      if (existing) {
        return { activeTabByProject: { ...state.activeTabByProject, [key]: existing.id } };
      }
      const tab: TodoTab = {
        id: crypto.randomUUID(),
        contextKey: key,
        todoId: rec.id,
        title: rec.name
      };
      return {
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
    // Optimistic: the component already shows the new items; mirror into the cache.
    set((state) => ({
      todos: state.todos.map((t) =>
        t.id === id ? { ...t, body, updatedAt: new Date().toISOString() } : t
      )
    }));
    await api.updateTodo(id, { body });
  },

  deleteTodo: async (id) => {
    const api = get().api;
    if (!api) {
      return;
    }
    await api.deleteTodo(id);
    set((state) => removeTodoEverywhere(state, id));
  },

  noteSessionActivity: (id) => {
    rearmIdleTimer(id, get, set);
    const current = get().activityById[id];
    // Already shown as working with nothing to clear → the timer re-arm above is
    // all that's needed; skip the set() so a streaming burst doesn't churn renders.
    if (current && current.state === "working" && !current.attention) {
      return;
    }
    set((state) => ({
      activityById: { ...state.activityById, [id]: { state: "working", attention: false } }
    }));
  },

  noteSessionBell: (id) => {
    // The bell is an explicit "done — your turn": go idle immediately (skip the
    // quiescence wait) and raise attention so the dot pulses until acknowledged.
    clearIdleTimer(id);
    set((state) => ({
      activityById: { ...state.activityById, [id]: { state: "idle", attention: true } }
    }));
  },

  clearSessionAttention: (id) => {
    const current = get().activityById[id];
    if (!current || !current.attention) {
      return;
    }
    set((state) => ({
      activityById: { ...state.activityById, [id]: { ...current, attention: false } }
    }));
  },

  applyEvent: (event) => {
    if (event.channel === "registry" && event.type === "registry.changed") {
      const entry = event.payload as RegistryEntry;
      set((state) => ({ registry: applyRegistryEntry(state.registry, entry) }));
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
    if (event.channel !== "sessions") {
      return;
    }
    if (
      event.type === "session.created" ||
      event.type === "session.exited" ||
      event.type === "session.updated"
    ) {
      const summary = event.payload as SessionSummary;
      // A real process exit makes activity meaningless (the gray "exited" dot
      // wins): drop tracking + the pending timer so a late quiescence fire can't
      // resurrect a working/idle dot on a dead session.
      if (event.type === "session.exited") {
        clearIdleTimer(summary.id);
        set((state) => ({
          sessions: upsertSession(state.sessions, summary),
          activityById: dropActivity(state.activityById, summary.id)
        }));
        return;
      }
      set((state) => ({ sessions: upsertSession(state.sessions, summary) }));
    } else if (event.type === "session.closed") {
      const { id } = event.payload as { id: string };
      set((state) => removeSession(state, id));
    }
  }
}));

/** First remaining tab id for a context (session, then file, then git, then to-do). */
function firstTabId(
  sessions: SessionSummary[],
  fileTabs: Record<string, FileTab[]>,
  gitTabs: Record<string, GitTab[]>,
  todoTabs: Record<string, TodoTab[]>,
  path: string
): string | null {
  return (
    sessions.find((s) => s.projectPath === path)?.id ??
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
  fileTabs: Record<string, FileTab[]>,
  gitTabs: Record<string, GitTab[]>,
  todoTabs: Record<string, TodoTab[]>
): Record<string, string | null> {
  const next = { ...activeTabByProject };
  for (const [path, activeId] of Object.entries(next)) {
    if (activeId === removedId) {
      next[path] = firstTabId(sessions, fileTabs, gitTabs, todoTabs, path);
    }
  }
  return next;
}

function removeSession(state: AppState, id: string): Partial<AppState> {
  clearIdleTimer(id);
  const sessions = state.sessions.filter((s) => s.id !== id);
  return {
    sessions,
    activityById: dropActivity(state.activityById, id),
    activeTabByProject: reassignActive(
      state.activeTabByProject,
      id,
      sessions,
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
  return {
    fileTabsByProject,
    gitTabsByProject,
    activeTabByProject,
    viewModeByProject,
    todoTabsByContext,
    todos
  };
}

/**
 * Combined tabs of the currently open **context** (a project → sessions + file +
 * git + to-do tabs; a workspace → to-do tabs only). Four single-slice selectors +
 * a `useMemo` (per-slice `Object.is` — no custom equality), mirroring the other
 * tab selectors.
 */
export function useProjectTabs(): ProjectTab[] {
  const sessions = useAppStore((s) => s.sessions);
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
    return [...sessionTabs, ...fileTabs, ...gitTabs, ...todoTabs];
  }, [sessions, fileTabsByProject, gitTabsByProject, todoTabsByContext, project, workspace]);
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

/**
 * Subscribe to a single session's activity slice. Only the dot for the session
 * that transitioned re-renders (other entries keep their object identity across
 * an `activityById` update), so this stays cheap on a chatty output stream.
 */
export function useSessionActivity(id: string): SessionActivity | undefined {
  return useAppStore((s) => s.activityById[id]);
}
