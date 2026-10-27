/**
 * Knowledge Graph linking — automatic re-linking (phase 2 spec, "Automatic re-linking", "Link gaps").
 *
 * Entries linked before neighbour context existed (frontmatter `linkContext` absent or below
 * {@link LINK_CONTEXT_VERSION}) and the entries of link gaps (pairs very close in meaning that share
 * no concept, `search/gaps.ts`) are linked again, with context, through the normal run cadence:
 *
 * - Only while no save waits: a run with pending entries links those (plus the batch in flux, below);
 *   a run with none takes up to {@link RELINK_BATCH_MAX} backlog entries (`update` mode). Re-linked
 *   entries are not new content: they never count toward schema growth.
 * - Only while neighbour context can be built (an embedder is loaded): re-linking without it would
 *   buy nothing.
 * - The order: the batch in flux (`prepared`), then gap-queued entries, then outdated ones, oldest
 *   save first.
 *
 * myKG would not re-extract an unchanged entry, and would answer it from its cache if it did, so
 * before the child of a run with a batch is spawned ({@link prepareRelinkBatch}):
 * 1. the entries' keys are dropped from `file_manifest.json` and the committed copy
 *    (`mykg-files.ts` `dropManifestEntries`): myKG's `--update` sees them as new, evicts their shards
 *    (per-file and `pass2_raw_batches`) and extracts them again;
 * 2. their cached Pass 2 answers are removed (`inbox.ts` `clearAnsweredTasks`, each task's document
 *    matched to exactly one entry, `context.ts`): myKG asks again under the same task id, and the
 *    worker's view of that task
 *    carries the context. myKG's prompt is unchanged, so this is the only way the new prompt is used.
 * Step 2 runs once per entry (`prepared`, persisted before the spawn): a resumed or retried run
 * keeps the answers it already got WITH context. Step 1 runs every time (idempotent). An entry
 * leaves `prepared` once a run that succeeded gave it a verdict.
 *
 * Resumable and idempotent: the backlog is read from the entries themselves; the run record keeps
 * its batch (`relinkEntryIds`); pauses are the run queue's own (plugin off, not installed, usage
 * limit, no account, error retry).
 */

import type { KnowledgeEntryMeta } from "@orquester/api";
import type { KnowledgeRelinkStateRecord } from "@orquester/config";
import type { KnowledgeVectorIndex } from "../ports.ts";
import { findLinkGaps } from "../search/gaps.ts";
import { documentOf, LINK_CONTEXT_VERSION } from "./context.ts";
import { clearAnsweredTasks } from "./inbox.ts";
import { dropManifestEntries, type MykgSessionPaths } from "./mykg-files.ts";

export { LINK_CONTEXT_VERSION };

/** Entries re-linked by one run at most. */
export const RELINK_BATCH_MAX = 25;
/** Link-gap pairs considered after a graph load, closest first. */
export const LINK_GAPS_MAX = 200;

export interface RelinkStore {
  listMeta(): readonly KnowledgeEntryMeta[];
  getMeta(id: string): KnowledgeEntryMeta | null;
  linkContext(id: string): number | null;
}

/** Linked with an older (or no) context version. */
export function isOutdated(store: RelinkStore, meta: KnowledgeEntryMeta): boolean {
  return meta.linkState === "linked" && (store.linkContext(meta.id) ?? 0) < LINK_CONTEXT_VERSION;
}

/**
 * Entries still to re-link, in the order they are taken (see the module header). `exclude`: the
 * pending entries (a save's run links them anyway). `candidates`: whether new entries may join
 * (false while context cannot be built: only the batch in flux is kept).
 */
export function relinkBacklog(relink: KnowledgeRelinkStateRecord, store: RelinkStore, exclude: ReadonlySet<string>, candidates: boolean): string[] {
  const out = new Set<string>();
  for (const id of relink.prepared) if (store.getMeta(id) && !exclude.has(id)) out.add(id);
  if (!candidates) return [...out];
  for (const id of relink.gapQueue) {
    const meta = store.getMeta(id);
    if (meta && meta.linkState === "linked" && !exclude.has(id)) out.add(id);
  }
  const outdated = store
    .listMeta()
    .filter((meta) => !exclude.has(meta.id) && isOutdated(store, meta))
    .sort((a, b) => (a.savedAt < b.savedAt ? -1 : a.savedAt > b.savedAt ? 1 : a.id < b.id ? -1 : 1));
  for (const meta of outdated) out.add(meta.id);
  return [...out];
}

