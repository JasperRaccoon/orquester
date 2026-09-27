/**
 * The saved-prompt editor's Save, as a function of what it talks to: a create
 * sends the whole record, an edit only what changed (and an edit that changes
 * nothing sends nothing), one save at a time — and the editor may close while
 * a save is in flight: the store applies the answer whenever it lands, and a
 * failure nobody can see in the form any more becomes the panel's notice.
 *
 * `SavedPromptEditor` binds it to the store; the tests bind fakes
 * (`editor-save.test.ts`).
 */

import type {
  CreateSavedPromptRequest,
  SavedPrompt,
  UpdateSavedPromptRequest
} from "@orquester/api";

import { savedPromptErrorText } from "../../../lib/saved-prompts/errors";
import type { SavedPromptResult } from "../../../lib/saved-prompts/store";
import type { SavedPromptEditorRequest } from "./editor-bridge";
import {
  createRequestFromDraft,
  updatePatchFromDraft,
  validateSavedPromptDraft,
  type SavedPromptDraft
} from "./editor.logic";

export type SavedPromptSaveOutcome =
  /** A save is already in flight: this one was not sent (the double-save guard). */
  | { status: "busy" }
  | { status: "invalid" }
  /** An edit that changes nothing: close, no request. */
  | { status: "unchanged" }
  /** `prompt` is `null` when the daemon's answer did not parse (the store reloads). */
  | { status: "saved"; prompt: SavedPrompt | null }
  | { status: "failed"; error: string };

export interface SavedPromptSaverDeps {
  create(request: CreateSavedPromptRequest): Promise<SavedPromptResult>;
  update(id: string, patch: UpdateSavedPromptRequest): Promise<SavedPromptResult>;
  /** A save landed — even after its editor closed: the panel reveals the prompt. */
  onSaved(prompt: SavedPrompt): void;
  /** A save failed after its editor closed, so the form cannot show why. */
  onFailedAfterClose(error: string): void;
}

export interface SavedPromptSaver {
  readonly saving: boolean;
  save(request: SavedPromptEditorRequest, draft: SavedPromptDraft): Promise<SavedPromptSaveOutcome>;
  /** The editor closed. A save in flight still lands; only where its failure is said changes. */
  close(): void;
}

export function createSavedPromptSaver(deps: SavedPromptSaverDeps): SavedPromptSaver {
  let saving = false;
  let closed = false;
  return {
    get saving() {
      return saving;
    },
    async save(request, draft) {
      if (saving) return { status: "busy" };
      if (!validateSavedPromptDraft(draft).valid) return { status: "invalid" };
      const projectPath = request.projectPath || null;
      let pending: Promise<SavedPromptResult>;
      if (request.mode === "edit") {
        const patch = updatePatchFromDraft(request.prompt, draft, projectPath);
        if (Object.keys(patch).length === 0) return { status: "unchanged" };
        pending = deps.update(request.prompt.id, patch);
      } else {
        pending = deps.create(createRequestFromDraft(draft, projectPath));
      }
      saving = true;
      let result: SavedPromptResult;
      try {
        result = await pending;
      } catch (error) {
        result = { ok: false, error: savedPromptErrorText(error) };
      } finally {
        saving = false;
      }
      if (result.ok) {
        if (result.prompt !== null) deps.onSaved(result.prompt);
        return { status: "saved", prompt: result.prompt };
      }
      if (closed) deps.onFailedAfterClose(result.error);
      return { status: "failed", error: result.error };
    },
    close() {
      closed = true;
    }
  };
}
