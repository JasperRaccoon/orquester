/**
 * Filling an Agent Profile (agent profiles spec §4.5, §5.1, §5.2): the
 * dialogs behind the editor's quick actions — Import from Global, Git, .zip /
 * .md, Copy from profile — the Plugins tab's "Add plugin", and the library's
 * "Import profile from file".
 *
 * They reuse the Agent config editor's frame, shell, fields, scan checklist
 * and progress (`agent-profile/editor/*`). Every import carries the profile's
 * revision as the store holds it at send time; a stale one (409) reloads the
 * profile and says so — import again. A pick that already exists asks Replace,
 * Keep both or Skip first. A landed import folds the fresh profile into the
 * store, closes, and puts what the daemon noted (renamed, replaced, skipped,
 * keys dropped, secrets to re-enter) in the panel's notice.
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { FileUp } from "lucide-react";

import {
  SESSION_PROFILE_AGENTS,
  sessionProfileScopeProblem,
  type AgentProfileSnapshot,
  type MarketplacePluginEntry,
  type ProfileImportScanResponse,
  type SessionProfileAgentId,
  type SessionProfileAgentScope,
  type SessionProfileDetail,
  type SessionProfileGlobalSourceResponse,
  type SessionProfileImportConflictPolicy,
  type SessionProfileItemKind,
  type SessionProfilePluginSourceRequest
} from "@orquester/api";

import { useApi } from "../../../context/orquester-context";
import { useMediaQuery } from "../../../hooks/use-media-query";
import { sanitizeAgentProfileSnapshot } from "../../../lib/agent-profile/store";
import type { ApiClient } from "../../../lib/api-client";
import { cn } from "../../../lib/cn";
import { useSessionProfileList } from "../../../lib/session-profiles/hooks";
import { agentLabel, PROFILE_KIND_LABELS, PROFILE_KIND_ORDER, scopeLabel } from "../../../lib/session-profiles/logic";
import { sanitizeGlobalSource, sanitizeSessionProfileDetail, sanitizeSessionProfileImport } from "../../../lib/session-profiles/sanitize";
import {
  applySessionProfileDetail,
  applySessionProfileWrite,
  openSessionProfile,
  reloadAfterConflict,
  sessionProfileDetailEntry,
  setSessionProfilesNotice
} from "../../../lib/session-profiles/store";
import { useAppStore } from "../../../store/app";
import { EditorEnvContext, useEditorEnv, useReportDirty, useTouch, type EditorEnv } from "../agent-profile/editor/env";
import { EditorFrame } from "../agent-profile/editor/EditorFrame";
import { EditorShell } from "../agent-profile/editor/EditorShell";
import { isAbort, profileError, type ProfileErrorInfo } from "../agent-profile/editor/errors";
import { Banner, Field, FOCUS_RING, Segmented, SelectInput, SmallButton, TextInput, describedBy } from "../agent-profile/editor/fields";
import { CandidateChecklist, Progress } from "../agent-profile/editor/ImportSources";
import { defaultPicks, gitUrlError, pickedCollisions, uploadFileError, uploadPercent } from "../agent-profile/editor/import.logic";
import { EDITOR_PHONE_QUERY, type EditorVariant } from "../agent-profile/editor/layout.logic";
import { AgentScopePicker } from "./AgentScopePicker";

/** What opens a dialog: an editor quick action, the Plugins tab, or the library. */
export type SessionProfileImportRequest =
  | { mode: "global" | "git" | "zip" | "copy"; profileId: string; kind: SessionProfileItemKind }
  | { mode: "plugin"; profileId: string }
  | { mode: "import-profile" };

const TITLES: Record<SessionProfileImportRequest["mode"], string> = {
  global: "Import from Global",
  git: "Import from Git",
  zip: "Import a .zip or .md",
  copy: "Copy from profile",
  plugin: "Add plugin",
  "import-profile": "Import profile from file"
};

