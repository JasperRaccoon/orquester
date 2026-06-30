import { join } from "node:path";
import { statSync } from "node:fs";
import type { ProjectSummary, SessionSummary, WorkspaceSummary } from "@orquester/api";
import { isValidName } from "@orquester/config";
import { assertInsideFsRoot, FsSandboxError } from "@orquester/config/fs";
import type { ISessionManager } from "../sessions.ts";
import type { RegistryService } from "../registry.ts";
import { encodeKey } from "./keys.ts";

const DEFAULT_IDLE_MS = 1000;
const DEFAULT_TIMEOUT_MS = 120_000; // 2 min
const MAX_TIMEOUT_MS = 600_000;     // 10 min ceiling

export type WaitResult = {
  text: string;
  settled: boolean;
  status: SessionSummary["status"];
  exitCode?: number;
  aborted?: boolean;
};

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
    return { text, status: t.status, exitCode: t.exitCode, cols: t.cols, rows: t.rows };
  }

  writeInput(sel: TabSelector, data: string, opts?: { submit?: boolean }) {
    const t = this.resolveTab(sel);
    this.deps.sessions.input(t.id, opts?.submit ? `${data}\r` : data); // Enter == CR in a PTY
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
    }));
  }

  listLaunchers() {
    const r = this.deps.registry.list();
    return [...r.shells, ...r.agents]
      .filter((e) => e.enabled)
      .map((e) => ({ id: e.id, name: e.name, kind: e.kind, version: e.version }));
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
      const unsub = sessions.subscribe(t.id, () => arm(), () => done(true));
      sig?.addEventListener("abort", onAbort, { once: true });
      if (sig?.aborted) {
        done(false);
        return;
      }
      // Subscribe is in place — now write, then start the idle countdown.
      sessions.input(t.id, opts?.submit ? `${data}\r` : data);
      arm();
    });
    if (sig?.aborted) {
      return { text: "", settled: false, aborted: true, status: sessions.get(t.id)?.status ?? "exited" };
    }
    const after = sessions.get(t.id);
    const text = await sessions.captureText(t.id, { lines: opts?.lines ?? 0 });
    return { text, settled, status: after?.status ?? "exited", exitCode: after?.exitCode };
  }
}
