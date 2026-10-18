/**
 * The Agent Profile item editors (spec §5.2): MCP servers, skills, commands
 * and hooks written by hand, a plugin's details, and the profile's
 * instructions. They reuse the Agent config editors' frame, shell and form
 * views (`agent-profile/editor/*`: the same fields, the same secret masking
 * with set / keep / clear, the same per-agent hook events) and add the agent
 * scope (`AgentScopePicker`); what they send is the session-profile draft,
 * carrying the profile's revision.
 *
 * The forms read their rules for one agent (transports, advanced fields,
 * frontmatter fields, hook events) from the editor env: the item's single
 * agent when its scope names one, else Claude's (the widest MCP transports).
 * An item an agent cannot load is skipped for that agent and the row says so.
 *
 * A save that lands folds the fresh profile into the store and closes; a
 * stale revision (409) reloads the profile and offers Reload here; a refusal
 * after the editor closed lands in the panel's notice.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  sessionProfileScopeProblem,
  type SessionProfileAgentId,
  type SessionProfileAgentScope,
  type SessionProfileItemDetail,
  type SessionProfileItemDraft,
  type SessionProfileItemKind
} from "@orquester/api";

import { useApi } from "../../../context/orquester-context";
import { useMediaQuery } from "../../../hooks/use-media-query";
import type { ApiClient } from "../../../lib/api-client";
import { PROFILE_KIND_LABELS, scopeLabel } from "../../../lib/session-profiles/logic";
import { sanitizeSessionProfileItemDetail } from "../../../lib/session-profiles/sanitize";
import {
  applySessionProfileWrite,
  reloadAfterConflict,
  sessionProfileDetailEntry,
  setSessionProfilesNotice
} from "../../../lib/session-profiles/store";
import { useAppStore } from "../../../store/app";
import { CodeArea } from "../agent-profile/editor/CodeArea";
import { EditorEnvContext, useEditorEnv, useReportDirty, useTouch, type EditorEnv } from "../agent-profile/editor/env";
import { EditorFrame } from "../agent-profile/editor/EditorFrame";
import { EditorShell } from "../agent-profile/editor/EditorShell";
import { isAbort, profileError, type ProfileErrorInfo, type ProfileErrorPlacement } from "../agent-profile/editor/errors";
import { Banner, SmallButton } from "../agent-profile/editor/fields";
import { HookFormView } from "../agent-profile/editor/HookEditor";
import {
  hookDraftFromForm,
  hookEvents,
  initialHookForm,
  validateHookForm,
  type HookForm
} from "../agent-profile/editor/hook.logic";
import { Progress } from "../agent-profile/editor/ImportSources";
import { EDITOR_PHONE_QUERY, type EditorVariant } from "../agent-profile/editor/layout.logic";
import { MarkdownWriteView } from "../agent-profile/editor/MarkdownEditor";
import {
  initialMarkdownForm,
  markdownDraftFromForm,
  markdownEditorModel,
  validateMarkdownForm,
  type MarkdownForm,
  type MarkdownKind
} from "../agent-profile/editor/markdown.logic";
import { McpFormView } from "../agent-profile/editor/McpEditor";
import {
  initialMcpForm,
  mcpDraftFromForm,
  mcpFormOrigin,
  mcpFormSignature,
  validateMcpForm,
  type McpForm
} from "../agent-profile/editor/mcp.logic";
import { SubmitStatus } from "../agent-profile/editor/use-submit";
import { AgentScopePicker, defaultScopeFor } from "./AgentScopePicker";

/** What opens the editor: "+ Add <kind>", a row's Edit, or the Instructions row. */
export type SessionProfileEditorRequest =
  | { mode: "create"; profileId: string; kind: Exclude<SessionProfileItemKind, "plugin"> }
  | { mode: "edit"; profileId: string; itemId: string }
  | { mode: "instructions"; profileId: string };

/** The agent whose rules a form follows for `scope`. */
export function formAgentFor(scope: SessionProfileAgentScope): SessionProfileAgentId {
  return scope !== "all" && scope.length === 1 ? scope[0]! : "claude";
}

