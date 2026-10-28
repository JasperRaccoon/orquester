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

  /** Whether the document `key` has the (tokenized) term in any field. */
  contains(key: string, term: string): boolean {
    return this.postings.get(term)?.has(key) ?? false;
  }

  /** Whether any document has the (tokenized) term. */
  has(term: string): boolean {
    return this.postings.has(term);
  }

  /** How many documents have the (tokenized) term. */
  documentFrequency(term: string): number {
    return this.postings.get(term)?.size ?? 0;
  }

  /** How many documents are indexed. */
  size(): number {
    return this.lengths.size;
  }

  /** The documents that have every one of the (tokenized) terms; none for no terms. */
  keysWithAll(terms: readonly string[]): string[] {
    const lists = [...new Set(terms)].map((term) => this.postings.get(term));
    if (lists.length === 0 || lists.some((list) => list === undefined)) return [];
    const [first, ...rest] = (lists as Map<string, number>[]).sort((x, y) => x.size - y.size);
    return [...first!.keys()].filter((key) => rest.every((list) => list.has(key)));
  }

  /** The term's inverse document frequency as `search` weighs it (0 for a term no document has). */
  idf(term: string): number {
    const n = this.lengths.size;
    const df = this.postings.get(term)?.size ?? 0;
    return df === 0 ? 0 : Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

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

  /**
   * The best documents for the query. A query term may be a group of alternatives (its forms and
   * synonyms: "phone", "iphone", "device"): a document scores the best of them, once per group.
   */
  search(queryTerms: readonly (string | readonly string[])[], accept: (key: string) => boolean, limit: number): Bm25Hit[] {
    const n = this.lengths.size;
    if (n === 0 || queryTerms.length === 0 || limit <= 0) return [];
    const avg = this.totalLength / n || 1;
    const scores = new Map<string, number>();
    const accepted = new Map<string, boolean>();
    const seen = new Set<string>();
    for (const group of queryTerms) {
      const alternatives = [...new Set(typeof group === "string" ? [group] : group)];
      const key0 = alternatives.join("\u0000");
      if (seen.has(key0)) continue;
      seen.add(key0);
      const best = new Map<string, number>();
      for (const term of alternatives) {
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
          const score = (idf * freq * (K1 + 1)) / norm;
          if (score > (best.get(key) ?? 0)) best.set(key, score);
        }
      }
      for (const [key, score] of best) scores.set(key, (scores.get(key) ?? 0) + score);
    }
    return [...scores]
      .map(([key, score]) => ({ key, score }))
      .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1))
      .slice(0, limit);
  }
}
