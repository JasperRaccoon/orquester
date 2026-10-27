/**
 * An in-memory {@link KnowledgeVectorIndex} for tests: chunk vectors set by hand, the port's
 * semantics (accept before score, L2-normalized entry means, a generation bumped on every change),
 * with generation changes matching the production port.
 */

import type { KnowledgeVectorHit, KnowledgeVectorIndex, KnowledgeVectorThresholds } from "../ports.ts";

export const FAKE_THRESHOLDS: KnowledgeVectorThresholds = Object.freeze({ minimum: 0.3, good: 0.5, strong: 0.7, duplicate: 0.9 });

function normalize(vector: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(vector);
  let norm = 0;
  for (const x of out) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i += 1) out[i]! /= norm;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i]! * b[i]!;
  return sum;
}

/** The unit vector along `axis` in `dims` dimensions. */
export function axis(dims: number, at: number): number[] {
  const v = new Array<number>(dims).fill(0);
  v[at] = 1;
  return v;
}

/**
 * A unit vector with cosine `cos` to the base axis, leaning toward `side` (another axis). Two
 * vectors around the same base with different sides have cosine `cosA · cosB`.
 */
export function around(dims: number, base: number, side: number, cos: number): number[] {
  const v = new Array<number>(dims).fill(0);
  v[base] = cos;
  v[side] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return v;
}

export class FakeVectorIndex implements KnowledgeVectorIndex {
  model: string | null = "fake/model";
  limits: KnowledgeVectorThresholds | null = FAKE_THRESHOLDS;
  /** What `embedQuery` answers (null: embeddings unavailable). */
  queryVector: ((text: string) => Float32Array | null) | null = null;
  private readonly chunks = new Map<string, Float32Array[]>();
  private readonly means = new Map<string, Float32Array>();
  private gen = 0;

  /** Set an entry's chunk vectors (each normalized); bumps the generation. */
  set(entryId: string, ...chunkVectors: ArrayLike<number>[]): this {
    this.chunks.set(entryId, chunkVectors.map(normalize));
    this.means.delete(entryId);
    this.gen += 1;
    return this;
  }

  remove(entryId: string): void {
    if (this.chunks.delete(entryId)) {
      this.means.delete(entryId);
      this.gen += 1;
    }
  }

  modelId(): string | null {
    return this.model;
  }

  thresholds(): KnowledgeVectorThresholds | null {
    return this.model ? this.limits : null;
  }

  async embedQuery(text: string): Promise<Float32Array | null> {
    return this.model && this.queryVector ? this.queryVector(text) : null;
  }

  search(query: Float32Array, accept: (entryId: string) => boolean, limit: number, minimum?: number): KnowledgeVectorHit[] {
    const floor = minimum ?? this.limits?.minimum ?? 0;
    const hits: KnowledgeVectorHit[] = [];
    for (const [entryId, vectors] of this.chunks) {
      if (!accept(entryId)) continue;
      let best = -Infinity;
      let chunk = 0;
      vectors.forEach((vector, i) => {
        const score = dot(query, vector);
        if (score > best) {
          best = score;
          chunk = i;
        }
      });
      if (best < floor) continue;
      const hit: KnowledgeVectorHit = { entryId, score: best, chunk, chunks: vectors.length, span: { start: chunk * 100, end: chunk * 100 + 100 } };
      if (vectors.length > 1) hit.chunkScores = vectors.map((vector, i) => ({ score: dot(query, vector), span: { start: i * 100, end: i * 100 + 100 } }));
      hits.push(hit);
    }
    return hits.sort((a, b) => b.score - a.score || (a.entryId < b.entryId ? -1 : 1)).slice(0, limit);
  }

  entryVector(entryId: string): Float32Array | null {
    if (!this.model) return null;
    const cached = this.means.get(entryId);
    if (cached) return cached;
    const vectors = this.chunks.get(entryId);
    if (!vectors || vectors.length === 0) return null;
    const sum = new Float32Array(vectors[0]!.length);
    for (const vector of vectors) for (let i = 0; i < sum.length; i += 1) sum[i]! += vector[i]!;
    const mean = normalize(sum);
    this.means.set(entryId, mean);
    return mean;
  }

  embeddedIds(): string[] {
    return this.model ? [...this.chunks.keys()] : [];
  }

  generation(): number {
    return this.gen;
  }
}
