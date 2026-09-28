/**
 * The workflow editor's state (workflows spec §7.2): per open workflow a
 * draft definition, the selection, undo/redo, live validation, and autosave.
 *
 * **The draft is the editor's; the daemon's copy is the record.** Every edit
 * replaces the draft (never mutates it — history keeps snapshots by
 * reference) and schedules a save 600 ms after the last change. Saves are
 * serialized: one `PUT` at a time with the revision the draft is based on; a
 * change made while one is in flight saves right after it. A `409
 * REVISION_CONFLICT` means someone else (another tab, an agent through the
 * MCP) saved first: autosave stops and the banner offers **Reload** (take
 * theirs) or **Keep mine** (overwrite theirs with this draft).
 *
 * **Remote changes.** `workflow.upserted` carries the daemon's revision. A
 * newer one while the draft is clean reloads silently; while it is dirty it
 * raises the same banner — nothing here ever merges two edits.
 *
 * **Enabling** goes through a patch (`set_enabled`) after any pending save, so
 * a refusal (errors block enabling) cannot take the rest of the edit with it.
 * A save the daemon refuses as invalid while the draft is enabled is retried
 * once disabled, and the editor says so.
 *
 * No React import; `useWorkflowEditor` (components) reads it through
 * `useSyncExternalStore`. Timers and the clock are injected for tests.
 */

import { createStore, type StoreApi } from "zustand/vanilla";

import {
  applyWorkflowPatch,
  validateWorkflow,
  WorkflowPatchError,
  type GetWorkflowResponse,
  type PatchWorkflowRequest,
  type ReplaceWorkflowRequest,
  type Workflow,
  type WorkflowPatchOp,
  type WorkflowProblem,
  type WorkflowWriteResponse
} from "@orquester/api";

import { SnapshotHistory } from "./history";
import { isRecord, sanitizeWorkflowRecord } from "./sanitize";
import { workflowsStore } from "./store";

/** Autosave fires this long after the last change. */
export const AUTOSAVE_DELAY_MS = 600;
/** Validation runs this long after the last change. */
export const VALIDATE_DELAY_MS = 200;

export interface WorkflowEditorApi {
  getWorkflow(id: string, signal?: AbortSignal): Promise<GetWorkflowResponse>;
  replaceWorkflow(id: string, req: ReplaceWorkflowRequest): Promise<WorkflowWriteResponse>;
  patchWorkflow(id: string, req: PatchWorkflowRequest): Promise<WorkflowWriteResponse>;
}

export interface EditorTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

const REAL_TIMERS: EditorTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now()
};

/** Where remote revisions come from — the workflows store by default. */
export interface RemoteRevisions {
  revisionOf(workflowId: string): number | undefined;
  subscribe(listener: () => void): () => void;
}

const STORE_REVISIONS: RemoteRevisions = {
  revisionOf: (id) => workflowsStore.getState().summaries.get(id)?.revision,
  subscribe: (listener) => workflowsStore.subscribe(listener)
};

export type EditorSaveState = "saved" | "pending" | "saving" | "error" | "conflict";

export interface EditorConflict {
  /** `save`: our save was refused as stale; `remote`: a newer revision arrived over unsaved edits. */
  kind: "save" | "remote";
}

export interface EditorSelection {
  nodeIds: readonly string[];
  edgeIds: readonly string[];
}

export interface WorkflowEditorState {
  workflowId: string;
  status: "loading" | "ready" | "error";
  loadError: string | null;
  draft: Workflow | null;
  /** The daemon revision the draft is based on. */
  revision: number;
  dirty: boolean;
  saveState: EditorSaveState;
  saveError: string | null;
  conflict: EditorConflict | null;
  /** A one-off message (e.g. "Disabled: …"); dismissible. */
  notice: string | null;
  /** Live validation of the draft (local; the daemon agrees by construction). */
  problems: readonly WorkflowProblem[];
  selection: EditorSelection;
  canUndo: boolean;
  canRedo: boolean;
}

export interface ChangeOptions {
  /** Changes with the same key within a second are one undo step (a drag, a typing burst). */
  coalesce?: string | null;
  /** Replace the selection along with the change. */
  select?: EditorSelection;
}

export interface ValidationContext {
  secretNames?: readonly string[];
  savedPromptIds?: readonly string[];
  knownWorkflowIds?: readonly string[];
}

const EMPTY_SELECTION: EditorSelection = { nodeIds: [], edgeIds: [] };

