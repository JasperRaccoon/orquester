/**
 * The retrieval evaluation harness (retrieval spec P0.4): the evaluation set in an in-memory
 * store behind a real `KnowledgeSearch`, recall@k and MRR over its queries, and the calibration
 * data the model's similarity thresholds are chosen from (`install/pins.ts`). Test support: it
 * runs under `node --test` (eval.test.ts), never in the daemon.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgeSearchRequest } from "@orquester/api";
import type { KnowledgeEmbedder } from "../embedder.ts";
import { KnowledgeGraph } from "../graph.ts";
import { KnowledgeSearch } from "../search.ts";
import { FakeEmbedderSource, FakeStore, silentLogger } from "../test-fakes.ts";
import { chunkBody, embeddingHeader, embeddingPassage } from "../text.ts";
import type { EvalEntry, EvalQuery } from "./corpus.ts";

/** Entry ids, best first, for a query. */
export type EvalRanker = (query: string) => Promise<readonly string[]>;

export interface EvalQueryResult {
  query: EvalQuery;
  /** The ranked entry ids the ranker returned. */
  ranked: readonly string[];
  /** Share of the expected entries in the top k. */
  recall: number;
  /** 1 / rank of the first expected entry (0 when none was returned). */
  reciprocalRank: number;
}

export interface EvalReport {
  k: number;
  /** Mean recall@k over the queries. */
  recallAtK: number;
  /** Mean reciprocal rank over the queries. */
  mrr: number;
  results: EvalQueryResult[];
}

/** recall@k and MRR of `rank` over `queries`. */
export async function evaluate(rank: EvalRanker, queries: readonly EvalQuery[], k = 5): Promise<EvalReport> {
  const results: EvalQueryResult[] = [];
  for (const query of queries) {
    const ranked = await rank(query.text);
    const top = new Set(ranked.slice(0, k));
    const found = query.expected.filter((id) => top.has(id)).length;
    const first = ranked.findIndex((id) => query.expected.includes(id));
    results.push({ query, ranked, recall: query.expected.length > 0 ? found / query.expected.length : 1, reciprocalRank: first < 0 ? 0 : 1 / (first + 1) });
  }
  const mean = (values: number[]) => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length);
  return { k, recallAtK: mean(results.map((r) => r.recall)), mrr: mean(results.map((r) => r.reciprocalRank)), results };
}

export interface EvalSearch {
  /** Entry hits of a search (visibility "all"), best first, up to `limit`. */
  rank(query: string, limit?: number): Promise<string[]>;
  /** Entry hits of any search request (visibility "all"), best first. */
  entries(request: KnowledgeSearchRequest): Promise<string[]>;
  close(): Promise<void>;
}

/**
 * The entries in a store behind a `KnowledgeSearch` over `embedder` (null: text only), with every
 * entry indexed and embedded before it returns.
 */
export async function openEvalSearch(entries: readonly EvalEntry[], embedder: KnowledgeEmbedder | null): Promise<EvalSearch> {
  const indexDir = await mkdtemp(join(tmpdir(), "kg-eval-"));
  const store = new FakeStore();
  for (const entry of entries) {
    store.put(entry.id, entry.body, [], { title: entry.title, author: entry.author, handle: entry.handle, kind: entry.kind }, true);
  }
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  const search = new KnowledgeSearch({ store, graph, embedders: new FakeEmbedderSource(embedder), indexDir, logger: silentLogger() });
  const close = async () => {
    await search.stop();
    await rm(indexDir, { recursive: true, force: true });
  };
  try {
    await search.start();
    await search.idle();
  } catch (error) {
    await close();
    throw error;
  }
  return {
    async rank(query, limit = 10) {
      const response = await search.search({ query, limit }, { kind: "all" });
      return response.hits.flatMap((hit) => (hit.kind === "entry" ? [hit.entry.id] : []));
    },
    async entries(request) {
      const response = await search.search(request, { kind: "all" });
      return response.hits.flatMap((hit) => (hit.kind === "entry" ? [hit.entry.id] : []));
    },
    close
  };
}

/** Five-number summary of a sample. */
export interface Spread {
  n: number;
  min: number;
  p10: number;
  p50: number;
  p90: number;
  max: number;
}

