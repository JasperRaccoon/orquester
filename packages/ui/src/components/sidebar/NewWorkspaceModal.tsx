import React, { useMemo, useState } from "react";
import { Check, Github, Plus } from "lucide-react";
import { BitbucketIcon } from "../../icons";
import {
  AdaptiveMenu,
  Button,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  Input,
  Modal,
  ModalCloseButton
} from "../ui";
import { useAppStore } from "../../store/app";

/** The "New workspace" dialog: a name and the git identity bound to it for good. */
export const NewWorkspaceModal: React.FC<{ open: boolean; onClose: () => void }> = ({
  open,
  onClose
}) => {
  const accounts = useAppStore((s) => s.accounts);
  const createWorkspace = useAppStore((s) => s.createWorkspace);
  const openSettings = useAppStore((s) => s.openSettings);

  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const accountLabel = useMemo(() => {
    const map = new Map(accounts.map((a) => [a.id, a.label] as const));
    return (id?: string | null) => (id ? map.get(id) ?? null : null);
  }, [accounts]);

  const close = () => {
    onClose();
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
    <Modal open={open} onClose={close} className="max-w-sm">
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
            <AdaptiveMenu
              width="w-72"
              title="Identity"
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
                  {account.label}{" "}
                  <span className="inline-flex items-center gap-1 text-neutral-500">
                    {account.provider === "github" ? (
                      <Github size={12} />
                    ) : (
                      <BitbucketIcon size={12} />
                    )}
                    @{account.login}
                  </span>
                </DropdownItem>
              ))}
              <DropdownSeparator />
              <DropdownItem
                icon={<Plus size={14} />}
                onClick={() => {
                  close();
                  openSettings("git-hosting");
                }}
              >
                Add account…
              </DropdownItem>
            </AdaptiveMenu>
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
  );
};
