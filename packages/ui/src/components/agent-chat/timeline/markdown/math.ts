/**
 * Math in chat markdown (spec §4): `$…$` inline, `$$…$$` display, rendered by
 * KaTeX through `rehype-katex` (hast elements, never an HTML string).
 *
 * ## The `singleDollarTextMath` decision
 *
 * `remark-math`'s `singleDollarTextMath: true` (its default) treats **any**
 * pair of single dollars as math, so ordinary currency prose such as
 * "it costs $5 and then $10" renders "5 and then " as an equation. Turning the
 * option off fixes that but also stops `$x^2$`, which is what models write
 * most. Neither is acceptable, so single-dollar math stays **on** and is held
 * to Pandoc's rules instead:
 *
 *  - the opening `$` is not followed by whitespace;
 *  - the closing `$` is not preceded by whitespace;
 *  - the closing `$` is not followed by a digit.
 *
 * "$5 and $10" fails the last rule at the second dollar and "costs $5, then
 * $x$" fails the middle one at the second, leaving `$x$` as the only math.
 * `$$…$$` (two or more dollars) is unambiguous and is never second-guessed.
 * The rules sit in a wrapper around `micromark-extension-math`'s own
 * construct, so everything else about its tokenising (escapes, line endings,
 * unterminated runs) is the library's. The wrapper runs the library's
 * tokenizer unchanged, records the characters it consumes, and rejects the
 * match at the moment it would be accepted when a rule above is broken.
 */

import remarkMath from "remark-math";

/** The `micromark` character codes this file cares about. */
const DOLLAR = 36;
const SPACE = 32;
const TAB = -2;
const VIRTUAL_SPACE = -1;
const LINE_FEED = -4;
const CARRIAGE_RETURN = -5;
const CRLF = -3;

type Code = number | null;
type State = (code: Code) => State | undefined;

/** The structural subset of `micromark`'s tokenizer effects this file wraps. */
interface EffectsLike {
  consume(code: number): void;
  [key: string]: unknown;
}

interface ConstructLike {
  tokenize: (this: unknown, effects: EffectsLike, ok: State, nok: State) => State;
  [key: string]: unknown;
}

interface MicromarkExtensionLike {
  text?: Record<number, ConstructLike | ConstructLike[]> | undefined;
  [key: string]: unknown;
}

interface MathProcessorLike {
  data(): { micromarkExtensions?: MicromarkExtensionLike[] | undefined; [key: string]: unknown };
}

function isWhitespace(code: Code): boolean {
  return (
    code === null ||
    code === SPACE ||
    code === TAB ||
    code === VIRTUAL_SPACE ||
    code === LINE_FEED ||
    code === CARRIAGE_RETURN ||
    code === CRLF
  );
}

function isDigit(code: Code): boolean {
  return code !== null && code >= 48 && code <= 57;
}

/**
 * Whether a single-dollar match is real math rather than currency prose.
 * `consumed` is every character from the opening `$` through the closing `$`;
 * `next` is the character after the match.
 */
export function isPlausibleSingleDollarMath(consumed: readonly number[], next: Code): boolean {
  let opening = 0;
  while (consumed[opening] === DOLLAR) opening += 1;
  // `$$…$$` and longer runs are deliberate; only the lone `$` is ambiguous.
  if (opening !== 1) return true;
  if (isWhitespace(consumed[1] ?? null)) return false;
  // The match ends with the closing `$`, so the character before it is [-2].
  if (isWhitespace(consumed[consumed.length - 2] ?? null)) return false;
  if (isDigit(next)) return false;
  return true;
}

/** Wraps `micromark-extension-math`'s text construct with `isPlausibleSingleDollarMath`. */
export function guardSingleDollarMath(construct: ConstructLike): ConstructLike {
  return {
    ...construct,
    tokenize(effects, ok, nok) {
      const consumed: number[] = [];
      const recording: EffectsLike = {
        ...effects,
        consume(code) {
          consumed.push(code);
          effects.consume(code);
        }
      };
      const accept: State = (code) => (isPlausibleSingleDollarMath(consumed, code) ? ok(code) : nok(code));
      return construct.tokenize.call(this, recording, accept, nok);
    }
  };
}

interface MdNode {
  type: string;
  value?: string | undefined;
  position?: { start: { offset?: number | undefined } } | undefined;
  children?: MdNode[] | undefined;
  data?: Record<string, unknown> | undefined;
  [key: string]: unknown;
}

/**
 * `remark-math` parses a `$$…$$` that shares its line with other text as
 * *inline* math, so a model's one-line `$$ E = mc^2 $$` would render as small
 * inline math. When such a run is the only thing in its paragraph (and was
 * written with a double dollar) it is promoted to the display block the author
 * meant. A single-dollar `$x$` alone on a line stays inline.
 */
function promoteDisplayMath(tree: MdNode, source: string): void {
  for (const child of tree.children ?? []) promoteDisplayMath(child, source);
  if (tree.type !== "paragraph") return;
  const meaningful = (tree.children ?? []).filter(
    (child) => !(child.type === "text" && (child.value ?? "").trim() === "")
  );
  const only = meaningful[0];
  if (meaningful.length !== 1 || only?.type !== "inlineMath" || only.value === undefined) return;
  const offset = only.position?.start.offset;
  if (offset === undefined || !source.startsWith("$$", offset)) return;
  const value = only.value;
  delete tree.children;
  tree.type = "math";
  tree.value = value;
  tree.data = {
    hName: "pre",
    hChildren: [
      {
        type: "element",
        tagName: "code",
        properties: { className: ["language-math", "math-display"] },
        children: [{ type: "text", value }]
      }
    ]
  };
}

/**
 * `remark-math` with single-dollar math held to the currency rules above, and
 * a lone `$$…$$` line promoted to display math. Installed by calling the
 * library's own plugin and then swapping the text construct it registered, so
 * the flow (`$$` block) construct and the mdast conversion stay the library's.
 */
export function remarkChatMath(this: MathProcessorLike): (tree: MdNode, file: { value: unknown }) => void {
  const data = this.data();
  const before = data.micromarkExtensions?.length ?? 0;
  (remarkMath as unknown as (this: MathProcessorLike, options: { singleDollarTextMath: boolean }) => void).call(
    this,
    { singleDollarTextMath: true }
  );
  for (const extension of (data.micromarkExtensions ?? []).slice(before)) {
    const text = extension.text?.[DOLLAR];
    if (extension.text === undefined || text === undefined || Array.isArray(text)) continue;
    extension.text[DOLLAR] = guardSingleDollarMath(text);
  }
  return (tree, file) => {
    promoteDisplayMath(tree, typeof file.value === "string" ? file.value : String(file.value));
  };
}

/**
 * KaTeX settings. `trust: false` refuses `\href`, `\url`, `\includegraphics`
 * and the like, so a formula can neither navigate nor fetch; `strict: "ignore"`
 * keeps unknown LaTeX commands from logging or throwing; `throwOnError: false`
 * renders a bad formula's source in `errorColor` instead of failing the
 * message. `maxExpand` (KaTeX's default, stated) bounds macro blow-up.
 */
export const KATEX_OPTIONS = {
  trust: false,
  strict: "ignore",
  throwOnError: false,
  errorColor: "#f87171",
  maxExpand: 1000
} as const;

/**
 * Cheap gate for the math plugins: no dollar sign, no math. Skipping them for
 * the common message keeps the per-token markdown pipeline as it was.
 */
export function mightContainMath(text: string): boolean {
  return text.includes("$");
}
