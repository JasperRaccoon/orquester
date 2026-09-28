/**
 * A skill or command from elsewhere (agent profile spec §6): Git URL and
 * Upload scan into a checklist of what they found, and Import takes the ticked
 * ones — asking Replace or Keep both first when a ticked one already exists;
 * Copy from agent takes one of another agent's own items of the same kind.
 *
 * Each takes an optional `initial` state so a render check can draw every
 * step without a daemon.
 */

import React, { useEffect, useId, useRef, useState } from "react";
import { FileUp, Loader2 } from "lucide-react";

import type {
  AgentProfileAgentId,
  AgentProfileSnapshot,
  ProfileConflictPolicy,
  ProfileImportCandidate,
  ProfileImportScanResponse
} from "@orquester/api";

import { agentProfileStore, sanitizeAgentProfileSnapshot } from "../../../../lib/agent-profile/store";
import { cn } from "../../../../lib/cn";
import { useEditorEnv, useReportDirty, useTouch } from "./env";
import { EditorShell } from "./EditorShell";
import { Banner, Field, FOCUS_RING, SelectInput, SmallButton, TextInput, describedBy } from "./fields";
import { profileError, isAbort } from "./errors";
import {
  copyableItems,
  copySourceAgents,
  defaultCopySource,
  defaultPicks,
  gitUrlError,
  pickedCollisions,
  toggleAllPicks,
  togglePick,
  UPLOAD_ACCEPT,
  uploadFileError,
  uploadPercent
} from "./import.logic";
import { agentLabel, kindTitle } from "./layout.logic";
import type { MarkdownKind } from "./markdown.logic";
import { SubmitStatus, useProfileSubmit } from "./use-submit";

// ---------------------------------------------------------------------------
// Scan → checklist → import (Git URL, Upload)
// ---------------------------------------------------------------------------

interface ScanState {
  scan: ProfileImportScanResponse;
  picks: string[];
}

function useImportStep(initial?: ScanState) {
  const { agent, api } = useEditorEnv();
  const [state, setState] = useState<ScanState | null>(initial ?? null);
  const [asking, setAsking] = useState(false);
  const submit = useProfileSubmit();
  const collisions = state ? pickedCollisions(state.scan.candidates, state.picks) : [];

  const accept = (scan: ProfileImportScanResponse) => {
    setAsking(false);
    submit.clear();
    setState({ scan, picks: defaultPicks(scan.candidates) });
  };
  const send = (onConflict?: ProfileConflictPolicy) => {
    if (!state) return;
    const { importId } = state.scan;
    const picks = state.picks;
    setAsking(false);
    void submit.run(
      (policy) => api.createAgentProfileItem(agent, { import: { importId, picks }, onConflict: policy }),
      onConflict
    );
  };
  const importSelected = () => {
    if (!state || state.picks.length === 0) return;
    if (collisions.length > 0) setAsking(true);
    else send();
  };
  const status = (
    <>
      {asking ? (
        <CollisionPrompt
          names={collisions.map((candidate) => candidate.name)}
          onResolve={(policy) => send(policy)}
          onCancel={() => setAsking(false)}
        />
      ) : null}
      <SubmitStatus state={submit} onResolveConflict={submit.resolveConflict} onDismiss={submit.clear} />
    </>
  );
  return {
    state,
    setPicks: (picks: string[]) => setState((current) => (current ? { ...current, picks } : current)),
    reset: () => {
      setState(null);
      setAsking(false);
      submit.clear();
    },
    accept,
    importSelected,
    submit,
    status
  };
}

export const CollisionPrompt: React.FC<{
  names: string[];
  onResolve: (policy: "replace" | "keep-both") => void;
  onCancel: () => void;
}> = ({ names, onResolve, onCancel }) => (
  <Banner
    tone="warn"
    title={names.length === 1 ? `${names[0]} already exists` : `${names.length} of these already exist`}
    actions={
      <>
        <SmallButton onClick={() => onResolve("replace")}>Replace</SmallButton>
        <SmallButton onClick={() => onResolve("keep-both")}>Keep both</SmallButton>
        <SmallButton onClick={onCancel}>Cancel</SmallButton>
      </>
    }
  >
    {names.length > 1 ? <span className="font-mono">{names.join(", ")}. </span> : null}
    Replace what is there, or keep both (the imported one gets a suffix)?
  </Banner>
);

