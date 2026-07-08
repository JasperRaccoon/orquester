import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Copy,
  Download,
  File,
  FilePlus,
  Folder,
  FolderDown,
  FolderPlus,
  RefreshCw,
  Trash2,
  Upload
} from "lucide-react";
import type { FsEntry } from "@orquester/api";
import { cn } from "../../lib/cn";
import {
  AdaptiveMenu,
  Button,
  ConfirmDialog,
  ContextMenu,
  DropdownItem,
  IconButton,
  Input,
  ResizeHandle,
  type ContextMenuItem
} from "../ui";
import { FilePreview } from "./FilePreview";
import { SearchPanel } from "./SearchPanel";
import { useApi } from "../../context/orquester-context";
import { usePollWhileActive, useIsDesktop } from "../../hooks";
import { useAppStore } from "../../store/app";
import { PANE_DEFAULTS, PANE_FLEX_RESERVE, clampPaneWidth } from "../../lib/panel-sizes";
import { gatherFromDataTransfer, gatherFromInput } from "../../lib/files";
import { downloadPath } from "../../lib/download";
import { copyText } from "../../lib/clipboard";
import { useFileUpload } from "./use-file-upload";
import { UploadConflictModal } from "./UploadConflictModal";

const parentOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/"))) || p;
const joinPath = (dir: string, name: string) => `${dir.replace(/\/$/, "")}/${name}`;
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

