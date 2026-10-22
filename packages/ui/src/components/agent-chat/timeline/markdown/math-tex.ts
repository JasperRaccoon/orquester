/**
 * `\(…\)` and `\[…\]` math (spec §4), the delimiters GPT and Codex write.
 *
 * Two `micromark` constructs, both keyed on the backslash and tried before
 * CommonMark's character escape, so whenever one declines, `\(` and `\[` are
 * the ordinary escapes they always were and render as `(` and `[`:
 *
 *  - {@link mathTexText}, inline: `\(x\)` and `\[x\]` inside a paragraph,
 *    which may run over line endings. It declines
 *    - with no closer before the end of the paragraph, so a formula still
 *      streaming in shows as text and never swallows the rest of the message;
 *    - at a backtick, so `` \(a `\)` `` keeps its code span;
 *    - with nothing but spaces between the delimiters (`\(\)`, `f\( \)`);
 *    - for `\[…\]` holding only digits, commas and spaces, so citations such
 *      as `\[1\]` and `\[2, 3\]` stay `[1]` and `[2, 3]`.
 *  - {@link mathTexFlow}, a block: `\[` alone on its line through a line that
 *    ends in `\]`. Only a **closed** block is one: an unclosed `\[` (a block
 *    still streaming) declines, and its lines stay the paragraph they are.
 *
 * Both emit the token names `micromark-extension-math` emits for `$`, so
 * `mdast-util-math` turns them into `inlineMath` and `math` nodes unchanged.
 * `math.ts` installs them and decides which inline formulas are display math.
 *
 * Types are structural, as in `math.ts` and `incremental.ts`: the `micromark`
 * type packages are transitive dependencies and not resolvable from here.
 */

// Adapted from T3 Code (MIT): patches/micromark-extension-llm-math@3.1.0.patch (dev/lib/math-tex-text.js, dev/lib/math-tex-flow.js)

/** The `micromark` character codes this file cares about. */
const BACKSLASH = 92;
const LEFT_PARENTHESIS = 40;
const RIGHT_PARENTHESIS = 41;
const LEFT_SQUARE_BRACKET = 91;
const RIGHT_SQUARE_BRACKET = 93;
const GRAVE_ACCENT = 96;
const COMMA = 44;
const SPACE = 32;
const TAB = -2;
const VIRTUAL_SPACE = -1;
/** Four columns: an indent of four or more is indented code, not a fence. */
const TAB_SIZE = 4;

type Code = number | null;
export type State = (code: Code) => State | undefined;

interface TokenLike {
  type: string;
  [key: string]: unknown;
}

/** The structural subset of `micromark`'s tokenizer effects these constructs use. */
export interface EffectsLike {
  consume(code: Code): void;
  enter(type: string): TokenLike;
  exit(type: string): TokenLike;
  attempt(construct: unknown, ok: State, nok: State): State;
  [key: string]: unknown;
}

/** The structural subset of `micromark`'s tokenize context. */
export interface TokenizeContextLike {
  previous: Code;
  interrupt?: boolean | undefined;
  events: Array<[string, TokenLike, unknown]>;
  now(): { line: number; offset: number };
  parser: {
    lazy: Record<number, boolean>;
    constructs: { disable: { null?: string[] | undefined } };
  };
  [key: string]: unknown;
}

export interface TexConstruct {
  name: string;
  tokenize: (this: TokenizeContextLike, effects: EffectsLike, ok: State, nok: State) => State;
  previous?: (this: TokenizeContextLike, code: Code) => boolean;
  resolve?: unknown;
  concrete?: boolean;
  partial?: boolean;
}

function markdownLineEnding(code: Code): boolean {
  return code !== null && code < TAB;
}

function markdownSpace(code: Code): boolean {
  return code === SPACE || code === TAB || code === VIRTUAL_SPACE;
}

function isDigit(code: Code): boolean {
  return code !== null && code >= 48 && code <= 57;
}

/** `micromark-factory-space`, which is not a direct dependency: optional spaces as one token. */
function factorySpace(effects: EffectsLike, ok: State, type: string, max?: number): State {
  const limit = max ? max - 1 : Number.POSITIVE_INFINITY;
  let size = 0;
  const prefix: State = (code) => {
    if (markdownSpace(code) && size++ < limit) {
      effects.consume(code);
      return prefix;
    }
    effects.exit(type);
    return ok(code);
  };
  return (code) => {
    if (markdownSpace(code)) {
      effects.enter(type);
      return prefix(code);
    }
    return ok(code);
  };
}

