import React, { useMemo, useState } from "react";
import { Check, Folder, FolderPlus, PanelLeftClose, Plus, Trash2 } from "lucide-react";
import {
  Button,
  ConfirmDialog,
  ContextMenu,
  Dropdown,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  IconButton,
  Input,
  Modal,
  ModalCloseButton,
  type ContextMenuItem
} from "../ui";
import { useAppStore } from "../../store/app";
import type { WorkspaceSummary } from "../../types";

/** Root sidebar view: the list of workspace folders. */
export const WorkspaceList: React.FC = () => {
  const workspaces = useAppStore((s) => s.workspaces);
  const loading = useAppStore((s) => s.workspacesLoading);
  const accounts = useAppStore((s) => s.accounts);
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const createWorkspace = useAppStore((s) => s.createWorkspace);
  const deleteWorkspace = useAppStore((s) => s.deleteWorkspace);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; workspace: WorkspaceSummary } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WorkspaceSummary | null>(null);

  // id → label, for rendering the bound account on each row.
  const accountLabel = useMemo(() => {
    const map = new Map(accounts.map((a) => [a.id, a.label] as const));
    return (id?: string | null) => (id ? map.get(id) ?? null : null);
  }, [accounts]);

  const menuItems = (workspace: WorkspaceSummary): ContextMenuItem[] => [
    {
      label: "Delete",
      icon: <Trash2 size={13} />,
      danger: true,
      onClick: () => setPendingDelete(workspace)
    }
  ];

  const close = () => {
    setCreating(false);
    setName("");
    setAccountId(null);
  };

  const submit = async () => {
    if (!name.trim()) {
      return;
    }
    setBusy(true);
    try {
      await createWorkspace(name.trim(), accountId ?? undefined);
      close();
    } finally {
      setBusy(false);
    }
  };

  const pickedLabel = accountId ? accountLabel(accountId) : "No account (default identity)";

  return (
    <>
      <div className="flex h-9 items-center gap-1 px-2">
        <IconButton label="Collapse sidebar" className="hidden md:flex" onClick={toggleSidebar}>
          <PanelLeftClose size={15} />
        </IconButton>
        <span className="flex-1 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
          Workspaces
        </span>
        <IconButton label="New workspace" onClick={() => setCreating(true)}>
          <FolderPlus size={15} />
        </IconButton>
      </div>

      <nav className="flex-1 space-y-px overflow-y-auto px-2 pb-2">
        {loading && workspaces.length === 0 && (
          <p className="px-2 py-2 text-xs text-neutral-600">Loading…</p>
        )}
        {!loading && workspaces.length === 0 && (
          <p className="px-2 py-2 text-xs text-neutral-600">No workspaces yet</p>
        )}
        {workspaces.map((workspace) => {
          const label = accountLabel(workspace.gitAccountId);
          return (
            <button
              key={workspace.path}
              type="button"
              onClick={() => void openWorkspace(workspace.name)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ x: event.clientX, y: event.clientY, workspace });
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
            >
              <Folder size={15} className="text-neutral-500" />
              <span className="flex-1 truncate">{workspace.name}</span>
              {label && (
                <span className="truncate text-[10px] text-neutral-600" title={`git account: ${label}`}>
                  {label}
                </span>
              )}
              <span className="text-xs text-neutral-600">{workspace.projectCount}</span>
            </button>
          );
        })}
      </nav>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.workspace)}
          onClose={() => setMenu(null)}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete workspace"
        confirmText={pendingDelete?.name}
        message={
          <>
            This permanently deletes <span className="font-medium text-neutral-200">{pendingDelete?.name}</span>{" "}
            and all of its projects from disk. This cannot be undone. Type the workspace name to confirm.
          </>
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const name = pendingDelete?.name;
          setPendingDelete(null);
          if (name) {
            void deleteWorkspace(name);
          }
        }}
      />

      <Modal open={creating} onClose={close} className="max-w-sm">
        <div className="flex w-full flex-col">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 px-4">
            <span className="text-sm font-medium text-neutral-100">New workspace</span>
            <ModalCloseButton onClose={close} />
          </div>
          <div className="space-y-3 p-4">
            <div className="space-y-1.5">
              <label className="text-xs text-neutral-400">Name</label>
              <Input
                autoFocus
                placeholder="workspace-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void submit()}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-neutral-400">Git account</label>
              <Dropdown
                width="w-72"
                trigger={
                  <span className="flex h-8 w-72 items-center justify-between rounded-md border border-neutral-700 bg-neutral-900 px-2.5 text-sm text-neutral-200">
                    <span className="truncate">{pickedLabel}</span>
                  </span>
                }
              >
                <DropdownLabel>Identity</DropdownLabel>
                <DropdownItem
                  icon={accountId === null ? <Check size={14} /> : <span className="h-2 w-2" />}
                  onClick={() => setAccountId(null)}
                >
                  No account (default identity)
                </DropdownItem>
                {accounts.map((account) => (
                  <DropdownItem
                    key={account.id}
                    icon={accountId === account.id ? <Check size={14} /> : <span className="h-2 w-2" />}
                    onClick={() => setAccountId(account.id)}
                  >
                    {account.label} <span className="text-neutral-500">@{account.githubLogin}</span>
                  </DropdownItem>
                ))}
                <DropdownSeparator />
                <DropdownItem
                  icon={<Plus size={14} />}
                  onClick={() => {
                    close();
                    setSettingsOpen(true);
                  }}
                >
                  Add account…
                </DropdownItem>
              </Dropdown>
              <p className="text-[11px] text-neutral-500">
                The git identity is bound to this workspace permanently. To change it, delete and recreate the workspace.
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button size="sm" variant="outline" disabled={busy} onClick={close}>
                Cancel
              </Button>
              <Button size="sm" disabled={busy || !name.trim()} onClick={() => void submit()}>
                {busy ? "Creating…" : "Create"}
              </Button>
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
};
