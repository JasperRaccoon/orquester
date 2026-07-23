import React, { useState } from "react";
import { FolderTree, GitBranch, Globe, ListTodo, Pencil, Trash2, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { shortAccountLabel } from "../../lib/account-label";
import { getRegistryIcon } from "../../icons";
import { ConfirmDialog } from "../ui";
import { ContextMenu, type ContextMenuItem } from "../ui/context-menu";
import { SessionStatusDot } from "../ui/session-status-dot";
import {
  useActiveTabId,
  useAppStore,
  useProjectTabs,
  type ProjectTab
} from "../../store/app";

/**
 * Short chip label for a proxy session's backing model, e.g. `gpt-5.6-sol` →
 * `sol`, `kimi-k3` → `kimi`. Mirrors the launcher-menu chip so a tab reads the
 * same as the "+" pick it came from. Rendered from `SessionSummary.model` (the
 * daemon-resolved record), so it survives refresh/reattach — never client state.
 */
const shortModelLabel = (model: string): string => {
  const lower = model.toLowerCase();
  if (lower.includes("kimi")) return "kimi";
  const parts = model.split(/[/-]/).filter(Boolean);
  return parts[parts.length - 1] ?? model;
};

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
  const requestCloseTab = useAppStore((s) => s.requestCloseTab);
  const renameTab = useAppStore((s) => s.renameTab);
  const renameTodo = useAppStore((s) => s.renameTodo);
  const deleteTodo = useAppStore((s) => s.deleteTodo);
  const reorderTabs = useAppStore((s) => s.reorderTabs);
  const agentAccounts = useAppStore((s) => s.agentAccounts);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; tab: ProjectTab } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ todoId: string; name: string } | null>(null);

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

  const menuItems = (tab: ProjectTab): ContextMenuItem[] => {
    if (tab.type === "session") {
      return [
        { label: "Rename", icon: <Pencil size={13} />, onClick: () => setEditingId(tab.id) },
        { label: "Close", icon: <X size={13} />, danger: true, onClick: () => void requestCloseTab(tab.id) }
      ];
    }
    if (tab.type === "todo") {
      return [
        { label: "Rename", icon: <Pencil size={13} />, onClick: () => setEditingId(tab.id) },
        {
          label: "Delete list",
          icon: <Trash2 size={13} />,
          danger: true,
          onClick: () => setConfirmDelete({ todoId: tab.todoId, name: tab.title })
        },
        { label: "Close", icon: <X size={13} />, onClick: () => void requestCloseTab(tab.id) }
      ];
    }
    return [{ label: "Close", icon: <X size={13} />, danger: true, onClick: () => void requestCloseTab(tab.id) }];
  };

  return (
    <div className="app-no-drag flex items-center gap-1">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const isSession = tab.type === "session";
        const canRename = isSession || tab.type === "todo";
        const accountId = tab.type === "session" ? tab.session.accountId : undefined;
        const accountLabel = accountId
          ? shortAccountLabel(agentAccounts?.accounts.find((a) => a.id === accountId)?.label)
          : undefined;
        // `model` is set by the daemon only for the claudex/claudemix proxy
        // launchers, so its presence gates the backing-model badge.
        const modelLabel =
          tab.type === "session" && tab.session.model
            ? shortModelLabel(tab.session.model)
            : undefined;
        const editing = editingId === tab.id;
        const title = isSession
          ? tab.session.title
          : tab.type === "browser"
            ? tab.browser.title || "Browser"
            : tab.title;
        const icon = isSession ? (
          getRegistryIcon(tab.session.kind, tab.session.refId, 13)
        ) : tab.type === "git" ? (
          <GitBranch size={13} />
        ) : tab.type === "todo" ? (
          <ListTodo size={13} />
        ) : tab.type === "browser" ? (
          <Globe size={13} />
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
            onDoubleClick={() => canRename && setEditingId(tab.id)}
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
                  if (value.trim() !== title) {
                    if (tab.type === "todo") {
                      void renameTodo(tab.todoId, value);
                    } else if (isSession) {
                      void renameTab(tab.id, value);
                    }
                  }
                }}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <span className="max-w-[140px] truncate">{title}</span>
            )}
            {modelLabel ? (
              <span
                className="ml-1 rounded bg-amber-500/15 px-1 text-[10px] text-amber-300"
                title={tab.type === "session" ? tab.session.model : undefined}
              >
                {modelLabel}
              </span>
            ) : null}
            {accountLabel ? (
              <span className="ml-1 rounded bg-neutral-800 px-1 text-[10px] text-neutral-400">
                {accountLabel}
              </span>
            ) : null}
            {isSession ? (
              <SessionStatusDot sessionId={tab.id} status={tab.session.status} className="ml-0.5" />
            ) : null}
            <button
              type="button"
              aria-label="Close tab"
              onClick={(event) => {
                event.stopPropagation();
                void requestCloseTab(tab.id);
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
      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete to-do list"
        message={`Delete '${confirmDelete?.name ?? ""}'? This removes it on every machine.`}
        confirmLabel="Delete"
        danger
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) void deleteTodo(confirmDelete.todoId);
          setConfirmDelete(null);
        }}
      />
    </div>
  );
};
