/**
 * Whether two entries are near-copies of each other (a repost, a lightly edited copy), by their
 * text: the Jaccard resemblance of their word 3-shingles. Meaning alone cannot tell a repost from
 * another guide on the same topic: multilingual-e5 scores two different TikTok setup guides 0.95,
 * as close as a repost. Possible duplicates and near-duplicates on save need both.
 *
 * Calibrated on the retrieval eval corpus (its two reposts: 0.63 and 0.71; any other two entries
 * at most 0.02) and on 126 real entries (2,154 pairs at cosine ≥ 0.90, none a repost: at most 0.24,
 * a hub that quotes a claims audit at length). 0.45 sits between them.
 */

/** Words per shingle. */
const SHINGLE_WORDS = 3;
/** The resemblance from which two texts are near-copies. */
export const NEAR_COPY_MIN_RESEMBLANCE = 0.45;

/** A text's word 3-shingles: lowercased, accents and punctuation aside (a text under 3 words is one shingle). */
export function shingles(text: string): Set<string> {
  const words = text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const out = new Set<string>();
  if (words.length > 0 && words.length < SHINGLE_WORDS) out.add(words.join(" "));
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i += 1) out.add(words.slice(i, i + SHINGLE_WORDS).join(" "));
  return out;
}

/** |A ∩ B| / |A ∪ B| of two shingle sets (0 when both are empty). */
export function resemblance(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const shingle of small) if (large.has(shingle)) shared += 1;
  return shared / (a.size + b.size - shared);
}
