import React, { useEffect, useMemo, useState } from "react";
import { FileText, KeyRound, Loader2 } from "lucide-react";

import type { SecretFileCompare, SecretKeyChange } from "@orquester/api";

import { useApi } from "../../context/orquester-context";
import { ApiError } from "../../lib/api-client";
import { cn } from "../../lib/cn";
import { useSecretVault } from "../../lib/secret-files/hooks";
import { useAppStore } from "../../store/app";
import { Button, Modal, ModalCloseButton } from "../ui";
import {
  compareSummaryText,
  compareTargets,
  countKeyChanges,
  differingKeys,
  secretFileStateText
} from "./drift.logic";

type FileCompare =
  | { status: "loading" }
  | { status: "ok"; compare: SecretFileCompare }
  | { status: "error"; message: string };

const errorText = (err: unknown): string => {
  if (err instanceof ApiError) return err.serverMessage ?? "Could not compare this file.";
  return err instanceof Error && err.message ? err.message : "Could not compare this file.";
};

const CHANGE_BADGE: Record<Exclude<SecretKeyChange, "same">, { label: string; title: string; className: string }> = {
  added: { label: "added", title: "In this project, not in the vault", className: "bg-ok-soft/40 text-ok" },
  removed: { label: "removed", title: "In the vault, not in this project", className: "bg-danger-soft/40 text-danger" },
  changed: { label: "changed", title: "A different value here than in the vault", className: "bg-warn-soft/40 text-warn" }
};

/**
 * Compare one clone's secret files with the vault (spec §7): per file, the
 * variable names added / removed / changed (or line counts) — never values.
 * `path` absent: every managed file of that clone that isn't synced.
 */
export const SecretFileCompareModal: React.FC<{
  open: boolean;
  workspace: string;
  repoKey: string;
  projectPath: string;
  path?: string;
  onClose: () => void;
}> = ({ open, workspace, repoKey, projectPath, path, onClose }) => (
  <Modal open={open} onClose={onClose} className="max-w-lg">
    {open && (
      <CompareBody workspace={workspace} repoKey={repoKey} projectPath={projectPath} path={path} onClose={onClose} />
    )}
  </Modal>
);

