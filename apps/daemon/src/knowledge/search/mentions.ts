/**
 * Whether an entry's text says what a concept of another entry says, in the text rather than in the
 * concept graph (myKG links an entry to the concepts it extracted, not to every thing it names):
 *
 * - {@link namesPhrase}: a tool named in another entry's text ("Find My iPhone" is Alex's concept
 *   alone, and jason's step 4 turns "Find My iPhone → off") is not new on Alex's page;
 * - {@link statesClaimNumber}: a figure another entry states ("231 configurable settings in Candy
 *   Crush", restated as "Candy Crush (231 configurable settings)") is not a single source.
 *
 * Both are read through the keyword index (`KnowledgeSearch.entriesNaming`, `entriesStating`): only
 * entries holding every word are read.
 */

/** Text folded for comparison: no accents, lower case, apostrophes dropped. */
function fold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/['’]/g, "");
}

/** A name's words (letters and digits), folded. */
export function phraseWords(phrase: string): string[] {
  return fold(phrase).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Whether `text` names `phrase`: its words in order, nothing but spaces or punctuation between
 * them, not inside longer words ("Find My iPhone" in "Find My → Find My iPhone → off", not "Proxy"
 * in "proxyless"). A phrase of one word under 3 letters names nothing.
 */
export function namesPhrase(text: string, phrase: string): boolean {
  const words = phraseWords(phrase);
  if (words.length === 0 || (words.length === 1 && words[0]!.length < 3)) return false;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${words.map(escape).join("[^\\p{L}\\p{N}]{1,3}")}(?![\\p{L}\\p{N}])`, "u");
  return pattern.test(fold(text));
}

/** Words that say nothing about which figure a number is ("in", "per", "the"). */
const GLUE = new Set(["the", "a", "an", "of", "for", "to", "and", "or", "with", "by", "at", "from", "as", "is", "in", "on", "per", "its", "it", "your", "you", "about", "than"]);

/** A claim name's numbers ("231 configurable settings" → 231; "$1.3M" → 1.3) and its other words (3+ letters). */
export function claimFigure(claim: string): { numbers: string[]; words: string[] } {
  const folded = fold(claim);
  const numbers = [...new Set(folded.match(/\d+(?:[.,]\d+)*/g) ?? [])];
  const words = [...new Set((folded.match(/\p{L}+/gu) ?? []).filter((word) => word.length >= 3 && !GLUE.has(word)))];
  return { numbers, words };
}

/**
 * Whether `text` states a claim's figure: one sentence holds every number of the claim's name and
 * at least half of its other words (one at least), each standing alone ("Candy Crush (231
 * configurable settings)" for "231 configurable settings in Candy Crush"; not a URL ending in 462231).
 * A name without a number states no figure.
 */
export function statesClaimNumber(text: string, claim: string): boolean {
  const { numbers, words } = claimFigure(claim);
  if (numbers.length === 0) return false;
  for (const sentence of fold(text).split(/(?<=[.!?])\s+|\n+/)) {
    if (!numbers.every((n) => new RegExp(`(?<![\\p{L}\\p{N}.])${escape(n)}(?![\\p{N}]|[.,]\\p{N})`, "u").test(sentence))) continue;
    const said = new Set(sentence.match(/\p{L}+/gu) ?? []);
    const held = words.filter((word) => said.has(word) || said.has(`${word}s`) || (word.endsWith("s") && said.has(word.slice(0, -1)))).length;
    if (held >= Math.max(1, Math.ceil(words.length / 2))) return true;
  }
  return false;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
