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

/**
 * Bumped whenever {@link embeddingHeader} or {@link embeddingPassage} changes: part of the vector
 * cache key, so cached vectors are recomputed.
 */
export const EMBEDDING_INPUT_VERSION = "ctx-v2";

/**
 * The most {@link estimateTokens} an {@link embeddingHeader} takes: what e5's 512 leaves beside a
 * chunk's {@link CHUNK_TOKEN_BUDGET} and the passage overhead (two special tokens, "passage: ",
 * the blank line: ~6), so header + prefix + chunk is never truncated.
 */
export const HEADER_TOKEN_BUDGET = 96;
/** A header's byline ("by" author @handle) and kind are cut to these first; the title takes the rest. */
const HEADER_WHO_TOKENS = 24;
const HEADER_KIND_TOKENS = 8;
const HEADER_SEPARATOR = " · ";

/** {@link estimateTokens} of a text: the sum over its whitespace-separated words. */
export function estimateTextTokens(text: string): number {
  let tokens = 0;
  for (const match of text.matchAll(/\S+/g)) tokens += estimateTokens(match[0]);
  return tokens;
}

/** The longest start of `text`, cut on a word or code point boundary, whose estimate is within `budget`. */
function capTokens(text: string, budget: number): string {
  if (estimateTextTokens(text) <= budget) return text;
  let used = 0;
  let end = 0;
  for (const match of text.matchAll(/\S+/g)) {
    const word = match[0];
    const cost = estimateTokens(word);
    if (used + cost <= budget) {
      used += cost;
      end = match.index! + word.length;
      continue;
    }
    // Cut inside the word: its longest start that fits what is left (every character costs at
    // least a quarter token, so no more than 4 a token are tried).
    let prefix = "";
    for (const char of [...word].slice(0, Math.max(0, Math.ceil((budget - used) * 4)))) {
      if (used + estimateTokens(prefix + char) > budget) break;
      prefix += char;
    }
    if (prefix.length > 0) end = match.index! + prefix.length;
    break;
  }
  return text.slice(0, end).trimEnd();
}

/**
 * The context line embedded with every chunk of an entry (retrieval spec, "Contextual chunks"):
 * title, author and handle, kind — so a chunk deep in a long article still carries what the
 * article is. Collections are left out on purpose: relabelling never re-embeds. Capped at
 * {@link HEADER_TOKEN_BUDGET} estimated tokens: a long byline and kind are cut first to a share
 * of it, then the title to what is left.
 */
export function embeddingHeader(meta: { title: string; author: string | null; handle: string | null; kind: string }): string {
  const handle = meta.handle ? `@${meta.handle.trim().replace(/^@+/, "")}` : "";
  const who = capTokens(
    [meta.author?.replace(/\s+/g, " ").trim() ?? "", handle].filter((part) => part.length > 0 && part !== "@").join(" "),
    HEADER_WHO_TOKENS
  );
  const rest = [who ? `by ${who}` : "", capTokens(meta.kind.replace(/\s+/g, " ").trim(), HEADER_KIND_TOKENS)].filter((part) => part.length > 0);
  const restTokens = rest.length > 0 ? estimateTextTokens(HEADER_SEPARATOR + rest.join(HEADER_SEPARATOR)) : 0;
  const title = capTokens(meta.title.replace(/\s+/g, " ").trim(), HEADER_TOKEN_BUDGET - restTokens);
  return [title, ...rest].filter((part) => part.length > 0).join(HEADER_SEPARATOR);
}

/** One chunk as it is embedded: the entry's {@link embeddingHeader}, a blank line, the chunk text. */
export function embeddingPassage(header: string, chunk: string): string {
  return header.length > 0 ? `${header}\n\n${chunk}` : chunk;
}

/** Bumped whenever {@link chunkBody} changes, so cached vectors are recomputed. */
export const CHUNKER_VERSION = "words-180-40-cost410-v2";
/** ~250 multilingual-e5-small tokens of English or Spanish prose. */
const CHUNK_WORDS = 180;
const CHUNK_OVERLAP = 40;
/**
 * The token budget of a chunk's text, by {@link estimateTokens}: e5's 512 less its two special
 * tokens, the "passage: " prefix and the blank line (~6), and {@link HEADER_TOKEN_BUDGET} (96) for
 * the entry's {@link embeddingHeader}, so header + prefix + chunk stays within 512.
 */
