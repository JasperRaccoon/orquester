import { join } from "node:path";
import { statSync } from "node:fs";
import type { ProjectSummary, SessionSummary, WorkspaceSummary } from "@orquester/api";
import { isValidName } from "@orquester/config";
import { assertInsideFsRoot } from "@orquester/config/fs";
import type { ISessionManager } from "../sessions.ts";
import type { RegistryService } from "../registry.ts";
import { encodeKey } from "./keys.ts";

const DEFAULT_IDLE_MS = 1000;
const DEFAULT_TIMEOUT_MS = 120_000; // 2 min
const MAX_TIMEOUT_MS = 600_000;     // 10 min ceiling
export const ACTIVITY_WORKING_MS = 3000;
// On submit, send Enter as its OWN write this long after the text. A coding-agent TUI
// (Claude Code) treats a bulk single-chunk write ending in CR as a *paste* and keeps
// the trailing newline literal — so `${data}\r` in one write types the message but never
// submits. Decoupling the CR into a discrete, later keystroke makes it a real Enter that
// submits. Harmless for shells (they submit on CR regardless of pacing).
const SUBMIT_ENTER_DELAY_MS = 150;

export type WaitResult = {
  text: string;
  settled: boolean;
  status: SessionSummary["status"];
  exitCode?: number;
  aborted?: boolean;
};

export type AttentionResult = {
  tabs: {
    id: string;
    title: string;
    status: SessionSummary["status"];
    activity?: "working" | "idle";
    attention?: boolean;
    lastOutputAt?: string;
  }[];
  settled: boolean;
  aborted?: boolean;
};

type ActivityFields = Partial<Pick<AttentionResult["tabs"][number], "activity" | "attention" | "lastOutputAt">>;

/** A tab is addressed by (workspace,project,tab) name, or by opaque tabId. */
export type TabSelector = { workspace?: string; project?: string; tab?: string; tabId?: string };

/** No such tab/project (message includes the available titles). */
export class TabNotFound extends Error {}
/** Name resolves to >1 running tab (message includes the {title=id} list). */
export class AmbiguousTab extends Error {}
/** Generic tool-level reject with a safe, surfaceable message (bad selector, launcher kind, tab limit). */
export class ToolError extends Error {}

export const MAX_TABS_PER_PROJECT = 24;

export interface TerminalControlDeps {
  sessions: ISessionManager;
  registry: RegistryService;
  /** (workspace,project) → projectPath via join (matches how sessions are created). */
  workspacesDir: string;
  /** Sandbox root for create_tab's cwd (resolved.fsRoot — may differ from workspacesDir). */
  fsRoot: string;
  listWorkspaces: () => Promise<WorkspaceSummary[]>;
  listProjects: (workspace: string) => Promise<ProjectSummary[]>;
}

/** node:fs statSync that returns undefined instead of throwing on ENOENT. */
function statSafe(p: string) {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
}

export class TerminalControl {
  constructor(private readonly deps: TerminalControlDeps) {}

  private activityFields(t: SessionSummary): ActivityFields {
    if (t.status !== "running") {
      return {};
    }
    const activity = this.deps.sessions.activity(t.id);
    if (!activity) {
      return {};
    }
    const fields: { activity: "working" | "idle"; attention: boolean; lastOutputAt?: string } = {
      activity:
        activity.lastOutputAt !== null && Date.now() - activity.lastOutputAt < ACTIVITY_WORKING_MS
          ? "working"
          : "idle",
      attention: activity.attention,
    };
    if (activity.lastOutputAt !== null) {
      fields.lastOutputAt = new Date(activity.lastOutputAt).toISOString();
    }
    return fields;
  }

  private attentionTab(t: SessionSummary): AttentionResult["tabs"][number] {
    return { id: t.id, title: t.title, status: t.status, ...this.activityFields(t) };
  }

