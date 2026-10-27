/**
 * Knowledge Graph linking — neighbour context for Pass 2 (phase 2 spec, "Neighbour context").
 *
 * myKG extracts each entry on its own (one Pass 2 task per entry, `batch_per_file`), so it never
 * sees what similar entries already said and names the same thing in slightly different ways. A
 * worker is therefore shown, after myKG's prompt, a block naming up to {@link CONTEXT_CONCEPTS_MAX}
 * concepts of the entry's {@link CONTEXT_NEIGHBOURS} nearest neighbours, with the instruction to reuse
 * a listed name for the same thing and never to extract a listed concept the document does not
 * mention. It is added by `InboxBroker`'s view only: the task file, its id and myKG's answer cache
 * are untouched (the prompt overlay, whose digest forces a reinstall, is not changed).
 *
 * Neighbours: entries with vectors from the current model AND at least one concept (one without
 * concepts has nothing to offer), at cosine ≥ the model's `minimum` (an unrelated entry's concepts
 * would only cost tokens), closest first by entry vector. Concepts: ranked by the summed similarity
 * of the neighbours that have them (shared by several close entries first), then by the closest
 * neighbour's order, then by name.
 *
 * The entry a task is for: myKG's Pass 2 prompt ends with `DOCUMENT\n========\n<text>` (`pass2.py`
 * `_build_extraction_prompt`; a retry prefixes the same prompt), and the text is the entry's mirror
 * file (or, for an entry longer than one chunk, a window of it). The label (`pass2 chunk <batch>`)
 * does not name the file, so the document is matched against the mirror files.
 *
 * Search is reached only through {@link KnowledgeLinkGraphView}, injected by `knowledge/service.ts`.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { KnowledgeConceptRef } from "@orquester/api";
import type { KnowledgeStorePort, KnowledgeVectorIndex } from "../ports.ts";
import type { InboxTaskEnvelope } from "./inbox.ts";

/** The linking-context version recorded per entry (`KnowledgeStorePort.setLinkContext`); bump it when the context changes. */
export const LINK_CONTEXT_VERSION = 1;
export const CONTEXT_NEIGHBOURS = 5;
export const CONTEXT_CONCEPTS_MAX = 40;
export const CONTEXT_HEADING = "KNOWN CONCEPTS FROM SIMILAR ENTRIES";
/** The steps whose view carries the context. */
export const CONTEXT_STEPS: ReadonlySet<string> = new Set(["pass2"]);

const DOCUMENT_MARKER = "\n\nDOCUMENT\n========\n";
/** How much of a document's start identifies it inside a mirror file (a chunk window of a long entry). */
const MATCH_PREFIX_CHARS = 300;

/** What linking reads of search and the concept graph (`knowledge/service.ts` builds it). */
export interface KnowledgeLinkGraphView {
  /** The vector index of the moment (entry vectors, the model's thresholds). */
  vectors(): KnowledgeVectorIndex;
  /** The concepts linked to an entry in the loaded graph. */
  conceptsOf(entryId: string): readonly KnowledgeConceptRef[];
  /** Concept ids joined to this one by a `contradicts` edge, either direction. */
  contradicting(conceptId: string): readonly string[];
}

/** Whether neighbour context can be built: an embedder is loaded. */
export function contextReady(view: KnowledgeLinkGraphView | undefined): boolean {
  return view !== undefined && view.vectors().thresholds() !== null;
}

export interface Neighbour {
  entryId: string;
  similarity: number;
}

/** The `k` entries closest to `entryId` by entry vector that `accept` passes, at cosine ≥ `minimum`. */
export function nearestNeighbours(index: KnowledgeVectorIndex, entryId: string, k: number, minimum: number, accept: (id: string) => boolean): Neighbour[] {
  const vector = index.entryVector(entryId);
  if (!vector) return [];
  const out: Neighbour[] = [];
  for (const id of index.embeddedIds()) {
    if (id === entryId || !accept(id)) continue;
    const other = index.entryVector(id);
    if (!other || other.length !== vector.length) continue;
    let dot = 0;
    for (let d = 0; d < vector.length; d += 1) dot += vector[d]! * other[d]!;
    if (dot >= minimum) out.push({ entryId: id, similarity: dot });
  }
  out.sort((a, b) => b.similarity - a.similarity || (a.entryId < b.entryId ? -1 : 1));
  return out.slice(0, k);
}

