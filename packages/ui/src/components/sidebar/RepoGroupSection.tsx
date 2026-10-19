import React, { useRef, useState } from "react";
import { ChevronRight, ClipboardCopy, ImageIcon, KeyRound, Pencil, Plus, RotateCcw } from "lucide-react";
import { normalizeRepoLabel, repoLabelProblem } from "@orquester/api";
import { cn } from "../../lib/cn";
import { copyText } from "../../lib/clipboard";
import { ApiError } from "../../lib/api-client";
import { useApi } from "../../context/orquester-context";
import { useRepoIdentity } from "../../lib/repo-identities/hooks";
import { setRepoLabel } from "../../lib/repo-identities/store";
import { setRepoGroupCollapsed } from "../../lib/collapsed-repo-groups";
import { useSecretFilesEnabled, useSecretVault } from "../../lib/secret-files/hooks";
import type { RepoProjectGroup } from "../../lib/repo-groups";
import { RepoIcon } from "../repo/RepoIcon";
import { RepoIconDialog } from "../repo/RepoIconDialog";
import { SecretFilesDialog } from "../secret-files/SecretFilesDialog";
import { repoSecretCount } from "../secret-files/drift.logic";
import { ContextMenu, Input, type ContextMenuItem } from "../ui";
import { CountPill, RowActionsButton } from "./parts";

/** The daemon's wording when it sent one. */
function describeError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.serverMessage ?? fallback;
  return err instanceof Error ? err.message : fallback;
}

/**
 * Inline label editor, like `NewItemInput`: Enter or leaving the field saves,
 * Escape cancels. A blank value goes back to the default label. A problem
 * keeps the field open with the reason under it.
 */
const RepoLabelInput: React.FC<{
  repoKey: string;
  initialValue: string;
  defaultLabel: string;
  onSave: (label: string | null) => Promise<void>;
  onDone: () => void;
}> = ({ repoKey, initialValue, defaultLabel, onSave, onDone }) => {
  const [value, setValue] = useState(initialValue);
  const [problem, setProblem] = useState<string | null>(null);
  // Enter, then the blur of the field going away, must save once.
  const settled = useRef(false);

  const finish = () => {
    settled.current = true;
    onDone();
  };

  const submit = async () => {
    if (settled.current) return;
    const label = normalizeRepoLabel(value);
    const reason = label === null ? null : repoLabelProblem(label);
    if (reason) {
      setProblem(reason);
      return;
    }
    // The default spelled out is no custom label at all.
    const next = label === null || label === defaultLabel ? null : label;
    if ((next ?? defaultLabel) === initialValue) {
      finish();
      return;
    }
    settled.current = true;
    try {
      await onSave(next);
      onDone();
    } catch (err) {
      settled.current = false;
      setProblem(describeError(err, "Could not rename the repo."));
    }
  };

  return (
    <div className="px-1 py-1">
      <div className="flex items-center gap-2">
        <RepoIcon repoKey={repoKey} size={24} />
        <Input
          autoFocus
          aria-label="Repo label"
          aria-invalid={problem !== null}
          value={value}
          placeholder={defaultLabel}
          onChange={(event) => {
            setValue(event.target.value);
            setProblem(null);
          }}
          onBlur={() => void submit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              finish();
            }
          }}
        />
      </div>
      {problem && <p className="px-1 pt-1 text-[11px] text-danger">{problem}</p>}
    </div>
  );
};

/**
 * One repo group inside the open workspace (spec 2026-10-18 §1, §3): a header
 * — chevron, repo icon, label, count, "+" (a fresh clone) and a ⋯ menu that
 * right-click also opens — and, unless collapsed, its project rows. With the
 * Secret files plugin on, the menu opens the repo's "Secret files…" dialog and
 * an amber key count flags clones needing attention or new candidate files.
 */
