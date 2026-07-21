import React, { useState } from "react";
import { ChevronDown, Circle, FolderTree, GitBranch, Globe, ListTodo, Pencil, Trash2, X } from "lucide-react";
import { BottomSheet, ConfirmDialog, DropdownEmpty } from "../ui";
import { SessionStatusDot } from "../ui/session-status-dot";
import { cn } from "../../lib/cn";
import { getRegistryIcon } from "../../icons";
import { useActiveTabId, useAppStore, useProjectTabs } from "../../store/app";
import type { ProjectTab } from "../../store/app";

const tabLabel = (tab: ProjectTab) =>
  tab.type === "session"
    ? tab.session.title
    : tab.type === "browser"
      ? tab.browser.title || "Browser"
      : tab.title;
const tabIcon = (tab: ProjectTab, size = 16) =>
  tab.type === "session" ? (
    getRegistryIcon(tab.session.kind, tab.session.refId, size)
  ) : tab.type === "git" ? (
    <GitBranch size={size} />
  ) : tab.type === "todo" ? (
    <ListTodo size={size} />
  ) : tab.type === "browser" ? (
    <Globe size={size} />
  ) : (
    <FolderTree size={size} />
  );

/** Inline editor shown in place of a tab row while renaming (touch-sized). */
const SheetRenameInput: React.FC<{
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
      className="h-9 min-w-0 flex-1 rounded bg-neutral-800 px-2 text-[15px] text-neutral-100 outline-none ring-1 ring-neutral-600"
    />
  );
};

/**
 * Mobile: shows the active tab and opens a bottom sheet to switch between tabs.
 * Each row also exposes rename + close (and "delete list" for to-do tabs) since
 * the desktop right-click / double-click / hover affordances don't work on touch.
 */
export const TabSwitcher: React.FC = () => {
  const tabs = useProjectTabs();
  const activeId = useActiveTabId();
  const activateTab = useAppStore((s) => s.activateTab);
  const requestCloseTab = useAppStore((s) => s.requestCloseTab);
  const renameTab = useAppStore((s) => s.renameTab);
  const renameTodo = useAppStore((s) => s.renameTodo);
  const deleteTodo = useAppStore((s) => s.deleteTodo);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ todoId: string; name: string } | null>(null);

  const active = tabs.find((t) => t.id === activeId);
  const close = () => {
    setOpen(false);
    setEditingId(null);
  };

  const submitRename = (tab: ProjectTab, value: string) => {
    setEditingId(null);
    const trimmed = value.trim();
    if (!trimmed || trimmed === tabLabel(tab)) {
      return;
    }
    if (tab.type === "todo") {
      void renameTodo(tab.todoId, value);
    } else if (tab.type === "session") {
      void renameTab(tab.id, value);
    }
  };

  const trigger = (
    <span className="flex h-8 min-w-0 items-center gap-1.5 rounded-md bg-neutral-800/60 px-2 text-sm text-neutral-200">
      <span className="text-neutral-500">{active ? tabIcon(active, 14) : <FolderTree size={14} />}</span>
      <span className="max-w-[42vw] truncate">{active ? tabLabel(active) : "No tabs"}</span>
      <ChevronDown size={14} className="text-neutral-500" />
    </span>
  );

  return (
    <>
      <button type="button" className="app-no-drag inline-flex min-w-0" onClick={() => setOpen(true)}>
        {trigger}
      </button>
      <BottomSheet open={open} onClose={close} title="Tabs">
        {tabs.length === 0 && <DropdownEmpty>No tabs open</DropdownEmpty>}
        {tabs.map((tab) => {
          const isActive = tab.id === activeId;
          const canRename = tab.type === "session" || tab.type === "todo";
          if (editingId === tab.id) {
            return (
              <div key={tab.id} className="flex items-center gap-2 px-2 py-1.5">
                <span className="text-neutral-500">{tabIcon(tab)}</span>
                <SheetRenameInput
                  initial={tabLabel(tab)}
                  onSubmit={(value) => submitRename(tab, value)}
                  onCancel={() => setEditingId(null)}
                />
              </div>
            );
          }
          return (
            <div
              key={tab.id}
              className={cn("flex items-center gap-1 rounded", isActive && "bg-neutral-800/60")}
            >
              <button
                type="button"
                onClick={() => {
                  activateTab(tab.id);
                  close();
                }}
                className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-2.5 text-left text-[15px] text-neutral-200 hover:bg-neutral-800"
              >
                <span className="text-neutral-500">{tabIcon(tab)}</span>
                {tab.type === "session" ? (
                  <SessionStatusDot sessionId={tab.id} status={tab.session.status} />
                ) : null}
                <span className="min-w-0 flex-1 truncate">{tabLabel(tab)}</span>
                {isActive && <Circle size={7} className="shrink-0 fill-neutral-300 text-neutral-300" />}
              </button>
              {canRename && (
                <button
                  type="button"
                  aria-label="Rename tab"
                  onClick={() => setEditingId(tab.id)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
                >
                  <Pencil size={16} />
                </button>
              )}
              {tab.type === "todo" && (
                <button
                  type="button"
                  aria-label="Delete list"
                  onClick={() => {
                    // ConfirmDialog (a Modal, z-100) renders below the sheet
                    // (z-110), so close the sheet first to surface it.
                    close();
                    setConfirmDelete({ todoId: tab.todoId, name: tab.title });
                  }}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded text-red-400 hover:bg-neutral-800 hover:text-red-300"
                >
                  <Trash2 size={16} />
                </button>
              )}
              <button
                type="button"
                aria-label="Close tab"
                onClick={() => {
                  // ConfirmDialog (z-100) renders below this sheet (z-110), so
                  // drop the sheet when a confirm opens to surface it.
                  if (requestCloseTab(tab.id)) close();
                }}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-neutral-800 hover:text-red-300"
              >
                <X size={16} />
              </button>
            </div>
          );
        })}
      </BottomSheet>
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
    </>
  );
};