/** `Agent Profile name` → `agent-profile-name.agent-profile.zip` (the daemon's own naming). */
export function exportFileName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "profile"}.agent-profile.zip`;
}

/** The notice a landed import leaves: how many items, then what the daemon noted. */
export function importNotice(count: number, notes: readonly string[]): string {
  const head = count === 0 ? "Nothing new was added." : `Added ${count} item${count === 1 ? "" : "s"}.`;
  if (notes.length === 0) return head;
  const shown = notes.slice(0, 3).join(" ");
  return `${head} ${shown}${notes.length > 3 ? ` (+${notes.length - 3} more)` : ""}`;
}

interface DialogContext {
  profileId: string | null;
  profileName: string;
  /** An import landed: the items it made. */
  done(itemIds: string[]): void;
}

const DialogCtx = React.createContext<DialogContext | null>(null);

function useDialog(): DialogContext {
  const context = React.useContext(DialogCtx);
  if (context === null) throw new Error("An import body must render inside SessionProfileImportDialog");
  return context;
}

export const SessionProfileImportDialog: React.FC<{
  request: SessionProfileImportRequest;
  profileName: string;
  onClose: () => void;
  onImported: (itemIds: string[]) => void;
}> = ({ request, profileName, onClose, onImported }) => {
  const api = useApi();
  const connected = useAppStore((state) => state.connectionStatus === "connected");
  const variant: EditorVariant = useMediaQuery(EDITOR_PHONE_QUERY) ? "phone" : "desktop";
  const [confirming, setConfirming] = useState(false);
  const dirty = useRef(false);
  const saving = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const importedRef = useRef(onImported);
  importedRef.current = onImported;

  const setDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  const setSaving = useCallback((value: boolean) => {
    saving.current = value;
  }, []);
  const requestClose = useCallback(() => {
    if (dirty.current && !saving.current) setConfirming(true);
    else closeRef.current();
  }, []);

  const env = useMemo<EditorEnv>(
    () => ({
      agent: "claude",
      api,
      variant,
      connected,
      requestClose,
      finish: () => closeRef.current(),
      setDirty,
      setSaving,
      switchKind: () => undefined
    }),
    [api, variant, connected, requestClose, setDirty, setSaving]
  );
  const dialog = useMemo<DialogContext>(
    () => ({
      profileId: request.mode === "import-profile" ? null : request.profileId,
      profileName,
      done: (itemIds) => {
        dirty.current = false;
        importedRef.current(itemIds);
        closeRef.current();
      }
    }),
    [request, profileName]
  );

  return (
    <EditorFrame
      open
      variant={variant}
      label={TITLES[request.mode]}
      onRequestClose={requestClose}
      confirmingDiscard={confirming}
      onKeepEditing={() => setConfirming(false)}
      onDiscard={() => {
        setConfirming(false);
        dirty.current = false;
        closeRef.current();
      }}
    >
      <EditorEnvContext.Provider value={env}>
        <DialogCtx.Provider value={dialog}>
          {request.mode === "global" ? (
            <GlobalBody kind={request.kind} />
          ) : request.mode === "git" ? (
            <ScanBody source="git" />
          ) : request.mode === "zip" ? (
            <ScanBody source="upload" />
          ) : request.mode === "copy" ? (
            <CopyBody kind={request.kind} />
          ) : request.mode === "plugin" ? (
            <PluginBody />
          ) : (
            <ImportProfileBody />
          )}
        </DialogCtx.Provider>
      </EditorEnvContext.Provider>
    </EditorFrame>
  );
};

// ---------------------------------------------------------------------------
// Sending: the revision at send time, a 409 reloads, the answer folds in
// ---------------------------------------------------------------------------

type ConflictChoice = Exclude<SessionProfileImportConflictPolicy, "fail">;

function useImportSend() {
  const env = useEditorEnv();
  const dialog = useDialog();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ProfileErrorInfo | null>(null);
  const inFlight = useRef(false);

  const run = useCallback(
    async (send: (revision: string) => Promise<unknown>) => {
      if (inFlight.current || dialog.profileId === null) return;
      const revision = sessionProfileDetailEntry(dialog.profileId).detail?.revision;
      if (revision === undefined) {
        setError({ code: null, message: "The profile is not loaded — close this and try again." });
        return;
      }
      inFlight.current = true;
      setBusy(true);
      setError(null);
      env.setSaving(true);
      try {
        const raw = await send(revision);
        applySessionProfileWrite(raw, "mutation");
        const { itemIds, notes } = sanitizeSessionProfileImport(raw);
        setSessionProfilesNotice({ tone: "ok", text: importNotice(itemIds.length, notes) });
        dialog.done(itemIds);
      } catch (caught) {
        const info = profileError(caught);
        if (info.code === "PROFILE_CONFLICT") {
          reloadAfterConflict(env.api, dialog.profileId);
          setError({ code: info.code, message: "The profile changed elsewhere and has been reloaded — check, then import again." });
        } else {
          setError(info);
        }
      } finally {
        inFlight.current = false;
        setBusy(false);
        env.setSaving(false);
      }
    },
    [dialog, env]
  );
  return { busy, error, run, clear: () => setError(null) };
}

/** Replace / Keep both / Skip, asked before an import whose picks already exist. */
const ConflictPrompt: React.FC<{
  names: readonly string[];
  keepBoth?: boolean;
  onResolve: (policy: ConflictChoice) => void;
  onCancel: () => void;
}> = ({ names, keepBoth = true, onResolve, onCancel }) => (
  <Banner
    tone="warn"
    title={names.length === 1 ? `${names[0]} is already in this profile` : `${names.length} of these are already in this profile`}
    actions={
      <>
        <SmallButton onClick={() => onResolve("replace")}>Replace</SmallButton>
        {keepBoth ? <SmallButton onClick={() => onResolve("keep-both")}>Keep both</SmallButton> : null}
        <SmallButton onClick={() => onResolve("skip")}>Skip</SmallButton>
        <SmallButton onClick={onCancel}>Cancel</SmallButton>
      </>
    }
  >
    {names.length > 1 ? <span className="font-mono">{names.join(", ")}. </span> : null}
    Replace the profile&apos;s, keep both (the new one gets a suffix), or skip {names.length === 1 ? "it" : "them"}?
  </Banner>
);

/** The status area every body shares: the conflict question, then the last refusal. */
function useImportFlow() {
  const send = useImportSend();
  const [asking, setAsking] = useState<{ names: string[]; keepBoth: boolean; go: (policy?: ConflictChoice) => void } | null>(null);
  const start = (names: readonly string[], go: (policy?: ConflictChoice) => void, keepBoth = true) => {
    send.clear();
    if (names.length > 0) setAsking({ names: [...names], keepBoth, go });
    else go();
  };
  const status = (
    <>
      {asking ? (
        <ConflictPrompt
          names={asking.names}
          keepBoth={asking.keepBoth}
          onResolve={(policy) => {
            const go = asking.go;
            setAsking(null);
            go(policy);
          }}
          onCancel={() => setAsking(null)}
        />
      ) : null}
      {send.error ? <Banner tone="error" title="Not imported">{send.error.message}</Banner> : null}
    </>
  );
  return { ...send, start, status };
}

// ---------------------------------------------------------------------------
// A pick list (Global items, another profile's items)
// ---------------------------------------------------------------------------

interface PickRow {
  id: string;
  kind: SessionProfileItemKind;
  name: string;
  description?: string;
  exists: boolean;
  disabled?: string;
  detail?: string;
}

const PickList: React.FC<{
  legend: string;
  rows: readonly PickRow[];
  picks: readonly string[];
  onChange: (picks: string[]) => void;
}> = ({ legend, rows, picks, onChange }) => {
  const ids = useId();
  const touch = useTouch();
  const pickable = rows.filter((row) => row.disabled === undefined);
  const all = pickable.length > 0 && pickable.every((row) => picks.includes(row.id));
  return (
    <div role="group" aria-labelledby={`${ids}-legend`} className="min-w-0 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p id={`${ids}-legend`} className="text-xs font-medium text-neutral-300">
          {legend} · {picks.length} selected
        </p>
        {pickable.length > 0 ? (
          <SmallButton onClick={() => onChange(all ? [] : pickable.map((row) => row.id))}>{all ? "Select none" : "Select all"}</SmallButton>
        ) : null}
      </div>
      <ul className="max-h-[45vh] divide-y divide-neutral-800 overflow-y-auto rounded-md border border-neutral-800">
        {rows.map((row, index) => {
          const id = `${ids}-r${index}`;
          const checked = picks.includes(row.id);
          return (
            <li key={row.id}>
              <label
                htmlFor={id}
                title={row.disabled}
                className={cn(
                  "flex min-w-0 items-start gap-3 px-3",
                  row.disabled === undefined ? "cursor-pointer hover:bg-neutral-800/40" : "opacity-60",
                  touch ? "min-h-12 py-2.5" : "py-2"
                )}
              >
                <input
                  id={id}
                  type="checkbox"
                  checked={checked}
                  disabled={row.disabled !== undefined}
                  data-pick={row.id}
                  onChange={() => onChange(checked ? picks.filter((pick) => pick !== row.id) : [...picks, row.id])}
                  className={cn("mt-0.5 shrink-0 accent-neutral-300", touch ? "h-5 w-5" : "h-4 w-4", FOCUS_RING)}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-[13px] text-neutral-100" title={row.name}>
                      {row.name}
                    </span>
                    <span className="shrink-0 rounded border border-neutral-700 px-1 text-[10px] uppercase tracking-wide text-neutral-400">
                      {PROFILE_KIND_LABELS[row.kind].short}
                    </span>
                    {row.exists ? <span className="shrink-0 rounded border border-warn-500/40 px-1 text-[10px] text-warn">exists</span> : null}
                  </span>
                  {row.description ? <span className="mt-0.5 line-clamp-2 text-xs text-neutral-400">{row.description}</span> : null}
                  {row.detail ? <span className="block truncate text-[11px] text-neutral-500">{row.detail}</span> : null}
                  {row.disabled ? <span className="block text-[11px] text-neutral-500">{row.disabled}</span> : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

/** Rows ordered with the shown kind first, then the editor's kind order. */
function orderRows(rows: PickRow[], first: SessionProfileItemKind | null): PickRow[] {
  const rank = (kind: SessionProfileItemKind) => (kind === first ? -1 : PROFILE_KIND_ORDER.indexOf(kind));
  return [...rows].sort((a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name));
}

const AGENT_OPTIONS = SESSION_PROFILE_AGENTS.map((agent) => ({ value: agent, label: agentLabel(agent) }));

type InstructionsChoice = "none" | "replace" | "append";

const InstructionsField: React.FC<{ id: string; value: InstructionsChoice; onChange: (value: InstructionsChoice) => void; from: string }> = ({
  id,
  value,
  onChange,
  from
}) => (
  <Field id={id} label="Instructions" hint={`Bring ${from}'s instructions into this profile.`}>
    <SelectInput
      id={id}
      value={value}
      describedBy={`${id}-hint`}
      options={[
        { value: "none", label: "Leave this profile's instructions as they are" },
        { value: "append", label: "Append below this profile's instructions" },
        { value: "replace", label: "Replace this profile's instructions" }
      ]}
      onChange={(next) => onChange(next as InstructionsChoice)}
    />
  </Field>
);

