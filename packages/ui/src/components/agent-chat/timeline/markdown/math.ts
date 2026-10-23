/**
 * Math in chat markdown (spec §4): `$…$` and `\(…\)` inline, `$$…$$`,
 * `\[…\]` and a ```` ```math ```` fence as display math. This file parses;
 * `MarkdownMath.tsx` renders, typeset by a lazily loaded KaTeX
 * (`math-typeset.ts`), so a message without math never loads it.
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
 *
 * Every dollar run, single or double, is also refused when it would swallow
 * other inline syntax (T3's rules): a backtick (`` $a`$HOME` `` keeps its code
 * span), a `://` (`$TOKEN … [users](https://…?$select=id)` keeps its link),
 * or a closing `$` that is escaped (`\$`).
 *
 * Known limit: the rules are about whitespace and digits, not meaning, so a
 * dollar pair that is tight on both sides still reads as math. Shell or
 * template text such as `${A}/${B}` or `cost is $a/$b` renders `{A}/` or
 * `a/` as an equation (put it in backticks, or write `\$`). It is left alone
 * because the obvious tightening (no letter after the closing dollar) would
 * break the common "the $n$th term". A rejected candidate also does not
 * rescan for a later closer in the same run.
 *
 * The rules sit in a wrapper around `micromark-extension-math`'s own
 * construct, so everything else about its tokenising (escapes, line endings)
 * is the library's. The wrapper runs the library's tokenizer unchanged,
 * records the characters it consumes, and rejects the match at the moment it
 * would be accepted when a rule above is broken.
 *
 * ## Streaming
 *
 * Every delimiter needs its closer before it is math. An unclosed `$`, `\(`
 * or `\[` is text, and an unclosed `$$` or `\[` block is not a block (the
 * library's `$$` block would otherwise run to the end of the message), so a
 * formula still streaming in reads as its source and never turns the rest of
 * the message into one broken equation. An unclosed ```` ```math ```` fence is
 * a code block until it closes. *T3: `packages/shared/src/markdownMath.ts`.*
 */

import remarkMath from "remark-math";

import { mathTexFlow, mathTexText, type TexConstruct } from "./math-tex";

/** The `micromark` character codes this file cares about. */
const DOLLAR = 36;
const BACKSLASH = 92;
const GRAVE_ACCENT = 96;
const COLON = 58;
const SLASH = 47;
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

/** The structural subset of `micromark`'s tokenize context this file reads. */
interface ContextLike {
  interrupt?: boolean | undefined;
  events: Array<[string, { type: string }, unknown]>;
  now(): { offset: number };
}

interface ConstructLike {
  tokenize: (this: ContextLike, effects: EffectsLike, ok: State, nok: State) => State;
  resolve?: unknown;
  [key: string]: unknown;
}

type ConstructMap = Record<number, ConstructLike | ConstructLike[] | TexConstruct>;

interface MicromarkExtensionLike {
  text?: ConstructMap | undefined;
  flow?: ConstructMap | undefined;
  [key: string]: unknown;
}