/** Where a session-profile refusal goes: a name clash beside the name, a stale revision as "Changed". */
export function sessionProfileErrorPlacement(info: ProfileErrorInfo): ProfileErrorPlacement {
  switch (info.code) {
    case "INVALID_NAME":
    case "ITEM_EXISTS":
      return "name";
    case "PROFILE_CONFLICT":
      return "changed";
    default:
      return "general";
  }
}

const SAVED_NOTICE = "Saved — new chats with this profile use it.";

interface SessionEditorContext {
  profileId: string;
  profileName: string;
  /** A save landed: the item it touched (null for the instructions). */
  done(itemId: string | null): void;
  /** Whether this editor is still open (a refusal after it closed goes to the panel's notice). */
  alive(): boolean;
}

const SessionEditorCtx = React.createContext<SessionEditorContext | null>(null);

function useSessionEditor(): SessionEditorContext {
  const context = React.useContext(SessionEditorCtx);
  if (context === null) throw new Error("A session-profile editor must render inside SessionProfileItemEditor");
  return context;
}

interface SubmitState {
  busy: boolean;
  error: ProfileErrorInfo | null;
  placement: ProfileErrorPlacement | null;
}

/** One save at a time; its refusal placed (`sessionProfileErrorPlacement`); a 409 reloads the profile. */
function useSessionSubmit() {
  const env = useEditorEnv();
  const session = useSessionEditor();
  const [state, setState] = useState<SubmitState>({ busy: false, error: null, placement: null });
  const inFlight = useRef(false);

  const run = useCallback(
    async (send: () => Promise<unknown>, answer: "mutation" | "detail") => {
      if (inFlight.current) return;
      inFlight.current = true;
      setState({ busy: true, error: null, placement: null });
      env.setSaving(true);
      try {
        const raw = await send();
        inFlight.current = false;
        env.setSaving(false);
        const itemId = applySessionProfileWrite(raw, answer);
        session.done(itemId);
      } catch (error) {
        inFlight.current = false;
        env.setSaving(false);
        const info = profileError(error);
        if (info.code === "PROFILE_CONFLICT") reloadAfterConflict(env.api, session.profileId);
        if (!session.alive()) {
          setSessionProfilesNotice({ tone: "error", text: `Your change was not saved: ${info.message}` });
          return;
        }
        setState({ busy: false, error: info, placement: sessionProfileErrorPlacement(info) });
      }
    },
    [env, session]
  );

  const clear = useCallback(() => {
    setState((current) => (current.error === null ? current : { busy: current.busy, error: null, placement: null }));
  }, []);

  return { ...state, run, clear, nameError: state.placement === "name" ? state.error?.message : undefined };
}

export const SessionProfileItemEditor: React.FC<{
  request: SessionProfileEditorRequest;
  profileName: string;
  onClose: () => void;
  onSaved: (itemId: string | null) => void;
}> = ({ request, profileName, onClose, onSaved }) => {
  const api = useApi();
  const connected = useAppStore((state) => state.connectionStatus === "connected");
  const variant: EditorVariant = useMediaQuery(EDITOR_PHONE_QUERY) ? "phone" : "desktop";
  const [confirming, setConfirming] = useState(false);
  const dirty = useRef(false);
  const saving = useRef(false);
  const open = useRef(true);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const savedRef = useRef(onSaved);
  savedRef.current = onSaved;
  useEffect(
    () => () => {
      open.current = false;
    },
    []
  );

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
      // The session editors fold their own answers in (`useSessionSubmit`).
      finish: () => closeRef.current(),
      setDirty,
      setSaving,
      switchKind: () => undefined
    }),
    [api, variant, connected, requestClose, setDirty, setSaving]
  );

  const session = useMemo<SessionEditorContext>(
    () => ({
      profileId: request.profileId,
      profileName,
      done: (itemId) => {
        dirty.current = false;
        setSessionProfilesNotice({ tone: "ok", text: SAVED_NOTICE });
        savedRef.current(itemId);
        closeRef.current();
      },
      alive: () => open.current
    }),
    [request.profileId, profileName]
  );

  const label =
    request.mode === "instructions"
      ? "Instructions"
      : request.mode === "edit"
        ? "Edit item"
        : `New ${PROFILE_KIND_LABELS[request.kind].one}`;

  return (
    <EditorFrame
      open
      variant={variant}
      label={label}
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
        <SessionEditorCtx.Provider value={session}>
          {request.mode === "instructions" ? (
            <InstructionsBody />
          ) : request.mode === "edit" ? (
            <EditLoader itemId={request.itemId} />
          ) : (
            <CreateBody kind={request.kind} />
          )}
        </SessionEditorCtx.Provider>
      </EditorEnvContext.Provider>
    </EditorFrame>
  );
};

