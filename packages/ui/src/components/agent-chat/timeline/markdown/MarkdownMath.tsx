// Adapted from T3 Code (MIT): apps/web/src/components/chat/MarkdownMath.tsx
import React from "react";

import { cn } from "../../../../lib/cn";
import { CopyButton } from "../../primitives/CopyButton";
import { mathSource } from "./math";
import { useTypesetMath } from "./math-typeset";

/** Marks a rendered formula; its value is `inline` or `display`. Copy and quote read it. */
export const MATH_ATTR = "data-markdown-math";
/** The formula's TeX in markdown delimiters, which copying any part of the formula yields. */
export const MATH_COPY_ATTR = "data-markdown-copy";

export interface MarkdownMathProps {
  tex: string;
  display: boolean;
  /**
   * `false` inside a control (a question option's button): no tab stop, no
   * group role, no copy button, so the control stays the one thing to focus.
   */
  focusable?: boolean;
}

/**
 * One formula. Shows its TeX source until KaTeX has loaded, and keeps showing
 * it when KaTeX cannot parse it, so a bad formula reads as what the agent
 * wrote instead of failing the message. A formula wider than the column
 * scrolls on its own, reachable by keyboard; display math has a Copy TeX
 * button. Copying a selection that touches a formula yields its TeX
 * (`math-clipboard.ts`, through {@link MATH_COPY_ATTR}).
 */
export const MarkdownMath = React.memo(function MarkdownMath({
  tex,
  display,
  focusable = true
}: MarkdownMathProps): React.ReactElement {
  const trimmed = tex.trim();
  const source = mathSource(trimmed, display);
  const html = useTypesetMath(trimmed, display);
  return (
    <span
      className={cn(
        display
          ? "ac-math-display relative my-[0.65rem] block first:mt-0 last:mb-0"
          : "inline-block max-w-full align-middle whitespace-nowrap [overflow-wrap:normal]"
      )}
      {...{ [MATH_ATTR]: display ? "display" : "inline", [MATH_COPY_ATTR]: source }}
      role={focusable ? "group" : undefined}
      aria-label={focusable ? (display ? "Display equation" : "Inline equation") : undefined}
    >
      <span
        className="ac-scroll-thin block max-w-full overflow-x-auto overflow-y-hidden px-0.5 py-[3px] focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-neutral-600"
        tabIndex={focusable ? 0 : -1}
        aria-label={focusable ? (display ? "Scroll display equation" : "Scroll inline equation") : undefined}
      >
        <span className={display ? "inline-block w-max min-w-full" : "inline-block w-max"}>
          {html ? (
            // KaTeX's own markup, never provider text (see `math-typeset.ts`).
            <span dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <span className="whitespace-pre-wrap">{source}</span>
          )}
        </span>
      </span>
      {display && focusable ? (
        <span className="absolute right-1 top-1 select-none" data-quote-skip="">
          <CopyButton value={trimmed} label="Copy TeX" reveal className="bg-neutral-900/80" />
        </span>
      ) : null}
    </span>
  );
});
