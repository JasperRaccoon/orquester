import React, { useState } from "react";
import { Check, Plus, Server, Trash2 } from "lucide-react";
import { cn } from "../../lib/cn";
import {
  AdaptiveMenu,
  Button,
  ConfirmDialog,
  DropdownContext,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  Input
} from "../ui";
import { useAppStore } from "../../store/app";
import type { ConnectionStatus } from "../../types";

const STATUS_COLOR: Record<ConnectionStatus, string> = {
  connected: "bg-emerald-400",
  connecting: "bg-neutral-500 animate-pulse",
  disconnected: "bg-neutral-700",
  error: "bg-red-500"
};

/**
 * Per-row remove affordance. Closes the menu before arming the confirm dialog:
 * the dialog is a Modal (z-[100]) and would otherwise render *under* the mobile
 * bottom sheet (z-[110]), and it lives outside the menu subtree so it survives
 * the close.
 */
const RemoveServerButton: React.FC<{ onRequest: () => void }> = ({ onRequest }) => {
  const { close } = React.useContext(DropdownContext);
  return (
    <button
      type="button"
      aria-label="Remove server"
      // 32px hit box with a gap from the row, so a thumb can't catch the
      // adjacent "switch server" item. Always visible on the mobile sheet —
      // touch has no hover, so the reveal-on-hover affordance only works from
      // md up.
      className="mx-1 flex h-8 w-8 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-red-400 md:hidden md:group-hover:flex"
      onClick={() => {
        close();
        onRequest();
      }}
    >
      <Trash2 size={14} />
    </button>
  );
};

/** Sidebar footer: shows the active daemon and switches/manages servers. */
export const ServerSwitcher: React.FC = () => {
  const connections = useAppStore((s) => s.connections);
  const activeId = useAppStore((s) => s.activeConnectionId);
  const status = useAppStore((s) => s.connectionStatus);
  const select = useAppStore((s) => s.selectConnection);
  const removeRemote = useAppStore((s) => s.removeRemote);
  const addRemote = useAppStore((s) => s.addRemote);

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [pendingRemove, setPendingRemove] = useState<{ id: string; name: string } | null>(null);

  const active = connections.find((c) => c.id === activeId);

  // No credential is collected here: a protected server prompts via AuthModal on
  // first connect, which derives the hash + builds the bearer client-side (the
  // raw password never leaves the client nor lands in remotes.json).
  const submit = async () => {
    if (!url.trim()) {
      return;
    }
    const id = await addRemote({ name, baseUrl: url });
    setAdding(false);
    setName("");
    setUrl("");
    void select(id);
  };

  const trigger = (
    <span className="flex w-full items-center gap-2 px-1 py-0.5 text-left">
      <span className={cn("h-2 w-2 shrink-0 rounded-full", STATUS_COLOR[status])} />
      <span className="flex-1 truncate text-xs text-neutral-300">{active?.name ?? "No server"}</span>
      <Server size={13} className="text-neutral-600" />
    </span>
  );

  return (
    <div className="border-t border-neutral-800 p-2">
      <AdaptiveMenu trigger={trigger} width="w-64" title="Servers">
        <DropdownLabel>Servers</DropdownLabel>
        {connections.map((connection) => (
          <div key={connection.id} className="group flex items-center">
            <DropdownItem
              className="flex-1"
              icon={
                connection.id === activeId ? (
                  <Check size={14} />
                ) : (
                  <span className={cn("h-2 w-2 rounded-full", STATUS_COLOR[connection.status])} />
                )
              }
              onClick={() => void select(connection.id)}
            >
              <span className="truncate">{connection.name}</span>
            </DropdownItem>
            {connection.kind === "remote" && (
              <RemoveServerButton
                onRequest={() => setPendingRemove({ id: connection.id, name: connection.name })}
              />
            )}
          </div>
        ))}

        <DropdownSeparator />

        {adding ? (
          <div className="space-y-1.5 p-1.5" onClick={(e) => e.stopPropagation()}>
            <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <Input
              placeholder="https://host:47831"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <div className="flex gap-1.5">
              <Button size="sm" className="flex-1" onClick={() => void submit()}>
                Add
              </Button>
              <Button size="sm" variant="outline" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <DropdownItem icon={<Plus size={14} />} keepOpen onClick={() => setAdding(true)}>
            Add server…
          </DropdownItem>
        )}
      </AdaptiveMenu>

      <ConfirmDialog
        open={pendingRemove !== null}
        title="Remove server"
        confirmLabel="Remove"
        message={
          <>
            Remove{" "}
            <span className="font-medium text-neutral-200">{pendingRemove?.name || "this server"}</span>{" "}
            from this client? Nothing on the server itself is touched — you can add it back with its URL.
          </>
        }
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => {
          const target = pendingRemove;
          setPendingRemove(null);
          if (target) {
            void removeRemote(target.id);
          }
        }}
      />
    </div>
  );
};