/** The profile's revision as the store holds it now. */
function currentRevision(profileId: string): string | null {
  return sessionProfileDetailEntry(profileId).detail?.revision ?? null;
}

const CreateBody: React.FC<{ kind: Exclude<SessionProfileItemKind, "plugin"> }> = ({ kind }) => {
  const { profileId } = useSessionEditor();
  const [revision] = useState(() => currentRevision(profileId));
  if (revision === null) {
    return (
      <EditorShell title={`New ${PROFILE_KIND_LABELS[kind].one}`} primary={null} cancelLabel="Close">
        <Banner tone="error">The profile is not loaded — close this and try again.</Banner>
      </EditorShell>
    );
  }
  switch (kind) {
    case "mcp":
      return <McpBody revision={revision} />;
    case "hook":
      return <HookBody revision={revision} />;
    default:
      return <MarkdownBody kind={kind} revision={revision} />;
  }
};

type DetailLoad =
  | { status: "loading" }
  | { status: "error"; message: string; code: string | null }
  | { status: "loaded"; detail: SessionProfileItemDetail; revision: string; seq: number };

const EditLoader: React.FC<{ itemId: string }> = ({ itemId }) => {
  const { api } = useEditorEnv();
  const { profileId } = useSessionEditor();
  const [load, setLoad] = useState<DetailLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ status: "loading" });
    (api as ApiClient).getSessionProfileItem(profileId, itemId, controller.signal).then(
      (raw) => {
        const detail = sanitizeSessionProfileItemDetail(raw);
        const revision = currentRevision(profileId);
        if (detail === null || revision === null) {
          setLoad({ status: "error", message: "The item could not be read.", code: null });
          return;
        }
        setLoad({ status: "loaded", detail, revision, seq: attempt });
      },
      (error) => {
        if (controller.signal.aborted || isAbort(error)) return;
        const info = profileError(error);
        setLoad({ status: "error", message: info.message, code: info.code });
      }
    );
    return () => controller.abort();
  }, [api, profileId, itemId, attempt]);

  // "Changed" → Reload: read it again (the store reloaded the profile) and start over.
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  if (load.status !== "loaded") {
    return (
      <EditorShell title="Edit" primary={null} cancelLabel="Close">
        {load.status === "loading" ? (
          <Progress label="Reading the item…" />
        ) : (
          <Banner
            tone="error"
            title={load.code === "ITEM_NOT_FOUND" ? "It is gone" : "Couldn't read it"}
            actions={load.code === "ITEM_NOT_FOUND" ? undefined : <SmallButton onClick={reload}>Retry</SmallButton>}
          >
            {load.message}
          </Banner>
        )}
      </EditorShell>
    );
  }
  const { detail, revision } = load;
  switch (detail.kind) {
    case "mcp":
      return <McpBody key={load.seq} revision={revision} detail={detail} onReload={reload} />;
    case "hook":
      return <HookBody key={load.seq} revision={revision} detail={detail} onReload={reload} />;
    case "plugin":
      return <PluginDetails detail={detail} />;
    default:
      return <MarkdownBody key={load.seq} kind={detail.kind} revision={revision} detail={detail} onReload={reload} />;
  }
};

/** The env with the form's agent: the forms read their rules from it. */
const FormAgent: React.FC<{ agent: SessionProfileAgentId; children: React.ReactNode }> = ({ agent, children }) => {
  const env = useEditorEnv();
  const value = useMemo(() => ({ ...env, agent }), [env, agent]);
  return <EditorEnvContext.Provider value={value}>{children}</EditorEnvContext.Provider>;
};

function sendItem(
  api: ApiClient,
  profileId: string,
  revision: string,
  itemId: string | null,
  draft: SessionProfileItemDraft
): Promise<unknown> {
  return itemId === null
    ? api.createSessionProfileItem(profileId, { revision, draft })
    : api.updateSessionProfileItem(profileId, itemId, { revision, draft });
}

const scopeKey = (scope: SessionProfileAgentScope) => (scope === "all" ? "all" : scope.join(","));

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

