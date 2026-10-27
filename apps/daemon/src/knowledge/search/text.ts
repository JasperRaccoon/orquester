/**
 * Text helpers shared by BM25, chunking and snippets. Deterministic and dependency-free.
 */

// English and Spanish function words (the saved material mixes both).
const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its " +
    "just me more most my no not of on or our out so than that the their them then there these they this those to too " +
    "up us was we were what when where which who why will with would you your " +
    "al como con de del el en es esta este la las lo los mas me mi muy no o para pero por que se sin su sus te tu un una " +
    "uno y ya"
  ).split(" ")
);

/** Lowercase, accents folded, split on anything but letters and digits; stopwords and 1-letter words dropped; light plural folding. */
export function tokenize(text: string): string[] {
  const words = text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  for (const word of words) {
    if (word.length < 2 && !/\d/.test(word)) continue;
    if (STOPWORDS.has(word)) continue;
    out.push(stem(word));
  }
  return out;
}

function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us") && !word.endsWith("is")) {
    return word.slice(0, -1);
  }
  return word;
}

/** A chunk of an entry body, as character offsets into it. */
export interface TextSpan {
  start: number;
  end: number;
}

/** Bumped whenever {@link chunkBody} changes, so cached vectors are recomputed. */
export const CHUNKER_VERSION = "words-180-40-v1";
/** ~256 MiniLM tokens of English prose. */
const CHUNK_WORDS = 180;
const CHUNK_OVERLAP = 40;

/** Overlapping word windows over the body (one span for a short body). */
export function chunkBody(body: string): TextSpan[] {
  const words = [...body.matchAll(/\S+/g)];
  if (words.length <= CHUNK_WORDS) return [{ start: 0, end: body.length }];
  const spans: TextSpan[] = [];
  for (let first = 0; first < words.length; first += CHUNK_WORDS - CHUNK_OVERLAP) {
    const last = Math.min(words.length, first + CHUNK_WORDS) - 1;
    const end = words[last]!.index! + words[last]![0].length;
    spans.push({ start: words[first]!.index!, end });
    if (last === words.length - 1) break;
  }
  return spans;
}

const SNIPPET_MAX = 240;

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cut(text: string, max = SNIPPET_MAX): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const space = slice.lastIndexOf(" ");
  return `${(space > max * 0.6 ? slice.slice(0, space) : slice).trimEnd()}…`;
}

/** Sentence-ish pieces: lines, then sentence ends. */
function passages(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    for (const piece of line.split(/(?<=[.!?])\s+(?=\S)/)) {
      const clean = squash(piece);
      if (clean.length > 0) out.push(clean);
    }
  }
  return out;
}

/**
 * One or two lines from `body` (inside `span` when given): the passage sharing the most query
 * terms, followed by the next one while it fits; the span's opening otherwise.
 */
export function bestSnippet(body: string, queryTerms: readonly string[], span?: TextSpan): string {
  const region = span ? body.slice(span.start, span.end) : body;
  const pieces = passages(region);
  if (pieces.length === 0) return "";
  const wanted = new Set(queryTerms);
  let best = 0;
  let bestScore = 0;
  if (wanted.size > 0) {
    pieces.forEach((piece, index) => {
      const seen = new Set(tokenize(piece).filter((t) => wanted.has(t)));
      if (seen.size > bestScore) {
        bestScore = seen.size;
        best = index;
      }
    });
  }
  let snippet = pieces[best]!;
  const next = pieces[best + 1];
  if (next && snippet.length + 1 + next.length <= SNIPPET_MAX) snippet = `${snippet} ${next}`;
  return cut(snippet);
}
