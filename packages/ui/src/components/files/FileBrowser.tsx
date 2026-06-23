import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  File,
  FilePlus,
  Folder,
  FolderPlus,
  RefreshCw,
  Save,
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
  type ContextMenuItem
} from "../ui";
import { Editor } from "./Editor";
import { useApi } from "../../context/orquester-context";
import { gatherFromDataTransfer, gatherFromInput } from "../../lib/files";
import { useFileUpload } from "./use-file-upload";
import { UploadConflictModal } from "./UploadConflictModal";

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
  const [dropTarget, setDropTarget] = useState<string | null>(null);

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
        { label: "Upload Files…", icon: <Upload size={14} />, onClick: () => pickUpload(menu.dir, "files") },
        { label: "Upload Folder…", icon: <Upload size={14} />, onClick: () => pickUpload(menu.dir, "folder") },
        { label: "Refresh", icon: <RefreshCw size={13} />, onClick: () => void loadDir(menu.dir) }
      ]
    : [];

  return (
    <div className="flex h-full min-h-0 bg-neutral-950">
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

        <div
          className={cn(
            "min-h-0 flex-1 overflow-auto py-1",
            dropTarget === rootPath && "ring-1 ring-inset ring-neutral-600"
          )}
          onContextMenu={(e) => openMenu(e, rootPath)}
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
            onSelectFile={selectFile}
            onContextMenu={openMenu}
            onDragTo={setDropTarget}
            onDropTo={(dir, dt) => void onDropTo(dir, dt)}
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
  onSelectFile: (path: string) => void;
  onContextMenu: (event: React.MouseEvent, dir: string) => void;
  onDragTo: (dir: string | null) => void;
  onDropTo: (dir: string, dt: DataTransfer) => void;
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
                "flex w-full items-center gap-1.5 py-1 pr-2 text-left text-sm",
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
