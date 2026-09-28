/**
 * The phone's add menu (workflows spec §7.4): the block catalogue in a sheet —
 * a search field, then every block that fits where it goes, grouped, each a
 * finger-sized row with its tile and a line of what it does. "+ Add after" on
 * a step, the empty workflow's "Add first step" and the toolbar's Add open it.
 */

import React, { useMemo, useState } from "react";
import { Search, X } from "lucide-react";

import { WORKFLOW_BLOCK_CATALOG, type WorkflowNodeType } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { filterPalette } from "../../../lib/workflows/catalog-ui";
import { BlockTile } from "../AddBlockMenu";
import { WorkflowSheet } from "./WorkflowSheet";

export interface AddBlockSheetProps {
  open: boolean;
  onClose: () => void;
  /** Where the block goes ("After Review · on failure"). */
  context?: string | null;
  /** Triggers (and notes) only when the block is not wired from an output. */
  allowTriggers: boolean;
  /** Only triggers (an empty workflow's first block). */
  triggersOnly?: boolean;
  onPick: (type: WorkflowNodeType) => void;
}

/** The catalogue's `code` spans as code. */
function withCode(text: string): React.ReactNode {
  return text.split(/`([^`]+)`/).map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} className="rounded bg-neutral-800/80 px-1 font-mono text-[11.5px] text-neutral-300">
        {part}
      </code>
    ) : (
      part
    )
  );
}

export const AddBlockSheet: React.FC<AddBlockSheetProps> = ({ open, onClose, context, allowTriggers, triggersOnly = false, onPick }) => {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const all = filterPalette(query, { allowTriggers: allowTriggers || triggersOnly, allowNotes: allowTriggers && !triggersOnly });
    return triggersOnly ? all.filter((group) => group.id === "triggers") : all;
  }, [query, allowTriggers, triggersOnly]);
  const count = groups.reduce((sum, group) => sum + group.types.length, 0);

  const close = (): void => {
    setQuery("");
    onClose();
  };

  return (
    <WorkflowSheet
      open={open}
      onClose={close}
      label={triggersOnly ? "Add a trigger" : "Add a block"}
      title={triggersOnly ? "Add a trigger" : "Add a step"}
      subtitle={context ?? (triggersOnly ? "What starts this workflow" : undefined)}
      size="full"
    >
      <div className="sticky top-0 z-[1] bg-neutral-950 px-4 pb-2">
        <div className="relative">
          <Search size={16} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search blocks"
            aria-label="Search blocks"
            enterKeyHint="search"
            className="h-11 w-full rounded-xl border border-neutral-800 bg-neutral-900 pl-10 pr-10 text-base text-neutral-100 placeholder:text-neutral-500 focus:border-neutral-600 focus:outline-none"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear the search"
              onClick={() => setQuery("")}
              className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-neutral-500 hover:text-neutral-200"
            >
              <X size={16} />
            </button>
          ) : null}
        </div>
      </div>
      <div role="listbox" aria-label="Blocks" className="px-2 pb-4">
        {count === 0 ? (
          <p className="px-3 py-10 text-center text-sm text-neutral-500">No block matches “{query}”.</p>
        ) : (
          groups.map((group) => (
            <div key={group.id} className="pt-2">
              <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{group.label}</div>
              {group.types.map((type) => {
                const entry = WORKFLOW_BLOCK_CATALOG[type];
                return (
                  <button
                    key={type}
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => {
                      setQuery("");
                      onPick(type);
                    }}
                    className={cn(
                      "flex min-h-[60px] w-full items-center gap-3.5 rounded-xl px-3 py-2 text-left transition-colors",
                      "hover:bg-neutral-900 active:bg-neutral-800 focus:outline-none focus-visible:bg-neutral-900"
                    )}
                  >
                    <BlockTile type={type} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-medium leading-5 text-neutral-100">{entry.title}</span>
                      <span className="line-clamp-2 text-[12.5px] leading-[18px] text-neutral-500">{withCode(entry.description)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
    </WorkflowSheet>
  );
};