  /** Name-first, id fallback. Prefers a running match; ambiguity is fatal (never guesses). */
  resolveTab(sel: TabSelector): SessionSummary {
    const { sessions, workspacesDir } = this.deps;
    if (sel.tabId) {
      const s = sessions.get(sel.tabId);
      if (!s) {
        throw new TabNotFound(`No tab with id ${sel.tabId}.`);
      }
      return s;
    }
    if (!sel.workspace || !sel.project || !sel.tab) {
      throw new ToolError("Provide tabId, or all of workspace+project+tab.");
    }
    if (!isValidName(sel.workspace) || !isValidName(sel.project)) {
      throw new TabNotFound("Invalid workspace/project name.");
    }
    const projectPath = join(workspacesDir, sel.workspace, sel.project);
    const tabs = sessions.list(projectPath);
    let matches = tabs.filter((t) => t.title.toLowerCase() === sel.tab!.toLowerCase());
    if (matches.length === 0) {
      throw new TabNotFound(
        `No tab "${sel.tab}". Open tabs: ${tabs.map((t) => t.title).join(", ") || "(none)"}.`
      );
    }
    // Exited tabs linger until close(), so prefer running to avoid permanent ambiguity.
    const running = matches.filter((m) => m.status === "running");
    if (running.length === 1) {
      return running[0];
    }
    matches = running.length ? running : matches;
    if (matches.length > 1) {
      throw new AmbiguousTab(
        `"${sel.tab}" is ambiguous (${matches.length}). Retry with tabId: ` +
          matches.map((m) => `${m.title}=${m.id} (${m.status})`).join(", ")
      );
    }
    return matches[0];
  }

  async readTerminal(sel: TabSelector, opts?: { lines?: number }) {
    const t = this.resolveTab(sel);
    const text = await this.deps.sessions.captureText(t.id, { lines: opts?.lines ?? 0 });
    return { text, status: t.status, exitCode: t.exitCode, cols: t.cols, rows: t.rows, ...this.activityFields(t) };
  }

  async writeInput(sel: TabSelector, data: string, opts?: { submit?: boolean }) {
    const t = this.resolveTab(sel);
    this.deps.sessions.input(t.id, data);
    if (opts?.submit) {
      // Enter as a SEPARATE, delayed keystroke — NOT `${data}\r` in one write — so a
      // coding-agent TUI doesn't paste-eat the newline (see SUBMIT_ENTER_DELAY_MS).
      await new Promise((r) => setTimeout(r, SUBMIT_ENTER_DELAY_MS));
      this.deps.sessions.input(t.id, "\r");
    }
    return { ok: true as const };
  }

  sendKeys(sel: TabSelector, keys: string[]) {
    const t = this.resolveTab(sel);
    let encoded: string;
    try {
      encoded = keys.map(encodeKey).join("");
    } catch (e) {
      throw new ToolError(e instanceof Error ? e.message : "Unknown key.");
    }
    this.deps.sessions.input(t.id, encoded);
    return { ok: true as const };
  }

  listTabs(sel: { workspace: string; project: string }) {
    if (!isValidName(sel.workspace) || !isValidName(sel.project)) {
      throw new TabNotFound("Invalid workspace/project name.");
    }
    const projectPath = join(this.deps.workspacesDir, sel.workspace, sel.project);
    return this.deps.sessions.list(projectPath).map((t) => ({
      id: t.id, title: t.title, kind: t.kind, refId: t.refId,
      status: t.status, exitCode: t.exitCode, order: t.order,
      ...this.activityFields(t),
    }));
  }

  listLaunchers() {
    const r = this.deps.registry.list();
    return [...r.shells, ...r.agents]
      .filter((e) => e.enabled)
      .map((e) => ({ id: e.id, name: e.name, kind: e.kind, version: e.version }));
  }

  async listWorkspacesProjected() {
    return this.deps.listWorkspaces();
  }

  async listProjectsProjected(workspace: string) {
    if (!isValidName(workspace)) {
      throw new TabNotFound("Invalid workspace name.");
    }
    return this.deps.listProjects(workspace);
  }