// ---------------------------------------------------------------------------
// Inline: \(…\) and \[…\]
// ---------------------------------------------------------------------------

function tokenizeMathTexText(effects: EffectsLike, ok: State, nok: State): State {
  let token: TokenLike;
  let closeCode: number;
  /** Anything but spaces between the delimiters. */
  let content = false;
  /** Anything but digits, commas and spaces: what makes `\[…\]` a formula, not a citation. */
  let substantive = false;

  const start: State = (code) => {
    effects.enter("mathText");
    effects.enter("mathTextSequence");
    effects.consume(code);
    return sequenceOpen;
  };

  const sequenceOpen: State = (code) => {
    if (code !== LEFT_PARENTHESIS && code !== LEFT_SQUARE_BRACKET) return nok(code);
    closeCode = code === LEFT_PARENTHESIS ? RIGHT_PARENTHESIS : RIGHT_SQUARE_BRACKET;
    effects.consume(code);
    effects.exit("mathTextSequence");
    return between;
  };

  const between: State = (code) => {
    if (code === null || code === GRAVE_ACCENT) return nok(code);
    if (code === BACKSLASH) {
      token = effects.enter("mathTextSequence");
      effects.consume(code);
      return sequenceClose;
    }
    // Tabs are data, as in `micromark-extension-math`.
    if (code === SPACE) {
      effects.enter("space");
      effects.consume(code);
      effects.exit("space");
      return between;
    }
    if (markdownLineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return between;
    }
    effects.enter("mathTextData");
    return data(code);
  };

  const data: State = (code) => {
    if (code === GRAVE_ACCENT) return nok(code);
    if (code === null || code === SPACE || code === BACKSLASH || markdownLineEnding(code)) {
      effects.exit("mathTextData");
      return between(code);
    }
    content = true;
    if (code !== COMMA && !isDigit(code)) substantive = true;
    effects.consume(code);
    return data;
  };

  const sequenceClose: State = (code) => {
    if (code === closeCode) {
      if (!content || (closeCode === RIGHT_SQUARE_BRACKET && !substantive)) return nok(code);
      effects.consume(code);
      effects.exit("mathTextSequence");
      effects.exit("mathText");
      return ok;
    }
    // Not a closer: the backslash starts a TeX command (`\alpha`) or an
    // escaped character (`\\`, `\{`), which is formula data.
    content = true;
    token.type = "mathTextData";
    if (code === BACKSLASH) {
      effects.consume(code);
      return data;
    }
    return data(code);
  };

  return start;
}

/**
 * `\(…\)` and `\[…\]` inside a paragraph. `resolve` is set by `math.ts` to
 * `micromark-extension-math`'s own text resolver, which folds the spaces and
 * line endings inside the formula into its data.
 */
export const mathTexText: TexConstruct = {
  name: "mathTexText",
  tokenize(effects, ok, nok) {
    return tokenizeMathTexText(effects, ok, nok);
  },
  // A backslash right after a backslash is the second half of an escape.
  previous(code) {
    return code !== BACKSLASH;
  }
};

// ---------------------------------------------------------------------------
// Block: \[ … \]
// ---------------------------------------------------------------------------

/** Whether the next line belongs to the block (is not a lazy continuation of a container). */
const nonLazyContinuation: TexConstruct = {
  name: "mathTexNonLazyContinuation",
  partial: true,
  tokenize(effects, ok, nok) {
    const lineStart: State = (code) => (this.parser.lazy[this.now().line] ? nok(code) : ok(code));
    return (code) => {
      if (code === null) return ok(code);
      if (markdownLineEnding(code)) {
        effects.enter("lineEnding");
        effects.consume(code);
        effects.exit("lineEnding");
        return lineStart;
      }
      return lineStart(code);
    };
  }
};

/** A backslash in the content that is not the start of the closing `\]`. */
const nonClosingBackslash: TexConstruct = {
  name: "mathTexNonClosingBackslash",
  partial: true,
  tokenize(effects, ok, nok) {
    return (code) => {
      effects.enter("mathFlowValue");
      effects.consume(code);
      return (next) => (next === RIGHT_SQUARE_BRACKET ? nok(next) : ok(next));
    };
  }
};