// ---------------------------------------------------------------------------
// Import from Global
// ---------------------------------------------------------------------------

type Load<T> = { status: "loading" } | { status: "error"; message: string } | { status: "loaded"; value: T };

const PORTABLE_KINDS: readonly SessionProfileItemKind[] = ["skill", "command", "mcp"];

const GlobalBody: React.FC<{ kind: SessionProfileItemKind }> = ({ kind }) => {
  const { api } = useEditorEnv();
  const { profileId, profileName } = useDialog();
  const ids = useId();
  const touch = useTouch();
  const [agent, setAgent] = useState<SessionProfileAgentId>("claude");
  const [load, setLoad] = useState<Load<SessionProfileGlobalSourceResponse>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [picks, setPicks] = useState<string[]>([]);
  const [instructions, setInstructions] = useState<InstructionsChoice>("none");
  const [scope, setScope] = useState<SessionProfileAgentScope>("all");
  const flow = useImportFlow();
  useReportDirty(picks.length > 0 || instructions !== "none");

  useEffect(() => {
    if (profileId === null) return undefined;
    const controller = new AbortController();
    setLoad({ status: "loading" });
    setPicks([]);
    setInstructions("none");
    (api as ApiClient).getSessionProfileGlobalSource(profileId, agent, controller.signal).then(
      (raw) => {
        const value = sanitizeGlobalSource(raw);
        setLoad(value ? { status: "loaded", value } : { status: "error", message: "The daemon's answer could not be read." });
      },
      (error) => {
        if (!controller.signal.aborted && !isAbort(error)) setLoad({ status: "error", message: profileError(error).message });
      }
    );
    return () => controller.abort();
  }, [api, profileId, agent, attempt]);

  const source = load.status === "loaded" ? load.value : null;
  const rows = useMemo(
    () =>
      orderRows(
        (source?.items ?? []).map((item) => ({
          id: item.id,
          kind: item.kind,
          name: item.name,
          ...(item.description ? { description: item.description } : {}),
          exists: item.exists,
          ...(item.unavailable ? { disabled: item.unavailable } : {})
        })),
        kind
      ),
    [source, kind]
  );
  const picked = rows.filter((row) => picks.includes(row.id));
  const needsScope = picked.some((row) => PORTABLE_KINDS.includes(row.kind));
  const scopeProblem = needsScope ? sessionProfileScopeProblem("skill", scope) : null;
  const nothing = picks.length === 0 && instructions === "none";

  const submit = () => {
    if (nothing || scopeProblem !== null || profileId === null) return;
    flow.start(
      picked.filter((row) => row.exists).map((row) => row.name),
      (policy) =>
        void flow.run((revision) =>
          (api as ApiClient).importSessionProfileFromGlobal(profileId, {
            revision,
            agent,
            itemIds: picks,
            ...(needsScope ? { agents: scope } : {}),
            ...(instructions !== "none" ? { instructions } : {}),
            onConflict: policy ?? "fail"
          })
        )
    );
  };

  return (
    <EditorShell
      title={TITLES.global}
      subtitle={profileName}
      status={flow.status}
      primary={{
        label: picks.length > 0 ? `Import ${picks.length}` : "Import",
        busyLabel: "Importing…",
        busy: flow.busy,
        disabled: nothing || scopeProblem !== null,
        title: nothing ? "Pick what to import" : (scopeProblem ?? undefined),
        onClick: submit
      }}
    >
      <Field id={`${ids}-agent`} label="From" hint="Items are copied: the agent's own setup is not changed.">
        <SelectInput id={`${ids}-agent`} value={agent} describedBy={`${ids}-agent-hint`} options={AGENT_OPTIONS} onChange={(value) => setAgent(value as SessionProfileAgentId)} />
      </Field>
      {load.status === "loading" ? <Progress label={`Reading ${agentLabel(agent)}'s setup…`} /> : null}
      {load.status === "error" ? (
        <Banner tone="error" title={`Couldn't read ${agentLabel(agent)}'s setup`} actions={<SmallButton onClick={() => setAttempt((n) => n + 1)}>Retry</SmallButton>}>
          {load.message}
        </Banner>
      ) : null}
      {source !== null && !source.installed ? <Banner tone="info">{agentLabel(agent)} is not installed.</Banner> : null}
      {source !== null && source.installed ? (
        <>
          {source.instructions.exists ? (
            <InstructionsField id={`${ids}-instructions`} value={instructions} onChange={setInstructions} from={agentLabel(agent)} />
          ) : null}
          {rows.length === 0 ? (
            <Banner tone="info">{agentLabel(agent)} has nothing of its own to import.</Banner>
          ) : (
            <PickList legend={`${agentLabel(agent)}'s items`} rows={rows} picks={picks} onChange={setPicks} />
          )}
          {needsScope ? (
            <div>
              <AgentScopePicker id={`${ids}-scope`} kind="skill" value={scope} touch={touch} onChange={setScope} />
              <p className="mt-1 text-[11px] leading-4 text-neutral-500">
                For skills, commands and MCP servers. Hooks and plugins stay {agentLabel(agent)}-only.
                {scope !== "all" && scope.length === 1 && scope[0] !== agent ? ` Frontmatter is converted for ${agentLabel(scope[0]!)}.` : ""}
              </p>
            </div>
          ) : null}
        </>
      ) : null}
    </EditorShell>
  );
};

