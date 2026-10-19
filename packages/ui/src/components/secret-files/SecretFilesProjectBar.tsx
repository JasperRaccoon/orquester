import React, { useEffect, useState } from "react";
import { GitCompare, Info, KeyRound, Loader2, RotateCcw, Upload, X } from "lucide-react";

import { useApi } from "../../context/orquester-context";
import { ApiError } from "../../lib/api-client";
import { cn } from "../../lib/cn";
import { useRepoIdentity } from "../../lib/repo-identities/hooks";
import { useProjectSecretFiles, useSecretFilesEnabled } from "../../lib/secret-files/hooks";
import { isContentChangedError, pushSecretFiles, resetCloneSecretFiles } from "../../lib/secret-files/store";
import { useAppStore } from "../../store/app";
import { Button, ConfirmDialog } from "../ui";
import { SecretFileCompareModal } from "./SecretFileCompareModal";
import { SecretFilesDialog } from "./SecretFilesDialog";
import {
  CONTENT_CHANGED_TEXT,
  addBarDismissal,
  compareSummaryText,
  expectedContent,
  parseBarDismissals,
  projectBarDismissKey,
  projectBarMessage,
  projectBarModel,
  pushConfirmText,
  resetConfirmText
} from "./drift.logic";

const DISMISS_STORAGE_KEY = "orquester:secret-files-bar-dismissed";

/** This tab session's dismissals; memory first, mirrored into sessionStorage when it is there. */
let dismissals: string[] | null = null;
const dismissListeners = new Set<() => void>();

function loadDismissals(): string[] {
  if (dismissals === null) {
    try {
      dismissals =
        typeof sessionStorage === "undefined" ? [] : parseBarDismissals(sessionStorage.getItem(DISMISS_STORAGE_KEY));
    } catch {
      dismissals = [];
    }
  }
  return dismissals;
}

function dismiss(key: string): void {
  dismissals = addBarDismissal(loadDismissals(), key);
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.setItem(DISMISS_STORAGE_KEY, JSON.stringify(dismissals));
  } catch {
    /* quota / availability: the dismissal stays in memory only */
  }
  for (const listener of dismissListeners) listener();
}

function useDismissed(key: string | null): boolean {
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    dismissListeners.add(listener);
    return () => {
      dismissListeners.delete(listener);
    };
  }, []);
  return key !== null && loadDismissals().includes(key);
}