  /** Subscribe → debounce on output → resolve on idle/exit/cap/abort. Shared by both waits. */
  private async runWait(id: string, opts: { idleMs?: number; timeoutMs?: number; signal?: AbortSignal }) {
    const { sessions } = this.deps;
    const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    const timeoutMs = Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const sig = opts.signal;
    return new Promise<boolean>((resolve) => {
      let idleTimer: ReturnType<typeof setTimeout>;
      let resolved = false;
      const done = (ok: boolean) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(idleTimer);
        clearTimeout(hardTimer);
        unsub();
        sig?.removeEventListener("abort", onAbort);
        resolve(ok);
      };
      const arm = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => done(true), idleMs);
      };
      const onAbort = () => done(false);
      const hardTimer = setTimeout(() => done(false), timeoutMs);
      const unsub = sessions.subscribe(id, () => arm(), () => done(true)); // output re-arms; exit settles
      sig?.addEventListener("abort", onAbort, { once: true });
      if (sig?.aborted) {
        done(false);
        return;
      }
      arm(); // start the idle countdown immediately
    });
  }

  /** Pure wait (no write) — the re-invoke path. Inspect `text` for a prompt regardless of `settled`. */
  async waitForIdle(
    sel: TabSelector,
    opts?: { idleMs?: number; timeoutMs?: number; lines?: number; signal?: AbortSignal }
  ): Promise<WaitResult> {
    const t = this.resolveTab(sel);
    const settled = await this.runWait(t.id, opts ?? {});
    if (opts?.signal?.aborted) {
      // Don't fabricate "exited"; don't touch a dead transport.
      return { text: "", settled: false, aborted: true, status: this.deps.sessions.get(t.id)?.status ?? "exited" };
    }
    const after = this.deps.sessions.get(t.id);
    const text = await this.deps.sessions.captureText(t.id, { lines: opts?.lines ?? 0 });
    return { text, settled, status: after?.status ?? "exited", exitCode: after?.exitCode };
  }

  async waitForAttention(
    sel: TabSelector,
    opts?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<AttentionResult> {
    const { sessions, workspacesDir } = this.deps;
    let watched: SessionSummary[];
    if (sel.tabId || sel.tab) {
      watched = [this.resolveTab(sel)];
    } else if (sel.workspace && sel.project) {
      if (!isValidName(sel.workspace) || !isValidName(sel.project)) {
        throw new TabNotFound("Invalid workspace/project name.");
      }
      const projectPath = join(workspacesDir, sel.workspace, sel.project);
      watched = sessions.list(projectPath).filter((t) => t.status === "running");
      if (watched.length === 0) {
        throw new ToolError(`No running tabs in "${sel.workspace}/${sel.project}".`);
      }
    } else {
      throw new ToolError("Provide tabId, workspace+project, or all of workspace+project+tab.");
    }

    const immediate = watched.filter((t) => t.status === "exited" || sessions.activity(t.id)?.attention);
    if (immediate.length > 0) {
      return { tabs: immediate.map((t) => this.attentionTab(t)), settled: true };
    }

    const watchedIds = new Set(watched.map((t) => t.id));
    const timeoutMs = Math.min(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const sig = opts?.signal;
    return new Promise<AttentionResult>((resolve) => {
      let resolved = false;
      const done = (result: AttentionResult) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(hardTimer);
        sessions.lifecycle.off("activity", onActivity);
        sessions.lifecycle.off("exited", onExited);
        sig?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onActivity = (event: { id: string; type: string }) => {
        if (event.type !== "bell" || !watchedIds.has(event.id)) {
          return;
        }
        const tab = sessions.get(event.id) ?? watched.find((t) => t.id === event.id);
        if (tab) {
          done({ tabs: [this.attentionTab(tab)], settled: true });
        }
      };
      const onExited = (tab: SessionSummary) => {
        if (!watchedIds.has(tab.id)) {
          return;
        }
        done({ tabs: [this.attentionTab(tab)], settled: true });
      };
      const onAbort = () => done({ tabs: [], settled: false, aborted: true });
      const hardTimer = setTimeout(() => done({ tabs: [], settled: false }), timeoutMs);

      sessions.lifecycle.on("activity", onActivity);
      sessions.lifecycle.on("exited", onExited);
      sig?.addEventListener("abort", onAbort, { once: true });
      if (sig?.aborted) {
        done({ tabs: [], settled: false, aborted: true });
      }
    });
  }

  /** Write input, then wait. Subscribes BEFORE writing so the response is never missed. */
  async sendAndWait(
    sel: TabSelector,
    data: string,
    opts?: { submit?: boolean; idleMs?: number; timeoutMs?: number; lines?: number; signal?: AbortSignal }
  ): Promise<WaitResult> {
    const t = this.resolveTab(sel);
    const { sessions } = this.deps;
    const idleMs = opts?.idleMs ?? DEFAULT_IDLE_MS;
    const timeoutMs = Math.min(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const sig = opts?.signal;
    const settled = await new Promise<boolean>((resolve) => {
      let idleTimer: ReturnType<typeof setTimeout>;
      let submitTimer: ReturnType<typeof setTimeout> | undefined;
      let resolved = false;
      const done = (ok: boolean) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(idleTimer);
        clearTimeout(submitTimer);
        clearTimeout(hardTimer);
        unsub();
        sig?.removeEventListener("abort", onAbort);
        resolve(ok);
      };
      const arm = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => done(true), idleMs);
      };
      const onAbort = () => done(false);
      const hardTimer = setTimeout(() => done(false), timeoutMs);
      const unsub = sessions.subscribe(t.id, () => arm(), () => done(true));
      sig?.addEventListener("abort", onAbort, { once: true });
      if (sig?.aborted) {
        done(false);
        return;
      }
      // Subscribe is in place — type the text, then on submit send Enter as a SEPARATE
      // delayed keystroke (so a TUI doesn't paste-eat the newline; see
      // SUBMIT_ENTER_DELAY_MS) before starting the idle countdown.
      sessions.input(t.id, data);
      if (opts?.submit) {
        submitTimer = setTimeout(() => {
          if (resolved) return; // wait already ended (abort/cap) — don't write into a dead flow
          sessions.input(t.id, "\r");
          arm();
        }, SUBMIT_ENTER_DELAY_MS);
      } else {
        arm();
      }
    });
    if (sig?.aborted) {
      return { text: "", settled: false, aborted: true, status: sessions.get(t.id)?.status ?? "exited" };
    }
    const after = sessions.get(t.id);
    const text = await sessions.captureText(t.id, { lines: opts?.lines ?? 0 });
    return { text, settled, status: after?.status ?? "exited", exitCode: after?.exitCode };
  }

  /**
   * Launch a new tab (shell/agent) in a project. Async because assertInsideFsRoot
   * realpaths — it MUST be awaited (un-awaited + swapped args would bypass the
   * sandbox AND crash-loop the daemon via an unhandled rejection).
   */
  async createTab(
    sel: { workspace: string; project: string },
    opts: { refId: string; title?: string; cwd?: string }
  ): Promise<SessionSummary> {
    const { sessions, registry, workspacesDir, fsRoot } = this.deps;
    if (!isValidName(sel.workspace) || !isValidName(sel.project)) {
      throw new TabNotFound("Invalid workspace/project name.");
    }
    const projectPath = join(workspacesDir, sel.workspace, sel.project);
    if (!statSafe(projectPath)?.isDirectory()) {
      // A FILE would pass existsSync then fail async in tmux — reject cleanly first.
      throw new TabNotFound(`No project "${sel.project}" in "${sel.workspace}".`);
    }
    // SECURITY: assertInsideFsRoot(ROOT, target), async, awaited, root = fsRoot.
    const cwd = await assertInsideFsRoot(fsRoot, opts.cwd ?? projectPath); // throws FsSandboxError
    // Only launch SESSION kinds: create() checks resolvedBin+enabled but NOT kind,
    // so a bare create() would launch an ide/browser, and claude/codex carry
    // --dangerously-skip-permissions/--yolo. Restrict to what list_launchers shows.
    const entry = registry.get(opts.refId);
    if (!entry?.enabled || (entry.kind !== "shell" && entry.kind !== "agent")) {
      throw new ToolError(`"${opts.refId}" is not a launchable shell or agent.`);
    }
    // Count cap — sessions persist across restart and reattach() re-spawns them all.
    const running = sessions.list(projectPath).filter((s) => s.status === "running").length;
    if (running >= MAX_TABS_PER_PROJECT) {
      throw new ToolError(`Tab limit reached for "${sel.project}" (${MAX_TABS_PER_PROJECT}).`);
    }
    return sessions.create({ kind: entry.kind, refId: opts.refId, projectPath, cwd, title: opts.title });
  }

  closeTab(sel: TabSelector) {
    const t = this.resolveTab(sel); // errors on ambiguity → never kills the wrong tab
    this.deps.sessions.close(t.id);
    return { closed: true as const };
  }
}
