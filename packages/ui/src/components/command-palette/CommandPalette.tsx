import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Box, Search } from "lucide-react";
import { cn } from "../../lib/cn";
import { cachedProjectIndex, refreshProjectIndex, type ProjectIndex } from "../../lib/project-index";
import { jumpToProject } from "../../lib/session-nav";
import { useApi } from "../../context/orquester-context";
import { useAppStore } from "../../store/app";
import { RegistryIcon } from "../../icons";
import type { ProjectSummary, SessionSummary } from "../../types";

/** One selectable row: an open session tab, or a project to jump into. */
interface SessionRow {
  key: string;
  kind: "session";
  session: SessionSummary;
  project: ProjectSummary;
}
interface ProjectRow {
  key: string;
  kind: "project";
  project: ProjectSummary;
}
type PaletteItem = SessionRow | ProjectRow;

/** Stable empty map for "the index hasn't resolved yet" — a fresh one would re-memo every render. */
const EMPTY_PROJECTS: ReadonlyMap<string, ProjectSummary> = new Map();

/**
 * Mounted palettes, so a shortcut or a button can drive the open state from
 * outside React without routing it through the store hub. Both openers report
 * whether a palette actually took the request, which is what lets the global
 * shortcut leave the key alone when it didn't.
 */
interface PaletteController {
  open: () => boolean;
  toggle: () => boolean;
  isOpen: () => boolean;
}
const controllers = new Set<PaletteController>();

/** Whether a palette is currently up — other global shortcuts stand down while it is. */
export function isCommandPaletteOpen(): boolean {
  for (const controller of controllers) {
    if (controller.isOpen()) {
      return true;
    }
  }
  return false;
}

/** Open the palette (no-op when it is open, or when opening is not allowed). */
export function openCommandPalette(): boolean {
  for (const controller of controllers) {
    if (controller.open()) {
      return true;
    }
  }
  return false;
}

/** Open/close the palette — the `Ctrl/Cmd+K` behaviour. */
export function toggleCommandPalette(): boolean {
  for (const controller of controllers) {
    if (controller.toggle()) {
      return true;
    }
  }
  return false;
}

/**
 * Split `text` around the first case-insensitive occurrence of `query` so the
 * matched run can be emphasised. Empty query = no match.
 */
function splitMatch(text: string, query: string): [string, string, string] | null {
  if (!query) {
    return null;
  }
  const at = text.toLowerCase().indexOf(query);
  if (at < 0) {
    return null;
  }
  return [text.slice(0, at), text.slice(at, at + query.length), text.slice(at + query.length)];
}

/** `text` with the matched substring highlighted (plain text when it doesn't match). */
const Highlighted: React.FC<{ text: string; query: string }> = ({ text, query }) => {
  const parts = splitMatch(text, query);
  if (!parts) {
    return <>{text}</>;
  }
  return (
    <>
      {parts[0]}
      <span className="font-medium text-amber-300">{parts[1]}</span>
      {parts[2]}
    </>
  );
};

function matches(text: string, query: string): boolean {
  return text.toLowerCase().includes(query);
}

/**
 * Global "go to" palette (`Ctrl/Cmd+K`, or the topbar button on mobile): open
 * session tabs first, then projects. Empty query lists every open session plus
 * the projects that have one (the "active" set); typing searches session
 * titles, project names and workspace names across every workspace.
 *
 * Every row — session rows included — comes out of the shared project index, so
 * nothing is ever listed before the daemon has confirmed its project is an
 * unarchived project of an unarchived workspace. Resolving sessions from the
 * store instead would show them one frame earlier and then retract the archived
 * ones, which is exactly the curtain leak this is here to avoid; the index is
 * cached across opens, so in practice only the very first open waits.
 */
