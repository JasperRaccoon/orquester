/** One document field: its tokens and how much a match in it counts. */
export interface Bm25Field {
  tokens: readonly string[];
  weight: number;
}

export interface Bm25Hit {
  key: string;
  score: number;
}

const K1 = 1.2;
const B = 0.75;

/**
 * An incremental BM25 index (field weights scale term frequency, BM25F-style). Keys are opaque
 * strings; `search` takes an `accept` predicate so visibility is applied while scoring, not after
 * truncating.
 */
export class Bm25Index {
  private readonly postings = new Map<string, Map<string, number>>();
  private readonly lengths = new Map<string, number>();
  private readonly terms = new Map<string, string[]>();
  private totalLength = 0;

  add(key: string, fields: readonly Bm25Field[]): void {
    if (this.lengths.has(key)) this.remove(key);
    const tf = new Map<string, number>();
    let length = 0;
    for (const field of fields) {
      for (const token of field.tokens) {
        tf.set(token, (tf.get(token) ?? 0) + field.weight);
        length += field.weight;
      }
    }
    for (const [term, freq] of tf) {
      let posting = this.postings.get(term);
      if (!posting) {
        posting = new Map();
        this.postings.set(term, posting);
      }
      posting.set(key, freq);
    }
    this.lengths.set(key, length);
    this.terms.set(key, [...tf.keys()]);
    this.totalLength += length;
  }

  remove(key: string): void {
    const length = this.lengths.get(key);
    if (length === undefined) return;
    for (const term of this.terms.get(key) ?? []) {
      const posting = this.postings.get(term);
      posting?.delete(key);
      if (posting && posting.size === 0) this.postings.delete(term);
    }
    this.lengths.delete(key);
    this.terms.delete(key);
    this.totalLength -= length;
  }

  search(queryTerms: readonly string[], accept: (key: string) => boolean, limit: number): Bm25Hit[] {
    const n = this.lengths.size;
    if (n === 0 || queryTerms.length === 0 || limit <= 0) return [];
    const avg = this.totalLength / n || 1;
    const scores = new Map<string, number>();
    const accepted = new Map<string, boolean>();
    for (const term of new Set(queryTerms)) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const idf = Math.log(1 + (n - posting.size + 0.5) / (posting.size + 0.5));
      for (const [key, freq] of posting) {
        let ok = accepted.get(key);
        if (ok === undefined) {
          ok = accept(key);
          accepted.set(key, ok);
        }
        if (!ok) continue;
        const norm = freq + K1 * (1 - B + (B * this.lengths.get(key)!) / avg);
        scores.set(key, (scores.get(key) ?? 0) + (idf * freq * (K1 + 1)) / norm);
      }
    }
    return [...scores]
      .map(([key, score]) => ({ key, score }))
      .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1))
      .slice(0, limit);
  }
}