// ---------------------------------------------------------------------------
// Git URL, .zip / .md upload: scan → checklist → import
// ---------------------------------------------------------------------------

const ScanBody: React.FC<{ source: "git" | "upload" }> = ({ source }) => {
  const { api, variant } = useEditorEnv();
  const { profileId, profileName } = useDialog();
  const ids = useId();
  const touch = useTouch();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [url, setUrl] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scan, setScan] = useState<ProfileImportScanResponse | null>(null);
  const [picks, setPicks] = useState<string[]>([]);
  const [scope, setScope] = useState<SessionProfileAgentScope>("all");
  const flow = useImportFlow();
  useReportDirty(url.trim() !== "" || scan !== null || progress !== null);
  const urlProblem = gitUrlError(url);

  const accept = (next: ProfileImportScanResponse) => {
    setScan(next);
    setPicks(defaultPicks(next.candidates));
  };

  const scanGit = async () => {
    if (urlProblem || profileId === null) {
      setShowErrors(true);
      return;
    }
    setScanning(true);
    setScanError(null);
    try {
      accept(await (api as ApiClient).scanSessionProfileGitImport(profileId, { url: url.trim() }));
    } catch (error) {
      setScanError(profileError(error).message);
    } finally {
      setScanning(false);
    }
  };

  const upload = async (file: File) => {
    if (profileId === null) return;
    const problem = uploadFileError(file.name);
    setFileName(file.name);
    setScan(null);
    if (problem) {
      setScanError(problem);
      return;
    }
    setScanError(null);
    setProgress(0);
    try {
      accept(await (api as ApiClient).scanSessionProfileUpload(profileId, file.name, file, (sent, total) => setProgress(uploadPercent(sent, total))));
    } catch (error) {
      if (!isAbort(error)) setScanError(profileError(error).message);
    } finally {
      setProgress(null);
    }
  };

  const scopeProblem = sessionProfileScopeProblem("skill", scope);
  const submit = () => {
    if (scan === null || picks.length === 0 || scopeProblem !== null || profileId === null) return;
    flow.start(
      pickedCollisions(scan.candidates, picks).map((candidate) => candidate.name),
      (policy) =>
        void flow.run((revision) =>
          (api as ApiClient).takeSessionProfileImport(profileId, scan.importId, { revision, picks, agents: scope, onConflict: policy ?? "fail" })
        )
    );
  };

  const pick = () => inputRef.current?.click();
  return (
    <EditorShell
      title={source === "git" ? TITLES.git : TITLES.zip}
      subtitle={profileName}
      status={
        <>
          {scanError ? <Banner tone="error" title={source === "git" ? "Couldn't read the repository" : "Couldn't use that file"}>{scanError}</Banner> : null}
          {flow.status}
        </>
      }
      primary={
        scan
          ? {
              label: picks.length > 0 ? `Import ${picks.length}` : "Import",
              busyLabel: "Importing…",
              busy: flow.busy,
              disabled: picks.length === 0 || scopeProblem !== null,
              title: picks.length === 0 ? "Tick what to import" : (scopeProblem ?? undefined),
              onClick: submit
            }
          : source === "git"
            ? { label: "Scan", busyLabel: "Cloning…", busy: scanning, onClick: () => void scanGit() }
            : { label: "Choose a file", busyLabel: "Uploading…", busy: progress !== null, onClick: pick }
      }
    >
      {source === "git" ? (
        <Field
          id={`${ids}-url`}
          label="Repository URL"
          required
          error={showErrors ? urlProblem : undefined}
          hint="A …/tree/<branch>/<folder> URL scans just that folder. Files are copied into the profile."
        >
          <TextInput
            id={`${ids}-url`}
            mono
            type="url"
            inputMode="url"
            value={url}
            placeholder="https://github.com/owner/repo"
            readOnly={scan !== null}
            autoFocus={!touch}
            invalid={showErrors && Boolean(urlProblem)}
            aria-required
            aria-describedby={describedBy(`${ids}-url`, showErrors ? urlProblem : undefined, true)}
            onChange={(event) => {
              setUrl(event.target.value);
              setScanError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && scan === null && !scanning) {
                event.preventDefault();
                void scanGit();
              }
            }}
          />
        </Field>
      ) : (
        <>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,.md"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            data-upload-input=""
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
          />
          <div className="flex min-w-0 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-neutral-700 px-4 py-6 text-center">
            <FileUp size={20} aria-hidden className="text-neutral-500" />
            <p className="text-sm text-neutral-300">{variant === "desktop" ? "A .zip of skill folders and commands, or one .md file" : "A .zip, or one .md file"}</p>
            <SmallButton onClick={pick} disabled={progress !== null}>
              {fileName ? "Choose another file" : "Choose a file"}
            </SmallButton>
            {fileName ? <p className="max-w-full truncate font-mono text-xs text-neutral-400">{fileName}</p> : null}
          </div>
        </>
      )}
      {scanning ? <Progress label="Cloning and scanning…" /> : null}
      {progress !== null ? <Progress label={`Uploading ${fileName ?? "file"}…`} value={progress} /> : null}
      {scan ? (
        <>
          <CandidateChecklist candidates={scan.candidates} picks={picks} notes={scan.notes} onChange={setPicks} />
          <div>
            <AgentScopePicker id={`${ids}-scope`} kind="skill" value={scope} touch={touch} onChange={setScope} />
            <p className="mt-1 text-[11px] leading-4 text-neutral-500">Commands stay commands; Codex gets them as skills.</p>
          </div>
        </>
      ) : null}
    </EditorShell>
  );
};

