import React from "react";
import { File as FileIcon, Folder, Sparkles, Target, TerminalSquare, Wand2 } from "lucide-react";

import { cn } from "../../../lib/cn";
import type { ComposerMenuItem } from "./composer-menu";

export interface ComposerTokenMenuProps {
  items: readonly ComposerMenuItem[];
  highlightedIndex: number;
  /** Hovering moves the highlight, so the pointer and the keyboard agree. */
  onHighlight: (index: number) => void;
  onPick: (item: ComposerMenuItem) => void;
  /** Rendered instead of the list while a path search is in flight. */
  loading?: boolean;
  emptyLabel: string;
  id: string;
}

function iconFor(item: ComposerMenuItem): React.ReactNode {
  switch (item.type) {
    case "path":
      return item.pathKind === "dir" ? <Folder size={12} aria-hidden /> : <FileIcon size={12} aria-hidden />;
    case "host-command":
      // The goal chip's glyph (goals §8.2), so `/goal` reads as that feature.
      return item.command === "goal" ? <Target size={12} aria-hidden /> : <Wand2 size={12} aria-hidden />;
    case "provider-command":
      return <TerminalSquare size={12} aria-hidden />;
    case "skill":
      return <Sparkles size={12} aria-hidden />;
  }
}

/**
 * The token overlay — the `@`, `/` and `$` menus (§4.6.7, §7.4).
 *
 * It sits **above** the composer rather than over the timeline: the composer
 * is pinned to the bottom of the view, so a menu below it would be off screen.
 * It is a `listbox` the textarea owns through `aria-activedescendant`, never a
 * focus trap — **focus stays in the textarea the whole time**, which is what
 * lets the user keep typing to narrow the list.
 *
 * The highlight follows the pointer as well as the arrow keys, so hovering one
 * row and pressing Enter can never commit a different one.
 */
export function ComposerTokenMenu({
  items,
  highlightedIndex,
  onHighlight,
  onPick,
  loading,
  emptyLabel,
  id
}: ComposerTokenMenuProps): React.ReactElement {
  const listRef = React.useRef<HTMLDivElement>(null);

  // Keep the highlighted row in view when the arrow keys walk past the edge.
  React.useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('[data-highlighted="true"]');
    node?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  return (
    <div
      id={id}
      role="listbox"
      aria-label="Composer suggestions"
      data-chat-composer-floating-layer="true"
      ref={listRef}
      className={cn(
        "ac-scroll-thin ac-banner-enter mb-1 max-h-64 overflow-y-auto rounded-xl border",
        "border-neutral-800 bg-neutral-900 p-1 shadow-xl shadow-black/40"
      )}
    >
      {loading ? (
        <p className="px-2 py-2 text-xs text-neutral-500">Searching…</p>
      ) : items.length === 0 ? (
        <p className="px-2 py-2 text-xs text-neutral-500">{emptyLabel}</p>
      ) : (
        items.map((item, index) => {
          const highlighted = index === highlightedIndex;
          return (
            <div
              key={item.id}
              id={`${id}-option-${index}`}
              role="option"
              aria-selected={highlighted}
              data-highlighted={highlighted ? "true" : undefined}
              // Pointer down must not blur the textarea: the caret is what the
              // insertion is measured against.
              onPointerDown={(event) => event.preventDefault()}
              onMouseEnter={() => onHighlight(index)}
              onClick={() => onPick(item)}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5",
                highlighted ? "bg-neutral-800 text-neutral-100" : "text-neutral-300"
              )}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center text-neutral-500">
                {iconFor(item)}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                {item.type === "host-command" && item.hint ? (
                  // The argument grammar rides beside the name (goals §8.5):
                  // `/goal` is typed on, so what may follow it is the point.
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="shrink-0 text-sm">{item.label}</span>
                    <span className="min-w-0 truncate font-mono text-[11px] text-neutral-500">
                      {item.hint}
                    </span>
                  </span>
                ) : (
                  <span className="truncate text-sm">{item.label}</span>
                )}
                {item.description ? (
                  <span className="truncate text-[11px] text-neutral-500">{item.description}</span>
                ) : null}
              </span>
              {item.type === "skill" && item.skill.scope ? (
                <span className="shrink-0 rounded border border-neutral-800 px-1 font-mono text-[10px] text-neutral-500">
                  {item.skill.scope}
                </span>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}
