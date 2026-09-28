/**
 * Open the saved-prompt editor from anywhere in the right rail — the Saved
 * prompts panel's "New prompt" and "Edit", and History's "Save as prompt" —
 * without holding a ref to it. The editor is mounted ONCE, by the rail
 * (`SavedPromptEditorHost`), so it opens whichever panel is showing.
 */

import type { SavedPrompt } from "@orquester/api";

export type SavedPromptEditorRequest =
  | {
      mode: "create";
      /** The open project: the editor offers "This project" as a scope when set. */
      projectPath: string | null;
      /** Prefill — History's "Save as prompt" passes the prompt's text as `body`. */
      initial?: {
        title?: string;
        body?: string;
        description?: string;
        tags?: string[];
        /** Defaults to "global". */
        scope?: "global" | "project";
      };
    }
  | {
      mode: "edit";
      projectPath: string | null;
      prompt: SavedPrompt;
    };

type Listener = (request: SavedPromptEditorRequest) => void;

/** Editor hosts. */
const listeners = new Set<Listener>();

/**
 * Ask the mounted editor to open. `false` when no editor host is mounted, so
 * the caller can open its own editor instead.
 */
export function openSavedPromptEditor(request: SavedPromptEditorRequest): boolean {
  if (listeners.size === 0) return false;
  for (const listener of [...listeners]) listener(request);
  return true;
}

/** The editor host subscribes; returns the unsubscribe function. */
export function subscribeSavedPromptEditor(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

type SavedListener = (prompt: SavedPrompt) => void;

const savedListeners = new Set<SavedListener>();

/** The editor saved `prompt` (created or edited) — the Saved prompts panel reveals it. */
export function notifySavedPromptSaved(prompt: SavedPrompt): void {
  for (const listener of savedListeners) listener(prompt);
}

/** The panel subscribes; returns the unsubscribe function. */
export function subscribeSavedPromptSaved(listener: SavedListener): () => void {
  savedListeners.add(listener);
  return () => {
    savedListeners.delete(listener);
  };
}
