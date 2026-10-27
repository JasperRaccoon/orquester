/**
 * Excerpts of long entry bodies for the LLM checks: instead of a body's opening, the passages that
 * bear on what the check compares it with. Deterministic: the same body and query give the same
 * excerpt.
 *
 * A body is split into passages ({@link splitPassages}): its lines (paragraphs, numbered steps,
 * bullets), a line longer than {@link PASSAGE_MAX_CHARS} cut at sentence ends, and a passage
 * shorter than {@link PASSAGE_MIN_CHARS} (a heading, a short step) joined with the next one.
 *
 * {@link relevantExcerpt} keeps a body that fits its budget whole. A longer one is shown as its
 * opening (about {@link EXCERPT_OPENING_CHARS}) and, within the budget, passages taken greedily and
 * shown in document order with "[…]" where text is left out: first, for each focus concept (a
 * concept the pair was found through), the best passage naming it; then the passage with the best
 * marginal score while one fits and scores above 0. A passage scores the other side's words it has
 * (BM25 over the body's own passages, idf squared: a word the body repeats everywhere says little,
 * a rare one shared with the other side is where they meet), a concept name's words weighing more,
 * plus a bonus per concept it names; a word or concept already shown (the opening included) counts
 * {@link DECAY} as much again per passage that showed it, so the excerpts cover more points.
 */

import { tokenize, type TextSpan } from "./text.ts";

/** A passage shorter than this joins the next one (headings, short steps). */
export const PASSAGE_MIN_CHARS = 200;
/** A line longer than this is cut at sentence ends (a sentence longer still, at a space). */
export const PASSAGE_MAX_CHARS = 700;
/** An excerpt always starts with the body's first passages up to about this many characters. */
export const EXCERPT_OPENING_CHARS = 300;
/** What separates two excerpts (and ends an excerpt that stops before the body does). */
export const EXCERPT_GAP = "[…]";
/** A passage names a concept when it has at least this share of the name's words (and two of them, or the only one). */
export const CONCEPT_MENTION_SHARE = 0.6;
/** A named concept's score, per unit of its weight (about one distinctive word's). */
const MENTION_BONUS = 2;
/** What a word or concept counts for again, per passage already showing it. */
export const DECAY = 0.5;
const K1 = 1.2;
const B = 0.75;

/** The passages of a body, as offsets into it, in order (see the module header). */
export function splitPassages(body: string): TextSpan[] {
  const units: TextSpan[] = [];
  for (const match of body.matchAll(/[^\n]+/g)) {
    let start = match.index;
    let end = start + match[0].length;
    while (start < end && /\s/.test(body[start]!)) start += 1;
    while (end > start && /\s/.test(body[end - 1]!)) end -= 1;
    if (end > start) units.push(...splitLong(body, start, end));
  }
  const out: TextSpan[] = [];
  for (const unit of units) {
    const last = out.at(-1);
    if (last && last.end - last.start < PASSAGE_MIN_CHARS && unit.end - last.start <= PASSAGE_MAX_CHARS) last.end = unit.end;
    else out.push({ ...unit });
  }
  // A short last passage joins the one before when it fits.
  const last = out.at(-1);
  const before = out.at(-2);
  if (last && before && last.end - last.start < PASSAGE_MIN_CHARS && last.end - before.start <= PASSAGE_MAX_CHARS) {
    before.end = last.end;
    out.pop();
  }
  return out;
}

