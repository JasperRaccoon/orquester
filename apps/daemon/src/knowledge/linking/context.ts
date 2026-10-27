/**
 * Knowledge Graph linking — neighbour context for Pass 2 (phase 2 spec, "Neighbour context").
 *
 * myKG extracts each entry on its own (one Pass 2 task per entry, `batch_per_file`), so it never
 * sees what similar entries already said and names the same thing in slightly different ways. A
 * worker is therefore shown, after myKG's prompt, a block naming up to {@link CONTEXT_CONCEPTS_MAX}
 * concepts of the entry's {@link CONTEXT_NEIGHBOURS} nearest neighbours, with the instruction to reuse
 * a listed name only for the same thing at the same specificity (a different number, duration,
 * quantity, tool or condition keeps a concept of its own) and never to extract a listed concept the
 * document does not mention. It is added by `InboxBroker`'s view only: the task file, its id and myKG's answer cache
 * are untouched (the prompt overlay, whose digest forces a reinstall, is not changed).
 *
 * Neighbours: entries with vectors from the current model AND at least one concept (one without
 * concepts has nothing to offer), at cosine ≥ the model's `minimum` (an unrelated entry's concepts
 * would only cost tokens), closest first by entry vector. Concepts: ranked by the summed similarity
 * of the neighbours that have them (shared by several close entries first), then by the closest
 * neighbour's order, then by name.
 *
 * The entry a task is for: myKG's Pass 2 prompt ends with `DOCUMENT\n========\n<text>` (`pass2.py`
 * `_build_extraction_prompt`; a retry prefixes the same prompt). The label (`pass2 chunk <batch>`)
 * does not name the file, so the document is matched against the mirror files, exactly
 * (`locateDocument`): the whole mirror, or — for an entry longer than one chunk — its chunk windows
 * as myKG cuts them (`chunker.py` `chunk_file`: {@link MYKG_CHUNK_TOKENS}-token windows,
 * overlapping, the first at the mirror's start; `pass2_batch.py` joins a file's windows that fit one
 * batch with a blank line). Text one entry quotes from another never makes it that entry's.
 *
 * Search is reached only through {@link KnowledgeLinkGraphView}, injected by `knowledge/service.ts`.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { KnowledgeConceptRef } from "@orquester/api";
import type { KnowledgeStorePort, KnowledgeVectorIndex } from "../ports.ts";
import type { InboxTaskEnvelope } from "./inbox.ts";
import { MYKG_CHUNK_TOKENS } from "./mykg-config.ts";

/**
 * The linking-context version recorded per entry (`KnowledgeStorePort.setLinkContext`); bump it when
 * the context changes: every entry linked at an older one is re-linked once (`relink.ts`). 2: a
 * listed name is reused only at the same specificity; a different number, duration, quantity, tool
 * or condition keeps a concept of its own (version 1 folded "warm it up for 48 hours" into a listed
 * generic warm-up whose description said 1-2 days).
 */
export const LINK_CONTEXT_VERSION = 2;
export const CONTEXT_NEIGHBOURS = 5;
export const CONTEXT_CONCEPTS_MAX = 40;
export const CONTEXT_HEADING = "KNOWN CONCEPTS FROM SIMILAR ENTRIES";
/** The steps whose view carries the context. */
export const CONTEXT_STEPS: ReadonlySet<string> = new Set(["pass2"]);

const DOCUMENT_MARKER = "\n\nDOCUMENT\n========\n";
/**
 * The fewest characters (UTF-16 units) a full chunk window holds: {@link MYKG_CHUNK_TOKENS} tokens
 * of at least one UTF-8 byte each, at most 4 bytes (2 units) or 3 bytes (1 unit) per character. A
 * mirror shorter than this is never cut into windows, and every window but a file's last is longer.
 */
export const WINDOW_MIN_CHARS = Math.floor(MYKG_CHUNK_TOKENS / 4);
/** How much of a window's start is looked up in a mirror before it is compared in full. */
const PROBE_CHARS = 64;
/** What a UTF-8 decode puts where a window cut a character in two. */
const REPLACEMENT = 0xfffd;
const SEPARATOR = "\n\n";