interface MathProcessorLike {
  data(): { micromarkExtensions?: MicromarkExtensionLike[] | undefined; [key: string]: unknown };
  /** What `remark-parse` installs; wrapped to see the document the block lookahead reads. */
  parser?: ((document: string, file: unknown) => unknown) | undefined;
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

/** Whether `consumed` holds `://`, the mark of a URL a dollar run would swallow. */
function containsUrlScheme(consumed: readonly number[]): boolean {
  for (let index = 2; index < consumed.length; index += 1) {
    if (consumed[index] === SLASH && consumed[index - 1] === SLASH && consumed[index - 2] === COLON) return true;
  }
  return false;
}

/**
 * Whether a dollar match is real math rather than prose. `consumed` is every
 * character from the opening `$` through the closing `$`; `next` is the
 * character after the match.
 */
export function isPlausibleSingleDollarMath(consumed: readonly number[], next: Code): boolean {
  let opening = 0;
  while (consumed[opening] === DOLLAR) opening += 1;
  // A code span or a URL inside the run belongs to the markdown, not to TeX.
  // *T3: `patches/micromark-extension-llm-math@3.1.0.patch`, `math-text.js`.*
  if (consumed.includes(GRAVE_ACCENT) || containsUrlScheme(consumed)) return false;
  // An escaped closing dollar is the formula's own `\$`, not its end.
  let backslashes = 0;
  for (let index = consumed.length - opening - 1; consumed[index] === BACKSLASH; index -= 1) backslashes += 1;
  if (backslashes % 2 === 1) return false;
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

/**
 * Whether a block opening at an offset (a `$$` run or `\[`) has its closing
 * line further on in `source`: for `$$`, a line of at least as many dollars;
 * for `\[`, a line that is `\]`. Container markers (`>`) and indentation
 * before a closer are skipped loosely; the tokenizer is the judge of the rest.
 *
 * The closing lines are indexed once per document, on the first question,
 * and every opener is then a binary search: a message of thousands of `$$`
 * or `\[` lines must not rescan the rest of itself per line.
 */
export function createClosingLineIndex(source: string): (offset: number) => boolean {
  let index: { starts: number[]; dollars: number[]; brackets: number[] } | null = null;
  const build = (): NonNullable<typeof index> => {
    // Per closing line, in order: where it starts, the longest `$$` run
    // closing at or after it, and whether a `\]` line is at or after it.
    const starts: number[] = [];
    const runs: number[] = [];
    const isBracket: boolean[] = [];
    const line = /[^\r\n]*/g;
    for (let at = 0; at <= source.length; ) {
      line.lastIndex = at;
      const text = line.exec(source)?.[0] ?? "";
      const closer = /^[ \t>]*(?:(\$+)|\\\])[ \t]*$/.exec(text);
      if (closer) {
        starts.push(at);
        runs.push(closer[1]?.length ?? 0);
        isBracket.push(closer[1] === undefined);
      }
      at += text.length;
      if (at >= source.length) break;
      at += source.startsWith("\r\n", at) ? 2 : 1;
    }
    const dollars = runs.slice();
    const brackets = isBracket.map((value) => (value ? 1 : 0));
    for (let i = starts.length - 2; i >= 0; i -= 1) {
      dollars[i] = Math.max(dollars[i]!, dollars[i + 1]!);
      brackets[i] = Math.max(brackets[i]!, brackets[i + 1]!);
    }
    return { starts, dollars, brackets };
  };
  return (offset) => {
    const lineEnd = /\r\n|\r|\n/g;
    lineEnd.lastIndex = offset;
    if (lineEnd.exec(source) === null) return false;
    const after = lineEnd.lastIndex;
    index ??= build();
    // The first closing line starting on a later line than the opener.
    let low = 0;
    let high = index.starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (index.starts[middle]! < after) low = middle + 1;
      else high = middle;
    }
    if (low >= index.starts.length) return false;
    if (source.startsWith("\\[", offset)) return index.brackets[low] === 1;
    let size = 0;
    while (source.charCodeAt(offset + size) === DOLLAR) size += 1;
    return index.dollars[low]! >= size;
  };
}

/** {@link createClosingLineIndex} for one question. */
export function hasClosingLine(source: string, offset: number): boolean {
  return createClosingLineIndex(source)(offset);
}

/**
 * Wraps a math block construct (the library's `$$`, or `\[`) so only a
 * closed block is one. The library ends an unclosed `$$` block at the end of
 * the document, which mid-stream turns everything after a `$$` line into one
 * formula.
 *
 * The closer is looked for in the source **before** the tokenizer reads a
 * line (`closedAhead`), because a block attempt that reads on to the end of
 * the message and then fails costs the lines it read their containers: a
 * list item or block quote after an unclosed `$$` would come back as
 * paragraph text. A block the lookahead admits must still exit two fences
 * (opening and closing), or it is declined after all.
 */
export function guardClosedMathBlock(
  construct: ConstructLike,
  closedAhead: (offset: number) => boolean
): ConstructLike {
  return {
    ...construct,
    tokenize(effects, ok, nok) {
      if (!closedAhead(this.now().offset)) return (code) => nok(code);
      const context = this;
      const from = context.events.length;
      const accept: State = (code) => {
        // An interrupt check answers from the opening line alone.
        if (context.interrupt) return ok(code);
        let fences = 0;
        for (const [kind, token] of context.events.slice(from)) {
          if (kind === "exit" && token.type === "mathFlowFence") fences += 1;
        }
        return fences >= 2 ? ok(code) : nok(code);
      };
      return construct.tokenize.call(context, effects, accept, nok);
    }
  };
}