type McpDetail = Extract<SessionProfileItemDetail, { kind: "mcp" }>;

const McpBody: React.FC<{ revision: string; detail?: McpDetail; onReload?: () => void }> = ({ revision, detail, onReload }) => {
  const { api } = useEditorEnv();
  const { profileId, profileName } = useSessionEditor();
  const touch = useTouch();
  const [initialScope] = useState<SessionProfileAgentScope>(() => detail?.item.agents ?? defaultScopeFor("mcp"));
  const [scope, setScope] = useState(initialScope);
  const agent = formAgentFor(scope);
  const origin = useMemo(() => mcpFormOrigin(detail?.mcp), [detail]);
  const [initial] = useState(() => initialMcpForm(formAgentFor(initialScope), detail?.mcp));
  const [form, setForm] = useState<McpForm>(initial);
  const [showErrors, setShowErrors] = useState(false);
  const submit = useSessionSubmit();
  const validation = validateMcpForm(agent, form);
  const scopeProblem = sessionProfileScopeProblem("mcp", scope);
  useReportDirty(mcpFormSignature(form) !== mcpFormSignature(initial) || scopeKey(scope) !== scopeKey(initialScope));

  const change = useCallback(
    (patch: Partial<McpForm>) => {
      setForm((current) => ({ ...current, ...patch }));
      submit.clear();
    },
    [submit]
  );

  const save = () => {
    if (!validation.valid || scopeProblem !== null) {
      setShowErrors(true);
      return;
    }
    const draft: SessionProfileItemDraft = { kind: "mcp", agents: scope, mcp: mcpDraftFromForm(agent, form, origin) };
    void submit.run(() => sendItem(api, profileId, revision, detail?.item.id ?? null, draft), "mutation");
  };

  return (
    <EditorShell
      title={detail ? "Edit MCP server" : "New MCP server"}
      subtitle={profileName}
      status={<SubmitStatus state={submit} onReload={onReload} nameShown />}
      primary={{ label: detail ? "Save" : "Add server", busy: submit.busy, onClick: save }}
    >
      <FormAgent agent={agent}>
        <AgentScopePicker
          id="session-profile-mcp-scope"
          kind="mcp"
          value={scope}
          touch={touch}
          onChange={(next) => {
            setScope(next);
            submit.clear();
          }}
        />
        <McpFormView
          mode={detail ? "edit" : "create"}
          form={form}
          onChange={change}
          validation={validation}
          showErrors={showErrors}
          nameError={submit.nameError}
        />
      </FormAgent>
    </EditorShell>
  );
};

// ---------------------------------------------------------------------------
// Skill, command
// ---------------------------------------------------------------------------

type MarkdownDetail = Extract<SessionProfileItemDetail, { kind: "skill" | "command" }>;

