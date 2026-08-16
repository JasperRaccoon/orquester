import { useAppStore } from "../store/app";
import type { ProjectSummary, WorkspaceSummary } from "../types";

/**
 * Surfaces that own their keystrokes, where an app-level shortcut must stand
 * down: the terminal (Ctrl+K is readline's kill-line, Ctrl+A beginning-of-line)
 * and a Design-Mode browser tab, whose keys are forwarded to a remote page.
 * One selector so every global shortcut bails on exactly the same set.
 */
export const SHORTCUT_BAIL_SELECTOR = ".xterm, [data-browser-view]";

/**
 * True when `target` sits inside a surface that owns its own key handling.
 * Duck-typed rather than `instanceof Element`: the target may come from
 * another realm (the DevTools iframe), and a non-element target is common.
 */
export function insideShortcutBailZone(target: EventTarget | null): boolean {
  const element = target as Element | null;
  return typeof element?.closest === "function"
    ? element.closest(SHORTCUT_BAIL_SELECTOR) !== null
    : false;
}

/**
 * A project path is `<workspacesDir>/<workspace>/<project>`, so the owning
 * workspace is whichever known workspace path prefixes it. Falls back to the
 * last two path segments when the workspace list hasn't loaded yet — `path` is
 * always the untouched `projectPath`, which is what keys the store's
 * per-project tab state.
 *
 * `knownProjects` (the store's list for the open workspace) supplies the real
 * `isArchived` flag; without it the ref would claim "not archived" for a
 * project the archived curtain is meant to hide, so it is never omitted —
 * callers with a wider index (the command palette) narrow it further.
 */
export function resolveProjectRef(
  projectPath: string,
  workspaces: readonly WorkspaceSummary[],
  knownProjects: readonly ProjectSummary[] = []
): ProjectSummary {
  const known = knownProjects.find((project) => project.path === projectPath);
  if (known) {
    return known;
  }
  const workspace = workspaces.find(
    (w) => projectPath.startsWith(`${w.path}/`) || projectPath.startsWith(`${w.path}\\`)
  );
  if (workspace) {
    const rest = projectPath.slice(workspace.path.length + 1).split(/[\\/]/).filter(Boolean);
    return {
      name: rest[0] ?? workspace.name,
      workspace: workspace.name,
      path: projectPath,
      isArchived: false
    };
  }
  const segments = projectPath.split(/[\\/]/).filter(Boolean);
  return {
    name: segments.at(-1) ?? projectPath,
    workspace: segments.at(-2) ?? "",
    path: projectPath,
    isArchived: false
  };
}

/**
 * The archived curtain, evaluated on store data alone: hide a project that is
 * flagged archived, or that lives in an archived workspace. Projects in a
 * workspace the store hasn't listed carry no flag of their own, so only the
 * workspace check applies there.
 */
export function isProjectRefVisible(
  project: ProjectSummary,
  workspaces: readonly WorkspaceSummary[]
): boolean {
  if (project.isArchived) {
    return false;
  }
  return !workspaces.find((w) => w.name === project.workspace)?.isArchived;
}

export interface JumpTarget {
  project: ProjectSummary;
  /** Tab to activate after opening the project; omit to just open the project. */
  sessionId?: string;
}

/**
 * The one "go there" navigation used by the attention center and the command
 * palette: reveal the owning workspace (it may not be the open one), open the
 * project, activate the tab. `openWorkspace` is left un-awaited on purpose — it
 * sets `currentWorkspace` synchronously, and its project fetch resolves later
 * without touching the current project.
 *
 * Returns whether the visible tab actually changed. Callers use that to decide
 * whether to hand focus back where it came from: a changed tab mounts a view
 * that claims focus itself, an unchanged one would strand focus on `body`.
 */
export function jumpToProject({ project, sessionId }: JumpTarget): boolean {
  const state = useAppStore.getState();
  const sameProject = state.currentProject?.path === project.path;
  const changed =
    !sameProject || (sessionId !== undefined && state.activeTabByProject[project.path] !== sessionId);
  if (project.workspace && state.currentWorkspace !== project.workspace) {
    void state.openWorkspace(project.workspace);
  }
  state.openProject(project);
  if (sessionId !== undefined) {
    state.activateTab(sessionId);
  }
  return changed;
}