// ---------------------------------------------------------------------------
// Copy from profile
// ---------------------------------------------------------------------------

const CopyBody: React.FC<{ kind: SessionProfileItemKind }> = ({ kind }) => {
  const { api } = useEditorEnv();
  const { profileId, profileName } = useDialog();
  const ids = useId();
  const list = useSessionProfileList();
  const others = (list.profiles ?? []).filter((candidate) => candidate.id !== profileId);
  const [fromId, setFromId] = useState<string | null>(others[0]?.id ?? null);
  const [load, setLoad] = useState<Load<SessionProfileDetail> | null>(null);
  const [picks, setPicks] = useState<string[]>([]);
  const [instructions, setInstructions] = useState<InstructionsChoice>("none");
  const flow = useImportFlow();
  useReportDirty(picks.length > 0 || instructions !== "none");
  const current = profileId !== null ? sessionProfileDetailEntry(profileId).detail : null;

  useEffect(() => {
    if (fromId === null) return undefined;
    const controller = new AbortController();
    setLoad({ status: "loading" });
    setPicks([]);
    setInstructions("none");
    (api as ApiClient).getSessionProfile(fromId, controller.signal).then(
      (raw) => {
        const value = sanitizeSessionProfileDetail(raw);
        setLoad(value ? { status: "loaded", value } : { status: "error", message: "The profile could not be read." });
      },
      (error) => {
        if (!controller.signal.aborted && !isAbort(error)) setLoad({ status: "error", message: profileError(error).message });
      }
    );
    return () => controller.abort();
  }, [api, fromId]);

  const from = load?.status === "loaded" ? load.value : null;
  const rows = useMemo(
    () =>
      orderRows(
        (from?.items ?? []).map((item) => ({
          id: item.id,
          kind: item.kind,
          name: item.name,
          ...(item.description ? { description: item.description } : {}),
          detail: scopeLabel(item.agents),
          exists: (current?.items ?? []).some((mine) => mine.kind === item.kind && mine.name === item.name && item.kind !== "hook")
        })),
        kind
      ),
    [from, current, kind]
  );
  const nothing = picks.length === 0 && instructions === "none";

  const submit = () => {
    if (nothing || fromId === null || profileId === null) return;
    flow.start(
      rows.filter((row) => row.exists && picks.includes(row.id)).map((row) => row.name),
      (policy) =>
        void flow.run((revision) =>
          (api as ApiClient).copySessionProfileItems(profileId, {
            revision,
            fromProfileId: fromId,
            itemIds: picks,
            ...(instructions !== "none" ? { instructions } : {}),
            onConflict: policy ?? "fail"
          })
        )
    );
  };

  return (
    <EditorShell
      title={TITLES.copy}
      subtitle={profileName}
      status={flow.status}
      primary={{
        label: picks.length > 0 ? `Copy ${picks.length}` : "Copy",
        busyLabel: "Copying…",
        busy: flow.busy,
        disabled: nothing,
        title: nothing ? "Pick what to copy" : undefined,
        onClick: submit
      }}
    >
      {others.length === 0 ? (
        <Banner tone="info">There is no other profile to copy from.</Banner>
      ) : (
        <Field id={`${ids}-from`} label="Copy from" hint="Items keep their agents, files, plugin copies and secret values.">
          <SelectInput
            id={`${ids}-from`}
            value={fromId ?? ""}
            describedBy={`${ids}-from-hint`}
            options={others.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
            onChange={(value) => setFromId(value)}
          />
        </Field>
      )}
      {load?.status === "loading" ? <Progress label="Reading the profile…" /> : null}
      {load?.status === "error" ? <Banner tone="error" title="Couldn't read that profile">{load.message}</Banner> : null}
      {from !== null ? (
        <>
          {from.hasInstructions ? <InstructionsField id={`${ids}-instructions`} value={instructions} onChange={setInstructions} from={from.name} /> : null}
          {rows.length === 0 ? <Banner tone="info">{from.name} has no items.</Banner> : <PickList legend={`${from.name}'s items`} rows={rows} picks={picks} onChange={setPicks} />}
        </>
      ) : null}
    </EditorShell>
  );
};

// ---------------------------------------------------------------------------
// Add plugin: a marketplace's, or an installed Global one (OpenCode: a plugin file)
// ---------------------------------------------------------------------------

type PluginSourceMode = "marketplace" | "global";

const PluginBody: React.FC = () => {
  const { api } = useEditorEnv();
  const { profileId, profileName } = useDialog();
  const ids = useId();
  const [agent, setAgent] = useState<SessionProfileAgentId>("claude");
  const [mode, setMode] = useState<PluginSourceMode>("marketplace");
  const [snapshot, setSnapshot] = useState<Load<AgentProfileSnapshot>>({ status: "loading" });
  const [marketplace, setMarketplace] = useState<string | null>(null);
  const [plugins, setPlugins] = useState<Load<MarketplacePluginEntry[]> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const flow = useImportFlow();
  const current = profileId !== null ? sessionProfileDetailEntry(profileId).detail : null;
  const effectiveMode: PluginSourceMode = agent === "opencode" ? "global" : mode;

  useEffect(() => {
    const controller = new AbortController();
    setSnapshot({ status: "loading" });
    setSelected(null);
    setMarketplace(null);
    api.getAgentProfile(agent, controller.signal).then(
      (raw) => {
        const value = sanitizeAgentProfileSnapshot(raw);
        setSnapshot(value ? { status: "loaded", value } : { status: "error", message: "The daemon's answer could not be read." });
        const first = value?.items.find((item) => item.kind === "marketplace");
        if (first) setMarketplace(first.name);
      },
      (error) => {
        if (!controller.signal.aborted && !isAbort(error)) setSnapshot({ status: "error", message: profileError(error).message });
      }
    );
    return () => controller.abort();
  }, [api, agent]);

  useEffect(() => {
    if (marketplace === null || effectiveMode !== "marketplace") return undefined;
    const controller = new AbortController();
    setPlugins({ status: "loading" });
    setSelected(null);
    api.listAgentProfileMarketplacePlugins(agent, marketplace, controller.signal).then(
      (raw) => {
        const list = Array.isArray((raw as { plugins?: unknown })?.plugins) ? (raw as { plugins: MarketplacePluginEntry[] }).plugins : [];
        setPlugins({ status: "loaded", value: list.filter((entry) => typeof entry?.name === "string") });
      },
      (error) => {
        if (!controller.signal.aborted && !isAbort(error)) setPlugins({ status: "error", message: profileError(error).message });
      }
    );
    return () => controller.abort();
  }, [api, agent, marketplace, effectiveMode]);

  const loaded = snapshot.status === "loaded" ? snapshot.value : null;
  const marketplaces = (loaded?.items ?? []).filter((item) => item.kind === "marketplace");
  const installed = (loaded?.items ?? []).filter(
    (item) => item.kind === "plugin" && item.source.type === "user" && (agent !== "opencode" || item.meta?.source === "file")
  );
  const choices: { id: string; name: string; description?: string; detail?: string }[] =
    effectiveMode === "marketplace"
      ? plugins?.status === "loaded"
        ? plugins.value.map((entry) => ({ id: entry.name, name: entry.name, ...(entry.description ? { description: entry.description } : {}), ...(entry.version ? { detail: `v${entry.version}` } : {}) }))
        : []
      : installed.map((item) => ({ id: item.id, name: item.name, ...(item.description ? { description: item.description } : {}), ...(item.meta?.version ? { detail: `v${item.meta.version}` } : {}) }));
  const chosen = choices.find((choice) => choice.id === selected) ?? null;
  const shortName = (name: string) => name.replace(/@[^@]+$/, "");

  const submit = () => {
    if (chosen === null || profileId === null) return;
    const source: SessionProfilePluginSourceRequest =
      effectiveMode === "marketplace" ? { type: "marketplace", marketplace: marketplace!, plugin: chosen.id } : { type: "global", itemId: chosen.id };
    const exists = (current?.items ?? []).some(
      (item) => item.kind === "plugin" && item.name === shortName(chosen.name) && item.agents !== "all" && item.agents.includes(agent)
    );
    flow.start(
      exists ? [shortName(chosen.name)] : [],
      (policy) =>
        void flow.run((revision) =>
          (api as ApiClient).addSessionProfilePlugin(profileId, {
            revision,
            agent,
            source,
            onConflict: policy === "keep-both" ? "skip" : (policy ?? "fail")
          })
        ),
      false
    );
  };

  return (
    <EditorShell
      title={TITLES.plugin}
      subtitle={profileName}
      status={flow.status}
      primary={{
        label: "Add to profile",
        busyLabel: "Copying the plugin…",
        busy: flow.busy,
        disabled: chosen === null,
        title: chosen === null ? "Pick a plugin" : undefined,
        onClick: submit
      }}
    >
      <Field id={`${ids}-agent`} label="Agent" hint="A plugin belongs to one agent. Its files are copied into this profile only.">
        <SelectInput id={`${ids}-agent`} value={agent} describedBy={`${ids}-agent-hint`} options={AGENT_OPTIONS} onChange={(value) => setAgent(value as SessionProfileAgentId)} />
      </Field>
      {agent === "opencode" ? (
        <p className="text-[11px] leading-4 text-neutral-500">OpenCode has no marketplaces: pick one of its plugin files.</p>
      ) : (
        <Segmented<PluginSourceMode>
          label="Plugin source"
          value={mode}
          onChange={(next) => {
            setMode(next);
            setSelected(null);
          }}
          options={[
            { id: "marketplace", label: "From a marketplace", shortLabel: "Marketplace" },
            { id: "global", label: "Installed in Global", shortLabel: "Installed" }
          ]}
        />
      )}
      {snapshot.status === "loading" ? <Progress label={`Reading ${agentLabel(agent)}'s setup…`} /> : null}
      {snapshot.status === "error" ? <Banner tone="error" title={`Couldn't read ${agentLabel(agent)}'s setup`}>{snapshot.message}</Banner> : null}
      {loaded !== null && !loaded.installed ? <Banner tone="info">{agentLabel(agent)} is not installed.</Banner> : null}
      {loaded !== null && loaded.installed && effectiveMode === "marketplace" ? (
        marketplaces.length === 0 ? (
          <Banner tone="info">{agentLabel(agent)} knows no marketplace yet: add one in Settings → Agent config.</Banner>
        ) : (
          <Field id={`${ids}-market`} label="Marketplace">
            <SelectInput
              id={`${ids}-market`}
              value={marketplace ?? ""}
              options={marketplaces.map((item) => ({ value: item.name, label: item.name }))}
              onChange={(value) => setMarketplace(value)}
            />
          </Field>
        )
      ) : null}
      {effectiveMode === "marketplace" && plugins?.status === "loading" ? <Progress label="Reading the marketplace…" /> : null}
      {effectiveMode === "marketplace" && plugins?.status === "error" ? <Banner tone="error" title="Couldn't read the marketplace">{plugins.message}</Banner> : null}
      {loaded !== null && loaded.installed && effectiveMode === "global" && installed.length === 0 ? (
        <Banner tone="info">{agentLabel(agent)} has no plugin{agent === "opencode" ? " file" : ""} of its own installed.</Banner>
      ) : null}
      {choices.length > 0 ? <PluginRadioList name={`${ids}-plugin`} choices={choices} selected={selected} onSelect={setSelected} /> : null}
    </EditorShell>
  );
};

const PluginRadioList: React.FC<{
  name: string;
  choices: { id: string; name: string; description?: string; detail?: string }[];
  selected: string | null;
  onSelect: (id: string) => void;
}> = ({ name, choices, selected, onSelect }) => {
  const touch = useTouch();
  return (
    <div role="radiogroup" aria-label="Plugins" className="min-w-0">
      <ul className="max-h-[45vh] divide-y divide-neutral-800 overflow-y-auto rounded-md border border-neutral-800">
        {choices.map((choice, index) => {
          const id = `${name}-${index}`;
          return (
            <li key={choice.id}>
              <label
                htmlFor={id}
                className={cn(
                  "flex min-w-0 cursor-pointer items-start gap-3 px-3 hover:bg-neutral-800/40",
                  touch ? "min-h-12 py-2.5" : "py-2",
                  selected === choice.id && "bg-neutral-800/60"
                )}
              >
                <input
                  id={id}
                  type="radio"
                  name={name}
                  checked={selected === choice.id}
                  data-plugin={choice.id}
                  onChange={() => onSelect(choice.id)}
                  className={cn("mt-0.5 shrink-0 accent-neutral-300", touch ? "h-5 w-5" : "h-4 w-4", FOCUS_RING)}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-[13px] text-neutral-100">{choice.name}</span>
                    {choice.detail ? <span className="shrink-0 text-[11px] text-neutral-500">{choice.detail}</span> : null}
                  </span>
                  {choice.description ? <span className="mt-0.5 line-clamp-2 text-xs text-neutral-400">{choice.description}</span> : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Import profile from file (the library)
// ---------------------------------------------------------------------------

const ImportProfileBody: React.FC = () => {
  const { api } = useEditorEnv();
  const { done } = useDialog();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useReportDirty(progress !== null);

  const upload = async (file: File) => {
    setFileName(file.name);
    if (!/\.zip$/i.test(file.name)) {
      setError("Choose an Agent Profile export (.zip).");
      return;
    }
    setError(null);
    setProgress(0);
    try {
      const raw = await (api as ApiClient).importSessionProfile(file.name, file, (sent, total) => setProgress(uploadPercent(sent, total)));
      const record = typeof raw === "object" && raw !== null ? (raw as unknown as Record<string, unknown>) : {};
      const profile = sanitizeSessionProfileDetail(record.profile);
      const answerNotes = Array.isArray(record.notes) ? record.notes.filter((note): note is string => typeof note === "string") : [];
      if (profile === null) {
        setError("The daemon's answer could not be read.");
        return;
      }
      applySessionProfileDetail(profile);
      openSessionProfile(profile.id);
      setSessionProfilesNotice({ tone: "ok", text: [`Imported ${profile.name}.`, ...answerNotes].join(" ") });
      done([]);
    } catch (caught) {
      if (!isAbort(caught)) setError(profileError(caught).message);
    } finally {
      setProgress(null);
    }
  };
  const pick = () => inputRef.current?.click();

  return (
    <EditorShell
      title={TITLES["import-profile"]}
      subtitle="A new profile from an export"
      status={error ? <Banner tone="error" title="Not imported">{error}</Banner> : null}
      primary={{ label: fileName ? "Choose another file" : "Choose a file", busyLabel: "Importing…", busy: progress !== null, onClick: pick }}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".zip"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        data-upload-input=""
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }}
      />
      <p className="text-xs leading-5 text-neutral-400">
        Choose a <span className="font-mono">.agent-profile.zip</span> made with Export. It becomes a new profile; MCP secret values are
        never in an export — enter them again afterwards.
      </p>
      {fileName ? <p className="truncate font-mono text-xs text-neutral-400">{fileName}</p> : null}
      {progress !== null ? <Progress label={`Uploading ${fileName ?? "file"}…`} value={progress} /> : null}
    </EditorShell>
  );
};