export const CommandPalette: React.FC = () => {
  const api = useApi();
  const sessions = useAppStore((s) => s.sessions);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<ProjectIndex | null>(null);
  const [highlight, setHighlight] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const highlightedRef = useRef<HTMLButtonElement>(null);
  // `open` for the always-mounted controller, which must not re-bind per state.
  const openRef = useRef(false);
  // Where focus came from, so Esc/backdrop hands it back (and a jump that left
  // the visible tab unchanged, which mounts nothing new to claim focus).
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // Scrolling the highlighted row into view is a keyboard affordance; doing it
  // for a hover would fight the pointer that caused it.
  const navSourceRef = useRef<"keyboard" | "pointer">("keyboard");

  const close = useCallback((restoreFocus: boolean) => {
    openRef.current = false;
    setOpen(false);
    const previous = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (restoreFocus && previous?.isConnected) {
      previous.focus();
    }
  }, []);

  const requestOpen = useCallback(() => {
    if (openRef.current) {
      return true;
    }
    const state = useAppStore.getState();
    // Nothing to jump to before the daemon answers; and a blocking modal owns
    // both the screen and the Escape key while it is up.
    if (
      state.connectionStatus !== "connected" ||
      state.authPrompt ||
      state.settingsOpen ||
      state.pendingCloseTabId
    ) {
      return false;
    }
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    openRef.current = true;
    setOpen(true);
    return true;
  }, []);

  // The open shortcut itself lives in GlobalShortcutListener (one listener, one
  // bail zone); this only publishes the handle it calls.
  useEffect(() => {
    const controller: PaletteController = {
      open: requestOpen,
      isOpen: () => openRef.current,
      toggle: () => {
        if (openRef.current) {
          close(true);
          return true;
        }
        return requestOpen();
      }
    };
    controllers.add(controller);
    return () => {
      controllers.delete(controller);
    };
  }, [requestOpen, close]);

  // Escape closes. Capture phase + stopPropagation: modals underneath listen
  // for Escape on `document` too, and one press must close only the top layer.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  // Fresh index on every open, seeded from the last published one so a reopen
  // is instant. The workspace list is read imperatively so a background refresh
  // of it can't re-run this and wipe what the user typed; the AbortController
  // drops the in-flight listings when the palette closes first.
  useEffect(() => {
    if (!open) {
      return;
    }
    setQuery("");
    setHighlight(0);
    setIndex(cachedProjectIndex());
    let cancelled = false;
    const controller = new AbortController();
    void refreshProjectIndex(api, useAppStore.getState().workspaces, controller.signal).then(
      (fresh) => {
        if (!cancelled) {
          setIndex(fresh);
        }
      }
    );
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, api]);

  // Focus the input once the portal is in the document (autoFocus alone loses
  // races with the portal mount on some engines).
  useEffect(() => {
    if (!open) {
      return;
    }
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  /**
   * Openable projects by path. The index already folds in both halves of the
   * archived curtain (the project's own flag and its workspace's), so
   * membership is the only check any row needs.
   */
  const projectsByPath = index?.visible ?? EMPTY_PROJECTS;

  const sessionRows = useMemo(() => {
    const rows: SessionRow[] = [];
    for (const session of sessions) {
      const project = projectsByPath.get(session.projectPath);
      if (!project) {
        continue;
      }
      rows.push({ key: `session:${session.id}`, kind: "session", session, project });
    }
    // Same order the tab strip uses, grouped by project.
    return rows.sort(
      (a, b) =>
        a.project.path.localeCompare(b.project.path) ||
        a.session.order - b.session.order ||
        a.session.createdAt.localeCompare(b.session.createdAt)
    );
  }, [sessions, projectsByPath]);

  const results = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    const projects = [...projectsByPath.values()].sort(
      (a, b) => a.workspace.localeCompare(b.workspace) || a.name.localeCompare(b.name)
    );

    if (!trimmed) {
      // Same "Active" set the sidebar shows (projects with an open tab); with
      // nothing open there is nothing to be active, so list everything instead.
      const active = new Set(sessionRows.map((row) => row.project.path));
      const activeProjects = projects.filter((project) => active.has(project.path));
      const shown = activeProjects.length > 0 ? activeProjects : projects;
      return {
        sessions: sessionRows,
        projects: shown.map<ProjectRow>((project) => ({
          key: `project:${project.path}`,
          kind: "project",
          project
        })),
        projectsLabel: activeProjects.length > 0 ? "Active" : "Projects"
      };
    }

    return {
      sessions: sessionRows.filter(
        (row) =>
          matches(row.session.title, trimmed) ||
          matches(row.project.name, trimmed) ||
          matches(row.project.workspace, trimmed)
      ),
      projects: projects
        .filter((project) => matches(project.name, trimmed) || matches(project.workspace, trimmed))
        .map<ProjectRow>((project) => ({ key: `project:${project.path}`, kind: "project", project })),
      projectsLabel: "Projects"
    };
  }, [query, projectsByPath, sessionRows]);

  const flat = useMemo(
    () => [...results.sessions, ...results.projects],
    [results.sessions, results.projects]
  );

  // Only a new query restarts at the top. Resetting on `flat.length` too would
  // yank the selection back whenever a live session event reshuffles the list
  // under the user's arrow keys; an out-of-range highlight is clamped instead.
  useEffect(() => setHighlight(0), [query]);
  const highlighted = flat.length === 0 ? 0 : Math.min(highlight, flat.length - 1);

  useEffect(() => {
    if (navSourceRef.current === "keyboard") {
      highlightedRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [highlighted]);

  const select = (item: PaletteItem) => {
    const changed = jumpToProject({
      project: item.project,
      sessionId: item.kind === "session" ? item.session.id : undefined
    });
    // A changed tab mounts a view that grabs focus itself; an unchanged one
    // (a project row for the open project, an already-active session) would
    // otherwise leave focus stranded on <body>.
    close(!changed);
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      navSourceRef.current = "keyboard";
      setHighlight(Math.min(highlighted + 1, Math.max(flat.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      navSourceRef.current = "keyboard";
      setHighlight(Math.max(highlighted - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const picked = flat[highlighted];
      if (picked) {
        select(picked);
      }
    }
  };

  // Tab is trapped. Rows are tabIndex=-1 (arrow keys navigate them), so the
  // input is the only tab stop and focus can never escape.
  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      event.preventDefault();
      inputRef.current?.focus();
    }
  };

  if (!open) {
    return null;
  }

  const trimmedQuery = query.trim().toLowerCase();
  const activeId = flat[highlighted] ? `command-palette-${flat[highlighted].key}` : undefined;

  const renderRow = (item: PaletteItem, index: number) => {
    const selected = index === highlighted;
    return (
      <button
        key={item.key}
        id={`command-palette-${item.key}`}
        ref={selected ? highlightedRef : null}
        type="button"
        role="option"
        aria-selected={selected}
        tabIndex={-1}
        onMouseEnter={() => {
          navSourceRef.current = "pointer";
          setHighlight(index);
        }}
        onClick={() => select(item)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
          selected ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-800/60"
        )}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-neutral-500">
          {item.kind === "session" ? (
            <RegistryIcon kind={item.session.kind} refId={item.session.refId} size={14} />
          ) : (
            <Box size={14} />
          )}
        </span>
        {item.kind === "session" ? (
          <>
            <span className="min-w-0 flex-1 truncate">
              <Highlighted text={item.session.title} query={trimmedQuery} />
            </span>
            <span className="min-w-0 shrink truncate text-xs text-neutral-500">
              <Highlighted text={item.project.name} query={trimmedQuery} />
            </span>
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate">
            <span className="text-neutral-500">
              <Highlighted text={item.project.workspace} query={trimmedQuery} />/
            </span>
            <Highlighted text={item.project.name} query={trimmedQuery} />
          </span>
        )}
      </button>
    );
  };

  return createPortal(
    <div
      className="app-no-drag fixed inset-0 z-[100] flex items-start justify-center bg-black/60 p-3 pt-[10vh] sm:p-6 sm:pt-[14vh]"
      onMouseDown={() => close(true)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onDialogKeyDown}
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2.5">
          <Search size={15} className="shrink-0 text-neutral-500" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Go to session or project…"
            aria-label="Go to session or project"
            role="combobox"
            aria-expanded
            aria-controls="command-palette-results"
            aria-activedescendant={activeId}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            // 16px on mobile (text-base) prevents iOS from zooming on focus.
            className="min-w-0 flex-1 bg-transparent text-base text-neutral-100 placeholder:text-neutral-500 focus:outline-none md:text-sm"
          />
        </div>

        <div
          id="command-palette-results"
          role="listbox"
          aria-label="Results"
          className="min-h-0 flex-1 overflow-y-auto p-1.5"
        >
          {flat.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-neutral-500">
              {index === null ? "Loading…" : "Nothing found."}
            </p>
          )}
          {results.sessions.length > 0 && (
            <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-neutral-600">
              Sessions
            </p>
          )}
          {results.sessions.map((item, index) => renderRow(item, index))}
          {results.projects.length > 0 && (
            <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-neutral-600">
              {results.projectsLabel}
            </p>
          )}
          {results.projects.map((item, index) => renderRow(item, results.sessions.length + index))}
          {/* One dead workspace shouldn't blank the palette, but silently
              dropping its projects would look like they don't exist. */}
          {index?.incomplete && (
            <p className="px-2.5 pb-1 pt-2 text-[10px] text-neutral-600">
              Some workspaces failed to load.
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
