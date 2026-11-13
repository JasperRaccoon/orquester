import React, { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import type { StorageNode } from "@orquester/api";
import { useApi } from "../../../context/orquester-context";
import { Button, ConfirmDialog, Input, Modal } from "../../ui";
import { Notice } from "../../settings/primitives";
import { formatBytes } from "../system-format";
import { errorText } from "./storage-paths";

/**
 * Delete one entry of the map. Outside the workspaces root the daemon wants the
 * entry's name typed back (`actions.confirmDelete`); the button stays disabled
 * until it matches. A refusal (403 reason, the OS's error) stays in the dialog.
 */
export const StorageDeleteDialog: React.FC<{
  node: StorageNode | null;
  onCancel: () => void;
  onDeleted: (node: StorageNode, freedBytes: number) => void;
}> = ({ node, onCancel, onDeleted }) => {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setBusy(false);
    setError(null);
  }, [node]);

  const typed = node?.actions?.confirmDelete === true;
  const confirm = async () => {
    if (!node || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.deleteStorageEntry({ path: node.path, ...(typed ? { confirm: node.name } : {}) });
      onDeleted(node, result.freedBytes);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open={node !== null}
      title={node?.kind === "dir" ? "Delete folder?" : "Delete file?"}
      confirmLabel={busy ? "Deleting…" : "Delete"}
      confirmText={typed ? node?.name : undefined}
      confirmDisabled={busy}
      message={
        node ? (
          <div className="space-y-2">
            <p>
              Delete <code className="break-all text-neutral-200">{node.path}</code>
              {node.kind === "dir" ? " and everything inside it" : ""}? This can&apos;t be undone.
            </p>
            <p className="text-xs tabular-nums text-neutral-500">
              {formatBytes(node.sizeBytes)} on disk
              {node.kind === "dir" ? ` · ${node.items.toLocaleString()} items` : ""}
            </p>
            {typed && (
              <p className="text-xs">
                This is outside the workspaces. Type <code className="text-neutral-200">{node.name}</code> to confirm.
              </p>
            )}
            {error && <Notice tone="danger">{error}</Notice>}
          </div>
        ) : (
          ""
        )
      }
      onConfirm={() => void confirm()}
      onCancel={onCancel}
    />
  );
};

/** Why `value` cannot be the new name, or null when it can (same rules as the daemon's). */
function nameProblem(value: string): string | null {
  const name = value.trim();
  if (!name) return "Enter a name.";
  if (/[\\/]/.test(name)) return "A name can't contain “/” or “\\”.";
  if (name.includes("\0")) return "A name can't contain a NUL character.";
  if (name === "." || name === "..") return "That name isn't allowed.";
  return null;
}

/** Rename one entry of the map in place (same folder, a new single path segment). */
export const StorageRenameDialog: React.FC<{
  node: StorageNode | null;
  onCancel: () => void;
  onRenamed: (node: StorageNode, newPath: string) => void;
}> = ({ node, onCancel, onRenamed }) => {
  const api = useApi();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setValue(node?.name ?? "");
    setBusy(false);
    setError(null);
  }, [node]);

  const problem = node ? nameProblem(value) : null;
  const unchanged = !node || value.trim() === node.name;
  const submit = async () => {
    if (!node || busy || problem || unchanged) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.renameStorageEntry({ path: node.path, newName: value.trim() });
      onRenamed(node, result.path);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={node !== null} onClose={onCancel} className="max-w-sm" ariaLabel="Rename">
      <form
        className="w-full p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="mb-3 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-neutral-800 text-neutral-300">
            <Pencil size={15} />
          </span>
          <p className="text-sm font-medium text-neutral-100">{node?.kind === "dir" ? "Rename folder" : "Rename file"}</p>
        </div>
        {node && <p className="mb-2 break-all text-xs text-neutral-500">{node.path}</p>}
        <Input
          autoFocus
          aria-label="New name"
          value={value}
          // 16px on mobile (text-base) prevents iOS from zooming on focus.
          className="text-base md:text-sm"
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
        />
        {problem && !unchanged && <p className="mt-1.5 text-xs text-danger">{problem}</p>}
        {error && (
          <Notice tone="danger" className="mt-3">
            {error}
          </Notice>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy || problem !== null || unchanged}>
            {busy ? "Renaming…" : "Rename"}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
