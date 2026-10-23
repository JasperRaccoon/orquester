/**
 * Knowledge Graph — whether the entries chat citations name still exist.
 *
 * A citation chip (`orquester-knowledge:entry/<id>` in an agent's answer)
 * asks once, when it is hovered, focused or clicked — never on render — and
 * every chip of that entry shares the answer. An entry the daemon answers
 * `KNOWLEDGE_NOT_FOUND` for is "deleted"; any other failure leaves it unknown
 * (asked again on the next hover).
 *
 * Answers follow the knowledge store: an entry change it names (an edit or
 * delete here, a `knowledge.changed` event) asks again about those entries
 * already known, and a change naming none — or a reset (connection switch,
 * plugin off) — forgets every answer.
 */

import { useSyncExternalStore } from "react";

import { knowledgeErrorCode } from "../../components/knowledge/knowledge.logic";
import { knowledgeStore } from "./store";

export type KnowledgeCitationState = "unknown" | "exists" | "deleted";

/** What the check calls — `ApiClient` satisfies it. */
export interface KnowledgeCitationsApi {
  readonly connection?: { readonly id: string };
  getKnowledgeItem(id: string, signal?: AbortSignal): Promise<unknown>;
}

const known = new Map<string, "exists" | "deleted">();
const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
/** Bumped by a reset: an answer from before it is dropped. */
let generation = 0;
let connectionId: string | null = null;
let client: KnowledgeCitationsApi | null = null;

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Forget every answer (and drop those in flight). */
export function resetKnowledgeCitations(): void {
  generation += 1;
  connectionId = null;
  client = null;
  inFlight.clear();
  if (known.size > 0) {
    known.clear();
    emit();
  }
}

export function knowledgeCitationState(id: string): KnowledgeCitationState {
  return known.get(id) ?? "unknown";
}

function ask(api: KnowledgeCitationsApi, id: string): Promise<void> {
  const gen = generation;
  const run = api.getKnowledgeItem(id).then(
    () => {
      if (gen === generation) known.set(id, "exists");
    },
    (error: unknown) => {
      if (gen === generation && knowledgeErrorCode(error) === "KNOWLEDGE_NOT_FOUND") known.set(id, "deleted");
    }
  );
  const settled = run.finally(() => {
    if (gen !== generation) return;
    if (inFlight.get(id) === settled) inFlight.delete(id);
    emit();
  });
  inFlight.set(id, settled);
  return settled;
}

/** Ask whether entry `id` exists, once: a known answer or a read in flight is reused. */
export function checkKnowledgeCitation(api: KnowledgeCitationsApi, id: string): Promise<void> {
  const connection = api.connection?.id ?? null;
  if (connectionId !== null && connection !== connectionId) resetKnowledgeCitations();
  connectionId = connection;
  client = api;
  if (known.has(id)) return Promise.resolve();
  return inFlight.get(id) ?? ask(api, id);
}

/** Entry changes: ask again about the named entries already known; `null` (any entry) forgets every answer. */
function entriesChanged(ids: readonly string[] | null): void {
  if (ids === null) {
    generation += 1;
    inFlight.clear();
    if (known.size > 0) {
      known.clear();
      emit();
    }
    return;
  }
  const api = client;
  for (const id of ids) {
    if (!known.has(id)) continue;
    known.delete(id);
    if (api) void ask(api, id);
  }
  emit();
}

knowledgeStore.subscribe((state, previous) => {
  if (state.entriesRevision === previous.entriesRevision) return;
  // A reset starts the counter again with nothing named: every answer goes.
  entriesChanged(state.entriesRevision < previous.entriesRevision ? null : state.changedEntryIds);
});

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useKnowledgeCitationState(id: string): KnowledgeCitationState {
  const snapshot = () => knowledgeCitationState(id);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
