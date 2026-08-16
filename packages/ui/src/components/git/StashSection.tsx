import React, { useCallback, useEffect, useState } from "react";
import { Archive, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import type { GitStashEntry } from "@orquester/api";
import { cn } from "../../lib/cn";
import { ApiError } from "../../lib/api-client";
import { Button, Input } from "../ui";
import { useApi } from "../../context/orquester-context";

interface StashSectionProps {
  projectPath: string;
  /** True when there is something in the working tree worth stashing. */
  hasChanges: boolean;
  /** Bumped by the panel after anything that can change the stash list / working tree. */
  reloadToken: number;
  /** Report a finished mutation so the panel re-reads status + bumps the token. */
  onChanged: () => void;
  /** Surface a failed stash op (nothing to stash, conflicting pop, …) — the
   *  panel formats it (it owns the daemon-message extraction). */
  onError: (error: unknown) => void;
}

/**
 * The stash strip at the bottom of the Changes panel: a collapsible list of
 * `git stash list` entries with apply/pop/drop, plus a create box that stashes
 * the current working tree (untracked files included). Collapsed by default so
 * it costs one line until there is something in it.
 */
export const StashSection: React.FC<StashSectionProps> = ({
  projectPath,
  hasChanges,
  reloadToken,
  onChanged,
  onError
}) => {
  const api = useApi();
  const [stashes, setStashes] = useState<GitStashEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  // Local reload ticket, bumped on top of the panel's `reloadToken` when the
  // daemon rejects an op as stale (409) — the list is re-read immediately rather
  // than waiting for the parent's next reconcile.
  const [localToken, setLocalToken] = useState(0);

  useEffect(() => {
    let active = true;
    api
      .gitStashes(projectPath)
      .then((entries) => active && setStashes(entries))
      .catch(() => active && setStashes([]));
    return () => {
      active = false;
    };
  }, [api, projectPath, reloadToken, localToken]);

  // Collapse + drop a half-typed message when switching repos.
  useEffect(() => {
    setOpen(false);
    setCreating(false);
    setMessage("");
  }, [projectPath]);

  const run = useCallback(
    async (op: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await op();
      } catch (error) {
        // 409 = the daemon found a different stash at that position, i.e. this
        // list is stale (another client, or a terminal). Re-read it instead of
        // just reporting; the row the user clicked no longer means what it said.
        if (error instanceof ApiError && error.status === 409) {
          setLocalToken((v) => v + 1);
        }
        onError(error);
      } finally {
        setBusy(false);
        onChanged();
      }
    },
    [onChanged, onError]
  );

  const create = () =>
    void run(async () => {
      await api.gitStashCreate({
        path: projectPath,
        message: message.trim() || undefined,
        includeUntracked: true
      });
      setMessage("");
      setCreating(false);
      setOpen(true);
    });

  return (
    <div className="shrink-0 border-t border-neutral-800">
      <div className="flex h-8 items-center gap-1 pl-1.5 pr-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left text-xs text-neutral-400",
            "transition-colors hover:text-neutral-200",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
          )}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <Archive size={12} className="shrink-0" />
          <span>Stashes</span>
          <span className="font-mono text-neutral-600">{stashes.length}</span>
        </button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!hasChanges || busy}
          title={hasChanges ? "Stash all changes" : "Nothing to stash"}
          onClick={() => setCreating((v) => !v)}
        >
          Stash all
        </Button>
      </div>

      {creating && (
        <div className="flex items-center gap-1.5 px-2 pb-2">
          <Input
            autoFocus
            placeholder="Stash message (optional)"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
              if (e.key === "Escape") setCreating(false);
            }}
          />
          <Button size="sm" disabled={busy} onClick={create}>
            Stash
          </Button>
        </div>
      )}

      {open && (
        <div className="max-h-40 overflow-auto border-t border-neutral-900">
          {stashes.length === 0 ? (
            <p className="px-3 py-2 text-xs text-neutral-600">No stashes.</p>
          ) : (
            stashes.map((stash) => (
              <StashRow
                key={`${stash.index}-${stash.sha}`}
                stash={stash}
                busy={busy}
                onApply={() =>
                  void run(() =>
                    api.gitStashApply({ path: projectPath, index: stash.index, sha: stash.sha })
                  )
                }
                onPop={() =>
                  void run(() =>
                    api.gitStashPop({ path: projectPath, index: stash.index, sha: stash.sha })
                  )
                }
                onDrop={() => {
                  if (!window.confirm(`Drop stash "${stash.message}"? This cannot be undone.`)) return;
                  void run(() =>
                    api.gitStashDrop({ path: projectPath, index: stash.index, sha: stash.sha })
                  );
                }}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
};

const StashRow: React.FC<{
  stash: GitStashEntry;
  busy: boolean;
  onApply: () => void;
  onPop: () => void;
  onDrop: () => void;
}> = ({ stash, busy, onApply, onPop, onDrop }) => (
  <div className="group flex items-center gap-2 py-1.5 pl-3 pr-2 text-sm hover:bg-neutral-900">
    <div className="min-w-0 flex-1">
      <div className="truncate text-neutral-200" title={stash.message}>
        {stash.message || `stash@{${stash.index}}`}
      </div>
      <div className="truncate text-xs text-neutral-500">
        {stash.branch && <span>{stash.branch} · </span>}
        <span className="font-mono">{stash.sha.slice(0, 7)}</span>
      </div>
    </div>
    {/* Always reachable on touch; revealed on hover/focus on desktop. */}
    <div className="flex shrink-0 items-center gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
      <Button size="sm" variant="ghost" disabled={busy} onClick={onApply} title="Apply, keeping the stash">
        Apply
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onPop} title="Apply and remove the stash">
        Pop
      </Button>
      <Button
        size="icon"
        variant="ghost"
        disabled={busy}
        onClick={onDrop}
        aria-label={`Drop stash ${stash.message}`}
        title="Drop the stash"
        className="text-neutral-500 hover:text-red-400"
      >
        <Trash2 size={13} />
      </Button>
    </div>
  </div>
);