// Path of `path` relative to the explorer's project root `root` (e.g. "apps/daemon/src/index.ts").
// Falls back to the absolute path when there is no root or `path` sits outside it. The trailing
// "/" boundary check stops "/a/proj" from being treated as a child of root "/a/pro".
const relativeTo = (root: string, path: string) => {
  const r = root.replace(/\/$/, "");
  if (r && (path === r || path.startsWith(r + "/"))) {
    return path.slice(r.length).replace(/^\//, "") || baseName(path);
  }
  return path;
};

const LONG_PRESS_MS = 500;
const MOVE_SLOP_PX = 10;

type MenuTarget = { path: string; name: string; kind: "dir" | "file" };

interface MenuState {
  x: number;
  y: number;
  dir: string;
  target?: MenuTarget;
}

/**
 * File browser: a lazy file tree on the left, the selected file's content on
 * the right. Create via the toolbar or right-click context menu. Responsive:
 * on narrow screens it's a master/detail (tree, then file with a back button).
 */
export const FileBrowser: React.FC<{ rootPath: string; active?: boolean }> = ({ rootPath, active = true }) => {
  const api = useApi();
  // Persisted tree-pane width, keyed by project path (rootPath). Applied inline
  // only at md+ so the mobile w-full/hidden master-detail classes still win.
  const isDesktop = useIsDesktop();
  // The flex row containing the tree pane + seam + content, measured live at drag
  // time so the seam clamp bounds against the real available width.
  const rowRef = useRef<HTMLDivElement>(null);
  const treeWidth = useAppStore((s) => s.paneSizesByProject[rootPath]?.fileTree) ?? PANE_DEFAULTS.fileTree;
  const setPaneSize = useAppStore((s) => s.setPaneSize);
  const resetPaneSize = useAppStore((s) => s.resetPaneSize);
  const [childrenByPath, setChildrenByPath] = useState<Record<string, FsEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedSize, setSelectedSize] = useState(0);
  // Line to jump to in the editor, set when a search result is opened and cleared
  // when the file is picked from the tree instead.
  const [pendingLine, setPendingLine] = useState<number | null>(null);
  // Bumped on every search-result open so re-clicking the SAME result (same file +
  // line) still re-triggers the editor's jump, which is otherwise keyed on the line.
  const [jumpNonce, setJumpNonce] = useState(0);
  const [searchActive, setSearchActive] = useState(false);
  const [activeDir, setActiveDir] = useState(rootPath);
  const [creating, setCreating] = useState<null | "file" | "dir">(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ path: string; name: string; kind: "dir" | "file" } | null>(null);
  // Whether the server can zip a folder. Optimistic (true) until the probe
  // answers, so a fast right-click before it resolves still works on a capable
  // server; if the server has no tool the folder item disables itself.
  const [folderZip, setFolderZip] = useState(true);

  const loadDir = useCallback(
    async (dir: string) => {
      try {
        const result = await api.listFiles(dir);
        setChildrenByPath((prev) => ({ ...prev, [dir]: result.entries }));
      } catch {
        /* ignore */
      }
    },
    [api]
  );

  // Mirror the set of loaded dirs into a ref so refreshTree can re-fetch them
  // all without re-creating its callback on every children change.
  const loadedDirsRef = useRef<string[]>([rootPath]);
  useEffect(() => {
    loadedDirsRef.current = Object.keys(childrenByPath);
  }, [childrenByPath]);
  const refreshTree = useCallback(() => {
    const dirs = loadedDirsRef.current.length > 0 ? loadedDirsRef.current : [rootPath];
    for (const dir of dirs) void loadDir(dir);
  }, [loadDir, rootPath]);

  const upload = useFileUpload(api, (dir) => {
    void loadDir(dir);
    setExpanded((prev) => new Set(prev).add(dir));
  });
  const filesInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  // Destination for the *next* button-triggered pick (root, or a context dir).
  const uploadDestRef = useRef<string>(rootPath);

  const pickUpload = (dest: string, mode: "files" | "folder") => {
    uploadDestRef.current = dest;
    (mode === "folder" ? folderInputRef : filesInputRef).current?.click();
  };

  const onInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const list = event.target.files;
    if (list && list.length > 0) {
      void upload.start(uploadDestRef.current, gatherFromInput(list));
    }
    event.target.value = ""; // allow re-picking the same path
  };

  const onDropTo = async (dir: string, dt: DataTransfer) => {
    setDropTarget(null);
    const items = await gatherFromDataTransfer(dt);
    if (items.length > 0) {
      void upload.start(dir, items);
    }
  };

  useEffect(() => {
    setActiveDir(rootPath);
    // Keep the toolbar-upload destination pinned to the current root (defends
    // against a reused instance whose rootPath prop changes without remount).
    uploadDestRef.current = rootPath;
    void loadDir(rootPath);
  }, [rootPath, loadDir]);

  useEffect(() => {
    let alive = true;
    api
      .getFsCapabilities()
      .then((caps) => {
        if (alive) setFolderZip(caps.folderZip);
      })
      .catch(() => {
        /* leave optimistic; a failed download surfaces its own error */
      });
    return () => {
      alive = false;
    };
  }, [api]);

  // Refresh the whole tree when the tab goes inactive -> active again, so a
  // file created/deleted in another tab shows up the moment you return.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) refreshTree();
    wasActive.current = active;
  }, [active, refreshTree]);

  // Same idea when the window regains focus (e.g. after editing on the host).
  useEffect(() => {
    const onFocus = () => {
      if (active) refreshTree();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, refreshTree]);

  // Live polling while the tab is active+visible (auto-paused otherwise).
  usePollWhileActive(active, refreshTree);

  // Clear a stranded drop-target highlight when a drag is abandoned — dropped
  // outside any zone, ended, or the cursor left the window. None of the row /
  // container dragleave handlers fire in those cases, so the ring would stick.
  useEffect(() => {
    const clear = () => setDropTarget(null);
    const onWindowDragLeave = (e: DragEvent) => {
      if (!e.relatedTarget) {
        setDropTarget(null); // relatedTarget null == pointer left the window
      }
    };
    window.addEventListener("drop", clear);
    window.addEventListener("dragend", clear);
    window.addEventListener("dragleave", onWindowDragLeave);
    return () => {
      window.removeEventListener("drop", clear);
      window.removeEventListener("dragend", clear);
      window.removeEventListener("dragleave", onWindowDragLeave);
    };
  }, []);

  const toggleDir = (path: string) => {
    setActiveDir(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        if (!childrenByPath[path]) {
          void loadDir(path);
        }
      }
      return next;
    });
  };

  const selectFile = (path: string, size: number) => {
    setSelectedFile(path);
    setSelectedSize(size);
    setActiveDir(parentOf(path));
  };

  // Tree clicks open a file with no line jump; a search hit carries the line.
  const selectFromTree = (path: string, size: number) => {
    setPendingLine(null);
    selectFile(path, size);
  };

  const openFromSearch = useCallback((path: string, size: number, line?: number) => {
    setSelectedFile(path);
    setSelectedSize(size);
    setActiveDir(parentOf(path));
    setPendingLine(line ?? null);
    setJumpNonce((n) => n + 1);
  }, []);

  const onSearchActiveChange = useCallback((value: boolean) => setSearchActive(value), []);

  const startCreate = (dir: string, kind: "file" | "dir") => {
    setActiveDir(dir);
    setCreating(kind);
  };

  const submitCreate = async (name: string) => {
    const kind = creating === "dir" ? "dir" : "file";
    setCreating(null);
    setError(null);
    try {
      await api.createFsEntry(joinPath(activeDir, name), kind);
      await loadDir(activeDir);
      setExpanded((prev) => new Set(prev).add(activeDir));
    } catch {
      setError(`Could not create ${kind}.`);
    }
  };

  const openMenu = (x: number, y: number, dir: string, target?: MenuTarget) => {
    setActiveDir(dir);
    setMenu({ x, y, dir, target });
  };

  const confirmDelete = async () => {
    if (!deleting) {
      return;
    }
    const { path } = deleting;
    setDeleting(null);
    setError(null);
    try {
      await api.deleteFsEntry(path);
      if (selectedFile && (selectedFile === path || selectedFile.startsWith(path + "/"))) {
        setSelectedFile(null);
      }
      setExpanded((prev) => {
        const next = new Set<string>();
        prev.forEach((d) => {
          if (d !== path && !d.startsWith(path + "/")) next.add(d);
        });
        return next;
      });
      // Drop the deleted subtree from the loaded-dir cache too, so the live poll
      // (which re-fetches every key of childrenByPath) stops issuing failing list
      // requests for paths that no longer exist.
      setChildrenByPath((prev) => {
        const next: Record<string, FsEntry[]> = {};
        for (const [d, entries] of Object.entries(prev)) {
          if (d !== path && !d.startsWith(path + "/")) next[d] = entries;
        }
        return next;
      });
      // If the active dir was inside the deleted tree, fall back to its parent so
      // New File/Folder/Refresh don't act on a now-deleted directory.
      if (activeDir === path || activeDir.startsWith(path + "/")) {
        setActiveDir(parentOf(path));
      }
      await loadDir(parentOf(path));
    } catch {
      setError("Could not delete.");
    }
  };

  const menuItems: ContextMenuItem[] = menu
    ? [
        { label: "New File", icon: <FilePlus size={14} />, onClick: () => startCreate(menu.dir, "file") },
        { label: "New Folder", icon: <FolderPlus size={14} />, onClick: () => startCreate(menu.dir, "dir") },
        { label: "Upload Files…", icon: <Upload size={14} />, onClick: () => pickUpload(menu.dir, "files") },
        { label: "Upload Folder…", icon: <Upload size={14} />, onClick: () => pickUpload(menu.dir, "folder") },
        { label: "Refresh", icon: <RefreshCw size={13} />, onClick: () => void loadDir(menu.dir) },
        ...(menu.target
          ? [
              {
                label: menu.target.kind === "dir" ? "Download as Zip" : "Download",
                icon: menu.target.kind === "dir" ? <FolderDown size={14} /> : <Download size={14} />,
                disabled: menu.target.kind === "dir" && !folderZip,
                onClick: () => void downloadPath(api, menu.target!)
              },
              {
                label: "Copy Relative Path",
                icon: <Copy size={14} />,
                onClick: () => void copyText(relativeTo(rootPath, menu.target!.path))
              },
              {
                label: "Copy Full Path",
                icon: <ClipboardCopy size={14} />,
                onClick: () => void copyText(menu.target!.path)
              },
              { label: "Delete", icon: <Trash2 size={14} />, onClick: () => setDeleting(menu.target!) }
            ]
          : [])
      ]
    : [];

  return (
    <div ref={rowRef} className="flex h-full min-h-0 bg-neutral-950">
      <input ref={filesInputRef} type="file" multiple hidden onChange={onInputChange} />
      <input
        type="file"
        hidden
        onChange={onInputChange}
        // webkitdirectory isn't in React's input typings — set via ref attrs.
        ref={(el) => {
          folderInputRef.current = el;
          if (el) {
            el.setAttribute("webkitdirectory", "");
            el.setAttribute("directory", "");
          }
        }}
      />
      {/* Tree sub-sidebar (full width on mobile; hidden when a file is open).
          At md+ the width is controlled inline (the ResizeHandle seam below
          replaces the desktop border-r); mobile keeps its w-full border-r. */}
      <div
        className={cn(
          "min-h-0 flex-col border-r border-neutral-800 md:flex md:shrink-0",
          selectedFile ? "hidden md:flex" : "flex w-full"
        )}
        // Inline style beats the mobile w-full class, so gate it to desktop. The
        // maxWidth guard keeps the content pane (and its divider) from collapsing
        // out of view on a narrow desktop row.
        style={
          isDesktop
            ? { width: treeWidth, maxWidth: `calc(100% - ${PANE_FLEX_RESERVE}px)` }
            : undefined
        }
      >
        <div className="flex h-9 items-center gap-0.5 border-b border-neutral-800 px-2">
          <span className="flex-1 truncate text-xs text-neutral-500" title={rootPath}>
            {baseName(rootPath) || rootPath}
          </span>
          {/* Disabled while a search query is active: the create input + inline
              errors render inside the tree pane, which is hidden during search, so
              triggering them there would be an invisible dead-end. */}
          <IconButton
            label="New file"
            disabled={searchActive}
            className="disabled:pointer-events-none disabled:opacity-40"
            onClick={() => startCreate(rootPath, "file")}
          >
            <FilePlus size={14} />
          </IconButton>
          <IconButton
            label="New folder"
            disabled={searchActive}
            className="disabled:pointer-events-none disabled:opacity-40"
            onClick={() => startCreate(rootPath, "dir")}
          >
            <FolderPlus size={14} />
          </IconButton>
          <AdaptiveMenu
            title="Upload"
            align="right"
            width="w-44"
            trigger={
              // A non-button element: AdaptiveMenu/Dropdown wraps the trigger in
              // its OWN <button>, so an IconButton here would nest <button> in
              // <button> (invalid HTML + a React warning). Mirror IconButton's
              // styling on a span instead.
              <span
                aria-label="Upload"
                title="Upload"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
              >
                <Upload size={14} />
              </span>
            }
          >
            <DropdownItem icon={<FilePlus size={14} />} onClick={() => pickUpload(rootPath, "files")}>
              Upload files…
            </DropdownItem>
            <DropdownItem icon={<FolderPlus size={14} />} onClick={() => pickUpload(rootPath, "folder")}>
              Upload folder…
            </DropdownItem>
          </AdaptiveMenu>
          <IconButton label="Refresh" onClick={() => void loadDir(activeDir)}>
            <RefreshCw size={13} />
          </IconButton>
        </div>

        {upload.status && (
          <p
            className={cn(
              "border-b border-neutral-800 px-3 py-1 text-[11px]",
              upload.status.error ? "text-red-400" : "text-neutral-400"
            )}
          >
            {upload.status.text}
          </p>
        )}

        {/* Search / quick-open above the tree. When a query is active it grows to
            fill the pane (its results scroll) and the tree below is hidden. */}
        <div
          className={cn(
            "flex min-h-0 flex-col border-b border-neutral-800",
            searchActive ? "flex-1" : "shrink-0"
          )}
        >
          <SearchPanel root={rootPath} onOpenFile={openFromSearch} onActiveChange={onSearchActiveChange} />
        </div>

        <div
          className={cn(
            "min-h-0 flex-1 overflow-auto py-1",
            searchActive && "hidden",
            dropTarget === rootPath && "ring-1 ring-inset ring-neutral-600"
          )}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openMenu(e.clientX, e.clientY, rootPath);
          }}
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer.types).includes("Files")) {
              e.preventDefault();
              setDropTarget(rootPath);
            }
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) {
              setDropTarget(null);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            void onDropTo(rootPath, e.dataTransfer);
          }}
        >
          {creating && (
            <div className="px-2 py-1">
              <Input
                autoFocus
                // 16px on mobile (text-base) prevents iOS from zooming on focus.
                className="text-base md:text-sm"
                placeholder={creating === "dir" ? "folder name" : "file name"}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const value = e.currentTarget.value.trim();
                    if (value) void submitCreate(value);
                  } else if (e.key === "Escape") {
                    setCreating(null);
                  }
                }}
                onBlur={() => setCreating(null)}
              />
              <p className="px-1 pt-1 text-[10px] text-neutral-600">in {baseName(activeDir)}/</p>
            </div>
          )}
          {error && <p className="px-3 py-1 text-xs text-red-400">{error}</p>}
          <TreeLevel
            dir={rootPath}
            depth={0}
            childrenByPath={childrenByPath}
            expanded={expanded}
            selectedFile={selectedFile}
            activeDir={activeDir}
            dropTarget={dropTarget}
            onToggleDir={toggleDir}
            onSelectFile={selectFromTree}
            onOpenMenu={openMenu}
            onDragTo={setDropTarget}
            onDropTo={(dir, dt) => void onDropTo(dir, dt)}
          />
        </div>
      </div>

      {/* Draggable seam between tree and content (desktop only). */}
      <ResizeHandle
        orientation="vertical"
        className="hidden md:block"
        aria-label="Resize file tree"
        // Disabled below md (the handle is display:none there but stays mounted)
        // and when there is no project to key the size by.
        disabled={!isDesktop || !rootPath}
        getCurrent={() => useAppStore.getState().paneSizesByProject[rootPath]?.fileTree ?? PANE_DEFAULTS.fileTree}
        clamp={(px) => clampPaneWidth(px, rowRef.current)}
        onResize={(px) => setPaneSize(rootPath, "fileTree", px, false)}
        onCommit={(px) => setPaneSize(rootPath, "fileTree", px)}
        onReset={() => resetPaneSize(rootPath, "fileTree")}
      />

      {/* Content pane (full width on mobile when a file is selected) */}
      <div
        className={cn(
          "min-w-0 flex-1 flex-col",
          selectedFile ? "flex" : "hidden md:flex"
        )}
      >
        <FilePreview
          path={selectedFile}
          size={selectedSize}
          jumpToLine={pendingLine ?? undefined}
          jumpNonce={jumpNonce}
          onBack={() => setSelectedFile(null)}
        />
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
      <UploadConflictModal prompt={upload.conflict} />
      <ConfirmDialog
        open={upload.bigFolder !== null}
        danger={false}
        title="Upload a large folder?"
        confirmLabel="Upload"
        message={
          upload.bigFolder
            ? `This will upload ${upload.bigFolder.count.toLocaleString()} files (${Math.round(
                upload.bigFolder.bytes / (1024 * 1024)
              ).toLocaleString()} MB). Folders like node_modules can be very large.`
            : ""
        }
        onConfirm={upload.confirmBigFolder}
        onCancel={upload.cancelBigFolder}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={deleting?.kind === "dir" ? "Delete folder?" : "Delete file?"}
        confirmLabel="Delete"
        message={
          deleting ? (
            deleting.kind === "dir" ? (
              <>
                Delete folder <code>{deleting.name}</code> and everything inside it? This can&apos;t be
                undone.
              </>
            ) : (
              <>
                Delete <code>{deleting.name}</code>? This can&apos;t be undone.
              </>
            )
          ) : (
            ""
          )
        }
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
};