/** What linking reads of search and the concept graph (`knowledge/service.ts` builds it). */
export interface KnowledgeLinkGraphView {
  /** The vector index of the moment (entry vectors, the model's thresholds). */
  vectors(): KnowledgeVectorIndex;
  /** The concepts linked to an entry in the loaded graph. */
  conceptsOf(entryId: string): readonly KnowledgeConceptRef[];
  /** Concept ids joined to this one by a `contradicts` edge, either direction. */
  contradicting(conceptId: string): readonly string[];
  /**
   * Moves whenever an entry's concepts may have changed (`KnowledgeGraph.contentRevision`); absent:
   * unknown (every link-gap scan runs).
   */
  graphRevision?(): number;
  /**
   * Resolves once the vector index has loaded its cache and finished embedding (a start, or a new
   * embedder): linking looks again then, since re-linking and pair checks need entry vectors.
   * Absent: linking only looks again on its own changes.
   */
  vectorsSettled?(): Promise<void>;
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
    "Reuse a listed type and name only when the document states the same thing at the same specificity: then extract it under exactly that type and name instead of a variant of the name.",
    'Keep a concept of its own, named for what the document says, when the document states a different number, duration, quantity, tool or condition, or a more specific or more general version ("Warm up the account for 48 hours" is not "Post the first video after 1-2 days").',
    "Never reuse a listed name whose claim differs from the document's, and never extract a listed concept the document does not mention.",
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

/** Whether `document` is the mirror file `mirror`, or windows of it as myKG cuts a long entry (see the header). */
export function documentMatches(document: string, mirror: string): boolean {
  const doc = document.trim();
  if (doc === "") return false;
  const text = mirror.trim();
  return doc === text || isWindowsOf(document.trimEnd(), text);
}

/**
 * Whether `doc` is one or more consecutive chunk windows of `text` (a trimmed mirror at least a
 * window long), joined by a blank line: each window is found in `text` whole, starting inside the
 * one before (they overlap), and is a full window (at least {@link WINDOW_MIN_CHARS}) unless it is
 * the mirror's last (it ends where the mirror does). A window cut inside a character carries U+FFFD
 * at its edges, which is skipped.
 */
function isWindowsOf(doc: string, text: string): boolean {
  if (text.length < WINDOW_MIN_CHARS) return false;
  let pos = 0;
  let previous: { start: number; end: number } | null = null;
  while (pos < doc.length) {
    while (doc.charCodeAt(pos) === REPLACEMENT) pos += 1;
    const probe = doc.slice(pos, pos + PROBE_CHARS);
    if (probe.length === 0) return previous !== null;
    // The longest run of `doc` from `pos` that `text` holds, starting after the previous window's start.
    let start = -1;
    let run = 0;
    for (let at = text.indexOf(probe, previous ? previous.start + 1 : 0); at >= 0; at = text.indexOf(probe, at + 1)) {
      let n = probe.length;
      while (pos + n < doc.length && at + n < text.length && doc.charCodeAt(pos + n) === text.charCodeAt(at + n)) n += 1;
      if (n > run) {
        start = at;
        run = n;
      }
      if (pos + n === doc.length) break;
    }
    if (start < 0) return false;
    // Where this window ends: the document's end, or the blank line before the next window (the run
    // may have gone past it where the mirror has a blank line too).
    let end = pos + run;
    let next: number;
    if (end === doc.length) next = end;
    else {
      let cut = end;
      while (doc.charCodeAt(cut) === REPLACEMENT) cut += 1;
      const separator = doc.startsWith(SEPARATOR, cut) ? cut : doc.lastIndexOf(SEPARATOR, end);
      if (separator <= pos) return false;
      if (separator < end) end = separator;
      next = separator + SEPARATOR.length;
    }
    const length = end - pos;
    const window = { start, end: start + length };
    if (previous && (window.start <= previous.start || window.start > previous.end)) return false;
    const last = next >= doc.length;
    if (length < WINDOW_MIN_CHARS && !(last && window.end === text.length)) return false;
    previous = window;
    pos = next;
  }
  return previous !== null;
}

/** The mirrors as a locator reads them: by whole (trimmed) text, and the ones long enough to have windows. */
interface MirrorIndex {
  /** Trimmed mirror text: its entry (null: two entries have that text). */
  exact: Map<string, string | null>;
  /** Mirrors at least a window long, trimmed. */
  long: { id: string; text: string }[];
}

/**
 * The entry `document` is from (`undefined`: none; `null`: more than one): an entry whose whole
 * mirror it is comes first (so another entry quoting it never claims it), else the one entry it is
 * windows of.
 */
function locateDocument(document: string, index: MirrorIndex): string | null | undefined {
  const exact = document.trim();
  if (exact === "") return undefined;
  if (index.exact.has(exact)) return index.exact.get(exact)!;
  const doc = document.trimEnd();
  let hit: string | undefined;
  for (const { id, text } of index.long) {
    if (!isWindowsOf(doc, text)) continue;
    if (hit !== undefined) return null;
    hit = id;
  }
  return hit;
}

/**
 * Finds the entry a Pass 2 prompt (or its document) is for among the mirror files
 * (`locateDocument`). The mirrors are read once, and again at most once on a miss (an entry saved
 * since): one locator serves one run. Null when none or more than one matches.
 */
export class EntryDocumentLocator {
  private index: MirrorIndex | null = null;
  private reloaded = false;

