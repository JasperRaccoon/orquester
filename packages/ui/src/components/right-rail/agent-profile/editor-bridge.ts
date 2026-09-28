/**
 * Open the agent-profile editor from anywhere in the right rail without holding
 * a ref to it. The editor is mounted ONCE, by the rail
 * (`AgentProfileEditorHost`), the way the saved-prompt editor is.
 */

import type { AgentProfileAgentId, ProfileItemKind } from "@orquester/api";

export type AgentProfileEditorRequest =
  /** "+ Add" → a kind. For skills and commands the editor offers Write · Git URL · Upload · Copy from agent. */
  | { mode: "create"; agent: AgentProfileAgentId; kind: ProfileItemKind }
  /** A row's Edit. */
  | { mode: "edit"; agent: AgentProfileAgentId; itemId: string }
  /** The instructions card. */
  | { mode: "instructions"; agent: AgentProfileAgentId };

/** Tells the panel what the editor saved, so it can reveal the item. */
export interface AgentProfileEditorSaved {
  agent: AgentProfileAgentId;
  itemIds: string[];
  notes: string[];
}

type Listener = (request: AgentProfileEditorRequest) => void;
type SavedListener = (saved: AgentProfileEditorSaved) => void;

const listeners = new Set<Listener>();
const savedListeners = new Set<SavedListener>();

/** Ask the mounted editor to open; `false` when no editor host is mounted. */
export function openAgentProfileEditor(request: AgentProfileEditorRequest): boolean {
  if (listeners.size === 0) return false;
  for (const listener of listeners) listener(request);
  return true;
}

/** Editor hosts subscribe; returns the unsubscribe. */
export function subscribeAgentProfileEditor(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyAgentProfileEditorSaved(saved: AgentProfileEditorSaved): void {
  for (const listener of savedListeners) listener(saved);
}

export function subscribeAgentProfileEditorSaved(listener: SavedListener): () => void {
  savedListeners.add(listener);
  return () => {
    savedListeners.delete(listener);
  };
}
