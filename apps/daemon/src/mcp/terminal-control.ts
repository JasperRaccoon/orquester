import { join } from "node:path";
import { statSync } from "node:fs";
import type { ProjectSummary, SessionSummary, WorkspaceSummary } from "@orquester/api";
import { isValidName } from "@orquester/config";
import { assertInsideFsRoot, FsSandboxError } from "@orquester/config/fs";
import type { ISessionManager } from "../sessions.ts";
import type { RegistryService } from "../registry.ts";
import { encodeKey } from "./keys.ts";

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
}
