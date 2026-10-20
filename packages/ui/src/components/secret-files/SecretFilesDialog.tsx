import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, GitCompare, KeyRound, Loader2, Plus, RotateCcw, Trash2, Upload } from "lucide-react";

import {
  secretFilePathProblem,
  type SecretFileCandidate,
  type SecretFileCandidatesResponse,
  type SecretFilesClone,
  type SecretVaultDetail,
  type SecretVaultFile
} from "@orquester/api";

import { useApi } from "../../context/orquester-context";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/relative-time";
import { useSecretVault } from "../../lib/secret-files/hooks";
import {
  deleteSecretVault,
  fetchSecretVault,
  pushSecretFiles,
  resetCloneSecretFiles,
  scanSecretFileCandidates,
  setupSecretVault,
  updateSecretFiles,
  vaultKey,
  type SecretFilesAdminApi
} from "../../lib/secret-files/store";
import { Button, ConfirmDialog, Input, Modal, ModalCloseButton } from "../ui";
import { SecretFileCompareModal } from "./SecretFileCompareModal";
import { expectedContent } from "./drift.logic";
import {
  buildAddRequest,
  buildSetupRequest,
  canCompare,
  canMerge,
  canPush,
  canReset,
  cloneName,
  defaultMergePrimary,
  defaultSourceChoice,
  isSelectable,
  isTicked,
  keyTable,
  listText,
  mergeCandidate,
  mergePrimaryOptions,
  needsSourceChoice,
  newestVariant,
  pushImpact,
  pushableFiles,
  refusalText,
  resettableFiles,
  scannedCandidate,
  secretFilesErrorText,
  stateLabel,
  stateTone,
  variantSizeText,
  type SetupSelection,
  type SourceChoice
} from "./secret-files-dialog.logic";

type CloneRef = { projectPath: string; projectName: string };

/**
 * "Secret files…" for one repo in one workspace (spec §6): first setup (file
 * selection, source per file) and, once the vault exists, file management and
 * every clone's per-file state with Push / Reset / Compare.
 *
 * Every change is applied to the shared vault store as soon as the daemon
 * answers — even when the dialog was closed meanwhile; only the dialog's own
 * feedback for a late answer is dropped. Values are never shown: variable
 * names, value classes (A/B/…) and states only.
 */
export const SecretFilesDialog: React.FC<{
  open: boolean;
  workspace: string;
  repoKey: string;
  /** The repo's label as shown, for the title. */
  repoLabel: string;
  onClose: () => void;
}> = ({ open, workspace, repoKey, repoLabel, onClose }) => (
  <Modal open={open} onClose={onClose} className="max-w-2xl">
    {open && (
      <SecretFilesDialogBody
        key={vaultKey(workspace, repoKey)}
        workspace={workspace}
        repoKey={repoKey}
        repoLabel={repoLabel}
        onClose={onClose}
      />
    )}
  </Modal>
);

// ---------------------------------------------------------------------------
// Request feedback that survives only while the body is mounted
// ---------------------------------------------------------------------------

/**
 * `run(key, work)`: one request at a time, its busy key and error shown only
 * while this component is mounted and the request is still the latest one.
 */
function useRequests() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      requestRef.current += 1;
    };
  }, []);
  const run = useCallback(async (key: string, work: () => Promise<void>): Promise<boolean> => {
    const token = ++requestRef.current;
    setBusy(key);
    setError(null);
    try {
      await work();
      if (!liveRef.current || token !== requestRef.current) return false;
      setBusy(null);
      return true;
    } catch (failure) {
      if (!liveRef.current || token !== requestRef.current) return false;
      setBusy(null);
      setError(secretFilesErrorText(failure));
      return false;
    }
  }, []);
  return { busy, error, setError, run, liveRef };
}

const spinner = <Loader2 size={13} className="animate-spin" aria-hidden />;

const ErrorLine: React.FC<{ error: string | null }> = ({ error }) =>
  error === null ? null : (
    <p role="alert" className="flex items-start gap-1.5 text-xs text-danger-300">
      <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden />
      <span>{error}</span>
    </p>
  );

const Section: React.FC<{ title: string; hint?: string; children: React.ReactNode }> = ({ title, hint, children }) => (
  <section className="space-y-2">
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-neutral-500">{hint}</p>}
    </div>
    {children}
  </section>
);