/** One line as pieces of at most {@link PASSAGE_MAX_CHARS}: cut after a sentence end, else at a space. */
function splitLong(body: string, start: number, end: number): TextSpan[] {
  const out: TextSpan[] = [];
  let from = start;
  while (end - from > PASSAGE_MAX_CHARS) {
    const limit = from + PASSAGE_MAX_CHARS;
    let cut = -1;
    const sentenceEnd = /[.!?…]+["'”’)\]]*\s+/g;
    sentenceEnd.lastIndex = from;
    for (let m = sentenceEnd.exec(body); m !== null && m.index < limit; m = sentenceEnd.exec(body)) {
      const after = m.index + m[0].trimEnd().length;
      if (after > limit) break;
      if (after - from >= PASSAGE_MIN_CHARS) cut = after;
    }
    if (cut === -1) {
      const space = body.lastIndexOf(" ", limit);
      cut = space > from + PASSAGE_MIN_CHARS ? space : limit;
    }
    out.push({ start: from, end: cut });
    from = cut;
    while (from < end && /\s/.test(body[from]!)) from += 1;
  }
  if (end > from) out.push({ start: from, end });
  return out;
}

/** What an excerpt is chosen for. */
export interface ExcerptQuery {
  /** The other side's text (title and body): words of it in a passage count. */
  text: string;
  /** Concept names whose words count `weight` more, and a passage naming one scores a bonus. */
  concepts?: readonly { name: string; weight: number }[];
  /** Concept names whose passages are taken first (the concepts a pair was found through). */
  focus?: readonly string[];
}

export interface Excerpt {
  /** The body (trimmed) when it fits the budget, else its excerpts joined by {@link EXCERPT_GAP}. */
  text: string;
  /** Whether text was left out. */
  excerpted: boolean;
  /** The trimmed body's length. */
  chars: number;
}

/** The distinct tokens of a name (empty for a name of stopwords only). */
function nameTokens(name: string): string[] {
  return [...new Set(tokenize(name))];
}

/** Whether a passage's tokens name a concept (see {@link CONCEPT_MENTION_SHARE}). */
export function namesConcept(passage: ReadonlySet<string>, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;
  let hit = 0;
  for (const token of tokens) if (passage.has(token)) hit += 1;
  return hit >= Math.min(2, tokens.length) && hit / tokens.length >= CONCEPT_MENTION_SHARE;
}

/**
 * A body for a check, within `budget` characters (separators aside): whole when it fits, else its
 * opening and its passages most relevant to `query` (see the module header).
 */
export function relevantExcerpt(body: string, query: ExcerptQuery, budget: number): Excerpt {
  const text = body.trim();
  if (text.length <= budget) return { text, excerpted: false, chars: text.length };
  const spans = splitPassages(text);
  // The opening: the first passages up to EXCERPT_OPENING_CHARS, or the first one cut there.
  let openEnd = 0;
  for (const span of spans) {
    if (span.end > EXCERPT_OPENING_CHARS) break;
    openEnd = span.end;
  }
  if (openEnd === 0) openEnd = openingCut(text, Math.min(EXCERPT_OPENING_CHARS, budget));

  // Query words: the other side's (1-letter tokens such as step numbers aside), a concept name's weighing more.
  const weights = new Map<string, number>();
  for (const token of tokenize(query.text)) if (token.length > 1) weights.set(token, 1);
  const concepts = (query.concepts ?? []).map((concept) => ({ tokens: nameTokens(concept.name), weight: concept.weight })).filter((c) => c.tokens.length > 0);
  for (const concept of concepts) for (const token of concept.tokens) weights.set(token, Math.max(weights.get(token) ?? 0, 1 + concept.weight));
  const focus = (query.focus ?? []).map(nameTokens).filter((tokens) => tokens.length > 0);

  const tokensOf = spans.map((span) => tokenize(text.slice(span.start, span.end)));
  const df = new Map<string, number>();
  for (const tokens of tokensOf) for (const token of new Set(tokens)) df.set(token, (df.get(token) ?? 0) + 1);
  const n = spans.length;
  const avg = tokensOf.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(1, n);
  // Per passage: each query word's part (BM25 with idf squared over the body's passages: a word the
  // body repeats everywhere says little about where the two entries meet), the concepts it names,
  // and the focus concepts it names.
  const scored = spans.map((span, i) => {
    const tokens = tokensOf[i]!;
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    const norm = K1 * (1 - B + (B * tokens.length) / Math.max(1, avg));
    const terms: [string, number][] = [];
    for (const [token, freq] of tf) {
      const weight = weights.get(token);
      if (weight === undefined) continue;
      const d = df.get(token)!;
      const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
      terms.push([token, (weight * idf * idf * freq * (K1 + 1)) / (freq + norm)]);
    }
    const set = new Set(tf.keys());
    const named = concepts.flatMap((concept, c) => (namesConcept(set, concept.tokens) ? [c] : []));
    const focused = focus.flatMap((tokens, f) => (namesConcept(set, tokens) ? [f] : []));
    return { span, terms, named, focused };
  });

  // Greedy by marginal score: a word or concept already shown (the opening included) counts
  // DECAY times less for each passage that showed it, so the excerpts cover more of the other side.
  const shownTerms = new Map<string, number>();
  const shownConcepts = new Map<number, number>();
  const chosen: TextSpan[] = [{ start: 0, end: openEnd }];
  const taken = new Set<number>();
  let used = openEnd;
  const show = (tokens: Iterable<string>, named: readonly number[]): void => {
    for (const token of new Set(tokens)) shownTerms.set(token, (shownTerms.get(token) ?? 0) + 1);
    for (const c of named) shownConcepts.set(c, (shownConcepts.get(c) ?? 0) + 1);
  };
  const openingTokens = tokenize(text.slice(0, openEnd));
  const openingSet = new Set(openingTokens);
  show(openingTokens, concepts.flatMap((concept, c) => (namesConcept(openingSet, concept.tokens) ? [c] : [])));
  const added = (span: TextSpan): number => span.end - Math.max(span.start, Math.min(span.end, openEnd));
  const fits = (i: number): boolean => !taken.has(i) && added(scored[i]!.span) > 0 && used + added(scored[i]!.span) <= budget;
  const gain = (i: number): number => {
    const passage = scored[i]!;
    let sum = 0;
    for (const [token, value] of passage.terms) sum += value * DECAY ** (shownTerms.get(token) ?? 0);
    for (const c of passage.named) sum += MENTION_BONUS * concepts[c]!.weight * DECAY ** (shownConcepts.get(c) ?? 0);
    return sum;
  };
  const take = (i: number): void => {
    const passage = scored[i]!;
    taken.add(i);
    chosen.push(passage.span);
    used += added(passage.span);
    show(
      passage.terms.map(([token]) => token),
      passage.named
    );
  };
  // First, for each focus concept, the best passage naming it.
  for (let f = 0; f < focus.length; f += 1) {
    let best = -1;
    let bestGain = 0;
    for (let i = 0; i < scored.length; i += 1) {
      if (!scored[i]!.focused.includes(f) || !fits(i)) continue;
      const g = gain(i);
      if (best === -1 || g > bestGain) [best, bestGain] = [i, g];
    }
    if (best !== -1) take(best);
  }
  // Then the best marginal score while one fits (ties: the earlier passage).
  for (;;) {
    let best = -1;
    let bestGain = 0;
    for (let i = 0; i < scored.length; i += 1) {
      if (!fits(i)) continue;
      const g = gain(i);
      if (g > bestGain) [best, bestGain] = [i, g];
    }
    if (best === -1) break;
    take(best);
  }
  chosen.sort((x, y) => x.start - y.start);
  const merged: TextSpan[] = [];
  for (const span of chosen) {
    const last = merged.at(-1);
    // Touching, or only whitespace between: one excerpt.
    if (last && (span.start <= last.end || text.slice(last.end, span.start).trim() === "")) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  const parts = merged.map((span) => text.slice(span.start, span.end).trim());
  const tail = text.slice(merged.at(-1)!.end).trim() === "" ? "" : `\n${EXCERPT_GAP}`;
  return { text: `${parts.join(`\n${EXCERPT_GAP}\n`)}${tail}`, excerpted: true, chars: text.length };
}

/** Where an opening of at most `max` characters ends: after a sentence in its second half, else at a space. */
function openingCut(text: string, max: number): number {
  const head = text.slice(0, max + 1);
  let cut = -1;
  for (const m of head.matchAll(/[.!?…]+["'”’)\]]*\s/g)) {
    const after = m.index + m[0].trimEnd().length;
    if (after <= max && after >= max / 2) cut = after;
  }
  if (cut !== -1) return cut;
  const space = head.lastIndexOf(" ", max);
  return space > max / 2 ? space : max;
}
