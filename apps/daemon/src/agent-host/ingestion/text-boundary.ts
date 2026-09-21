// Ported from T3 Code (MIT): apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:196-250
/**
 * Where a buffered stream of markdown may be cut (spec §5.6).
 *
 * A flush "never splits a code block", so the splitter reports both the last
 * safe boundary and whether the tail is sitting inside an open fence. The
 * 250 ms timer uses the second fact to hold a fenced block back one more
 * window; the 8 KB valve ignores it, because memory is the harder bound.
 */

/**
 * An opening fence may sit at any indentation, since fences inside list items
 * are indented past the marker. A closing fence may be indented at most three
 * spaces more than its opener. Deeper lines are content in the block.
 */
const MARKDOWN_FENCE_PATTERN = /^( *)(`{3,}|~{3,})/;
/**
 * CommonMark blank lines hold only spaces and tabs. Other whitespace, such as
 * a no-break space, is paragraph content.
 */
const BLANK_LINE_PATTERN = /^[ \t]*$/;
/**
 * A bullet or ordered marker followed by whitespace, at any indentation so
 * nested items count. The trailing space is required, so a partial `-` or
 * `1.` never matches before the model finishes the marker.
 */
const LIST_ITEM_START_PATTERN = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/;

export interface BufferedTextSplit {
  /** Safe to deliver now: the markdown before it will not change shape. */
  ready: string;
  /** Stays buffered until the next boundary or a completion. */
  rest: string;
  /** True when `rest` ends inside an unclosed fenced code block. */
  openFence: boolean;
}

/**
 * Splits buffered text at the last blank line, closing code fence, or list
 * item start that is not inside an open fenced code block. Only fully
 * terminated lines count, so a trailing partial line never leaks; a list item
 * start is the one lookahead that may sit on the partial line, since tight
 * lists have no blank lines between items and would otherwise land all at
 * once.
 */
export function splitBufferedText(text: string): BufferedTextSplit {
  let openFence: { marker: string; indent: number } | null = null;
  let boundary = -1;
  let lineStart = 0;
  for (;;) {
    const newline = text.indexOf("\n", lineStart);
    const line = text
      .slice(lineStart, newline === -1 ? text.length : newline)
      .replace(/[ \t\r]+$/, "");
    if (openFence === null && lineStart > 0 && LIST_ITEM_START_PATTERN.test(line)) {
      boundary = lineStart;
    }
    if (newline === -1) {
      break;
    }
    const fenceMatch = MARKDOWN_FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      const indent = fenceMatch[1]!.length;
      const marker = fenceMatch[2]!;
      if (openFence === null) {
        openFence = { marker, indent };
      } else if (
        marker[0] === openFence.marker[0] &&
        marker.length >= openFence.marker.length &&
        indent <= openFence.indent + 3 &&
        line.length === indent + marker.length
      ) {
        // CommonMark: a closing fence carries no info string.
        openFence = null;
        boundary = newline + 1;
      }
    } else if (openFence === null && BLANK_LINE_PATTERN.test(line) && lineStart > 0) {
      boundary = newline + 1;
    }
    lineStart = newline + 1;
  }
  if (boundary === -1) {
    return { ready: "", rest: text, openFence: openFence !== null };
  }
  return {
    ready: text.slice(0, boundary),
    rest: text.slice(boundary),
    openFence: openFence !== null
  };
}

/** Text worth appending as a message delta. */
export function hasRenderableText(value: string | undefined): boolean {
  return (value?.trim().length ?? 0) > 0;
}

/** T3's activity-detail cap, applied to every free-text field that reaches a row. */
export function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}