interface MdNode {
  type: string;
  value?: string | undefined;
  lang?: string | null | undefined;
  position?: { start: { offset?: number | undefined }; end: { offset?: number | undefined } } | undefined;
  children?: MdNode[] | undefined;
  data?: Record<string, unknown> | undefined;
  [key: string]: unknown;
}

/** The hast a display formula becomes: what `mdast-util-math` gives a `$$` block. */
function displayMathData(value: string): Record<string, unknown> {
  return {
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

/** Turns `node` into a display math block in place. */
function toDisplayMath(node: MdNode, value: string): void {
  for (const key of Object.keys(node)) {
    if (key !== "type" && key !== "position") delete node[key];
  }
  node.type = "math";
  node.value = value;
  node.data = displayMathData(value);
}

/** Whether a math run was written with a display delimiter, `$$` or `\[`. */
function isDisplayDelimited(node: MdNode, source: string): boolean {
  const offset = node.position?.start.offset;
  return offset !== undefined && (source.startsWith("$$", offset) || source.startsWith("\\[", offset));
}

// Adapted from T3 Code (MIT): apps/web/src/components/chat/MarkdownCodeBlock.logic.ts
/**
 * Whether a fenced code node's closing fence is in the source. A streaming
 * fence is parsed to the end of the message until its closer arrives.
 */
export function isClosedCodeFence(node: MdNode, source: string): boolean {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return false;
  const authored = source.slice(start, end);
  const opening = /^[ \t]*(`{3,}|~{3,})/.exec(authored)?.[1];
  // One class for the blockquote prefix: nested quantifiers here backtrack
  // exponentially on code lines that start with many `> ` markers.
  const closing = /\n[ \t>]*(`{3,}|~{3,})[ \t\r]*$/.exec(authored)?.[1];
  return opening !== undefined && closing !== undefined && opening[0] === closing[0] && closing.length >= opening.length;
}

/**
 * Settles which formulas are display math:
 *
 *  - `remark-math` parses a `$$…$$` that shares its line with other text as
 *    *inline* math, so a model's one-line `$$ E = mc^2 $$` would render as
 *    small inline math. When such a run (or `\[…\]`) is the only thing in its
 *    paragraph, it is promoted to the display block the author meant. A
 *    single-dollar `$x$` alone on a line stays inline;
 *  - a `\[…\]` inside a sentence is display math where it stands, as in T3
 *    (a `$$…$$` there stays inline, as it always has here);
 *  - a closed ```` ```math ```` fence is a display block. An unclosed one
 *    stays a code block, so a fence still streaming shows its source.
 */
function settleDisplayMath(tree: MdNode, source: string): void {
  for (const child of tree.children ?? []) settleDisplayMath(child, source);
  if (tree.type === "code") {
    if (tree.lang?.toLowerCase() === "math" && isClosedCodeFence(tree, source)) toDisplayMath(tree, tree.value ?? "");
    return;
  }
  if (tree.type === "inlineMath" && source.startsWith("\\[", tree.position?.start.offset ?? -1)) {
    const value = tree.value ?? "";
    tree.data = {
      hName: "code",
      hProperties: { className: ["language-math", "math-display"] },
      hChildren: [{ type: "text", value }]
    };
    return;
  }
  if (tree.type !== "paragraph") return;
  const meaningful = (tree.children ?? []).filter(
    (child) => !(child.type === "text" && (child.value ?? "").trim() === "")
  );
  const only = meaningful[0];
  if (meaningful.length !== 1 || only?.type !== "inlineMath" || only.value === undefined) return;
  if (!isDisplayDelimited(only, source)) return;
  toDisplayMath(tree, only.value);
}

/** Whether a construct map entry is a single construct this file can wrap. */
function single(entry: ConstructMap[number] | undefined): ConstructLike | undefined {
  return entry === undefined || Array.isArray(entry) ? undefined : (entry as ConstructLike);
}

/**
 * `remark-math` with the dollar rules above, closed-only `$$` blocks, and the
 * `\(…\)` / `\[…\]` constructs of `math-tex.ts`; then the display decisions of
 * {@link settleDisplayMath}. Installed by calling the library's own plugin and
 * then swapping the constructs it registered, so the mdast conversion stays
 * the library's.
 */
export function remarkChatMath(this: MathProcessorLike): (tree: MdNode, file: { value: unknown }) => void {
  const data = this.data();
  const before = data.micromarkExtensions?.length ?? 0;
  (remarkMath as unknown as (this: MathProcessorLike, options: { singleDollarTextMath: boolean }) => void).call(
    this,
    { singleDollarTextMath: true }
  );
  // The text being parsed, for the block lookahead. Every parse on this
  // processor passes through here, including the incremental parser's suffix
  // parses, whose offsets are then relative to the suffix as well.
  let closedAhead = createClosingLineIndex("");
  const parse = this.parser;
  if (parse) {
    this.parser = (text, file) => {
      closedAhead = createClosingLineIndex(text);
      return parse(text, file);
    };
  }
  let resolveMathText: unknown;
  for (const extension of (data.micromarkExtensions ?? []).slice(before)) {
    const text = single(extension.text?.[DOLLAR]);
    if (extension.text && text) {
      resolveMathText = text.resolve;
      extension.text[DOLLAR] = guardSingleDollarMath(text);
    }
    const flow = single(extension.flow?.[DOLLAR]);
    if (extension.flow && flow) extension.flow[DOLLAR] = guardClosedMathBlock(flow, (offset) => closedAhead(offset));
  }
  // The library's resolver folds the spaces and line endings inside a
  // formula into its data; `\(…\)` emits the same tokens, so it shares it.
  (data.micromarkExtensions ??= []).push({
    text: { [BACKSLASH]: { ...mathTexText, resolve: resolveMathText } },
    flow: { [BACKSLASH]: guardClosedMathBlock(mathTexFlow as unknown as ConstructLike, (offset) => closedAhead(offset)) }
  });
  return (tree, file) => {
    settleDisplayMath(tree, typeof file.value === "string" ? file.value : String(file.value));
  };
}

/**
 * KaTeX settings. `trust: false` refuses `\href`, `\url`, `\includegraphics`,
 * `\htmlClass` and the like, so a formula can neither navigate, fetch, nor
 * write attributes of its own; `strict: "ignore"` keeps unknown LaTeX
 * commands from logging; `throwOnError: true` lets the renderer show a
 * formula KaTeX cannot parse (mid-stream, or plain wrong) as its source
 * instead of a red error. The formula is untrusted input, so its size is
 * bounded too: `maxSize` clamps every user-specified length
 * (`\rule{999em}{999em}`, `\kern`, `\hspace`) to 20em, and `maxExpand` caps
 * macro expansion at 1000 steps (KaTeX's default, stated so it is not
 * silently loosened).
 */
export const KATEX_OPTIONS = {
  trust: false,
  strict: "ignore",
  throwOnError: true,
  output: "htmlAndMathml",
  maxSize: 20,
  maxExpand: 1000
} as const;

/**
 * Cheap gate for the math plugins: no dollar sign, no `\(` or `\[`, and no
 * `math` fence means no math. Skipping them for the common message keeps the
 * per-token markdown pipeline as it was.
 */
export function mightContainMath(text: string): boolean {
  return (
    text.includes("$") ||
    text.includes("\\(") ||
    text.includes("\\[") ||
    /(?:`{3,}|~{3,})[ \t]*math\b/i.test(text)
  );
}

/** What a rendered formula's `className` says it is, or `null` for any other code. */
export function mathKind(className: string | undefined): "inline" | "display" | null {
  if (!className?.split(/\s+/).includes("language-math")) return null;
  if (className.includes("math-display")) return "display";
  return className.includes("math-inline") ? "inline" : null;
}

/**
 * A formula's TeX as markdown, in the unambiguous delimiters: what copying it
 * yields, and what it shows before (or instead of) being typeset.
 */
export function mathSource(tex: string, display: boolean): string {
  const trimmed = tex.trim();
  return display ? `\\[\n${trimmed}\n\\]` : `\\(${trimmed}\\)`;
}
