import React, { useState } from "react";
import { Circle, FolderTree, Pencil, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { getRegistryIcon } from "../../icons";
import { ContextMenu, type ContextMenuItem } from "../ui/context-menu";
import {
  useActiveTabId,
  useAppStore,
  useProjectTabs,
  type ProjectTab
} from "../../store/app";

/** Small inline editor shown in place of a tab label while renaming. */
const TabRenameInput: React.FC<{
  initial: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}> = ({ initial, onSubmit, onCancel }) => {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onBlur={() => onSubmit(value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onSubmit(value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      className="h-5 w-[120px] rounded bg-neutral-900 px-1 text-xs text-neutral-100 outline-none ring-1 ring-neutral-600"
    />
  );
};

/** Tabs for the current project — daemon sessions (drag/rename) plus file tabs. */
export const TabStrip: React.FC = () => {
  const tabs = useProjectTabs();
  const activeTabId = useActiveTabId();
  const activateTab = useAppStore((s) => s.activateTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const renameTab = useAppStore((s) => s.renameTab);
  const reorderTabs = useAppStore((s) => s.reorderTabs);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; tab: ProjectTab } | null>(null);

  if (tabs.length === 0) {
    return null;
  }

  const sessionIds = tabs.filter((t) => t.type === "session").map((t) => t.id);

  const drop = (targetId: string) => {
    const from = sessionIds.indexOf(dragId ?? "");
    const to = sessionIds.indexOf(targetId);
    setDragId(null);
    setOverId(null);
    if (from === -1 || to === -1 || from === to) {
      return;
    }
    const next = [...sessionIds];
    next.splice(from, 1);
    next.splice(to, 0, sessionIds[from]);
    void reorderTabs(next);
  };

  const menuItems = (tab: ProjectTab): ContextMenuItem[] =>
    tab.type === "session"
      ? [
          { label: "Rename", icon: <Pencil size={13} />, onClick: () => setEditingId(tab.id) },
          { label: "Close", icon: <X size={13} />, danger: true, onClick: () => void closeTab(tab.id) }
        ]
      : [{ label: "Close", icon: <X size={13} />, danger: true, onClick: () => void closeTab(tab.id) }];

  return (
    <div className="app-no-drag flex items-center gap-1">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const isSession = tab.type === "session";
        const editing = editingId === tab.id;
        const title = isSession ? tab.session.title : tab.title;
        const icon = isSession ? (
          getRegistryIcon(tab.session.kind, tab.session.refId, 13)
        ) : (
          <FolderTree size={13} />
        );
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            draggable={isSession && !editing}
            onClick={() => activateTab(tab.id)}
            onDoubleClick={() => isSession && setEditingId(tab.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, tab });
            }}
            onDragStart={() => isSession && setDragId(tab.id)}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
            onDragOver={(event) => {
              if (isSession && dragId) {
                event.preventDefault();
                if (overId !== tab.id) setOverId(tab.id);
              }
            }}
            onDrop={(event) => {
              if (isSession && dragId) {
                event.preventDefault();
                drop(tab.id);
              }
            }}
            className={cn(
              "group flex h-7 items-center gap-1.5 rounded-md pl-2 pr-1 text-xs",
              editing ? "cursor-text" : "cursor-pointer",
              dragId === tab.id && "opacity-50",
              overId === tab.id && dragId !== tab.id && "ring-1 ring-neutral-500",
              active
                ? "bg-neutral-800 text-neutral-100"
                : "text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200"
            )}
          >
            <span className="text-neutral-500">{icon}</span>
            {editing ? (
              <TabRenameInput
                initial={title}
                onSubmit={(value) => {
                  setEditingId(null);
                  if (value.trim() !== title) void renameTab(tab.id, value);
                }}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <span className="max-w-[140px] truncate">{title}</span>
            )}
            {isSession && tab.session.status === "exited" ? (
              <Circle size={7} className="ml-0.5 fill-neutral-600 text-neutral-600" />
            ) : null}
            <button
              type="button"
              aria-label="Close tab"
              onClick={(event) => {
                event.stopPropagation();
                void closeTab(tab.id);
              }}
              className="flex h-4 w-4 items-center justify-center rounded text-neutral-500 opacity-0 transition-opacity hover:bg-neutral-700 hover:text-neutral-100 group-hover:opacity-100"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.tab)} onClose={() => setMenu(null)} />
      )}
    </div>
  );
};
