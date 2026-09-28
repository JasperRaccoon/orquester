/**
 * The block palette (workflows spec §7.2): the catalogue grouped Triggers ·
 * Agents · Code · Flow · Integrations, searchable, collapsible to a rail of
 * icons. Drag a block onto the canvas, or click it to add it in the middle of
 * the view (wired after the selected block when one is selected).
 */

import React, { useMemo, useState } from "react";
import { PanelLeftClose, PanelLeft, Search, X } from "lucide-react";

import { WORKFLOW_BLOCK_CATALOG, type WorkflowNodeType } from "@orquester/api";

import { cn } from "../../lib/cn";
import { filterPalette, PALETTE_GROUPS } from "../../lib/workflows/catalog-ui";
import { BlockTile } from "./AddBlockMenu";
import { BLOCK_DRAG_TYPE } from "./canvas/WorkflowCanvas";
import { FOCUS_RING } from "./ui/controls";

export interface BlockPaletteProps {
  open: boolean;
  onToggle: () => void;
  onAdd: (type: WorkflowNodeType) => void;
  disabled?: boolean;
}

function dragStart(event: React.DragEvent, type: WorkflowNodeType): void {
  event.dataTransfer.setData(BLOCK_DRAG_TYPE, type);
  event.dataTransfer.setData("text/plain", WORKFLOW_BLOCK_CATALOG[type].title);
  event.dataTransfer.effectAllowed = "copy";
}

export const BlockPalette: React.FC<BlockPaletteProps> = ({ open, onToggle, onAdd, disabled }) => {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => filterPalette(query), [query]);

  if (!open) {
    return (
      <aside
        aria-label="Blocks"
        className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-neutral-800 bg-neutral-950 py-2"
      >
        <button
          type="button"
          onClick={onToggle}
          aria-label="Show the block palette"
          title="Show blocks"
          className={cn("mb-1 flex h-8 w-8 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100", FOCUS_RING)}
        >
          <PanelLeft size={16} />
        </button>
        {PALETTE_GROUPS.flatMap((group) => group.types).map((type) => (
          <button
            key={type}
            type="button"
            draggable={!disabled}
            disabled={disabled}
            onDragStart={(event) => dragStart(event, type)}
            onClick={() => onAdd(type)}
            aria-label={`Add ${WORKFLOW_BLOCK_CATALOG[type].title}`}
            title={WORKFLOW_BLOCK_CATALOG[type].title}
            className={cn("rounded-lg p-0.5 transition-opacity hover:opacity-100 disabled:opacity-40", FOCUS_RING, "opacity-80")}
          >
            <BlockTile type={type} size="sm" />
          </button>
        ))}
      </aside>
    );
  }

  return (
    <aside aria-label="Blocks" className="flex w-[232px] shrink-0 flex-col border-r border-neutral-800 bg-neutral-950">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-neutral-800 pl-3 pr-1.5">
        <span className="text-[13px] font-medium text-neutral-100">Blocks</span>
        <button
          type="button"
          onClick={onToggle}
          aria-label="Hide the block palette"
          title="Hide blocks"
          className={cn("flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100", FOCUS_RING)}
        >
          <PanelLeftClose size={15} />
        </button>
      </div>
      <div className="p-2">
        <div className="relative">
          <Search size={13} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="Search blocks"
            aria-label="Search blocks"
            className="h-8 w-full rounded-lg border border-neutral-800 bg-neutral-900/60 pl-7 pr-7 text-[12.5px] text-neutral-100 placeholder:text-neutral-500 focus:border-neutral-600 focus:outline-none [&::-webkit-search-cancel-button]:appearance-none"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-neutral-500 hover:text-neutral-200"
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {groups.length === 0 ? <p className="px-2 py-4 text-xs text-neutral-500">No block matches.</p> : null}
        {groups.map((group) => (
          <div key={group.id} className="mb-2">
            <div className="px-1.5 pb-1 pt-2 text-[11px] font-medium text-neutral-500">{group.label}</div>
            {group.types.map((type) => {
              const entry = WORKFLOW_BLOCK_CATALOG[type];
              return (
                <button
                  key={type}
                  type="button"
                  draggable={!disabled}
                  disabled={disabled}
                  onDragStart={(event) => dragStart(event, type)}
                  onClick={() => onAdd(type)}
                  title={entry.description}
                  className={cn(
                    "group flex w-full cursor-grab items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors active:cursor-grabbing",
                    "hover:bg-neutral-900 disabled:cursor-not-allowed disabled:opacity-40",
                    FOCUS_RING
                  )}
                >
                  <BlockTile type={type} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-neutral-200 group-hover:text-neutral-50">
                    {entry.title}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <p className="border-t border-neutral-800 px-3 py-2 text-[10.5px] leading-4 text-neutral-500">
        Drag onto the canvas, or press Tab over it.
      </p>
    </aside>
  );
};