function tokenizeMathTexFlow(
  this: TokenizeContextLike,
  effects: EffectsLike,
  ok: State,
  nok: State
): State {
  const self = this;
  const tail = self.events[self.events.length - 1];
  const initialSize =
    tail && tail[1].type === "linePrefix"
      ? ((tail[2] as { sliceSerialize(token: TokenLike, expand: boolean): string }).sliceSerialize(tail[1], true)
          .length)
      : 0;
  let closed = false;

  const closingFence: TexConstruct = {
    name: "mathTexClosingFence",
    partial: true,
    tokenize(closeEffects, closeOk, closeNok) {
      const afterSequenceClose: State = (code) => {
        if (code === null || markdownLineEnding(code)) {
          closeEffects.exit("mathFlowFence");
          closed = true;
          return closeOk(code);
        }
        return closeNok(code);
      };
      const sequenceClose: State = (code) => {
        if (code !== RIGHT_SQUARE_BRACKET) return closeNok(code);
        closeEffects.consume(code);
        closeEffects.exit("mathFlowFenceSequence");
        return factorySpace(closeEffects, afterSequenceClose, "whitespace");
      };
      const beforeSequenceClose: State = (code) => {
        if (code !== BACKSLASH) return closeNok(code);
        closeEffects.enter("mathFlowFence");
        closeEffects.enter("mathFlowFenceSequence");
        closeEffects.consume(code);
        return sequenceClose;
      };
      const disabled = self.parser.constructs.disable.null ?? [];
      return factorySpace(
        closeEffects,
        beforeSequenceClose,
        "linePrefix",
        disabled.includes("codeIndented") ? undefined : TAB_SIZE
      );
    }
  };

  const after: State = (code) => {
    // An unclosed block is no block: its lines stay the paragraph they are.
    if (!closed) return nok(code);
    effects.exit("mathFlow");
    return ok(code);
  };

  const contentChunk: State = (code) => {
    if (code === null || code === BACKSLASH || markdownLineEnding(code)) {
      effects.exit("mathFlowValue");
      return beforeContentChunk(code);
    }
    effects.consume(code);
    return contentChunk;
  };

  const continueContentChunk: State = (code) => {
    effects.enter("mathFlowValue");
    effects.consume(code);
    return contentChunk;
  };

  const beforeContentChunkContinuation: State = (code) =>
    effects.attempt(closingFence, after, continueContentChunk)(code);

  const beforeNonLazyContinuation: State = (code) => {
    if (code === null) return after(code);
    return effects.attempt(closingFence, after, contentStart)(code);
  };

  function beforeContentChunk(code: Code): State | undefined {
    if (code === null) return after(code);
    if (code === BACKSLASH) {
      return effects.attempt(nonClosingBackslash, contentChunk, beforeContentChunkContinuation)(code);
    }
    if (markdownLineEnding(code)) {
      return effects.attempt(nonLazyContinuation, beforeNonLazyContinuation, after)(code);
    }
    effects.enter("mathFlowValue");
    return contentChunk(code);
  }

  const contentStart: State = (code) =>
    (initialSize ? factorySpace(effects, beforeContentChunk, "linePrefix", initialSize + 1) : beforeContentChunk)(
      code
    );

  const metaAfter: State = (code) => {
    // `\[ x` is not an opening fence: it is inline math or text.
    if (code !== null && !markdownLineEnding(code)) return nok(code);
    effects.exit("mathFlowFence");
    if (self.interrupt) return ok(code);
    return effects.attempt(nonLazyContinuation, beforeNonLazyContinuation, after)(code);
  };

  const sequenceOpen: State = (code) => {
    if (code !== LEFT_SQUARE_BRACKET) return nok(code);
    effects.consume(code);
    effects.exit("mathFlowFenceSequence");
    return factorySpace(effects, metaAfter, "whitespace");
  };

  return (code) => {
    effects.enter("mathFlow");
    effects.enter("mathFlowFence");
    effects.enter("mathFlowFenceSequence");
    effects.consume(code);
    return sequenceOpen;
  };
}

/**
 * A `\[ … \]` block. It requires its closer, but it cannot look ahead for
 * it: an attempt that reads on to the end of the message and fails leaves
 * the lines it read without their containers (a list item after it is a
 * paragraph line). `math.ts` therefore wraps it in a lookahead on the source
 * that declines an unclosed block before it reads a line.
 */
export const mathTexFlow: TexConstruct = {
  name: "mathTexFlow",
  concrete: true,
  tokenize(effects, ok, nok) {
    return tokenizeMathTexFlow.call(this, effects, ok, nok);
  }
};