  constructor(private readonly store: Pick<KnowledgeStorePort, "listMeta" | "mykgInputDir">) {}

  async entryOf(user: string): Promise<string | null> {
    const document = documentOf(user);
    if (document === null) return null;
    const found = locateDocument(document, await this.load());
    if (found !== undefined || this.reloaded) return found ?? null;
    this.reloaded = true;
    this.index = await this.read();
    return locateDocument(document, this.index) ?? null;
  }

  /** Reads the mirrors (on first use only). */
  async load(): Promise<MirrorIndex> {
    this.index ??= await this.read();
    return this.index;
  }

  /** The entry a document is from, over the mirrors {@link load} read; null before that, when none or ambiguous. */
  locate(document: string): string | null {
    return this.index ? (locateDocument(document, this.index) ?? null) : null;
  }

  private async read(): Promise<MirrorIndex> {
    const index: MirrorIndex = { exact: new Map(), long: [] };
    for (const { id } of this.store.listMeta()) {
      const raw = await readFile(join(this.store.mykgInputDir, `${id}.md`), "utf8").catch(() => null);
      if (raw === null) continue;
      const text = raw.trim();
      index.exact.set(text, index.exact.has(text) ? null : id);
      if (text.length >= WINDOW_MIN_CHARS) index.long.push({ id, text });
    }
    return index;
  }
}

/**
 * The broker's `contextFor` for one run: the block for Pass 2 tasks whose entry is found, else null.
 * `onContext`: called with each entry a task was shown a block for (only those record
 * {@link LINK_CONTEXT_VERSION} when the run links them).
 */
export function linkContextProvider(
  store: Pick<KnowledgeStorePort, "listMeta" | "mykgInputDir">,
  view: KnowledgeLinkGraphView,
  onContext?: (entryId: string) => void
): (envelope: InboxTaskEnvelope) => Promise<string | null> {
  const locator = new EntryDocumentLocator(store);
  // Once per task: a task handed out again (a released lease) gets the same block.
  const blocks = new Map<string, Promise<string | null>>();
  const blockFor = async (envelope: InboxTaskEnvelope): Promise<string | null> => {
    const entryId = await locator.entryOf(envelope.user);
    const block = entryId ? neighbourContextBlock(entryId, view) : null;
    if (entryId && block !== null) onContext?.(entryId);
    return block;
  };
  return (envelope) => {
    if (!CONTEXT_STEPS.has(envelope.step) || !contextReady(view)) return Promise.resolve(null);
    let block = blocks.get(envelope.task_id);
    if (!block) {
      block = blockFor(envelope);
      blocks.set(envelope.task_id, block);
      // A failure is not remembered: the next lease tries again.
      block.catch(() => blocks.delete(envelope.task_id));
    }
    return block;
  };
}