function errorCode(error: unknown): string | null {
  if (!isRecord(error)) return null;
  if (typeof error.code === "string") return error.code;
  const body = error.body;
  if (isRecord(body) && isRecord(body.error) && typeof body.error.code === "string") return body.error.code;
  return null;
}

function errorStatus(error: unknown): number | null {
  return isRecord(error) && typeof error.status === "number" ? error.status : null;
}

function errorText(error: unknown, fallback: string): string {
  if (isRecord(error)) {
    if (typeof error.serverMessage === "string" && error.serverMessage.trim()) return error.serverMessage.trim();
    if (typeof error.message === "string" && error.message.trim()) return error.message.trim();
  }
  return fallback;
}

const isConflict = (error: unknown): boolean => errorCode(error) === "REVISION_CONFLICT" || errorStatus(error) === 409;

/** The body of a `PUT`: the definition without the daemon's own fields. */
export function replaceBody(workflow: Workflow): ReplaceWorkflowRequest["workflow"] {
  const { id: _id, revision: _revision, createdAt: _created, updatedAt: _updated, ...rest } = workflow;
  return rest;
}

function recordOf(answer: unknown): Workflow | null {
  return isRecord(answer) ? sanitizeWorkflowRecord(answer.workflow) : null;
}

let idCounter = 0;
const defaultMintId = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${(idCounter += 1)}`;

export interface WorkflowEditorOptions {
  timers?: EditorTimers;
  remote?: RemoteRevisions | null;
  mintId?: () => string;
}

export class WorkflowEditor {
  readonly store: StoreApi<WorkflowEditorState>;
  readonly mintId: () => string;
  private readonly timers: EditorTimers;
  private readonly history = new SnapshotHistory<Workflow>();
  private saveTimer: unknown = null;
  private validateTimer: unknown = null;
  private saving: Promise<void> | null = null;
  private saveAgain = false;
  private validation: ValidationContext = {};
  private unsubscribeRemote: (() => void) | null = null;
  private disposed = false;
  private loadSeq = 0;
  private readonly remote: RemoteRevisions | null;

  constructor(
    private readonly api: WorkflowEditorApi,
    readonly workflowId: string,
    options: WorkflowEditorOptions = {}
  ) {
    this.timers = options.timers ?? REAL_TIMERS;
    this.mintId = options.mintId ?? defaultMintId;
    this.store = createStore<WorkflowEditorState>(() => ({
      workflowId,
      status: "loading",
      loadError: null,
      draft: null,
      revision: 0,
      dirty: false,
      saveState: "saved",
      saveError: null,
      conflict: null,
      notice: null,
      problems: [],
      selection: EMPTY_SELECTION,
      canUndo: false,
      canRedo: false
    }));
    const remote = options.remote === undefined ? STORE_REVISIONS : options.remote;
    this.remote = remote;
    if (remote !== null) {
      this.unsubscribeRemote = remote.subscribe(() => {
        const revision = remote.revisionOf(workflowId);
        if (revision !== undefined) this.onRemoteRevision(revision);
      });
    }
  }

  get state(): WorkflowEditorState {
    return this.store.getState();
  }

  private set(patch: Partial<WorkflowEditorState>): void {
    if (!this.disposed) this.store.setState(patch);
  }

  private syncHistoryFlags(): void {
    this.set({ canUndo: this.history.canUndo, canRedo: this.history.canRedo });
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /** Read the workflow; replaces the draft, clears history and conflicts. */
  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    if (this.state.draft === null) this.set({ status: "loading", loadError: null });
    try {
      const answer = await this.api.getWorkflow(this.workflowId);
      if (seq !== this.loadSeq || this.disposed) return;
      const record = recordOf(answer);
      if (record === null) throw new Error("The daemon answered in an unexpected shape.");
      this.adoptServerCopy(record);
    } catch (error) {
      if (seq !== this.loadSeq || this.disposed) return;
      const missing = errorCode(error) === "WORKFLOW_NOT_FOUND" || errorStatus(error) === 404;
      this.set({
        status: this.state.draft === null ? "error" : this.state.status,
        loadError: missing ? "This workflow no longer exists." : errorText(error, "The daemon did not answer.")
      });
    }
  }

  private adoptServerCopy(record: Workflow): void {
    this.cancelSave();
    this.history.clear();
    const ids = new Set(record.nodes.map((node) => node.id));
    const edgeIds = new Set(record.edges.map((edge) => edge.id));
    const selection = this.state.selection;
    this.set({
      status: "ready",
      loadError: null,
      draft: record,
      revision: record.revision,
      dirty: false,
      saveState: "saved",
      saveError: null,
      conflict: null,
      selection: {
        nodeIds: selection.nodeIds.filter((id) => ids.has(id)),
        edgeIds: selection.edgeIds.filter((id) => edgeIds.has(id))
      },
      canUndo: false,
      canRedo: false
    });
    this.validateNow();
  }

  /** Banner: take the daemon's copy, dropping unsaved edits. */
  reload(): Promise<void> {
    return this.load();
  }

  /** Banner: overwrite the daemon's copy with this draft. */
  async keepMine(): Promise<void> {
    try {
      const answer = await this.api.getWorkflow(this.workflowId);
      const record = recordOf(answer);
      if (record === null) throw new Error("The daemon answered in an unexpected shape.");
      this.set({ revision: record.revision, conflict: null, dirty: true, saveState: "pending" });
      await this.flush();
    } catch (error) {
      this.set({ saveState: "error", saveError: errorText(error, "Couldn't save.") });
    }
  }

  // -------------------------------------------------------------------------
  // Remote revisions
  // -------------------------------------------------------------------------

  /** A revision announced by the daemon (`workflow.upserted`). */
  onRemoteRevision(revision: number): void {
    if (this.disposed || this.state.draft === null) return;
    // Our own save's answer decides once it lands; checked again after it.
    if (this.saving !== null) return;
    if (revision <= this.state.revision) return;
    if (!this.state.dirty) {
      void this.load();
      return;
    }
    this.cancelSave();
    this.set({ conflict: { kind: "remote" }, saveState: "conflict" });
  }

  // -------------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------------

  /** Apply a change to the draft: one undo step (or joins a burst), autosave, revalidate. */
  change(recipe: (draft: Workflow) => Workflow, options: ChangeOptions = {}): boolean {
    const draft = this.state.draft;
    if (draft === null || this.disposed) return false;
    const next = recipe(draft);
    if (next === draft) {
      if (options.select) this.select(options.select);
      return false;
    }
    this.history.record(draft, options.coalesce ?? null, this.timers.now());
    this.set({
      draft: next,
      dirty: true,
      saveState: this.state.conflict ? "conflict" : "pending",
      ...(options.select ? { selection: options.select } : {})
    });
    this.syncHistoryFlags();
    this.afterDraftChange();
    return true;
  }

  /**
   * Apply patch ops locally (`rename_node` rewrites `{{nodes.Old…}}`
   * references). Returns the refusal's message, or null when it applied.
   */
  applyOps(ops: readonly WorkflowPatchOp[], options: ChangeOptions = {}): string | null {
    let refusal: string | null = null;
    this.change((draft) => {
      try {
        const next = applyWorkflowPatch(draft, ops, { mintId: this.mintId, now: () => new Date(this.timers.now()) });
        // The daemon stamps updatedAt; keep ours so an undo is a pure swap.
        return { ...next, updatedAt: draft.updatedAt };
      } catch (error) {
        refusal = error instanceof WorkflowPatchError ? error.message : errorText(error, "That change could not be applied.");
        return draft;
      }
    }, options);
    return refusal;
  }

  /** End a typing burst / drag: the next change is its own undo step. */
  sealHistory(): void {
    this.history.seal();
  }

  undo(): void {
    const draft = this.state.draft;
    if (draft === null) return;
    const previous = this.history.undo(draft);
    if (previous === null) return;
    this.swapDraft(previous);
  }

  redo(): void {
    const draft = this.state.draft;
    if (draft === null) return;
    const next = this.history.redo(draft);
    if (next === null) return;
    this.swapDraft(next);
  }

  private swapDraft(next: Workflow): void {
    const ids = new Set(next.nodes.map((node) => node.id));
    const edgeIds = new Set(next.edges.map((edge) => edge.id));
    const selection = this.state.selection;
    this.set({
      draft: next,
      dirty: true,
      saveState: this.state.conflict ? "conflict" : "pending",
      selection: {
        nodeIds: selection.nodeIds.filter((id) => ids.has(id)),
        edgeIds: selection.edgeIds.filter((id) => edgeIds.has(id))
      }
    });
    this.syncHistoryFlags();
    this.afterDraftChange();
  }

  select(selection: EditorSelection): void {
    const current = this.state.selection;
    const same =
      current.nodeIds.length === selection.nodeIds.length &&
      current.edgeIds.length === selection.edgeIds.length &&
      current.nodeIds.every((id, index) => selection.nodeIds[index] === id) &&
      current.edgeIds.every((id, index) => selection.edgeIds[index] === id);
    if (!same) this.set({ selection: { nodeIds: [...selection.nodeIds], edgeIds: [...selection.edgeIds] } });
  }

  dismissNotice(): void {
    this.set({ notice: null });
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  setValidationContext(context: ValidationContext): void {
    this.validation = context;
    this.scheduleValidate();
  }

  private scheduleValidate(): void {
    if (this.validateTimer !== null) this.timers.clear(this.validateTimer);
    this.validateTimer = this.timers.set(() => {
      this.validateTimer = null;
      this.validateNow();
    }, VALIDATE_DELAY_MS);
  }

  validateNow(): void {
    const draft = this.state.draft;
    if (draft === null) return;
    const { problems } = validateWorkflow(draft, {
      ...(this.validation.secretNames ? { secretNames: this.validation.secretNames } : {}),
      ...(this.validation.savedPromptIds ? { savedPromptIds: this.validation.savedPromptIds } : {}),
      ...(this.validation.knownWorkflowIds ? { knownWorkflowIds: this.validation.knownWorkflowIds } : {})
    });
    this.set({ problems });
  }

  // -------------------------------------------------------------------------
  // Saving
  // -------------------------------------------------------------------------

  private afterDraftChange(): void {
    this.scheduleValidate();
    if (this.state.conflict !== null) return;
    this.cancelSave();
    this.saveTimer = this.timers.set(() => {
      this.saveTimer = null;
      void this.flush();
    }, AUTOSAVE_DELAY_MS);
  }

  private cancelSave(): void {
    if (this.saveTimer !== null) {
      this.timers.clear(this.saveTimer);
      this.saveTimer = null;
    }
  }

  /** Save now (a pending autosave included); resolves once the draft is saved or refused. */
  flush(): Promise<void> {
    this.cancelSave();
    if (this.saving !== null) {
      this.saveAgain = true;
      return this.saving;
    }
    if (!this.state.dirty || this.state.conflict !== null || this.state.draft === null) return Promise.resolve();
    const run = this.saveOnce().finally(() => {
      this.saving = null;
      if (this.disposed) return;
      if (this.saveAgain) {
        this.saveAgain = false;
        if (this.state.dirty && this.state.conflict === null) return this.flush();
      }
      const remote = this.remoteRevision();
      if (remote !== undefined) this.onRemoteRevision(remote);
      return undefined;
    });
    this.saving = run;
    return run;
  }

  private remoteRevision(): number | undefined {
    return this.remote?.revisionOf(this.workflowId);
  }

  private async saveOnce(): Promise<void> {
    const snapshot = this.state.draft!;
    this.set({ saveState: "saving", saveError: null });
    try {
      const answer = await this.api.replaceWorkflow(this.workflowId, {
        revision: this.state.revision,
        workflow: replaceBody(snapshot)
      });
      this.afterSaved(snapshot, answer);
    } catch (error) {
      if (this.disposed) return;
      if (isConflict(error)) {
        this.set({ conflict: { kind: "save" }, saveState: "conflict", saveError: null });
        return;
      }
      if (errorCode(error) === "INVALID_WORKFLOW" && snapshot.enabled) {
        // Errors block enabling, not saving: keep the edit, disabled.
        const disabled = { ...snapshot, enabled: false };
        try {
          const answer = await this.api.replaceWorkflow(this.workflowId, {
            revision: this.state.revision,
            workflow: replaceBody(disabled)
          });
          const current = this.state.draft;
          if (current === snapshot) this.set({ draft: disabled });
          else if (current !== null && current.enabled) this.set({ draft: { ...current, enabled: false } });
          this.set({ notice: "The workflow was disabled: fix its errors to enable it again." });
          this.afterSaved(current === snapshot ? disabled : snapshot, answer);
          return;
        } catch (retryError) {
          error = retryError;
          if (isConflict(error)) {
            this.set({ conflict: { kind: "save" }, saveState: "conflict", saveError: null });
            return;
          }
        }
      }
      this.set({ saveState: "error", saveError: errorText(error, "Couldn't save.") });
    }
  }

  private afterSaved(snapshot: Workflow, answer: WorkflowWriteResponse): void {
    if (this.disposed) return;
    const record = recordOf(answer);
    const revision = record?.revision ?? this.state.revision + 1;
    const clean = this.state.draft === snapshot;
    this.set({
      revision,
      dirty: !clean,
      saveState: clean ? "saved" : "pending",
      saveError: null
    });
    if (!clean) this.saveAgain = true;
  }

  /**
   * Enable or disable: any pending edit is saved first, then one `set_enabled`
   * patch. Returns the refusal's text, or null.
   */
  async setEnabled(enabled: boolean): Promise<string | null> {
    if (this.state.draft === null) return "The workflow is not loaded.";
    await this.flush();
    if (this.state.conflict !== null) return "Resolve the conflict first.";
    try {
      const answer = await this.api.patchWorkflow(this.workflowId, {
        revision: this.state.revision,
        ops: [{ op: "set_enabled", enabled }]
      });
      const record = recordOf(answer);
      const draft = this.state.draft;
      if (draft !== null) this.set({ draft: { ...draft, enabled: record?.enabled ?? enabled } });
      this.set({ revision: record?.revision ?? this.state.revision + 1 });
      return null;
    } catch (error) {
      if (isConflict(error)) {
        this.set({ conflict: { kind: "save" }, saveState: "conflict" });
        return "The workflow changed elsewhere.";
      }
      return errorText(error, enabled ? "Couldn't enable the workflow." : "Couldn't disable the workflow.");
    }
  }

  /** Stop timers and listeners; a pending edit is saved first. */
  dispose(): void {
    if (this.disposed) return;
    const pending = this.state.dirty && this.state.conflict === null;
    if (pending) void this.flush();
    if (this.validateTimer !== null) this.timers.clear(this.validateTimer);
    this.unsubscribeRemote?.();
    this.unsubscribeRemote = null;
    // Let an in-flight or just-started save finish; nothing else writes after this.
    const finish = this.saving ?? Promise.resolve();
    void finish.finally(() => {
      this.disposed = true;
    });
    if (!pending && this.saving === null) this.disposed = true;
  }
}

// ---------------------------------------------------------------------------
// One editor per open workflow (tabs share it; the last to go disposes it)
// ---------------------------------------------------------------------------

/** A released editor lingers this long, so a remount (StrictMode, a tab moving cells) keeps its draft. */
export const EDITOR_RELEASE_GRACE_MS = 1_000;

interface EditorEntry {
  editor: WorkflowEditor;
  api: WorkflowEditorApi;
  refs: number;
  disposeTimer: ReturnType<typeof setTimeout> | null;
}

const editors = new Map<string, EditorEntry>();

/**
 * The editor for `workflowId`, created (and loaded) on first use. Safe to call
 * while rendering; hold it with `retainWorkflowEditor` from an effect.
 */
export function workflowEditorFor(api: WorkflowEditorApi, workflowId: string, options?: WorkflowEditorOptions): WorkflowEditor {
  let entry = editors.get(workflowId);
  if (entry && entry.api !== api) {
    // Another connection's client: its draft belongs to another daemon.
    if (entry.disposeTimer) clearTimeout(entry.disposeTimer);
    entry.editor.dispose();
    editors.delete(workflowId);
    entry = undefined;
  }
  if (!entry) {
    const editor = new WorkflowEditor(api, workflowId, options);
    entry = { editor, api, refs: 0, disposeTimer: null };
    editors.set(workflowId, entry);
    void editor.load();
  }
  return entry.editor;
}

/** Hold `editor` open; the returned release lets it go (disposed once nothing holds it). */
export function retainWorkflowEditor(editor: WorkflowEditor): () => void {
  const entry = editors.get(editor.workflowId);
  if (!entry || entry.editor !== editor) return () => undefined;
  entry.refs += 1;
  if (entry.disposeTimer) {
    clearTimeout(entry.disposeTimer);
    entry.disposeTimer = null;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    entry.disposeTimer = setTimeout(() => {
      entry.disposeTimer = null;
      if (entry.refs > 0 || editors.get(editor.workflowId) !== entry) return;
      editors.delete(editor.workflowId);
      entry.editor.dispose();
    }, EDITOR_RELEASE_GRACE_MS);
  };
}

/** Test seam. */
export function resetWorkflowEditors(): void {
  for (const entry of editors.values()) {
    if (entry.disposeTimer) clearTimeout(entry.disposeTimer);
    entry.editor.dispose();
  }
  editors.clear();
}