export interface CalibrationReport {
  /** Query → best chunk of an entry that answers it. */
  matched: Spread;
  /** Query → best chunk of an entry that does not. */
  unmatched: Spread;
  /** Query → the best-scoring entry that does not answer it (the hardest negative), per query. */
  hardestUnmatched: Spread;
  /** Entry ↔ entry (L2-normalized mean of chunk vectors): near-copies. */
  duplicates: Spread;
  /** Entry ↔ entry: same topic, not copies. */
  sameTopic: Spread;
  /** Entry ↔ entry: different topics. */
  otherTopic: Spread;
}

function spread(values: number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] ?? Number.NaN;
  return { n: sorted.length, min: sorted[0] ?? Number.NaN, p10: at(0.1), p50: at(0.5), p90: at(0.9), max: sorted.at(-1) ?? Number.NaN };
}

const dot = (a: Float32Array, b: Float32Array) => {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i]! * b[i]!;
  return sum;
};

function meanNormalized(vectors: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(vectors[0]!.length);
  for (const vector of vectors) for (let i = 0; i < out.length; i += 1) out[i]! += vector[i]!;
  const norm = Math.sqrt(dot(out, out)) || 1;
  for (let i = 0; i < out.length; i += 1) out[i]! /= norm;
  return out;
}

/**
 * The cosines the thresholds are calibrated from, embedding exactly as search does once the
 * retrieval spec is wired in: queries as `embed(…, "query")`, every chunk as
 * `embed(embeddingPassage(embeddingHeader(meta), chunk), "passage")`.
 */
export async function calibrationData(embedder: KnowledgeEmbedder, entries: readonly EvalEntry[], queries: readonly EvalQuery[]): Promise<CalibrationReport> {
  const chunkVectors = new Map<string, Float32Array[]>();
  for (const entry of entries) {
    const header = embeddingHeader(entry);
    const passages = chunkBody(entry.body).map((span) => embeddingPassage(header, entry.body.slice(span.start, span.end)));
    chunkVectors.set(entry.id, await embedder.embed(passages, "passage"));
  }
  const queryVectors = await embedder.embed(queries.map((query) => query.text), "query");
  const matched: number[] = [];
  const unmatched: number[] = [];
  const hardest: number[] = [];
  queries.forEach((query, index) => {
    let worst = -1;
    for (const entry of entries) {
      const best = Math.max(...chunkVectors.get(entry.id)!.map((vector) => dot(queryVectors[index]!, vector)));
      if (query.expected.includes(entry.id)) matched.push(best);
      else {
        unmatched.push(best);
        worst = Math.max(worst, best);
      }
    }
    hardest.push(worst);
  });
  const entryVectors = new Map(entries.map((entry) => [entry.id, meanNormalized(chunkVectors.get(entry.id)!)]));
  const duplicates: number[] = [];
  const sameTopic: number[] = [];
  const otherTopic: number[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i]!;
      const b = entries[j]!;
      const cosine = dot(entryVectors.get(a.id)!, entryVectors.get(b.id)!);
      if (a.duplicateOf === b.id || b.duplicateOf === a.id) duplicates.push(cosine);
      else if (a.topic === b.topic) sameTopic.push(cosine);
      else otherTopic.push(cosine);
    }
  }
  return {
    matched: spread(matched),
    unmatched: spread(unmatched),
    hardestUnmatched: spread(hardest),
    duplicates: spread(duplicates),
    sameTopic: spread(sameTopic),
    otherTopic: spread(otherTopic)
  };
}

/** One line per query (rank of the first expected hit, the top 3), for a test's diagnostics. */
export function describeReport(report: EvalReport): string[] {
  return report.results.map((result) => {
    const rank = result.reciprocalRank > 0 ? Math.round(1 / result.reciprocalRank) : "-";
    return `[${result.query.lang}] rank ${rank} recall ${result.recall.toFixed(2)} "${result.query.text}" → ${result.ranked.slice(0, 3).join(", ")}`;
  });
}

export function describeSpread(name: string, s: Spread): string {
  const f = (x: number) => x.toFixed(3);
  return `${name.padEnd(17)} n=${String(s.n).padStart(3)} min ${f(s.min)} p10 ${f(s.p10)} p50 ${f(s.p50)} p90 ${f(s.p90)} max ${f(s.max)}`;
}