/** The next run's batch: everything in flux, then the backlog up to {@link RELINK_BATCH_MAX}. */
export function pickRelinkBatch(relink: KnowledgeRelinkStateRecord, backlog: readonly string[], withPending: boolean): string[] {
  const prepared = new Set(relink.prepared);
  const inFlux = backlog.filter((id) => prepared.has(id));
  // A save's run carries only the batch in flux (myKG re-extracts it anyway): saves are served first.
  if (withPending) return inFlux;
  const rest = backlog.filter((id) => !prepared.has(id));
  return [...inFlux, ...rest.slice(0, Math.max(0, RELINK_BATCH_MAX - inFlux.length))];
}

/** Status `relink`: null when nothing is left. */
export function relinkStatus(relink: KnowledgeRelinkStateRecord, pending: number): { pending: number; done: number; total: number } | null {
  return pending === 0 ? null : { pending, done: relink.done, total: pending + relink.done };
}

/**
 * A successful run's verdicts: `settled` entries (linked or failed) leave the gap queue and the batch
 * in flux; the batch's settled entries count as done. Ids no longer stored are dropped everywhere.
 */
export function settleRelink(relink: KnowledgeRelinkStateRecord, settled: readonly string[], batch: readonly string[], exists: (id: string) => boolean): void {
  const gone = new Set(settled);
  const inBatch = new Set(batch);
  relink.done += settled.filter((id) => inBatch.has(id)).length;
  relink.gapQueue = relink.gapQueue.filter((id) => !gone.has(id) && exists(id));
  relink.prepared = relink.prepared.filter((id) => !gone.has(id) && exists(id));
  for (const key of Object.keys(relink.gapPairs)) {
    const [a, b] = key.split(" ");
    if (!a || !b || !exists(a) || !exists(b)) delete relink.gapPairs[key];
  }
}

/** Nothing is left: the next wave counts from zero. */
export function resetRelinkWave(relink: KnowledgeRelinkStateRecord, backlog: number): void {
  if (backlog === 0) relink.done = 0;
}

export interface QueueLinkGapsOptions {
  /** Linked entries (all of them: re-linking is not scoped). */
  ids: readonly string[];
  index: KnowledgeVectorIndex;
  conceptsOf: (entryId: string) => readonly string[];
  hashOf: (entryId: string) => string | null;
  /** The model's `strong` threshold. */
  minimum: number;
}

/**
 * Link gaps after a graph load: both entries of each NEW pair join the gap queue once. A pair is
 * recorded with both content hashes, so it is queued again only after one of them is edited.
 * Answers the entries newly queued.
 */
export async function queueLinkGaps(relink: KnowledgeRelinkStateRecord, options: QueueLinkGapsOptions): Promise<string[]> {
  // A pair already recorded at both entries' current hashes is left out inside the scan, so the
  // limit counts new pairs only (else the queue would stop growing after the first LINK_GAPS_MAX).
  const recorded = (a: string, b: string): boolean => {
    const hashA = options.hashOf(a);
    const hashB = options.hashOf(b);
    return hashA !== null && hashB !== null && relink.gapPairs[`${a} ${b}`] === `${hashA} ${hashB}`;
  };
  const pairs = await findLinkGaps({ ids: options.ids, index: options.index, conceptsOf: options.conceptsOf, minimum: options.minimum, limit: LINK_GAPS_MAX, exclude: recorded });
  const queued = new Set(relink.gapQueue);
  const added: string[] = [];
  for (const pair of pairs) {
    const hashA = options.hashOf(pair.a);
    const hashB = options.hashOf(pair.b);
    if (!hashA || !hashB) continue;
    const key = `${pair.a} ${pair.b}`;
    const hashes = `${hashA} ${hashB}`;
    if (relink.gapPairs[key] === hashes) continue;
    relink.gapPairs[key] = hashes;
    for (const id of [pair.a, pair.b]) {
      if (queued.has(id)) continue;
      queued.add(id);
      added.push(id);
    }
  }
  relink.gapQueue = [...queued];
  return added;
}

/**
 * Before the child of a run with a re-link batch starts (see the module header): drops the batch's
 * manifest keys (always) and clears the cached Pass 2 answers whose document `fresh` claims (one of
 * the entries not yet `prepared`: the document located to exactly that entry, `context.ts`
 * `EntryDocumentLocator.locate`; null: none). The caller records them as `prepared` and persists
 * that before spawning. Answers the task ids cleared.
 */
export async function prepareRelinkBatch(paths: MykgSessionPaths, batch: readonly string[], fresh: ((document: string) => boolean) | null): Promise<string[]> {
  await dropManifestEntries(paths, batch);
  if (!fresh) return [];
  return clearAnsweredTasks(paths.intermediate, (envelope) => {
    if (envelope.step !== "pass2") return false;
    const document = documentOf(envelope.user);
    return document !== null && fresh(document);
  });
}
