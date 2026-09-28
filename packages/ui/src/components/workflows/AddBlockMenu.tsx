/**
 * The add menu (workflows spec §7.2): opened by a "+" on an output, by the
 * "+" on a hovered edge, by Tab or a double-click on empty canvas. Search
 * first, arrows to move, Enter to add. From an output or into an edge it
 * offers only blocks that take an input.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

import { WORKFLOW_BLOCK_CATALOG, type WorkflowNodeType } from "@orquester/api";

import { cn } from "../../lib/cn";
import { accentClass, BLOCK_ICONS, filterPalette } from "../../lib/workflows/catalog-ui";
import { Popover } from "./ui/Popover";

export interface AddBlockMenuProps {
  open: boolean;
  point: { x: number; y: number };
  /** False when the new block is wired from an output (a trigger cannot take input). */
  allowTriggers: boolean;
  /** A short line saying where the block goes ("After Review · failure"). */
  context?: string | null;
  onPick: (type: WorkflowNodeType) => void;
  onClose: () => void;
}

export const BlockTile: React.FC<{ type: WorkflowNodeType; size?: "sm" | "md" }> = ({ type, size = "md" }) => {
  const Icon = BLOCK_ICONS[type];
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg",
        "bg-[rgb(var(--wf-accent)/0.13)] text-[rgb(var(--wf-accent))] ring-1 ring-inset ring-[rgb(var(--wf-accent)/0.22)]",
        accentClass(type),
        size === "sm" ? "h-7 w-7" : "h-8 w-8"
      )}
    >
      <Icon size={size === "sm" ? 14 : 15} strokeWidth={1.9} />
    </span>
  );
};

export const AddBlockMenu: React.FC<AddBlockMenuProps> = ({ open, point, allowTriggers, context, onPick, onClose }) => {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const groups = useMemo(() => filterPalette(query, { allowTriggers, allowNotes: allowTriggers }), [query, allowTriggers]);
  const flat = useMemo(() => groups.flatMap((group) => group.types), [groups]);

  useEffect(() => {
    setActive((current) => Math.min(current, Math.max(0, flat.length - 1)));
  }, [flat.length]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  let index = -1;
  return (
    <Popover open={open} anchor={{ point }} onClose={onClose} role="dialog" ariaLabel="Add a block" className="w-[320px]">
      <div className="border-b border-neutral-800 p-2">
        {context ? <div className="mb-1.5 truncate px-1 text-[11px] text-neutral-500">{context}</div> : null}
        <div className="relative">
          <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((current) => Math.min(flat.length - 1, current + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((current) => Math.max(0, current - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                const type = flat[active];
                if (type) onPick(type);
              }
            }}
            placeholder="Search blocks…"
            aria-label="Search blocks"
            role="combobox"
            aria-expanded="true"
            aria-controls="wf-add-block-list"
            className="h-9 w-full rounded-lg border border-neutral-800 bg-neutral-950/60 pl-8 pr-2 text-[13px] text-neutral-100 placeholder:text-neutral-500 focus:border-neutral-600 focus:outline-none"
          />
        </div>
      </div>
      <div ref={listRef} id="wf-add-block-list" role="listbox" aria-label="Blocks" className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {flat.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-neutral-500">No block matches “{query}”.</div>
        ) : (
          groups.map((group) => (
            <div key={group.id} className="mb-1 last:mb-0">
              <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-neutral-500">{group.label}</div>
              {group.types.map((type) => {
                index += 1;
                const current = index;
                const entry = WORKFLOW_BLOCK_CATALOG[type];
                return (
                  <button
                    key={type}
                    type="button"
                    role="option"
                    aria-selected={current === active}
                    data-index={current}
                    onMouseEnter={() => setActive(current)}
                    onClick={() => onPick(type)}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
                      current === active ? "bg-neutral-800/80" : "hover:bg-neutral-800/50"
                    )}
                  >
                    <BlockTile type={type} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium leading-5 text-neutral-100">{entry.title}</span>
                      <span className="line-clamp-2 text-[11px] leading-4 text-neutral-500">{entry.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-neutral-800 px-3 py-1.5 text-[10.5px] text-neutral-500">
        <span>
          <kbd className="font-sans text-neutral-400">↑↓</kbd> move
        </span>
        <span>
          <kbd className="font-sans text-neutral-400">Enter</kbd> add
        </span>
        <span>
          <kbd className="font-sans text-neutral-400">Esc</kbd> close
        </span>
      </div>
    </Popover>
  );
};
