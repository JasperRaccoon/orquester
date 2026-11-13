import React, { useEffect, useMemo, useRef, useState } from "react";
import { EyeOff, File, Folder, FolderLock, Layers, MoreHorizontal } from "lucide-react";
import type { StorageNode } from "@orquester/api";
import { cn } from "../../../lib/cn";
import { useAppStore } from "../../../store/app";
import { formatBytes } from "../system-format";
import type { StorageMapProps } from "./StorageTreemap";
import { formatItems, formatShare, hueSlots, isOpenable, nodeNote, sortedChildren, swatchColor } from "./storage-treemap.logic";

function NodeIcon({ node }: { node: StorageNode }) {
  const props = { size: 14, "aria-hidden": true, className: "shrink-0" } as const;
  switch (node.kind) {
    case "dir":
      return node.unreadable ? <FolderLock {...props} /> : <Folder {...props} />;
    case "file":
      return <File {...props} />;
    case "unaccounted":
      return <EyeOff {...props} />;
    default:
      return <Layers {...props} />;
  }
}

const COLUMNS =
  "grid grid-cols-[1rem_minmax(0,1fr)_4rem_1.75rem] sm:grid-cols-[1rem_minmax(0,1fr)_5rem_3.5rem_6.5rem_1.75rem] items-center gap-x-3";

/** Where a keyboard-opened menu appears: just under the row's name. */
function rowAnchor(el: HTMLElement): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  return { x: Math.round(rect.left + 32), y: Math.round(rect.bottom) };
}

/**
 * The storage map as a sorted list (biggest first): the keyboard and
 * screen-reader way through the treemap, and the main view on narrow screens.
 * One tab stop; arrows move between rows, Enter opens a folder, the
 * context-menu key or Shift+F10 opens the same menu as a right-click.
 */
export const StorageList: React.FC<StorageMapProps> = ({ root, onOpen, onContextMenu, className }) => {
  const mode = useAppStore((s) => s.resolvedMode);
  const rows = useMemo(() => sortedChildren(root), [root]);
  const slots = useMemo(() => hueSlots(root), [root]);
  const largest = rows.reduce((max, n) => Math.max(max, n.sizeBytes), 0);
  const [active, setActive] = useState(0);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  // The menu key also fires a native `contextmenu` on some platforms; the key
  // already opened the menu, so that one is swallowed (reset by any pointer press).
  const keyboardMenu = useRef(false);

  useEffect(() => setActive(0), [root]);
  const current = Math.min(active, Math.max(0, rows.length - 1));

  const focusRow = (index: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, index));
    setActive(next);
    rowRefs.current[next]?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent, index: number, node: StorageNode) => {
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      keyboardMenu.current = true;
      const el = rowRefs.current[index];
      onContextMenu(node, el ? rowAnchor(el) : { x: 0, y: 0 });
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusRow(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusRow(index - 1);
        break;
      case "Home":
        event.preventDefault();
        focusRow(0);
        break;
      case "End":
        event.preventDefault();
        focusRow(rows.length - 1);
        break;
      case "PageDown":
        event.preventDefault();
        focusRow(index + 10);
        break;
      case "PageUp":
        event.preventDefault();
        focusRow(index - 10);
        break;
      case "Enter":
        if (isOpenable(node)) {
          event.preventDefault();
          onOpen(node);
        }
        break;
    }
  };

  if (rows.length === 0) {
    return (
      <p
        className={cn(
          "rounded-xl border border-dashed border-neutral-800 px-3 py-6 text-center text-xs text-neutral-500",
          className
        )}
      >
        {root.name} is empty.
      </p>
    );
  }

  return (
    <div className={cn("overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/40", className)}>
      <div
        aria-hidden="true"
        className={cn(
          COLUMNS,
          "border-b border-neutral-800 bg-neutral-900/60 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500"
        )}
      >
        <span />
        <span>Name</span>
        <span className="text-right">Size</span>
        <span className="hidden text-right sm:block">Share</span>
        <span className="hidden text-right sm:block">Items</span>
        <span />
      </div>
      <div role="listbox" aria-label={`Contents of ${root.name}, largest first`} className="divide-y divide-neutral-800/60">
        {rows.map((node, index) => {
          const share = formatShare(node.sizeBytes, root.sizeBytes);
          const note = nodeNote(node);
          const openable = isOpenable(node);
          const bar = largest > 0 ? Math.max(0, (node.sizeBytes / largest) * 100) : 0;
          const showItems = node.kind === "dir" || node.kind === "smaller" || node.kind === "other";
          return (
            <div
              key={`${node.kind}:${node.path}:${node.name}`}
              ref={(el) => {
                rowRefs.current[index] = el;
              }}
              role="option"
              aria-selected={index === current}
              aria-label={`${node.name}, ${formatBytes(node.sizeBytes)}${share ? `, ${share}` : ""}${
                showItems ? `, ${formatItems(node.items)}` : ""
              }${openable ? ", folder" : ""}`}
              title={note ?? (node.kind === "dir" || node.kind === "file" ? node.path : undefined)}
              tabIndex={index === current ? 0 : -1}
              onFocus={() => setActive(index)}
              onKeyDown={(event) => onKeyDown(event, index, node)}
              onPointerDown={() => {
                keyboardMenu.current = false;
              }}
              onClick={() => {
                setActive(index);
                if (openable) onOpen(node);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                if (keyboardMenu.current) {
                  keyboardMenu.current = false;
                  return;
                }
                setActive(index);
                onContextMenu(node, { x: event.clientX, y: event.clientY });
              }}
              className={cn(
                COLUMNS,
                "group px-3 py-1.5 text-xs outline-none transition-colors motion-reduce:transition-none",
                "hover:bg-neutral-800/50 focus-visible:bg-neutral-800/70 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500",
                openable && "cursor-pointer"
              )}
            >
              <span className={cn("flex", node.kind === "unaccounted" || node.unreadable ? "text-neutral-500" : "text-neutral-400")}>
                <NodeIcon node={node} />
              </span>
              <span className="min-w-0">
                <span
                  className={cn(
                    "block truncate",
                    node.kind === "dir" || node.kind === "file" ? "text-neutral-200" : "italic text-neutral-400"
                  )}
                >
                  {node.name}
                </span>
                <span className="mt-1 block h-1 overflow-hidden rounded-full bg-neutral-800">
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${bar}%`, backgroundColor: swatchColor(node, slots.get(node), mode) }}
                  />
                </span>
              </span>
              <span className="text-right tabular-nums">
                <span className="block text-neutral-200">{formatBytes(node.sizeBytes)}</span>
                {share && <span className="block text-[10px] text-neutral-500 sm:hidden">{share}</span>}
              </span>
              <span className="hidden text-right tabular-nums text-neutral-400 sm:block">{share ?? "—"}</span>
              <span className="hidden text-right tabular-nums text-neutral-500 sm:block">
                {showItems ? node.items.toLocaleString("en-US") : ""}
              </span>
              <button
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 opacity-100 hover:bg-neutral-700/60 hover:text-neutral-200 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-visible:opacity-100"
                onClick={(event) => {
                  event.stopPropagation();
                  setActive(index);
                  const rect = event.currentTarget.getBoundingClientRect();
                  onContextMenu(node, { x: Math.round(rect.left), y: Math.round(rect.bottom) });
                }}
              >
                <MoreHorizontal size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};