const CompareBody: React.FC<{
  workspace: string;
  repoKey: string;
  projectPath: string;
  path?: string;
  onClose: () => void;
}> = ({ workspace, repoKey, projectPath, path, onClose }) => {
  const api = useApi();
  const vault = useSecretVault(workspace, repoKey);
  const clone = vault?.clones.find((entry) => entry.projectPath === projectPath);
  const targets = useMemo(() => compareTargets(clone, path), [clone, path]);
  // Compare again whenever a target's state, its content here or the vault's version of it moves.
  const versionOf = (p: string) => vault?.files.find((file) => file.path === p)?.version ?? "";
  const stateOf = (p: string) => clone?.files.find((file) => file.path === p);
  const fetchKey = targets
    .map((p) => `${p}\u0001${stateOf(p)?.state ?? ""}\u0001${versionOf(p)}\u0001${stateOf(p)?.contentToken ?? ""}`)
    .join("\u0000");

  const [results, setResults] = useState<ReadonlyMap<string, FileCompare>>(new Map());
  useEffect(() => {
    const controller = new AbortController();
    setResults(new Map(targets.map((p) => [p, { status: "loading" }])));
    for (const target of targets) {
      api.compareSecretFile(workspace, repoKey, projectPath, target, controller.signal).then(
        ({ compare }) => {
          if (controller.signal.aborted) return;
          setResults((prev) => new Map(prev).set(target, { status: "ok", compare }));
        },
        (err: unknown) => {
          if (controller.signal.aborted) return;
          setResults((prev) => new Map(prev).set(target, { status: "error", message: errorText(err) }));
        }
      );
    }
    return () => controller.abort();
    // `targets` is read through `fetchKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, workspace, repoKey, projectPath, fetchKey]);

  // The file viewer opens files of the open project only.
  const canOpen = useAppStore((s) => s.currentProject?.path === projectPath);
  const revealInFileBrowser = useAppStore((s) => s.revealInFileBrowser);
  const openFile = (p: string) => {
    revealInFileBrowser(`${projectPath.replace(/\/$/, "")}/${p}`);
    onClose();
  };

  return (
    <div className="flex max-h-[90vh] w-full flex-col">
      <div className="flex items-center gap-3 border-b border-neutral-800 px-4 py-3 sm:px-5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-warn-soft/40 text-warn">
          <KeyRound size={15} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium text-neutral-100">Compare with the vault</h2>
          <p className="truncate text-xs text-neutral-500">{clone?.projectName ?? projectPath}</p>
        </div>
        <ModalCloseButton onClose={onClose} />
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 sm:px-5">
        {targets.length === 0 ? (
          <p className="py-4 text-center text-sm text-neutral-500">Every secret file of this project is in sync.</p>
        ) : (
          targets.map((target) => {
            const file = stateOf(target);
            return (
              <section
                key={target}
                aria-label={target}
                className="rounded-lg border border-neutral-800 bg-neutral-950/40"
              >
                <div className="flex items-center gap-2 border-b border-neutral-800/70 px-3 py-2">
                  <FileText size={13} aria-hidden className="shrink-0 text-neutral-500" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-200" title={target}>
                    {target}
                  </span>
                  {file && <span className="shrink-0 text-[11px] text-neutral-500">{secretFileStateText(file)}</span>}
                  {canOpen && targets.length > 1 && (
                    <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => openFile(target)}>
                      Open
                    </Button>
                  )}
                </div>
                <div className="px-3 py-2">
                  <CompareResult result={results.get(target) ?? { status: "loading" }} />
                </div>
              </section>
            );
          })
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-neutral-800 px-4 py-3 sm:px-5">
        <p className="min-w-0 flex-1 basis-48 text-xs text-neutral-500">
          Values are never shown here. To see values, open the file.
        </p>
        {canOpen && targets.length === 1 && (
          <Button size="sm" variant="outline" onClick={() => openFile(targets[0])}>
            <FileText size={13} /> Open file
          </Button>
        )}
      </div>
    </div>
  );
};

const CompareResult: React.FC<{ result: FileCompare }> = ({ result }) => {
  if (result.status === "loading") {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-neutral-500">
        <Loader2 size={12} className="animate-spin" aria-hidden /> Comparing…
      </p>
    );
  }
  if (result.status === "error") return <p className="text-xs text-danger">{result.message}</p>;
  const { compare } = result;
  if (compare.format === "missing") {
    return (
      <p className="text-xs text-neutral-300">
        {compare.side === "left" ? "This project has no copy of this file." : "The vault has no copy of this file."}
      </p>
    );
  }
  if (compare.format === "lines") {
    return <p className="text-xs text-neutral-300">{compareSummaryText(compare) ?? "No lines differ."}</p>;
  }
  const differing = differingKeys(compare.keys);
  const { same } = countKeyChanges(compare.keys);
  return (
    <div className="space-y-1.5">
      {differing.length === 0 ? (
        <p className="text-xs text-neutral-300">
          No variable differs (only comments, order or spacing).
        </p>
      ) : (
        <ul aria-label="Variables that differ" className="space-y-1">
          {differing.map(({ key, change }) => {
            const badge = CHANGE_BADGE[change as Exclude<SecretKeyChange, "same">];
            return (
              <li key={key} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-200" title={key}>
                  {key}
                </span>
                <span
                  title={badge.title}
                  className={cn("shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium", badge.className)}
                >
                  {badge.label}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {same > 0 && (
        <p className="text-[11px] text-neutral-500">
          {same} {same === 1 ? "variable is" : "variables are"} the same
        </p>
      )}
    </div>
  );
};
