import React from "react";
import { Code2, Quote, X } from "lucide-react";

import { cn } from "../../../lib/cn";
import { ChatIconButton, DisclosureChevron } from "../primitives";
import { ChatMarkdown } from "../timeline/markdown/ChatMarkdown";
import { isCodeQuote, quoteExcerpt, type ComposerQuote } from "./composer-quotes";

export interface ComposerQuotesProps {
  quotes: readonly ComposerQuote[];
  onRemove: (id: string) => void;
  disabled?: boolean;
}

/**
 * The draft's quotes above the textarea: one compact block per passage, in
 * the order they were quoted, each a two-line excerpt that opens to the whole
 * passage (rendered as the markdown it will be sent as) and closes again, and
 * an X that takes it out of the draft.
 *
 * Full-width blocks rather than inline chips: a two-line excerpt needs the
 * width, and on a phone a row of chips would wrap into a column anyway. The
 * list scrolls past a share of the viewport, so many quotes never push the
 * textarea off a short screen.
 */
export function ComposerQuotes({
  quotes,
  onRemove,
  disabled = false
}: ComposerQuotesProps): React.ReactElement | null {
  const [open, setOpen] = React.useState<ReadonlySet<string>>(() => new Set());
  const baseId = React.useId();

  // An id that left the draft leaves the open set with it, so a quote that
  // comes back (a failed send) opens collapsed, as it was quoted.
  const idList = quotes.map((quote) => quote.id).join("\u0000");
  React.useEffect(() => {
    setOpen((current) => {
      const live = new Set(idList.split("\u0000"));
      const next = new Set([...current].filter((id) => live.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [idList]);

  if (quotes.length === 0) return null;

  const toggle = (id: string): void => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <ul
      data-chat-composer-quotes="true"
      aria-label={quotes.length === 1 ? "Quoted passage" : `${quotes.length} quoted passages`}
      className="ac-scroll-thin flex max-h-[40vh] flex-col gap-1.5 overflow-y-auto pb-2"
    >
      {quotes.map((quote) => {
        const expanded = open.has(quote.id);
        const code = isCodeQuote(quote.text);
        const panelId = `${baseId}-${quote.id}`;
        const Icon = code ? Code2 : Quote;
        return (
          <li
            key={quote.id}
            data-composer-quote={quote.id}
            className="min-w-0 rounded-md border border-l-2 border-neutral-800 border-l-neutral-600 bg-neutral-900/60"
          >
            <div className="flex min-w-0 items-start gap-1 py-1 pl-2 pr-1">
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={expanded ? panelId : undefined}
                title={expanded ? "Hide the whole quote" : "Show the whole quote"}
                onClick={() => toggle(quote.id)}
                className={cn(
                  "flex min-w-0 flex-1 items-start gap-1.5 rounded text-left",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
                )}
              >
                <Icon size={12} strokeWidth={1.8} aria-hidden className="mt-[3px] shrink-0 text-neutral-500" />
                <span
                  className={cn(
                    "min-w-0 flex-1 text-neutral-300 [overflow-wrap:anywhere]",
                    code ? "font-mono text-[11px] leading-[1.125rem]" : "text-xs leading-[1.125rem]",
                    // Collapsed it is the excerpt; open, the panel below says the rest.
                    "line-clamp-2"
                  )}
                >
                  <span className="sr-only">Quote: </span>
                  {quoteExcerpt(quote.text)}
                </span>
                <span className="mt-px shrink-0">
                  <DisclosureChevron open={expanded} />
                </span>
              </button>
              <ChatIconButton
                label="Remove quote"
                size="micro"
                disabled={disabled}
                onClick={() => onRemove(quote.id)}
              >
                <X size={10} aria-hidden />
              </ChatIconButton>
            </div>
            {expanded ? (
              <div
                id={panelId}
                className="ac-scroll-thin max-h-60 overflow-y-auto border-t border-neutral-800 px-2.5 py-2"
              >
                <ChatMarkdown text={quote.text} className="text-[13px]" />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