/** Tests: forget every dismissal. */
export function resetSecretFilesBarDismissals(): void {
  dismissals = [];
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(DISMISS_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  for (const listener of dismissListeners) listener();
}

const errorText = (err: unknown, fallback: string): string => {
  if (isContentChangedError(err)) return CONTENT_CHANGED_TEXT;
  if (err instanceof ApiError) return err.serverMessage ?? fallback;
  return err instanceof Error && err.message ? err.message : fallback;
};

type Busy = "push" | "reset" | null;

/**
 * The open project's secret-file drift (spec §7): a slim bar at the top of the
 * main view while one of its files differs from the vault (`modified` /
 * `deleted`) — Push to vault, Reset to vault, Compare — or, for files it can't
 * get (`missing-dir` / `refused`), an informational variant pointing at the
 * "Secret files…" dialog. Dismissing it hides it until a flagged file's path,
 * state, content or vault version changes. Push / Reset send the content
 * tokens the bar showed (`expect`): a file edited since is refused, not acted on.
 */
export const SecretFilesProjectBar: React.FC = () => {
  const enabled = useSecretFilesEnabled();
  const projectPath = useAppStore((s) => s.currentProject?.path);
  const entry = useProjectSecretFiles(enabled ? projectPath : undefined);
  if (!enabled || !projectPath || !entry) return null;
  return <ProjectBar key={projectPath} projectPath={projectPath} vault={entry.vault} clone={entry.clone} />;
};

const ProjectBar: React.FC<{
  projectPath: string;
  vault: NonNullable<ReturnType<typeof useProjectSecretFiles>>["vault"];
  clone: NonNullable<ReturnType<typeof useProjectSecretFiles>>["clone"];
}> = ({ projectPath, vault, clone }) => {
  const api = useApi();
  const repoLabel = useAppStore((s) => s.currentProject?.repoName);
  const customLabel = useRepoIdentity(vault.repoKey)?.label;
  const model = projectBarModel(clone);
  const dismissKey = model ? projectBarDismissKey(projectPath, model.files, vault) : null;
  const dismissed = useDismissed(dismissKey);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  // What the confirm was opened on: the paths and the content tokens shown then.
  const [confirm, setConfirm] = useState<{
    kind: "push" | "reset";
    files: string[];
    expect: Record<string, string | null> | undefined;
  } | null>(null);
  // What Compare was opened on (one path, or every file not in sync).
  const [comparing, setComparing] = useState<{ path?: string } | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  // The one modified file's compare summary completes the message; refetched
  // when its content, its state or the vault's version of it moves.
  const comparePath = model?.kind === "drift" ? model.comparePath : null;
  const compareVersion = comparePath ? vault.files.find((file) => file.path === comparePath)?.version ?? "" : "";
  const compareToken = comparePath ? clone.files.find((file) => file.path === comparePath)?.contentToken ?? "" : "";
  const [summary, setSummary] = useState<{
    path: string;
    /** The store's token it was fetched for, and the one the daemon compared. */
    token: string;
    comparedToken: string | undefined;
    text: string | null;
  } | null>(null);
  useEffect(() => {
    if (!comparePath || dismissed) return undefined;
    const controller = new AbortController();
    api.compareSecretFile(vault.workspace, vault.repoKey, projectPath, comparePath, controller.signal).then(
      ({ compare, contentToken }) => {
        if (controller.signal.aborted) return;
        setSummary({
          path: comparePath,
          token: compareToken,
          comparedToken: typeof contentToken === "string" && contentToken ? contentToken : undefined,
          text: compareSummaryText(compare)
        });
      },
      () => {
        // The message reads fine without the counts; Compare shows the error.
        if (!controller.signal.aborted) setSummary(null);
      }
    );
    return () => controller.abort();
  }, [api, vault.workspace, vault.repoKey, projectPath, comparePath, compareVersion, compareToken, dismissed]);
  // A summary of another copy of the file than the one shown now is not shown.
  const shownSummary = summary !== null && summary.path === comparePath && summary.token === compareToken ? summary : null;

  // The modals outlive the bar: an action taken in them can settle the state the bar shows.
  const modals = (
    <>
      <SecretFileCompareModal
        open={comparing !== null}
        workspace={vault.workspace}
        repoKey={vault.repoKey}
        projectPath={projectPath}
        path={comparing?.path}
        onClose={() => setComparing(null)}
      />
      <SecretFilesDialog
        open={dialogOpen}
        workspace={vault.workspace}
        repoKey={vault.repoKey}
        repoLabel={customLabel ?? repoLabel ?? vault.repoKey}
        onClose={() => setDialogOpen(false)}
      />
    </>
  );

  // Same slots as the bar's tree below, so the modals keep their state when it goes.
  if (!model || !dismissKey || dismissed) {
    return (
      <>
        {null}
        {modals}
      </>
    );
  }

  const message = projectBarMessage(model, shownSummary?.text);
  const drift = model.kind === "drift";

  /** Ask first, remembering what the bar shows now (the counts' compared copy for the one file, when known). */
  const ask = (kind: "push" | "reset") => {
    if (model.kind !== "drift") return;
    const files = kind === "push" ? model.pushPaths : model.resetPaths;
    let expect = expectedContent(model.files, files);
    if (shownSummary?.comparedToken && files.includes(shownSummary.path)) {
      expect = { ...expect, [shownSummary.path]: shownSummary.comparedToken };
    }
    setConfirm({ kind, files, expect });
  };

  const run = async ({ kind, files, expect }: NonNullable<typeof confirm>) => {
    const req = { workspace: vault.workspace, repoKey: vault.repoKey, projectPath, files, ...(expect ? { expect } : {}) };
    setBusy(kind);
    setError(null);
    try {
      await (kind === "push" ? pushSecretFiles(api, req) : resetCloneSecretFiles(api, req));
    } catch (err) {
      setError(errorText(err, kind === "push" ? "Could not push to the vault." : "Could not reset to the vault."));
    } finally {
      setBusy(null);
    }
  };

  const spinner = (kind: Busy) => (busy === kind ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null);

  return (
    <>
      <div
        role="region"
        aria-label="Secret files"
        className={cn(
          "flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-1.5 text-xs",
          drift ? "border-warn/30 bg-warn-soft/20 text-neutral-200" : "border-neutral-800 bg-neutral-900/60 text-neutral-300"
        )}
      >
        <span className="flex min-w-0 flex-1 basis-56 items-center gap-2">
          {drift ? (
            <KeyRound size={14} aria-hidden className="shrink-0 text-warn" />
          ) : (
            <Info size={14} aria-hidden className="shrink-0 text-neutral-500" />
          )}
          <span className="min-w-0">
            {message.path !== null && <code className="break-all font-mono text-neutral-100">{message.path}</code>}
            {message.text}
          </span>
        </span>
        {error && <span role="alert" className="text-danger">{error}</span>}
        <span className="flex shrink-0 flex-wrap items-center gap-1.5">
          {drift ? (
            <>
              {model.pushPaths.length > 0 && (
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => ask("push")}>
                  {spinner("push") ?? <Upload size={13} />} Push to vault
                </Button>
              )}
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => ask("reset")}>
                {spinner("reset") ?? <RotateCcw size={13} />} Reset to vault
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setComparing({ path: model.files.length === 1 ? model.files[0].path : undefined })}
              >
                <GitCompare size={13} /> Compare
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
              <KeyRound size={13} /> Open secret files…
            </Button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            title="Hide until this changes again"
            onClick={() => dismiss(dismissKey)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
          >
            <X size={14} />
          </button>
        </span>

        {model.kind === "drift" && (
          <ConfirmDialog
            open={confirm !== null}
            title={confirm?.kind === "push" ? "Push to vault?" : "Reset to vault?"}
            message={
              confirm === null
                ? null
                : confirm.kind === "push"
                  ? pushConfirmText(vault, projectPath, confirm.files)
                  : resetConfirmText(confirm.files)
            }
            confirmLabel={confirm?.kind === "push" ? "Push to vault" : "Reset to vault"}
            danger={confirm?.kind === "reset"}
            onCancel={() => setConfirm(null)}
            onConfirm={() => {
              const action = confirm;
              setConfirm(null);
              if (action) void run(action);
            }}
          />
        )}
      </div>
      {modals}
    </>
  );
};