const MarkdownBody: React.FC<{ kind: MarkdownKind; revision: string; detail?: MarkdownDetail; onReload?: () => void }> = ({
  kind,
  revision,
  detail,
  onReload
}) => {
  const { api } = useEditorEnv();
  const { profileId, profileName } = useSessionEditor();
  const touch = useTouch();
  const [initialScope] = useState<SessionProfileAgentScope>(() => detail?.item.agents ?? defaultScopeFor(kind));
  const [scope, setScope] = useState(initialScope);
  const formAgent = formAgentFor(initialScope);
  const model = useMemo(() => markdownEditorModel(formAgent, kind, detail?.document), [formAgent, kind, detail]);
  const [initial] = useState<MarkdownForm>(() => initialMarkdownForm(model, detail?.item.name ?? "", detail?.document.body ?? ""));
  const [form, setForm] = useState<MarkdownForm>(initial);
  const [showErrors, setShowErrors] = useState(false);
  const submit = useSessionSubmit();
  const validation = validateMarkdownForm(kind, model, form);
  const scopeProblem = sessionProfileScopeProblem(kind, scope);
  useReportDirty(JSON.stringify(form) !== JSON.stringify(initial) || scopeKey(scope) !== scopeKey(initialScope));

  const change = useCallback(
    (patch: Partial<MarkdownForm>) => {
      setForm((current) => ({ ...current, ...patch }));
      submit.clear();
    },
    [submit]
  );

  const save = () => {
    if (!validation.valid || scopeProblem !== null) {
      setShowErrors(true);
      return;
    }
    const document = markdownDraftFromForm(kind, model, form);
    const draft: SessionProfileItemDraft =
      kind === "skill" ? { kind: "skill", agents: scope, document } : { kind: "command", agents: scope, document };
    void submit.run(() => sendItem(api, profileId, revision, detail?.item.id ?? null, draft), "mutation");
  };

  return (
    <EditorShell
      title={detail ? `Edit ${kind}` : `New ${kind}`}
      subtitle={profileName}
      fill
      status={<SubmitStatus state={submit} onReload={onReload} nameShown />}
      primary={{ label: detail ? "Save" : kind === "skill" ? "Create skill" : "Create command", busy: submit.busy, onClick: save }}
    >
      <FormAgent agent={formAgent}>
        <div className="shrink-0">
          <AgentScopePicker
            id={`session-profile-${kind}-scope`}
            kind={kind}
            value={scope}
            touch={touch}
            onChange={(next) => {
              setScope(next);
              submit.clear();
            }}
          />
          {kind === "command" && (scope === "all" || scope.includes("codex")) ? (
            <p className="mt-1 text-[11px] leading-4 text-neutral-500">Codex has no commands: it gets this one as a skill.</p>
          ) : null}
        </div>
        <MarkdownWriteView
          kind={kind}
          mode={detail ? "edit" : "create"}
          model={model}
          form={form}
          onChange={change}
          validation={validation}
          showErrors={showErrors}
          nameError={submit.nameError}
          files={detail && detail.kind === "skill" ? detail.files : undefined}
          onSave={save}
        />
      </FormAgent>
    </EditorShell>
  );
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

type HookDetail = Extract<SessionProfileItemDetail, { kind: "hook" }>;

const HookBody: React.FC<{ revision: string; detail?: HookDetail; onReload?: () => void }> = ({ revision, detail, onReload }) => {
  const { api } = useEditorEnv();
  const { profileId, profileName } = useSessionEditor();
  const touch = useTouch();
  const [initialScope] = useState<SessionProfileAgentScope>(() => detail?.item.agents ?? defaultScopeFor("hook"));
  const [scope, setScope] = useState(initialScope);
  const agent = formAgentFor(scope);
  const [initial] = useState<HookForm>(() => initialHookForm(formAgentFor(initialScope), detail?.hook));
  const [form, setForm] = useState<HookForm>(initial);
  const [showErrors, setShowErrors] = useState(false);
  const submit = useSessionSubmit();
  const originalEvent = agent === formAgentFor(initialScope) ? detail?.hook.event : undefined;
  const validation = validateHookForm(agent, form, originalEvent);
  const scopeProblem = sessionProfileScopeProblem("hook", scope);
  useReportDirty(JSON.stringify(form) !== JSON.stringify(initial) || scopeKey(scope) !== scopeKey(initialScope));

  const change = useCallback(
    (patch: Partial<HookForm>) => {
      setForm((current) => ({ ...current, ...patch }));
      submit.clear();
    },
    [submit]
  );

  // Another agent speaks other events: keep the event when it has it, else take its default.
  const pickScope = (next: SessionProfileAgentScope) => {
    setScope(next);
    submit.clear();
    const nextAgent = formAgentFor(next);
    if (!hookEvents(nextAgent).includes(form.event)) change({ event: initialHookForm(nextAgent).event });
  };

  const save = () => {
    if (!validation.valid || scopeProblem !== null) {
      setShowErrors(true);
      return;
    }
    const draft: SessionProfileItemDraft = { kind: "hook", agents: scope, hook: hookDraftFromForm(form) };
    void submit.run(() => sendItem(api, profileId, revision, detail?.item.id ?? null, draft), "mutation");
  };

  return (
    <EditorShell
      title={detail ? "Edit hook" : "New hook"}
      subtitle={profileName}
      status={<SubmitStatus state={submit} onReload={onReload} />}
      primary={{ label: detail ? "Save" : "Add hook", busy: submit.busy, onClick: save }}
    >
      <FormAgent agent={agent}>
        <AgentScopePicker id="session-profile-hook-scope" kind="hook" value={scope} touch={touch} onChange={pickScope} />
        <HookFormView form={form} onChange={change} validation={validation} showErrors={showErrors} originalEvent={originalEvent} />
      </FormAgent>
    </EditorShell>
  );
};

// ---------------------------------------------------------------------------
// Plugin (read-only: plugins come from a marketplace, whole)
// ---------------------------------------------------------------------------

const PluginDetails: React.FC<{ detail: Extract<SessionProfileItemDetail, { kind: "plugin" }> }> = ({ detail }) => {
  const { profileName } = useSessionEditor();
  const rows: [string, string][] = [["Agent", scopeLabel(detail.item.agents)]];
  if (detail.plugin.marketplace) rows.push(["Marketplace", detail.plugin.marketplace]);
  if (detail.plugin.version) rows.push(["Version", detail.plugin.version]);
  if (detail.item.description) rows.push(["Description", detail.item.description]);
  rows.push(["Files", detail.plugin.cached ? "In this profile's plugin cache" : "Not copied into the profile yet"]);
  return (
    <EditorShell title={detail.item.name} subtitle={profileName} primary={null} cancelLabel="Close">
      <Banner tone="info">A plugin is installed into the profile as a whole: delete it and add it again to change it.</Banner>
      <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
        {rows.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt className="text-neutral-500">{label}</dt>
            <dd className="min-w-0 break-words text-neutral-200">{value}</dd>
          </React.Fragment>
        ))}
      </dl>
    </EditorShell>
  );
};

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