interface TreeLevelProps {
  dir: string;
  depth: number;
  childrenByPath: Record<string, FsEntry[]>;
  expanded: Set<string>;
  selectedFile: string | null;
  activeDir: string;
  dropTarget: string | null;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string, size: number) => void;
  onOpenMenu: (x: number, y: number, dir: string, target?: MenuTarget) => void;
  onDragTo: (dir: string | null) => void;
  onDropTo: (dir: string, dt: DataTransfer) => void;
}

const TreeLevel: React.FC<TreeLevelProps> = (props) => {
  const entries = props.childrenByPath[props.dir];
  const pressTimer = useRef<number | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const didLongPress = useRef(false);
  const clearPress = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };
  if (!entries) {
    return props.depth === 0 ? (
      <p className="px-3 py-2 text-xs text-neutral-600">Loading…</p>
    ) : null;
  }
  if (entries.length === 0 && props.depth === 0) {
    return <p className="px-3 py-2 text-xs text-neutral-600">Empty directory</p>;
  }

  return (
    <>
      {entries.map((entry) => {
        const isDir = entry.kind === "dir";
        const isOpen = props.expanded.has(entry.path);
        const isActive =
          entry.path === props.selectedFile || (isDir && entry.path === props.activeDir);
        return (
          <React.Fragment key={entry.path}>
            <button
              type="button"
              onClick={() => {
                if (didLongPress.current) {
                  didLongPress.current = false;
                  return;
                }
                if (isDir) props.onToggleDir(entry.path);
                else props.onSelectFile(entry.path, entry.size);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                props.onOpenMenu(e.clientX, e.clientY, isDir ? entry.path : parentOf(entry.path), {
                  path: entry.path,
                  name: entry.name,
                  kind: entry.kind
                });
              }}
              onTouchStart={(e) => {
                const { clientX, clientY } = e.touches[0];
                pressStart.current = { x: clientX, y: clientY };
                didLongPress.current = false;
                clearPress();
                pressTimer.current = window.setTimeout(() => {
                  didLongPress.current = true;
                  props.onOpenMenu(clientX, clientY, isDir ? entry.path : parentOf(entry.path), {
                    path: entry.path,
                    name: entry.name,
                    kind: entry.kind
                  });
                }, LONG_PRESS_MS);
              }}
              onTouchMove={(e) => {
                const s = pressStart.current;
                if (!s) return;
                const t = e.touches[0];
                if (Math.abs(t.clientX - s.x) > MOVE_SLOP_PX || Math.abs(t.clientY - s.y) > MOVE_SLOP_PX) {
                  clearPress();
                }
              }}
              onTouchEnd={(e) => {
                clearPress();
                if (didLongPress.current) e.preventDefault();
              }}
              onTouchCancel={clearPress}
              onDragOver={(e) => {
                if (Array.from(e.dataTransfer.types).includes("Files")) {
                  e.preventDefault();
                  e.stopPropagation();
                  props.onDragTo(isDir ? entry.path : parentOf(entry.path));
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                props.onDropTo(isDir ? entry.path : parentOf(entry.path), e.dataTransfer);
              }}
              style={{ paddingLeft: 8 + props.depth * 12 }}
              className={cn(
                "flex w-full select-none items-center gap-1.5 py-1 pr-2 text-left text-sm [-webkit-touch-callout:none]",
                isActive ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-900",
                isDir && props.dropTarget === entry.path && "bg-neutral-800 ring-1 ring-inset ring-neutral-600"
              )}
            >
              {isDir ? (
                <span className="text-neutral-500">
                  {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </span>
              ) : (
                <span className="w-[13px]" />
              )}
              {isDir ? (
                <Folder size={14} className="shrink-0 text-neutral-500" />
              ) : (
                <File size={14} className="shrink-0 text-neutral-600" />
              )}
              <span className="flex-1 truncate">{entry.name}</span>
            </button>
            {isDir && isOpen && <TreeLevel {...props} dir={entry.path} depth={props.depth + 1} />}
          </React.Fragment>
        );
      })}
    </>
  );
};