export const CHUNK_TOKEN_BUDGET = 410;
/** The overlap's share of the budget (as 40 of 180 words). */
const CHUNK_OVERLAP_BUDGET = Math.floor((CHUNK_TOKEN_BUDGET * CHUNK_OVERLAP) / CHUNK_WORDS);
/** A "word" estimated past this (a CJK sentence, minified JSON, a data URL) is cut into pieces of at most this. */
const PIECE_BUDGET = 48;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LATIN = /\p{Script=Latin}/u;
/** Letters of scripts whose words XLM-R's vocabulary covers well (measured: ≤ 0.3 tokens a character in prose). */
const WELL_COVERED = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}]/u;
/** A plain word: optional opening punctuation, letters (with marks, inner hyphens or apostrophes), optional closing punctuation. */
const PLAIN_WORD = /^([(["'«“¿¡]*)([\p{L}\p{M}][\p{L}\p{M}'’-]*)([.,;:!?)\]"'»”…]*)$/u;

/**
 * An upper estimate of how many multilingual-e5-small (XLM-R SentencePiece) tokens `word` takes,
 * from its characters alone. Measured on the pinned tokenizer: English and Spanish prose ~0.25
 * tokens a character, Cyrillic/Arabic/Devanagari ~0.3, code and URLs ~0.45, JSON ~0.55, base64
 * and hex up to ~0.66, Chinese/Japanese/Korean ~0.55–0.75, mathematical symbols ~1. So: a plain
 * word of a well-covered script costs half a token plus a quarter (Latin) or 0.4 a letter; any
 * other word one token plus 0.7 a letter or digit and 1 for anything else (CJK, punctuation,
 * symbols, emoji, rarer scripts). On the samples measured it never underestimates: prose by
 * ~1.3–1.6×, dense text (hex, base64, emoji, symbols) by ~1.0–1.2×.
 */
export function estimateTokens(word: string): number {
  const plain = PLAIN_WORD.exec(word);
  if (plain && !/\p{Ll}\p{Lu}/u.test(plain[2]!) && !CJK.test(plain[2]!)) {
    let cost = 0.5 + [...plain[1]!].length + [...plain[3]!].length;
    let letters = 0;
    let common = true;
    for (const char of plain[2]!) {
      letters += 1;
      if (/[\p{M}'’-]/u.test(char) || LATIN.test(char)) cost += 0.25;
      else if (WELL_COVERED.test(char)) cost += 0.4;
      else {
        cost += 1;
        common = false;
      }
    }
    // Long or rare-script words, and Latin "words" with too few vowels to be words (ids, hashes,
    // keyboard mashing: XLM-R spells them out), fall through to the dense estimate.
    if (letters <= 24 && common && !consonantRun(plain[2]!)) return cost;
  }
  let cost = 1;
  for (const char of word) cost += denseCharCost(char);
  return cost;
}

/** A Latin word of 4+ letters under 25% vowels ("xkcd", "tlrmnbvc"; few real words, "strengths"). */
function consonantRun(letters: string): boolean {
  const latin = letters.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^a-z]/g, "");
  if (latin.length < 4) return false;
  return (latin.match(/[aeiouy]/g)?.length ?? 0) < latin.length * 0.25;
}

/** One character of a dense word (see {@link estimateTokens}). */
function denseCharCost(char: string): number {
  if (CJK.test(char)) return 1;
  if (/\p{M}/u.test(char)) return 0.3;
  if (/\p{N}/u.test(char) || (/\p{L}/u.test(char) && (LATIN.test(char) || WELL_COVERED.test(char)))) return 0.7;
  return 1;
}

interface Unit {
  start: number;
  end: number;
  cost: number;
}

/** The body's words with their estimated tokens; a word past {@link PIECE_BUDGET} cut into pieces that fit it. */
function chunkUnits(body: string): Unit[] {
  const units: Unit[] = [];
  for (const match of body.matchAll(/\S+/g)) {
    const word = match[0];
    const start = match.index!;
    const cost = estimateTokens(word);
    if (cost <= PIECE_BUDGET) {
      units.push({ start, end: start + word.length, cost });
      continue;
    }
    // Cut at code point boundaries; each piece costs as a dense word of its own (never less than
    // its own estimate).
    let pieceStart = 0;
    let pieceCost = 1;
    let offset = 0;
    for (const char of word) {
      const charCost = denseCharCost(char);
      if (offset > pieceStart && pieceCost + charCost > PIECE_BUDGET) {
        units.push({ start: start + pieceStart, end: start + offset, cost: pieceCost });
        pieceStart = offset;
        pieceCost = 1;
      }
      pieceCost += charCost;
      offset += char.length;
    }
    units.push({ start: start + pieceStart, end: start + word.length, cost: pieceCost });
  }
  return units;
}

/**
 * Overlapping word windows over the body (one span for a short body): at most 180 words (40
 * shared with the next window) and at most {@link CHUNK_TOKEN_BUDGET} estimated tokens, so
 * token-dense text (code, JSON, URLs, non-Latin scripts) gets shorter windows instead of being
 * truncated by the model; a run without spaces longer than a window is cut inside. The spans
 * cover every non-space character of the body.
 */
export function chunkBody(body: string): TextSpan[] {
  const units = chunkUnits(body);
  const total = units.reduce((sum, unit) => sum + unit.cost, 0);
  if (units.length <= CHUNK_WORDS && total <= CHUNK_TOKEN_BUDGET) return [{ start: 0, end: body.length }];
  const spans: TextSpan[] = [];
  let first = 0;
  for (;;) {
    let last = first;
    let cost = units[first]!.cost;
    while (last + 1 < units.length && last + 1 - first < CHUNK_WORDS && cost + units[last + 1]!.cost <= CHUNK_TOKEN_BUDGET) {
      last += 1;
      cost += units[last]!.cost;
    }
    spans.push({ start: units[first]!.start, end: units[last]!.end });
    if (last === units.length - 1) break;
    // The next window starts up to 40 units (and the overlap's share of the budget) back.
    let next = last + 1;
    let overlap = 0;
    while (next - 1 > first && last + 1 - (next - 1) <= CHUNK_OVERLAP && overlap + units[next - 1]!.cost <= CHUNK_OVERLAP_BUDGET) {
      next -= 1;
      overlap += units[next]!.cost;
    }
    first = next;
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

/** A duration as a text states one: "48 hours", "1–2 days", "3-5 days", "15-30 min", "7-day". */
export const DURATION = /\b\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?[\s-]*(?:hrs?|hours?|days?|weeks?|wks?|mins?|minutes?|months?)\b/i;
/** A number as a text states one, in figures or as a small number word ("5 tiktok accounts", "2–3 accounts", "two accounts"). */
export const NUMBER = /\b\d+(?:[.,]\d+)?\b|\b(?:two|three|four|five|six|seven|eight|nine|ten|twice|dozen)\b/i;
/** What a stated duration counts for, in query words, when the query asks how long: it is the answer. */
const DURATION_WEIGHT = 2;
/**
 * What a stated number counts for, in query words, beside at least one of them, when the query asks
 * how many: half a word, so a passage holding more of the query's nouns still wins ("a new device
 * for each US number/TikTok account" over "scroll TikTok at least 10min every day").
 */
const NUMBER_WEIGHT = 0.5;

/** What a query asks for beside its words: a duration ("how long …"), a count ("how many …"), or neither. */
export type AnswerShape = "duration" | "count" | null;

/**
 * How well a passage answers a query: how many of its terms it holds (a term may be a group of
 * alternatives: its forms and synonyms, counted once), plus {@link DURATION_WEIGHT} for a stated
 * duration when the query asks how long, or {@link NUMBER_WEIGHT} for a stated number beside a
 * term it holds when the query asks how many.
 */
export function passageScore(text: string, groups: readonly (string | readonly string[])[], shape: AnswerShape = null): number {
  const tokens = new Set(tokenize(text));
  let held = 0;
  for (const group of groups) if ((typeof group === "string" ? [group] : group).some((term) => tokens.has(term))) held += 1;
  if (shape === "duration" && DURATION.test(text)) return held + DURATION_WEIGHT;
  if (shape === "count" && held > 0 && NUMBER.test(text)) return held + NUMBER_WEIGHT;
  return held;
}

/**
 * One or two lines from `body` (inside `span` when given): the passage that answers the query best
 * ({@link passageScore}), followed by the next one while it fits; the span's opening otherwise.
 */
export function bestSnippet(body: string, queryTerms: readonly (string | readonly string[])[], span?: TextSpan, shape: AnswerShape = null): string {
  const region = span ? body.slice(span.start, span.end) : body;
  const pieces = passages(region);
  if (pieces.length === 0) return "";
  let best = 0;
  let bestScore = 0;
  if (queryTerms.length > 0 || shape === "duration") {
    pieces.forEach((piece, index) => {
      const seen = passageScore(piece, queryTerms, shape);
      if (seen > bestScore) {
        bestScore = seen;
        best = index;
      }
    });
  }
  let snippet = pieces[best]!;
  const next = pieces[best + 1];
  if (next && snippet.length + 1 + next.length <= SNIPPET_MAX) snippet = `${snippet} ${next}`;
  return cut(snippet);
}
