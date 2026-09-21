import React from "react";
import { WrapText } from "lucide-react";

import { cn } from "../../../../lib/cn";
import { CopyButton } from "../../primitives";
import {
  createIncrementalTreeHighlighter,
  estimateHighlightSize,
  fenceLanguageLabel,
  highlightCache,
  highlightCacheKey,
  highlightCode,
  plainLines,
  type HighlightedLine
} from "./highlight-core";
import { useLanguageParser } from "./languages";
import { tokenColor } from "./token-theme";
import { ChatIconButton } from "../../primitives";

/**
 * A fenced code block (spec §7.3).
 *
 * Two properties are load-bearing and easy to lose:
 *
 *  1. **Lines are mounted individually.** While a message streams, appending a
 *     line must not rebuild the lines above it — otherwise the browser
 *     re-parses and re-styles every token span on every chunk, and the user's
 *     text selection dies with them. Each line is its own keyed element, and a
 *     block that streamed **keeps** this renderer after settling for the same
 *     reason (swapping to a cached blob would clear a live selection).
 *     *T3: `ChatMarkdown.tsx:1039-1073` and the selection comment there.*
 *  2. **The settled result is cached.** Once the message settles, the
 *     highlighted document goes into a size-aware LRU keyed on content +
 *     language + mode, so scrolling a long thread never re-parses anything.
 *     *T3: `ChatMarkdown.tsx:338-357, 1117-1126`.*
 *
 * DELIBERATE DIFFERENCE FROM T3: T3 caches rendered **HTML** and re-injects it
 * with `dangerouslySetInnerHTML`. We cache the token model and render React
 * elements. It is the same saving (the parse, not the DOM build), it keeps the
 * line-mounted guarantee unconditional, and no provider text is ever handed to
 * the browser as HTML.
 */
export interface CodeBlockProps {
  code: string;
  /** The fence's info string, e.g. `ts` or `ts title="a.ts"`. */
  info: string;
  streaming: boolean;
  mode: "light" | "dark";
}

const WRAP_STORAGE_KEY = "orquester.agentChat.codeWrap";

function readWrapPreference(): boolean {
  try {
    return window.localStorage.getItem(WRAP_STORAGE_KEY) === "1";
  } catch {
    // Private windows and blocked site data throw on access, and a code block
    // must render regardless.
    return false;
  }
}

function writeWrapPreference(value: boolean): void {
  try {
    window.localStorage.setItem(WRAP_STORAGE_KEY, value ? "1" : "0");
  } catch {
    // Per-viewer convenience only; losing it costs nothing.
  }
}

const HighlightedLineView = React.memo(function HighlightedLineView({
  line,
  mode
}: {
  line: HighlightedLine;
  mode: "light" | "dark";
}) {
  return (
    <span className="block min-h-[1.4em]">
      {line.map((token, index) => (
        <span
          // A line's token positions are stable as the document grows.
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          style={token.cls === null ? undefined : { color: tokenColor(mode, token.cls) }}
        >
          {token.text}
        </span>
      ))}
    </span>
  );
});

export const CodeBlock = React.memo(function CodeBlock({
  code,
  info,
  streaming,
  mode
}: CodeBlockProps): React.ReactElement {
  const label = fenceLanguageLabel(info);
  const parser = useLanguageParser(info);
  const [wrapped, setWrapped] = React.useState(readWrapPreference);

  // Once a block has streamed it keeps the incremental renderer forever, so a
  // settle never swaps the DOM under a selection.
  const [hasStreamed, setHasStreamed] = React.useState(streaming);
  if (streaming && !hasStreamed) setHasStreamed(true);

  const incremental = React.useMemo(
    () => (parser !== null && hasStreamed ? createIncrementalTreeHighlighter(parser) : null),
    [parser, hasStreamed]
  );

  const lines = React.useMemo<HighlightedLine[]>(() => {
    if (parser === null) return plainLines(code);
    if (incremental !== null) return incremental(code);
    const key = highlightCacheKey(code, label, mode);
    const cached = highlightCache.get(key);
    if (cached !== null) return cached;
    const highlighted = highlightCode(code, parser);
    highlightCache.set(key, highlighted, estimateHighlightSize(code, highlighted));
    return highlighted;
  }, [code, incremental, label, mode, parser]);

  const toggleWrap = React.useCallback(() => {
    setWrapped((value) => {
      writeWrapPreference(!value);
      return !value;
    });
  }, []);

  return (
    <div
      data-language={label}
      data-wrap={wrapped ? "true" : "false"}
      className="my-[0.65rem] overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/60 first:mt-0 last:mb-0"
    >
      <div className="flex select-none items-center justify-between gap-2 pb-0 pl-3 pr-1.5 pt-1.5">
        <span className="min-w-0 truncate font-mono text-[11px] leading-4 text-neutral-500">
          {label || "text"}
        </span>
        <span className="flex items-center gap-0.5" role="toolbar" aria-label="Code block actions">
          <ChatIconButton
            size="xs"
            label={wrapped ? "Disable line wrap" : "Wrap lines"}
            aria-pressed={wrapped}
            onClick={toggleWrap}
          >
            <WrapText size={12} strokeWidth={1.8} aria-hidden />
          </ChatIconButton>
          {/* Code chrome never hover-reveals: the copy button is why the chrome exists. */}
          <CopyButton value={code} label="Copy code" size="xs" />
        </span>
      </div>
      <pre
        className={cn(
          "ac-scroll-thin m-0 overflow-x-auto px-[0.9rem] pb-[0.8rem] pt-1",
          "font-mono text-[length:var(--font-size-code,0.8125rem)] leading-relaxed",
          "text-neutral-200",
          wrapped && "whitespace-pre-wrap [overflow-wrap:anywhere]"
        )}
      >
        <code className="block">
          {lines.map((line, index) => (
            // A line's position is stable as tokens and new lines are appended.
            // eslint-disable-next-line react/no-array-index-key
            <HighlightedLineView key={index} line={line} mode={mode} />
          ))}
        </code>
      </pre>
    </div>
  );
});

export default CodeBlock;