export const RepoGroupSection: React.FC<{
  /** The workspace whose projects the group lists (the secret-files vault's scope). */
  workspace: string;
  group: RepoProjectGroup;
  /** Start a fresh clone of this repo; absent when there is no clone URL. */
  onClone?: () => void;
  children: React.ReactNode;
}> = ({ workspace, group, onClone, children }) => {
  const api = useApi();
  const customLabel = useRepoIdentity(group.repoKey)?.label;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);
  const [secretsOpen, setSecretsOpen] = useState(false);
  const secretsOn = useSecretFilesEnabled();
  const secretCount = repoSecretCount(secretsOn, useSecretVault(workspace, group.repoKey));
  const [error, setError] = useState<string | null>(null);
  const expanded = !group.collapsed;

  const saveLabel = (label: string | null) => setRepoLabel(api, group.repoKey, label);

  const menuItems: ContextMenuItem[] = [
    { label: "Change icon…", icon: <ImageIcon size={13} />, onClick: () => setIconOpen(true) },
    {
      label: "Rename label…",
      icon: <Pencil size={13} />,
      onClick: () => {
        setError(null);
        setRenaming(true);
      }
    },
    { label: "Copy repo id", icon: <ClipboardCopy size={13} />, onClick: () => void copyText(group.repoKey) },
    ...(secretsOn ? [{ label: "Secret files…", icon: <KeyRound size={13} />, onClick: () => setSecretsOpen(true) }] : []),
    ...(customLabel !== undefined
      ? [
          {
            label: "Reset label",
            icon: <RotateCcw size={13} />,
            onClick: () => {
              setError(null);
              saveLabel(null).catch((err: unknown) => setError(describeError(err, "Could not reset the label.")));
            }
          }
        ]
      : [])
  ];

  return (
    <div role="group" aria-label={group.label} className="py-1">
      {renaming ? (
        <RepoLabelInput
          repoKey={group.repoKey}
          initialValue={group.label}
          defaultLabel={group.defaultLabel}
          onSave={saveLabel}
          onDone={() => setRenaming(false)}
        />
      ) : (
        <div
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY });
          }}
          className="group flex items-center rounded-lg text-neutral-200 transition-colors hover:bg-neutral-800/60 hover:text-neutral-50"
        >
          <button
            type="button"
            aria-expanded={expanded}
            title={group.repoKey}
            // A search or the open project holds the group open; the click has nothing to change.
            onClick={() => {
              if (!group.pinnedOpen) setRepoGroupCollapsed(group.repoKey, expanded);
            }}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-[13px] font-medium focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
          >
            <ChevronRight
              size={13}
              aria-hidden
              className={cn(
                "shrink-0 text-neutral-500 transition-transform duration-150 motion-reduce:transition-none",
                expanded && "rotate-90",
                group.pinnedOpen && "opacity-50"
              )}
            />
            <RepoIcon repoKey={group.repoKey} size={24} />
            <span className="min-w-0 flex-1 truncate">{group.label}</span>
            {secretCount && (
              <CountPill tone="warn" title={secretCount.title}>
                <KeyRound size={11} aria-hidden />
                {secretCount.count}
              </CountPill>
            )}
            <CountPill>{group.projects.length}</CountPill>
          </button>
          {onClone && (
            <button
              type="button"
              aria-label={`New clone of ${group.label}`}
              title={`New clone of ${group.label}`}
              onClick={(event) => {
                event.stopPropagation();
                onClone();
              }}
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-500",
                "transition-colors hover:bg-neutral-700 hover:text-neutral-200",
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
                "opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
              )}
            >
              <Plus size={15} />
            </button>
          )}
          <RowActionsButton label={`Actions for ${group.label}`} onOpen={setMenu} />
        </div>
      )}
      {error && <p className="px-2 pt-0.5 text-[11px] text-danger">{error}</p>}

      {expanded && <div className="space-y-px pl-5">{children}</div>}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
      <RepoIconDialog
        open={iconOpen}
        repoKey={group.repoKey}
        repoLabel={group.label}
        onClose={() => setIconOpen(false)}
      />
      {secretsOn && (
        <SecretFilesDialog
          open={secretsOpen}
          workspace={workspace}
          repoKey={group.repoKey}
          repoLabel={group.label}
          onClose={() => setSecretsOpen(false)}
        />
      )}
    </div>
  );
};