const absoluteTime = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};

// ---------------------------------------------------------------------------
// Body: setup vs manage
// ---------------------------------------------------------------------------

const SecretFilesDialogBody: React.FC<{
  workspace: string;
  repoKey: string;
  repoLabel: string;
  onClose: () => void;
}> = ({ workspace, repoKey, repoLabel, onClose }) => {
  const api: SecretFilesAdminApi = useApi();
  const vault = useSecretVault(workspace, repoKey);
  // The store may not hold this vault yet (just turned on, a missed event):
  // ask the daemon once before offering setup.
  const [checked, setChecked] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setCheckError(null);
    fetchSecretVault(api, workspace, repoKey, controller.signal).then(
      () => live && setChecked(true),
      (failure) => live && setCheckError(secretFilesErrorText(failure))
    );
    return () => {
      live = false;
      controller.abort();
    };
  }, [api, workspace, repoKey, attempt]);

  return (
    <div className="flex max-h-[90vh] w-full flex-col">
      <div className="flex items-center gap-3 border-b border-neutral-800 px-4 py-3 sm:px-5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-neutral-800 text-neutral-300">
          <KeyRound size={15} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium text-neutral-100" title={repoLabel}>
            Secret files — {repoLabel}
          </h2>
          <p className="truncate text-xs text-neutral-500">Workspace {workspace}</p>
        </div>
        <ModalCloseButton onClose={onClose} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
        {vault ? (
          <ManageView api={api} vault={vault} repoLabel={repoLabel} />
        ) : checked ? (
          <SetupView api={api} workspace={workspace} repoKey={repoKey} />
        ) : checkError !== null ? (
          <div className="space-y-3">
            <ErrorLine error={checkError} />
            <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </div>
        ) : (
          <p role="status" className="flex items-center gap-2 text-xs text-neutral-400">
            {spinner}
            Loading…
          </p>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Source picker + variable table (shared by setup and Add)
// ---------------------------------------------------------------------------

const SourcePicker: React.FC<{
  candidate: SecretFileCandidate;
  clones: readonly CloneRef[];
  choice: SourceChoice | null;
  disabled: boolean;
  onChange: (choice: SourceChoice) => void;
}> = ({ candidate, clones, choice, disabled, onChange }) => {
  const name = useId();
  const newest = newestVariant(candidate);
  const effective = choice ?? defaultSourceChoice(candidate);
  const mergeable = canMerge(candidate);
  const primary =
    effective?.kind === "merge" ? effective.primary : (defaultMergePrimary(candidate) ?? mergePrimaryOptions(candidate)[0]);
  const rows = keyTable(candidate);
  const copyLabel = (index: number) => `Copy ${index + 1}`;
  return (
    <div className="space-y-2 rounded-md border border-neutral-800 bg-neutral-950/40 p-2.5">
      <p className="text-xs text-neutral-400">The clones hold different copies. Which one goes into the vault?</p>
      <div role="radiogroup" aria-label={`Source for ${candidate.path}`} className="space-y-1">
        {candidate.variants.map((variant, index) => (
          <label
            key={variant.variantId}
            className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-xs hover:bg-neutral-800/60"
          >
            <input
              type="radio"
              name={name}
              className="mt-0.5"
              disabled={disabled}
              checked={effective?.kind === "variant" && effective.variantId === variant.variantId}
              onChange={() => onChange({ kind: "variant", variantId: variant.variantId })}
            />
            <span className="min-w-0 flex-1">
              <span className="font-medium text-neutral-200">{copyLabel(index)}</span>
              {variant === newest && <span className="ml-1.5 text-[11px] text-emerald-400">newest</span>}
              <span className="block text-neutral-400">
                {listText(variant.projectPaths.map((path) => cloneName(clones, path)))}
              </span>
              <span className="block text-neutral-500" title={absoluteTime(variant.modifiedAt)}>
                Modified {relativeTime(variant.modifiedAt) || absoluteTime(variant.modifiedAt)}
                {variantSizeText(candidate, variant) && ` · ${variantSizeText(candidate, variant)}`}
              </span>
            </span>
          </label>
        ))}
        {mergeable && (
          <div className="rounded px-1.5 py-1 text-xs hover:bg-neutral-800/60">
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="radio"
                name={name}
                className="mt-0.5"
                disabled={disabled}
                checked={effective?.kind === "merge"}
                onChange={() => primary && onChange({ kind: "merge", primary })}
              />
              <span className="min-w-0 flex-1">
                <span className="font-medium text-neutral-200">Merge all</span>
                <span className="block text-neutral-500">
                  Every variable from every copy; where values differ, the chosen clone's value wins.
                </span>
              </span>
            </label>
            {effective?.kind === "merge" && (
              <label className="ml-5 mt-1 flex flex-wrap items-center gap-2 text-neutral-400">
                Values from
                <select
                  aria-label={`Merge primary for ${candidate.path}`}
                  disabled={disabled}
                  value={effective.primary}
                  onChange={(event) => onChange({ kind: "merge", primary: event.target.value })}
                  className="h-7 rounded-md border border-neutral-700 bg-neutral-900 px-1.5 text-base text-neutral-100 sm:text-xs"
                >
                  {mergePrimaryOptions(candidate).map((path) => (
                    <option key={path} value={path}>
                      {cloneName(clones, path)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
      </div>
      {rows.length > 0 && (
        <div className="space-y-1">
          <div className="overflow-x-auto rounded border border-neutral-800">
            <table className="w-full text-left text-[11px]">
              <thead className="bg-neutral-900 text-neutral-400">
                <tr>
                  <th scope="col" className="px-2 py-1 font-medium">
                    Variable
                  </th>
                  {candidate.variants.map((variant, index) => (
                    <th key={variant.variantId} scope="col" className="whitespace-nowrap px-2 py-1 text-center font-medium">
                      {copyLabel(index)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className={cn("border-t border-neutral-800", !row.agree && "bg-amber-500/5")}>
                    <th scope="row" className="max-w-[14rem] truncate px-2 py-1 font-mono font-normal text-neutral-200" title={row.key}>
                      {row.key}
                    </th>
                    {row.cells.map((cell) => (
                      <td key={cell.variantId} className="px-2 py-1 text-center font-mono">
                        {cell.present ? (
                          <span className={cn(row.agree ? "text-neutral-400" : "text-amber-300")}>{cell.letter}</span>
                        ) : (
                          <span className="text-neutral-600" aria-label="absent">
                            —
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-neutral-500">
            Same letter in a row = same value; — = not set. Values are never shown.
          </p>
        </div>
      )}
    </div>
  );
};

const RefusedLines: React.FC<{ candidate: SecretFileCandidate; clones: readonly CloneRef[] }> = ({ candidate, clones }) =>
  candidate.refused.length === 0 ? null : (
    <ul className="space-y-0.5 text-xs text-amber-300/90">
      {candidate.refused.map((entry) => (
        <li key={entry.projectPath}>
          Not synced in {cloneName(clones, entry.projectPath)}: {refusalText(entry.refusal)}
        </li>
      ))}
    </ul>
  );

/** "Add file…": a hand-typed path, validated, then scanned on its own. */
const AddPathField: React.FC<{
  disabled: boolean;
  busy: boolean;
  onAdd: (path: string) => void;
}> = ({ disabled, busy, onAdd }) => {
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const submit = () => {
    const path = value.trim();
    const issue = secretFilePathProblem(path);
    if (issue !== null) {
      setProblem(issue);
      return;
    }
    setProblem(null);
    setValue("");
    onAdd(path);
  };
  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <Input
          aria-label="Add file"
          placeholder="Add file… e.g. deploy/targets.conf"
          value={value}
          disabled={disabled}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => {
            setValue(event.target.value);
            setProblem(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!disabled) submit();
            }
          }}
          className="flex-1 font-mono text-base sm:text-xs"
        />
        <Button variant="outline" size="sm" className="h-8" disabled={disabled || value.trim().length === 0} onClick={submit}>
          {busy ? spinner : <Plus size={13} aria-hidden />}
          Add
        </Button>
      </div>
      {problem !== null && (
        <p role="alert" className="text-xs text-danger-300">
          {problem}
        </p>
      )}
    </div>
  );
};

/** A one-path scan's answer for `path`, or an error naming why it can't be added. */
async function scanOnePath(
  api: SecretFilesAdminApi,
  workspace: string,
  repoKey: string,
  path: string
): Promise<{ scan: SecretFileCandidatesResponse; candidate: SecretFileCandidate }> {
  const scan = await scanSecretFileCandidates(api, workspace, repoKey, path);
  const candidate = scannedCandidate(scan.candidates, path);
  if (candidate === null || !isSelectable(candidate)) {
    const refused = candidate?.refused ?? [];
    const why = refused.length
      ? ` (${refused.map((entry) => `${cloneName(scan.clones, entry.projectPath)}: ${refusalText(entry.refusal)}`).join("; ")})`
      : "";
    throw new Error(`No clone has a usable ${path}${why}.`);
  }
  return { scan, candidate };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const SetupView: React.FC<{ api: SecretFilesAdminApi; workspace: string; repoKey: string }> = ({
  api,
  workspace,
  repoKey
}) => {
  const { busy, error, run } = useRequests();
  const [scan, setScan] = useState<SecretFileCandidatesResponse | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selection, setSelection] = useState<SetupSelection>({ ticked: {}, sources: {} });

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setScanError(null);
    scanSecretFileCandidates(api, workspace, repoKey, undefined, controller.signal).then(
      (answer) => live && setScan(answer),
      (failure) => live && setScanError(secretFilesErrorText(failure))
    );
    return () => {
      live = false;
      controller.abort();
    };
  }, [api, workspace, repoKey, attempt]);

  const clones = scan?.clones ?? [];
  const candidates = scan?.candidates ?? [];
  const disabled = busy !== null;

  const setTicked = (path: string, ticked: boolean) =>
    setSelection((held) => ({ ...held, ticked: { ...held.ticked, [path]: ticked } }));
  const setSource = (path: string, choice: SourceChoice) =>
    setSelection((held) => ({ ...held, sources: { ...held.sources, [path]: choice } }));

  const addPath = (path: string) => {
    void run("add-path", async () => {
      const { scan: answer, candidate } = await scanOnePath(api, workspace, repoKey, path);
      setScan((held) => ({
        workspace,
        repoKey,
        clones: held?.clones.length ? held.clones : answer.clones,
        candidates: mergeCandidate(held?.candidates ?? [], candidate)
      }));
      setTicked(path, true);
    });
  };

  const submit = () => {
    const plan = buildSetupRequest(workspace, repoKey, candidates, selection);
    void run("setup", async () => {
      if (!plan.ok) throw new Error(plan.problem);
      await setupSecretVault(api, plan.request);
    });
  };

  if (scan === null) {
    return scanError !== null ? (
      <div className="space-y-3">
        <ErrorLine error={scanError} />
        <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      </div>
    ) : (
      <p role="status" className="flex items-center gap-2 text-xs text-neutral-400">
        {spinner}
        Looking for secret files in this repo's clones…
      </p>
    );
  }

  const tickedCount = candidates.filter((candidate) => isTicked(candidate, selection)).length;

  return (
    <div className="space-y-5">
      <p className="text-xs text-neutral-400">
        Keep this repo's secret files in one vault and synced to its {clones.length === 1 ? "clone" : `${clones.length} clones`} in
        this workspace. Clones missing a file get a copy; clones whose copy differs are flagged, never overwritten.
      </p>

      <Section title="Files" hint="Gitignored .env files are found automatically. Untick any you don't want synced.">
        {candidates.length === 0 ? (
          <p className="text-xs text-neutral-500">No secret files found. Add one by its path below.</p>
        ) : (
          <ul className="space-y-2">
            {candidates.map((candidate) => {
              const ticked = isTicked(candidate, selection);
              const holders = [...new Set(candidate.variants.flatMap((variant) => variant.projectPaths))];
              return (
                <li key={candidate.path} className="space-y-1.5 rounded-md border border-neutral-800 p-2.5">
                  <label className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      aria-label={candidate.path}
                      checked={ticked}
                      disabled={disabled || !isSelectable(candidate)}
                      onChange={(event) => setTicked(candidate.path, event.target.checked)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="break-all font-mono text-xs text-neutral-100">{candidate.path}</span>
                      {!candidate.conventional && <span className="ml-1.5 text-[11px] text-neutral-500">added</span>}
                      {candidate.excluded && <span className="ml-1.5 text-[11px] text-neutral-500">excluded before</span>}
                      <span className="block text-xs text-neutral-500">
                        {holders.length > 0
                          ? `In ${listText(holders.map((path) => cloneName(clones, path)))}`
                          : "No clone has a usable copy"}
                        {candidate.variants.length > 1 && ` · ${candidate.variants.length} different copies`}
                      </span>
                    </span>
                  </label>
                  <RefusedLines candidate={candidate} clones={clones} />
                  {ticked && needsSourceChoice(candidate) && (
                    <SourcePicker
                      candidate={candidate}
                      clones={clones}
                      choice={selection.sources[candidate.path] ?? null}
                      disabled={disabled}
                      onChange={(choice) => setSource(candidate.path, choice)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <AddPathField disabled={disabled} busy={busy === "add-path"} onAdd={addPath} />
      </Section>

      <ErrorLine error={error} />

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-neutral-800 pt-3">
        <span className="mr-auto text-xs text-neutral-500">
          {tickedCount} {tickedCount === 1 ? "file" : "files"} selected
        </span>
        <Button onClick={submit} disabled={disabled || tickedCount === 0}>
          {busy === "setup" && spinner}
          Set up
        </Button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Manage
// ---------------------------------------------------------------------------

/** A Push / Reset remembers the clone as shown when asked, so `expect` carries the content the user saw. */
type Confirm =
  | { kind: "push"; clone: SecretFilesClone; files: string[] }
  | { kind: "reset"; clone: SecretFilesClone; files: string[] }
  | { kind: "delete" };

/** The Push / Reset request for a confirmed action, with the content tokens it was shown with. */
function cloneRequest(workspace: string, repoKey: string, action: { clone: SecretFilesClone; files: string[] }) {
  const expect = expectedContent(action.clone.files, action.files);
  return {
    workspace,
    repoKey,
    projectPath: action.clone.projectPath,
    files: action.files,
    ...(expect ? { expect } : {})
  };
}

interface PendingAdd {
  candidate: SecretFileCandidate;
  clones: CloneRef[];
  choice: SourceChoice | null;
}

const TONE_CLASS = {
  ok: "text-emerald-400",
  pending: "text-neutral-400",
  attention: "text-amber-300"
} as const;

function updatedByText(file: SecretVaultFile): string {
  const who = file.updatedBy.kind === "agent" ? "an agent" : "you";
  const from = file.updatedBy.projectName ? ` from ${file.updatedBy.projectName}` : "";
  const when = relativeTime(file.updatedAt);
  return `Updated${when ? ` ${when}` : ""} by ${who}${from}`;
}

const ManageView: React.FC<{ api: SecretFilesAdminApi; vault: SecretVaultDetail; repoLabel: string }> = ({
  api,
  vault,
  repoLabel
}) => {
  const { workspace, repoKey } = vault;
  const { busy, error, run, liveRef } = useRequests();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [compare, setCompare] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAdd | null>(null);
  const disabled = busy !== null;
  const clonesRef: CloneRef[] = vault.clones;

  const update = (key: string, req: Omit<Parameters<typeof updateSecretFiles>[1], "workspace" | "repoKey">) =>
    run(key, async () => {
      await updateSecretFiles(api, { workspace, repoKey, ...req });
    });

  const startAdd = (path: string) => {
    void run(`scan:${path}`, async () => {
      const { scan, candidate } = await scanOnePath(api, workspace, repoKey, path);
      if (liveRef.current) setPending({ candidate, clones: scan.clones, choice: null });
    });
  };

  const confirmAdd = () => {
    if (pending === null) return;
    const plan = buildAddRequest(workspace, repoKey, pending.candidate, pending.choice);
    void run("add", async () => {
      if (!plan.ok) throw new Error(plan.problem);
      await updateSecretFiles(api, plan.request);
      if (liveRef.current) setPending(null);
    });
  };

  const runConfirmed = () => {
    const action = confirm;
    setConfirm(null);
    if (action === null) return;
    if (action.kind === "delete") {
      void run("delete", () => deleteSecretVault(api, workspace, repoKey));
    } else if (action.kind === "push") {
      void run(`push:${action.clone.projectPath}`, async () => {
        await pushSecretFiles(api, cloneRequest(workspace, repoKey, action));
      });
    } else {
      void run(`reset:${action.clone.projectPath}`, async () => {
        await resetCloneSecretFiles(api, cloneRequest(workspace, repoKey, action));
      });
    }
  };

  const confirmMessage = (action: Confirm): React.ReactNode => {
    if (action.kind === "delete") {
      return (
        <>
          Delete the secret-files vault for <strong>{repoLabel}</strong> in {workspace}? Syncing stops; the clone files are
          left as they are.
        </>
      );
    }
    const files = listText(action.files);
    if (action.kind === "reset") {
      return (
        <>
          Discard {action.clone.projectName}'s changes to {files} and restore the vault's version? Those changes are lost.
        </>
      );
    }
    const impact = pushImpact(vault, action.clone, action.files);
    return (
      <span className="space-y-2">
        <span className="block">
          Make {action.clone.projectName}'s {files} the vault's version.
        </span>
        <span className="block">
          {impact.overwritten.length > 0
            ? `${listText(impact.overwritten.map((clone) => clone.projectName))} will be overwritten with it.`
            : "No other clone is overwritten."}
        </span>
        {impact.keptFlagged.length > 0 && (
          <span className="block">
            {listText(impact.keptFlagged.map((clone) => clone.projectName))} keep their own changes, still flagged.
          </span>
        )}
      </span>
    );
  };

  const compareClone = compare === null ? undefined : vault.clones.find((clone) => clone.projectPath === compare);

  return (
    <div className="space-y-5">
      <p className="text-xs text-neutral-400">
        {vault.files.length} {vault.files.length === 1 ? "file" : "files"} in the vault ·{" "}
        {vault.clones.length} {vault.clones.length === 1 ? "clone" : "clones"}
        {vault.clonesNeedingAttention > 0 && (
          <span className="text-amber-300"> · {vault.clonesNeedingAttention} need attention</span>
        )}
      </p>

      <ErrorLine error={error} />

      <Section title="Files in the vault">
        {vault.files.length === 0 ? (
          <p className="text-xs text-neutral-500">No files yet. Add one below.</p>
        ) : (
          <ul className="divide-y divide-neutral-800 rounded-md border border-neutral-800">
            {vault.files.map((file) => (
              <li key={file.path} className="flex flex-wrap items-center gap-2 px-2.5 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block break-all font-mono text-xs text-neutral-100">{file.path}</span>
                  <span className="block text-xs text-neutral-500" title={absoluteTime(file.updatedAt)}>
                    {updatedByText(file)}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  title="Clones keep their copy; the vault keeps its history."
                  onClick={() => void update(`unmanage:${file.path}`, { unmanage: [file.path] })}
                >
                  {busy === `unmanage:${file.path}` && spinner}
                  Stop syncing
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  title="Stop syncing it and never suggest it again."
                  onClick={() => void update(`exclude:${file.path}`, { exclude: [file.path] })}
                >
                  {busy === `exclude:${file.path}` && spinner}
                  Exclude
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Add files">
        {vault.candidates.length > 0 && (
          <ul className="divide-y divide-neutral-800 rounded-md border border-amber-500/30">
            {vault.candidates.map((path) => (
              <li key={path} className="flex flex-wrap items-center gap-2 px-2.5 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block break-all font-mono text-xs text-neutral-100">{path}</span>
                  <span className="block text-xs text-amber-300/90">New secret file found</span>
                </span>
                <Button variant="outline" size="sm" disabled={disabled} onClick={() => startAdd(path)}>
                  {busy === `scan:${path}` ? spinner : <Plus size={13} aria-hidden />}
                  Add
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() => void update(`exclude:${path}`, { exclude: [path] })}
                >
                  {busy === `exclude:${path}` && spinner}
                  Ignore
                </Button>
              </li>
            ))}
          </ul>
        )}
        {pending !== null && (
          <div className="space-y-2 rounded-md border border-neutral-700 p-2.5">
            <p className="text-xs text-neutral-200">
              Add <span className="break-all font-mono">{pending.candidate.path}</span>
              {!needsSourceChoice(pending.candidate) &&
                ` from ${cloneName(pending.clones, pending.candidate.variants[0].projectPaths[0])}`}
            </p>
            <RefusedLines candidate={pending.candidate} clones={pending.clones} />
            {needsSourceChoice(pending.candidate) && (
              <SourcePicker
                candidate={pending.candidate}
                clones={pending.clones}
                choice={pending.choice}
                disabled={disabled}
                onChange={(choice) => setPending((held) => (held ? { ...held, choice } : held))}
              />
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setPending(null)}>
                Cancel
              </Button>
              <Button size="sm" disabled={disabled} onClick={confirmAdd}>
                {busy === "add" && spinner}
                Add to vault
              </Button>
            </div>
          </div>
        )}
        <AddPathField
          disabled={disabled}
          busy={busy !== null && busy.startsWith("scan:")}
          onAdd={(path) => startAdd(path)}
        />
      </Section>

      {vault.excluded.length > 0 && (
        <Section title="Excluded" hint="Never suggested or synced.">
          <ul className="divide-y divide-neutral-800 rounded-md border border-neutral-800">
            {vault.excluded.map((path) => (
              <li key={path} className="flex flex-wrap items-center gap-2 px-2.5 py-1.5">
                <span className="min-w-0 flex-1 break-all font-mono text-xs text-neutral-400">{path}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() => void update(`include:${path}`, { include: [path] })}
                >
                  {busy === `include:${path}` && spinner}
                  Include again
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Clones">
        {vault.clones.length === 0 ? (
          <p className="text-xs text-neutral-500">No clones of this repo in this workspace.</p>
        ) : (
          <ul className="space-y-2">
            {vault.clones.map((clone) => (
              <li
                key={clone.projectPath}
                aria-label={clone.projectName}
                className={cn(
                  "space-y-1.5 rounded-md border p-2.5",
                  clone.needsAttention ? "border-amber-500/30" : "border-neutral-800"
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-neutral-100" title={clone.projectPath}>
                    {clone.projectName}
                  </span>
                  {canPush(clone) && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={disabled}
                      onClick={() => setConfirm({ kind: "push", clone, files: pushableFiles(clone) })}
                    >
                      {busy === `push:${clone.projectPath}` ? spinner : <Upload size={13} aria-hidden />}
                      Push to vault
                    </Button>
                  )}
                  {canReset(clone) && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={disabled}
                      onClick={() => setConfirm({ kind: "reset", clone, files: resettableFiles(clone) })}
                    >
                      {busy === `reset:${clone.projectPath}` ? spinner : <RotateCcw size={13} aria-hidden />}
                      Reset to vault
                    </Button>
                  )}
                  {canCompare(clone) && (
                    <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setCompare(clone.projectPath)}>
                      <GitCompare size={13} aria-hidden />
                      Compare
                    </Button>
                  )}
                </div>
                <ul className="space-y-0.5">
                  {clone.files.map((file) => {
                    const tone = stateTone(file.state);
                    return (
                      <li key={file.path} className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
                        <span className="min-w-0 break-all font-mono text-neutral-300">{file.path}</span>
                        <span className={cn("flex items-center gap-1", TONE_CLASS[tone])}>
                          {tone === "ok" && <CheckCircle2 size={11} aria-hidden />}
                          {stateLabel(file.state, file.refusal)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="flex border-t border-neutral-800 pt-3">
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="text-danger-300"
          onClick={() => setConfirm({ kind: "delete" })}
        >
          {busy === "delete" ? spinner : <Trash2 size={13} aria-hidden />}
          Delete vault
        </Button>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.kind === "push"
            ? `Push ${confirm.clone.projectName} to the vault?`
            : confirm?.kind === "reset"
              ? `Reset ${confirm.clone.projectName} to the vault?`
              : "Delete vault?"
        }
        message={confirm === null ? null : confirmMessage(confirm)}
        confirmLabel={confirm?.kind === "push" ? "Push to vault" : confirm?.kind === "reset" ? "Reset" : "Delete vault"}
        onConfirm={runConfirmed}
        onCancel={() => setConfirm(null)}
      />
      {compareClone && (
        <SecretFileCompareModal
          open
          workspace={workspace}
          repoKey={repoKey}
          projectPath={compareClone.projectPath}
          onClose={() => setCompare(null)}
        />
      )}
    </div>
  );
};
