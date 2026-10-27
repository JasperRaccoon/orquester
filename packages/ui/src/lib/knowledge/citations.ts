/**
 * Knowledge Graph — whether the entries chat citations name still exist, and
 * what the citation's hover card says about them.
 *
 * A citation chip (`orquester-knowledge:entry/<id>` in an agent's answer)
 * asks once, when it is hovered, focused or clicked — never on render — and
 * every chip of that entry shares the answer: that it exists, with a short
 * summary for the card (title, byline, dates, collections, a snippet; never
 * the whole body), or that it is "deleted" (the daemon answered
 * `KNOWLEDGE_NOT_FOUND`). Any other failure leaves it unknown (asked again on
 * the next hover).
 *
 * Answers follow the knowledge store: an entry change it names (an edit or
 * delete here, a `knowledge.changed` event) asks again about those entries
 * already known, and a change naming none — or a reset (connection switch,
 * plugin off) — forgets every answer.
 */

import { useSyncExternalStore } from "react";
import type { KnowledgeEntryMeta } from "@orquester/api";

import { knowledgeErrorCode } from "../../components/knowledge/knowledge.logic";
import { knowledgeStore, onKnowledgeReset } from "./store";
import { parseKnowledgeItemResponse } from "./validate";

export type KnowledgeCitationState = "unknown" | "exists" | "deleted";

/** What a citation's hover card shows about an entry that exists. */
export type KnowledgeCitationSummary = Pick<KnowledgeEntryMeta, "id" | "title" | "author" | "handle" | "postedAt" | "savedAt" | "collections"> & {
  /** The body's opening words as plain text (Markdown marks stripped), at most {@link CITATION_SNIPPET_MAX} characters. */
  snippet: string;
};

/** A known answer; `summary` is null when the daemon's answer was no readable entry. */
export type KnowledgeCitationAnswer = { state: "exists"; summary: KnowledgeCitationSummary | null } | { state: "deleted" };

export const CITATION_SNIPPET_MAX = 240;

/** A body's opening as one plain line: fences, headings, quotes, list marks, emphasis and link targets dropped. */
export function citationSnippet(body: string, max = CITATION_SNIPPET_MAX): string {
  // Look at no more than the opening of a long body.
  const head = body.slice(0, max * 8);
  const lines: string[] = [];
  for (const raw of head.split("\n")) {
    if (/^\s{0,3}(```|~~~)/.test(raw)) continue;
    const line = raw
      .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)+/, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\*\*|__|`/g, "")
      .trim();
    if (line) lines.push(line);
  }
  const text = lines.join(" ").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:–—-]+$/, "")}…`;
}

/** The card's summary of a `GET /items/:id` answer, or null when it is no entry this client can read. */
export function citationSummaryOf(answer: unknown): KnowledgeCitationSummary | null {
  const item = parseKnowledgeItemResponse(answer);
  if (item?.kind !== "entry") return null;
  const { id, title, author, handle, postedAt, savedAt, collections, body } = item.entry.entry;
  return { id, title, author, handle, postedAt, savedAt, collections, snippet: citationSnippet(body) };
}

/** What the check calls — `ApiClient` satisfies it. */
export interface KnowledgeCitationsApi {
  readonly connection?: { readonly id: string };
  getKnowledgeItem(id: string, signal?: AbortSignal): Promise<unknown>;
}

const known = new Map<string, KnowledgeCitationAnswer>();
const inFlight = new Map<string, Promise<void>>();
/** The newest read of each entry: an older one that settles after it is dropped. */
const latest = new Map<string, number>();
let reads = 0;
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
  forgetAll();
}

/**
 * Drop every answer and every read in flight. Their late answers are dropped by the generation
 * check without a word, so tell the cards now — also when only reads were in flight (else a card
 * would stay on "Loading…").
 */
function forgetAll(): void {
  const had = known.size > 0 || inFlight.size > 0;
  inFlight.clear();
  latest.clear();
  known.clear();
  if (had) emit();
}

export function knowledgeCitationState(id: string): KnowledgeCitationState {
  return known.get(id)?.state ?? "unknown";
}

/** The known answer about entry `id`, or undefined (never asked, asked again after a change, or the last ask failed). */
export function knowledgeCitationAnswer(id: string): KnowledgeCitationAnswer | undefined {
  return known.get(id);
}

/** Whether entry `id` is being asked about right now. */
export function knowledgeCitationPending(id: string): boolean {
  return inFlight.has(id);
}

function ask(api: KnowledgeCitationsApi, id: string): Promise<void> {
  const gen = generation;
  const mine = ++reads;
  latest.set(id, mine);
  const current = () => gen === generation && latest.get(id) === mine;
  const run = api.getKnowledgeItem(id).then(
    (answer) => {
      if (current()) known.set(id, { state: "exists", summary: citationSummaryOf(answer) });
    },
    (error: unknown) => {
      if (current() && knowledgeErrorCode(error) === "KNOWLEDGE_NOT_FOUND") known.set(id, { state: "deleted" });
    }
  );
  const settled = run.finally(() => {
    if (gen !== generation) return;
    if (inFlight.get(id) === settled) inFlight.delete(id);
    emit();
  });
  inFlight.set(id, settled);
  // The card shows the read is on its way.
  emit();
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

/** Entry changes: ask again about the named entries known or being asked about; `null` (any entry) forgets every answer. */
function entriesChanged(ids: readonly string[] | null): void {
  if (ids === null) {
    generation += 1;
    forgetAll();
    return;
  }
  const api = client;
  for (const id of ids) {
    // A read in flight may answer from before the change: ask again.
    if (!known.has(id) && !inFlight.has(id)) continue;
    known.delete(id);
    if (api) void ask(api, id);
  }
  emit();
}

// A reset (connection switch, plugin off) forgets every answer and the client.
onKnowledgeReset(resetKnowledgeCitations);

knowledgeStore.subscribe((state, previous) => {
  if (state.entriesRevision === previous.entriesRevision) return;
  // A reset starts the counter again with nothing named: every answer goes.
  entriesChanged(state.entriesRevision < previous.entriesRevision ? null : state.changedEntryIds);
});

/** Run `listener` whenever an answer or a pending read changes (the hooks below; tests). */
export function subscribeKnowledgeCitations(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const subscribe = subscribeKnowledgeCitations;

export function useKnowledgeCitationState(id: string): KnowledgeCitationState {
  const snapshot = () => knowledgeCitationState(id);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The answer about entry `id` (the same object until it changes) and whether a read is in flight. */
export function useKnowledgeCitation(id: string): { answer: KnowledgeCitationAnswer | undefined; pending: boolean } {
  const answerOf = () => knowledgeCitationAnswer(id);
  const pendingOf = () => knowledgeCitationPending(id);
  const answer = useSyncExternalStore(subscribe, answerOf, answerOf);
  const pending = useSyncExternalStore(subscribe, pendingOf, pendingOf);
  return { answer, pending };
}