/** The context block for an entry's Pass 2 task, or null when it has no embedded neighbour with concepts. */
export function neighbourContextBlock(entryId: string, view: KnowledgeLinkGraphView): string | null {
  const index = view.vectors();
  const thresholds = index.thresholds();
  if (!thresholds) return null;
  const neighbours = nearestNeighbours(index, entryId, CONTEXT_NEIGHBOURS, thresholds.minimum, (id) => view.conceptsOf(id).length > 0);
  const ranked = new Map<string, { ref: KnowledgeConceptRef; score: number; order: number }>();
  let order = 0;
  for (const neighbour of neighbours) {
    for (const ref of view.conceptsOf(neighbour.entryId)) {
      const seen = ranked.get(ref.id);
      if (seen) seen.score += neighbour.similarity;
      else ranked.set(ref.id, { ref, score: neighbour.similarity, order: order++ });
    }
  }
  if (ranked.size === 0) return null;
  const concepts = [...ranked.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order || (a.ref.name < b.ref.name ? -1 : 1))
    .slice(0, CONTEXT_CONCEPTS_MAX);
  const lines = concepts.map(({ ref }) => `- ${oneLine(ref.type)}: ${oneLine(ref.name)}`);
  return [
    CONTEXT_HEADING,
    "=".repeat(CONTEXT_HEADING.length),
    "These concepts are already in the knowledge graph, taken from the entries most similar to the document above.",
    "When the document mentions one of them, extract it under exactly this type and name instead of a variant of the name.",
    "Never extract a listed concept the document does not mention.",
    ...lines
  ].join("\n");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The document a Pass 2 prompt extracts from (after its last `DOCUMENT` header), or null. */
export function documentOf(user: string): string | null {
  const at = user.lastIndexOf(DOCUMENT_MARKER);
  return at < 0 ? null : user.slice(at + DOCUMENT_MARKER.length);
}

/** Whether `document` is the mirror file `mirror` or a window of it. */
export function documentMatches(document: string, mirror: string): boolean {
  const doc = document.trim();
  if (doc === "") return false;
  if (doc === mirror.trim()) return true;
  return mirror.includes(doc.slice(0, MATCH_PREFIX_CHARS));
}

/**
 * Finds the entry a Pass 2 prompt is for among the mirror files (read once, again on a miss: an
 * entry saved or edited since). Null when none or more than one matches.
 */
export class EntryDocumentLocator {
  private mirrors: Map<string, string> | null = null;

  constructor(private readonly store: Pick<KnowledgeStorePort, "listMeta" | "mykgInputDir">) {}

  async entryOf(user: string): Promise<string | null> {
    const document = documentOf(user);
    if (document === null) return null;
    const fresh = this.mirrors === null;
    const found = this.find(document, this.mirrors ?? (await this.load()));
    if (found !== undefined || fresh) return found ?? null;
    return this.find(document, await this.load()) ?? null;
  }

  /** The mirror text of these entries (unreadable ones absent). */
  async mirrorsOf(ids: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of ids) {
      const text = await readFile(join(this.store.mykgInputDir, `${id}.md`), "utf8").catch(() => null);
      if (text !== null) out.set(id, text);
    }
    return out;
  }

  /** `undefined`: no match; `null`: ambiguous. */
  private find(document: string, mirrors: ReadonlyMap<string, string>): string | null | undefined {
    const exact = document.trim();
    for (const [id, text] of mirrors) if (text.trim() === exact) return id;
    let hit: string | undefined;
    for (const [id, text] of mirrors) {
      if (!documentMatches(document, text)) continue;
      if (hit !== undefined) return null;
      hit = id;
    }
    return hit;
  }

  private async load(): Promise<Map<string, string>> {
    this.mirrors = await this.mirrorsOf(this.store.listMeta().map((meta) => meta.id));
    return this.mirrors;
  }
}

/** The broker's `contextFor` for one run: the block for Pass 2 tasks whose entry is found, else null. */
export function linkContextProvider(
  store: Pick<KnowledgeStorePort, "listMeta" | "mykgInputDir">,
  view: KnowledgeLinkGraphView
): (envelope: InboxTaskEnvelope) => Promise<string | null> {
  const locator = new EntryDocumentLocator(store);
  return async (envelope) => {
    if (!CONTEXT_STEPS.has(envelope.step) || !contextReady(view)) return null;
    const entryId = await locator.entryOf(envelope.user);
    return entryId ? neighbourContextBlock(entryId, view) : null;
  };
}
