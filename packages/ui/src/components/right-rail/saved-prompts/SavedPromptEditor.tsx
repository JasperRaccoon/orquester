/**
 * The saved-prompt editor: "New prompt" / "Edit prompt" in a modal. Owns the
 * draft; the save itself is `editor-save.ts` — a create sends the whole
 * record, an edit only what changed — and the editor closes on success, while
 * a refusal stays in the form, beside the fields, with the draft intact. It
 * may be closed while a save is in flight: the save still lands, and a late
 * failure becomes the panel's notice.
 *
 * Opened through `editor-bridge.ts` (the rail mounts one `SavedPromptEditorHost`).
 */

import React, { useCallback, useEffect, useRef, useState } from "react";

import { useApi } from "../../../context/orquester-context";
import {
  createSavedPrompt,
  setSavedPromptsNotice,
  updateSavedPrompt
} from "../../../lib/saved-prompts/store";
import { Modal } from "../../ui/modal";
import { notifySavedPromptSaved, type SavedPromptEditorRequest } from "./editor-bridge";
import { createSavedPromptSaver, type SavedPromptSaver } from "./editor-save";
import { initialDraft, projectScopeAvailable, type SavedPromptDraft } from "./editor.logic";
import { SavedPromptEditorForm } from "./SavedPromptEditorForm";

export const SavedPromptEditor: React.FC<{
  request: SavedPromptEditorRequest;
  onClose: () => void;
}> = ({ request, onClose }) => {
  const api = useApi();
  const [draft, setDraft] = useState<SavedPromptDraft>(() => initialDraft(request));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The save outlives this editor (closed mid-save), so it is made once and
  // reads the client it saves through at the moment it sends.
  const apiRef = useRef(api);
  apiRef.current = api;
  const [saver] = useState<SavedPromptSaver>(() =>
    createSavedPromptSaver({
      create: (req) => createSavedPrompt(apiRef.current, req, { quiet: true }),
      update: (id, patch) => updateSavedPrompt(apiRef.current, id, patch, { quiet: true }),
      onSaved: notifySavedPromptSaved,
      onFailedAfterClose: (message) => setSavedPromptsNotice(`Couldn't save the prompt: ${message}`)
    })
  );
  // Nothing may be shown once the editor is gone. Re-armed on mount: React's
  // StrictMode rehearses an unmount, and a flag set for good there would
  // leave a real save unable to close the editor.
  const closed = useRef(false);
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
    };
  }, []);

  const change = useCallback((patch: Partial<SavedPromptDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  }, []);

  // Escape, the backdrop and Cancel all land here — a save in flight included.
  const close = useCallback(() => {
    closed.current = true;
    saver.close();
    onClose();
  }, [onClose, saver]);

  const save = async () => {
    if (saver.saving) return;
    setSaving(true);
    setError(null);
    const outcome = await saver.save(request, draft);
    if (closed.current) return;
    setSaving(false);
    if (outcome.status === "saved" || outcome.status === "unchanged") {
      closed.current = true;
      onClose();
    } else if (outcome.status === "failed") {
      setError(outcome.error);
    }
  };

  return (
    <Modal
      open
      onClose={close}
      className="max-h-[calc(100dvh-1.5rem)] max-w-2xl sm:max-h-[90vh]"
    >
      <SavedPromptEditorForm
        mode={request.mode}
        draft={draft}
        onChange={change}
        projectScopeAvailable={projectScopeAvailable(request)}
        saving={saving}
        error={error}
        onSave={() => void save()}
        onCancel={close}
      />
    </Modal>
  );
};
