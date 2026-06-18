import React, { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  File,
  FilePlus,
  Folder,
  FolderPlus,
  RefreshCw,
  Save
} from "lucide-react";
import type { FsEntry } from "@orquester/api";
import { cn } from "../../lib/cn";
import { Button, ContextMenu, IconButton, Input, type ContextMenuItem } from "../ui";
import { Editor } from "./Editor";
import { useApi } from "../../context/orquester-context";

const parentOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/"))) || p;
const joinPath = (dir: string, name: string) => `${dir.replace(/\/$/, "")}/${name}`;
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

interface MenuState {
  x: number;
  y: number;
  dir: string;
}

/**
 * File browser: a lazy file tree on the left, the selected file's content on
 * the right. Create via the toolbar or right-click context menu. Responsive:
 * on narrow screens it's a master/detail (tree, then file with a back button).
 */
export const FileBrowser: React.FC<{ rootPath: string }> = ({ rootPath }) => {
  const api = useApi();
  const [childrenByPath, setChildrenByPath] = useState<Record<string, FsEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [activeDir, setActiveDir] = useState(rootPath);
  const [creating, setCreating] = useState<null | "file" | "dir">(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    setActiveDir(rootPath);
    void loadDir(rootPath);
  }, [rootPath, loadDir]);

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

  const selectFile = (path: string) => {
    setSelectedFile(path);
    setActiveDir(parentOf(path));
  };

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

  const openMenu = (event: React.MouseEvent, dir: string) => {
    event.preventDefault();
    event.stopPropagation();
    setActiveDir(dir);
    setMenu({ x: event.clientX, y: event.clientY, dir });
  };

  const menuItems: ContextMenuItem[] = menu
    ? [
        { label: "New File", icon: <FilePlus size={14} />, onClick: () => startCreate(menu.dir, "file") },
        { label: "New Folder", icon: <FolderPlus size={14} />, onClick: () => startCreate(menu.dir, "dir") },
        { label: "Refresh", icon: <RefreshCw size={13} />, onClick: () => void loadDir(menu.dir) }
      ]
    : [];

  return (
    <div className="flex h-full min-h-0 bg-neutral-950">
      {/* Tree sub-sidebar (full width on mobile; hidden when a file is open) */}
      <div
        className={cn(
          "min-h-0 flex-col border-r border-neutral-800 md:flex md:w-64 md:shrink-0",
          selectedFile ? "hidden md:flex" : "flex w-full"
        )}
      >
        <div className="flex h-9 items-center gap-0.5 border-b border-neutral-800 px-2">
          <span className="flex-1 truncate text-xs text-neutral-500" title={rootPath}>
            {baseName(rootPath) || rootPath}
          </span>
          <IconButton label="New file" onClick={() => startCreate(rootPath, "file")}>
            <FilePlus size={14} />
          </IconButton>
          <IconButton label="New folder" onClick={() => startCreate(rootPath, "dir")}>
            <FolderPlus size={14} />
          </IconButton>
          <IconButton label="Refresh" onClick={() => void loadDir(activeDir)}>
            <RefreshCw size={13} />
          </IconButton>
        </div>

        <div
          className="min-h-0 flex-1 overflow-auto py-1"
          onContextMenu={(e) => openMenu(e, rootPath)}
        >
          {creating && (
            <div className="px-2 py-1">
              <Input
                autoFocus
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
            onToggleDir={toggleDir}
            onSelectFile={selectFile}
            onContextMenu={openMenu}
          />
        </div>
      </div>

      {/* Content pane (full width on mobile when a file is selected) */}
      <div
        className={cn(
          "min-w-0 flex-1 flex-col",
          selectedFile ? "flex" : "hidden md:flex"
        )}
      >
        <FileContent path={selectedFile} onBack={() => setSelectedFile(null)} />
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
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
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  onContextMenu: (event: React.MouseEvent, dir: string) => void;
}

const TreeLevel: React.FC<TreeLevelProps> = (props) => {
  const entries = props.childrenByPath[props.dir];
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
              onClick={() => (isDir ? props.onToggleDir(entry.path) : props.onSelectFile(entry.path))}
              onContextMenu={(e) => props.onContextMenu(e, isDir ? entry.path : parentOf(entry.path))}
              style={{ paddingLeft: 8 + props.depth * 12 }}
              className={cn(
                "flex w-full items-center gap-1.5 py-1 pr-2 text-left text-sm",
                isActive ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-900"
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

const FileContent: React.FC<{ path: string | null; onBack: () => void }> = ({ path, onBack }) => {
  const api = useApi();
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [truncated, setTruncated] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!path) {
      return;
    }
    let active = true;
    setState("loading");
    api
      .readFile(path)
      .then((res) => {
        if (!active) return;
        setContent(res.content);
        setOriginal(res.content);
        setTruncated(res.truncated);
        setState("idle");
      })
      .catch(() => active && setState("error"));
    return () => {
      active = false;
    };
  }, [api, path]);

  if (!path) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-600">
        Select a file to view its contents
      </div>
    );
  }

  // Don't allow editing partial reads or binary blobs (would corrupt on save).
  const readOnly = truncated || content.includes("\u0000");
  const dirty = !readOnly && content !== original;

  const save = async () => {
    if (!dirty || saving) {
      return;
    }
    setSaving(true);
    try {
      await api.saveFile(path, content);
      setOriginal(content);
    } catch {
      /* surfaced as still-dirty */
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="flex h-9 items-center gap-2 border-b border-neutral-800 px-2">
        <button
          type="button"
          aria-label="Back to files"
          onClick={onBack}
          className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 md:hidden"
        >
          <ArrowLeft size={15} />
        </button>
        <File size={13} className="text-neutral-500" />
        <span className="truncate text-xs text-neutral-300">{baseName(path)}</span>
        {dirty && <span className="h-1.5 w-1.5 rounded-full bg-neutral-300" title="Unsaved changes" />}
        {truncated && <span className="text-[10px] text-neutral-600">(truncated · read-only)</span>}
        <div className="flex-1" />
        {!readOnly && state === "idle" && (
          <Button size="sm" variant="outline" disabled={!dirty || saving} onClick={() => void save()}>
            <Save size={13} />
            {saving ? "Saving…" : "Save"}
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {state === "loading" && <p className="p-3 text-xs text-neutral-600">Loading…</p>}
        {state === "error" && <p className="p-3 text-xs text-red-400">Could not read file.</p>}
        {state === "idle" && (
          <Editor
            filename={baseName(path)}
            value={content}
            readOnly={readOnly}
            onChange={setContent}
            onSave={() => void save()}
          />
        )}
      </div>
    </>
  );
};