export const CandidateChecklist: React.FC<{
  candidates: readonly ProfileImportCandidate[];
  picks: readonly string[];
  notes: readonly string[];
  onChange: (picks: string[]) => void;
}> = ({ candidates, picks, notes, onChange }) => {
  const ids = useId();
  const touch = useTouch();
  if (candidates.length === 0) {
    return (
      <Banner tone="info" title="Nothing to import">
        No SKILL.md folders or command .md files were found there.
        {notes.length > 0 ? <NotesList notes={notes} /> : null}
      </Banner>
    );
  }
  const all = candidates.every((candidate) => picks.includes(candidate.ref));
  return (
    <div role="group" aria-labelledby={`${ids}-legend`} className="min-w-0 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p id={`${ids}-legend`} className="text-xs font-medium text-neutral-300">
          Found {candidates.length} · {picks.length} selected
        </p>
        <SmallButton onClick={() => onChange(toggleAllPicks(candidates, picks))}>{all ? "Select none" : "Select all"}</SmallButton>
      </div>
      <ul className="divide-y divide-neutral-800 overflow-hidden rounded-md border border-neutral-800">
        {candidates.map((candidate, index) => {
          const id = `${ids}-c${index}`;
          const checked = picks.includes(candidate.ref);
          return (
            <li key={candidate.ref}>
              <label
                htmlFor={id}
                className={cn(
                  "flex min-w-0 cursor-pointer items-start gap-3 px-3 hover:bg-neutral-800/40",
                  touch ? "min-h-12 py-2.5" : "py-2"
                )}
              >
                <input
                  id={id}
                  type="checkbox"
                  checked={checked}
                  onChange={() => onChange(togglePick(picks, candidate.ref))}
                  className={cn("mt-0.5 shrink-0 accent-neutral-300", touch ? "h-5 w-5" : "h-4 w-4", FOCUS_RING)}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-[13px] text-neutral-100" title={candidate.name}>
                      {candidate.name}
                    </span>
                    <span className="shrink-0 rounded border border-neutral-700 px-1 text-[10px] uppercase tracking-wide text-neutral-400">
                      {candidate.kind}
                    </span>
                    {candidate.exists ? (
                      <span className="shrink-0 rounded border border-warn-500/40 px-1 text-[10px] text-warn">exists</span>
                    ) : null}
                  </span>
                  {candidate.description ? (
                    <span className="mt-0.5 line-clamp-2 block text-xs text-neutral-400">{candidate.description}</span>
                  ) : null}
                  <span className="block truncate text-[11px] text-neutral-600" title={candidate.ref}>
                    {candidate.ref}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {notes.length > 0 ? <NotesList notes={notes} /> : null}
    </div>
  );
};

const NotesList: React.FC<{ notes: readonly string[] }> = ({ notes }) => (
  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-neutral-500">
    {notes.map((note) => (
      <li key={note}>{note}</li>
    ))}
  </ul>
);

function importLabel(count: number): string {
  return count === 0 ? "Import" : `Import ${count}`;
}

// ---------------------------------------------------------------------------
// Git URL
// ---------------------------------------------------------------------------

export const GitSource: React.FC<{
  kind: MarkdownKind;
  toolbar: React.ReactNode;
  /** Unsaved work under another source (the Write draft). */
  carriedDirty?: boolean;
  initial?: { url?: string; scan?: ProfileImportScanResponse; scanning?: boolean; scanError?: string };
}> = ({ kind, toolbar, carriedDirty = false, initial }) => {
  const { agent, api } = useEditorEnv();
  const ids = useId();
  const touch = useTouch();
  const [url, setUrl] = useState(initial?.url ?? "");
  const [scanning, setScanning] = useState(initial?.scanning ?? false);
  const [scanError, setScanError] = useState<string | null>(initial?.scanError ?? null);
  const [showErrors, setShowErrors] = useState(false);
  const step = useImportStep(initial?.scan ? { scan: initial.scan, picks: defaultPicks(initial.scan.candidates) } : undefined);
  useReportDirty(carriedDirty || url.trim() !== "" || step.state !== null);
  const urlProblem = gitUrlError(url);
  const urlMessage = showErrors ? urlProblem : undefined;

  const scan = async () => {
    if (urlProblem) {
      setShowErrors(true);
      return;
    }
    setScanning(true);
    setScanError(null);
    try {
      step.accept(await api.scanAgentProfileGitImport(agent, { url: url.trim() }));
    } catch (error) {
      setScanError(profileError(error).message);
    } finally {
      setScanning(false);
    }
  };

  const scanned = step.state;
  return (
    <EditorShell
      title={kindTitle("create", kind)}
      toolbar={toolbar}
      status={
        <>
          {scanError ? <Banner tone="error" title="Couldn't read the repository">{scanError}</Banner> : null}
          {step.status}
        </>
      }
      secondary={scanned ? <SmallButton onClick={step.reset}>Scan another</SmallButton> : undefined}
      primary={
        scanned
          ? {
              label: importLabel(scanned.picks.length),
              busyLabel: "Importing…",
              busy: step.submit.busy,
              disabled: scanned.picks.length === 0,
              title: scanned.picks.length === 0 ? "Tick what to import" : undefined,
              onClick: step.importSelected
            }
          : { label: "Scan", busyLabel: "Cloning…", busy: scanning, onClick: () => void scan() }
      }
    >
      <Field
        id={`${ids}-url`}
        label="Repository URL"
        required
        error={urlMessage}
        hint="A …/tree/<branch>/<folder> URL scans just that folder. Files are copied; nothing stays linked to the repository."
      >
        <TextInput
          id={`${ids}-url`}
          mono
          type="url"
          inputMode="url"
          value={url}
          placeholder="https://github.com/owner/repo"
          readOnly={scanned !== null}
          autoFocus={!touch}
          invalid={Boolean(urlMessage)}
          aria-required
          aria-describedby={describedBy(`${ids}-url`, urlMessage, true)}
          onChange={(event) => {
            setUrl(event.target.value);
            setScanError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && scanned === null && !scanning) {
              event.preventDefault();
              void scan();
            }
          }}
        />
      </Field>
      {scanning ? <Progress label="Cloning and scanning…" /> : null}
      {scanned ? (
        <CandidateChecklist
          candidates={scanned.scan.candidates}
          picks={scanned.picks}
          notes={scanned.scan.notes}
          onChange={step.setPicks}
        />
      ) : null}
    </EditorShell>
  );
};

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export const UploadSource: React.FC<{
  kind: MarkdownKind;
  toolbar: React.ReactNode;
  carriedDirty?: boolean;
  initial?: { fileName?: string; progress?: number; scan?: ProfileImportScanResponse; uploadError?: string };
}> = ({ kind, toolbar, carriedDirty = false, initial }) => {
  const { agent, api, variant } = useEditorEnv();
  const ids = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [fileName, setFileName] = useState<string | null>(initial?.fileName ?? null);
  const [progress, setProgress] = useState<number | null>(initial?.progress ?? null);
  const [uploadError, setUploadError] = useState<string | null>(initial?.uploadError ?? null);
  const [dragging, setDragging] = useState(false);
  const step = useImportStep(initial?.scan ? { scan: initial.scan, picks: defaultPicks(initial.scan.candidates) } : undefined);
  const uploading = progress !== null;
  useReportDirty(carriedDirty || uploading || step.state !== null);

  const upload = async (file: File) => {
    const problem = uploadFileError(file.name);
    setFileName(file.name);
    step.reset();
    if (problem) {
      setUploadError(problem);
      return;
    }
    setUploadError(null);
    setProgress(0);
    try {
      step.accept(
        await api.scanAgentProfileUpload(agent, file.name, file, (sent, total) => setProgress(uploadPercent(sent, total)))
      );
    } catch (error) {
      if (!isAbort(error)) setUploadError(profileError(error).message);
    } finally {
      setProgress(null);
    }
  };

  const pick = () => inputRef.current?.click();
  const scanned = step.state;
  const desktop = variant === "desktop";

  return (
    <EditorShell
      title={kindTitle("create", kind)}
      toolbar={toolbar}
      status={
        <>
          {uploadError ? <Banner tone="error" title="Couldn't use that file">{uploadError}</Banner> : null}
          {step.status}
        </>
      }
      secondary={scanned ? <SmallButton onClick={pick}>Choose another</SmallButton> : undefined}
      primary={
        scanned
          ? {
              label: importLabel(scanned.picks.length),
              busyLabel: "Importing…",
              busy: step.submit.busy,
              disabled: scanned.picks.length === 0,
              title: scanned.picks.length === 0 ? "Tick what to import" : undefined,
              onClick: step.importSelected
            }
          : { label: "Choose a file", busyLabel: "Uploading…", busy: uploading, onClick: pick }
      }
    >
      <input
        ref={inputRef}
        id={`${ids}-file`}
        type="file"
        accept={UPLOAD_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }}
      />
      <div
        onDragOver={
          desktop
            ? (event) => {
                event.preventDefault();
                setDragging(true);
              }
            : undefined
        }
        onDragLeave={desktop ? () => setDragging(false) : undefined}
        onDrop={
          desktop
            ? (event) => {
                event.preventDefault();
                setDragging(false);
                const file = event.dataTransfer.files?.[0];
                if (file && !uploading) void upload(file);
              }
            : undefined
        }
        className={cn(
          "flex min-w-0 flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center",
          dragging ? "border-neutral-400 bg-neutral-800/50" : "border-neutral-700"
        )}
      >
        <FileUp size={20} aria-hidden className="text-neutral-500" />
        <p className="text-sm text-neutral-300">
          {desktop ? "Drop a .zip or .md file here, or" : "A .zip of skill folders, or one .md file"}
        </p>
        <SmallButton onClick={pick} disabled={uploading} aria-describedby={`${ids}-file-hint`}>
          {fileName ? "Choose another file" : "Choose a file"}
        </SmallButton>
        <p id={`${ids}-file-hint`} className="text-[11px] text-neutral-500">
          A zip may hold several SKILL.md folders or command files; you pick which to import.
        </p>
        {fileName ? (
          <p className="max-w-full truncate font-mono text-xs text-neutral-400" title={fileName}>
            {fileName}
          </p>
        ) : null}
      </div>
      {uploading ? <Progress label={`Uploading ${fileName ?? "file"}…`} value={progress} /> : null}
      {scanned ? (
        <CandidateChecklist
          candidates={scanned.scan.candidates}
          picks={scanned.picks}
          notes={scanned.scan.notes}
          onChange={step.setPicks}
        />
      ) : null}
    </EditorShell>
  );
};

export const Progress: React.FC<{ label: string; value?: number | null }> = ({ label, value }) => (
  <div className="space-y-1.5" role="status">
    <div className="flex items-center gap-2 text-xs text-neutral-400">
      <Loader2 size={13} aria-hidden className="animate-spin" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {typeof value === "number" ? <span className="tabular-nums">{value}%</span> : null}
    </div>
    {typeof value === "number" ? (
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        className="h-1.5 overflow-hidden rounded-full bg-neutral-800"
      >
        <div className="h-full rounded-full bg-neutral-300 transition-[width]" style={{ width: `${value}%` }} />
      </div>
    ) : null}
  </div>
);

// ---------------------------------------------------------------------------
// Copy from agent
// ---------------------------------------------------------------------------

type SnapshotLoad =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; snapshot: AgentProfileSnapshot };

export const CopySource: React.FC<{
  kind: MarkdownKind;
  toolbar: React.ReactNode;
  carriedDirty?: boolean;
  initial?: { from?: AgentProfileAgentId; load?: SnapshotLoad; selected?: string };
}> = ({ kind, toolbar, carriedDirty = false, initial }) => {
  const { agent, api } = useEditorEnv();
  const ids = useId();
  const choices = copySourceAgents(agent);
  // What the panel's overview knows: an agent not installed is offered, but not first.
  const [installedOf] = useState(() => {
    const known = agentProfileStore.getState().overview.agents;
    return (other: AgentProfileAgentId): boolean | null => known?.find((entry) => entry.agent === other)?.installed ?? null;
  });
  const [from, setFrom] = useState<AgentProfileAgentId>(() => initial?.from ?? defaultCopySource(agent, installedOf));
  const [load, setLoad] = useState<SnapshotLoad>(initial?.load ?? { status: "loading" });
  const [selected, setSelected] = useState<string | null>(initial?.selected ?? null);
  const [attempt, setAttempt] = useState(0);
  const submit = useProfileSubmit();
  const preset = useRef(initial?.load !== undefined);
  useReportDirty(carriedDirty);

  useEffect(() => {
    if (preset.current) {
      preset.current = false;
      return;
    }
    const controller = new AbortController();
    setLoad({ status: "loading" });
    api.getAgentProfile(from, controller.signal).then(
      (raw) => {
        const snapshot = sanitizeAgentProfileSnapshot(raw);
        setLoad(snapshot ? { status: "loaded", snapshot } : { status: "error", message: "The daemon's answer could not be read." });
      },
      (error) => {
        if (!controller.signal.aborted && !isAbort(error)) setLoad({ status: "error", message: profileError(error).message });
      }
    );
    return () => controller.abort();
  }, [api, from, attempt]);

  const items = load.status === "loaded" ? copyableItems(load.snapshot, kind) : [];
  const copy = () => {
    if (!selected) return;
    void submit.run((onConflict) => api.copyAgentProfileItem(from, selected, { toAgent: agent, onConflict }));
  };
  const noun = kind === "skill" ? "skills" : "commands";

  return (
    <EditorShell
      title={kindTitle("create", kind)}
      toolbar={toolbar}
      status={<SubmitStatus state={submit} onResolveConflict={submit.resolveConflict} onDismiss={submit.clear} />}
      primary={{
        label: "Copy",
        busyLabel: "Copying…",
        busy: submit.busy,
        disabled: selected === null,
        title: selected === null ? `Pick one of ${agentLabel(from)}'s ${noun}` : undefined,
        onClick: copy
      }}
    >
      <Field id={`${ids}-from`} label="Copy from" hint={`Only ${agentLabel(from)}'s own ${noun} can be copied.`}>
        <SelectInput
          id={`${ids}-from`}
          value={from}
          describedBy={`${ids}-from-hint`}
          options={choices.map((choice) => ({
            value: choice,
            label: installedOf(choice) === false ? `${agentLabel(choice)} (not installed)` : agentLabel(choice)
          }))}
          onChange={(value) => {
            setFrom(value as AgentProfileAgentId);
            setSelected(null);
            submit.clear();
          }}
        />
      </Field>
      {load.status === "loading" ? <Progress label={`Reading ${agentLabel(from)}'s profile…`} /> : null}
      {load.status === "error" ? (
        <Banner tone="error" title={`Couldn't read ${agentLabel(from)}'s profile`} actions={<SmallButton onClick={() => setAttempt((n) => n + 1)}>Retry</SmallButton>}>
          {load.message}
        </Banner>
      ) : null}
      {load.status === "loaded" && !load.snapshot.installed ? (
        <Banner tone="info">{agentLabel(from)} is not installed.</Banner>
      ) : null}
      {load.status === "loaded" && load.snapshot.installed && items.length === 0 ? (
        <Banner tone="info">{agentLabel(from)} has no {noun} of its own to copy.</Banner>
      ) : null}
      {items.length > 0 ? (
        <CopyItemList
          name={`${ids}-item`}
          items={items.map((item) => ({ id: item.id, name: item.name, description: item.description }))}
          selected={selected}
          onSelect={(id) => {
            setSelected(id);
            submit.clear();
          }}
          legend={`${agentLabel(from)}'s ${noun}`}
        />
      ) : null}
      <p className="text-[11px] leading-4 text-neutral-500">
        Frontmatter keys {agentLabel(agent)} does not know are dropped, and the copy says which.
      </p>
    </EditorShell>
  );
};

export const CopyItemList: React.FC<{
  name: string;
  legend: string;
  items: { id: string; name: string; description?: string }[];
  selected: string | null;
  onSelect: (id: string) => void;
}> = ({ name, legend, items, selected, onSelect }) => {
  const touch = useTouch();
  return (
    <div role="radiogroup" aria-labelledby={`${name}-legend`} className="min-w-0 space-y-1.5">
      <p id={`${name}-legend`} className="text-xs font-medium text-neutral-300">
        {legend}
      </p>
      <ul className="max-h-[50vh] divide-y divide-neutral-800 overflow-y-auto rounded-md border border-neutral-800">
        {items.map((item, index) => {
          const id = `${name}-${index}`;
          return (
            <li key={item.id}>
              <label
                htmlFor={id}
                className={cn(
                  "flex min-w-0 cursor-pointer items-start gap-3 px-3 hover:bg-neutral-800/40",
                  touch ? "min-h-12 py-2.5" : "py-2",
                  selected === item.id && "bg-neutral-800/60"
                )}
              >
                <input
                  id={id}
                  type="radio"
                  name={name}
                  checked={selected === item.id}
                  onChange={() => onSelect(item.id)}
                  className={cn("mt-0.5 shrink-0 accent-neutral-300", touch ? "h-5 w-5" : "h-4 w-4", FOCUS_RING)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[13px] text-neutral-100" title={item.name}>
                    {item.name}
                  </span>
                  {item.description ? (
                    <span className="mt-0.5 line-clamp-2 block text-xs text-neutral-400">{item.description}</span>
                  ) : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