type InstructionsLoad =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; text: string; revision: string };

const InstructionsBody: React.FC = () => {
  const { api } = useEditorEnv();
  const { profileId, profileName } = useSessionEditor();
  const [load, setLoad] = useState<InstructionsLoad>({ status: "loading" });
  const [text, setText] = useState("");
  const [attempt, setAttempt] = useState(0);
  const submit = useSessionSubmit();
  const loaded = load.status === "loaded" ? load : null;
  const dirty = loaded !== null && text !== loaded.text;
  useReportDirty(dirty);

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ status: "loading" });
    (api as ApiClient).readSessionProfileInstructions(profileId, controller.signal).then(
      (raw) => {
        const record = typeof raw === "object" && raw !== null ? (raw as unknown as Record<string, unknown>) : {};
        const revision = typeof record.revision === "string" ? record.revision : currentRevision(profileId);
        if (revision === null) {
          setLoad({ status: "error", message: "The instructions could not be read." });
          return;
        }
        const body = typeof record.text === "string" ? record.text : "";
        setLoad({ status: "loaded", text: body, revision });
        setText(body);
      },
      (error) => {
        if (!controller.signal.aborted && !isAbort(error)) setLoad({ status: "error", message: profileError(error).message });
      }
    );
    return () => controller.abort();
  }, [api, profileId, attempt]);

  const reload = useCallback(() => {
    submit.clear();
    setAttempt((n) => n + 1);
  }, [submit]);

  const save = () => {
    if (!loaded) return;
    void submit.run(() => api.writeSessionProfileInstructions(profileId, loaded.revision, text), "detail");
  };

  return (
    <EditorShell
      title="Instructions"
      subtitle={profileName}
      fill
      status={<SubmitStatus state={submit} onReload={reload} />}
      primary={
        loaded
          ? { label: "Save", busy: submit.busy, disabled: !dirty, title: dirty ? undefined : "Nothing changed", onClick: save }
          : null
      }
      cancelLabel={loaded ? "Cancel" : "Close"}
    >
      {load.status === "loading" ? <Progress label="Reading the instructions…" /> : null}
      {load.status === "error" ? (
        <Banner tone="error" title="Couldn't read them" actions={<SmallButton onClick={reload}>Retry</SmallButton>}>
          {load.message}
        </Banner>
      ) : null}
      {loaded ? (
        <>
          <p className="shrink-0 text-[11px] leading-4 text-neutral-500">
            Every agent in a chat with this profile reads these instead of its own global instruction file. Empty
            removes them.
          </p>
          <CodeArea
            id="session-profile-instructions"
            label="Profile instructions"
            value={text}
            minHeight={320}
            placeholder={"# Instructions\n\nWhat every chat with this profile should know."}
            onChange={(next) => {
              setText(next);
              if (submit.placement !== "changed") submit.clear();
            }}
            onSave={save}
          />
        </>
      ) : null}
    </EditorShell>
  );
};
