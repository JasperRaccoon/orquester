/**
 * The kind tabs: one per kind the agent has — icon, label and a count badge —
 * single-select, WRAPPING onto more lines rather than scrolling, so no tab is
 * ever cut off at any panel width (the dock's 260–560 px, a phone's sheet).
 *
 * The shown tab is filled (the app's selected neutral: 100 on 900, which the
 * light palette inverts); the rest are outlined pills, and a kind with nothing
 * in it reads muted. While the search is on it looks across every kind, so
 * the tabs step back (no fill, dimmed) and a line says so; picking a tab then
 * leaves the search for that tab (the container's `onChange`).
 *
 * A WAI-ARIA tablist: one tab stop (the selected tab), ←/→ (wrapping) and
 * Home/End move and select. Only those keys are handled — and kept from
 * travelling on; Escape passes, for the dock (`dock-keyboard.ts`).
 */

import React from "react";
import { Puzzle, Search, Server, Sparkles, SquareSlash, Store, Webhook, type LucideIcon } from "lucide-react";

import type { ProfileItemKind } from "@orquester/api";

import { cn } from "../../../lib/cn";
import type { ProfileKindTab } from "./list.logic";

export const PROFILE_KIND_ICONS: Record<ProfileItemKind, LucideIcon> = {
  mcp: Server,
  skill: Sparkles,
  plugin: Puzzle,
  marketplace: Store,
  hook: Webhook,
  command: SquareSlash
};

/** The DOM id of `kind`'s tab under the tablist `baseId` (the list's `aria-labelledby`). */
export function kindTabId(baseId: string, kind: ProfileItemKind): string {
  return `${baseId}-tab-${kind}`;
}

/** Where a roving key moves from `index` among `count` tabs, or `null` for a key the tabs leave alone. */
export function kindTabKeyTarget(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

export interface KindTabsProps {
  tabs: readonly ProfileKindTab[];
  value: ProfileItemKind;
  onChange: (kind: ProfileItemKind) => void;
  /** The search is on and looks across every kind: the tabs step back. */
  searching: boolean;
  sheet: boolean;
  /** Prefix of the tabs' ids. */
  baseId: string;
  /** The id of the list the tabs control. */
  panelId: string;
}

export const KindTabs: React.FC<KindTabsProps> = ({ tabs, value, onChange, searching, sheet, baseId, panelId }) => {
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    // From the focused tab, else the selected one.
    const focused = (event.target as HTMLElement).getAttribute?.("data-kind-tab");
    const index = tabs.findIndex((tab) => tab.id === (focused ?? value));
    const target = kindTabKeyTarget(event.key, Math.max(index, 0), tabs.length);
    if (target === null) return;
    event.preventDefault();
    event.stopPropagation();
    const next = tabs[target]!;
    onChange(next.id);
    const button = event.currentTarget.ownerDocument.getElementById(kindTabId(baseId, next.id));
    button?.focus();
  };

  return (
    <div className="space-y-1.5">
      <div
        role="tablist"
        aria-label="Kinds"
        aria-orientation="horizontal"
        data-kind-tabs=""
        data-searching={searching ? "" : undefined}
        onKeyDown={onKeyDown}
        className={cn(
          "flex flex-wrap transition-opacity",
          sheet ? "gap-1.5" : "gap-1",
          searching && "opacity-60 hover:opacity-100"
        )}
      >
        {tabs.map((tab) => {
          const selected = tab.id === value;
          const filled = selected && !searching;
          const empty = tab.count === 0;
          const Icon = PROFILE_KIND_ICONS[tab.id];
          return (
            <button
              key={tab.id}
              id={kindTabId(baseId, tab.id)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              data-kind-tab={tab.id}
              onClick={() => onChange(tab.id)}
              className={cn(
                "inline-flex max-w-full shrink-0 items-center whitespace-nowrap rounded-full border font-medium transition-colors",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500 focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-950",
                // A 40 px target on a phone; a comfortable 32 px in the dock,
                // kept snug so the 260 px dock pairs the tabs up where it can.
                sheet ? "h-10 gap-2 pl-3 pr-2 text-[13px]" : "h-8 gap-1 pl-2 pr-1.5 text-xs",
                filled
                  ? "border-neutral-100 bg-neutral-100 text-neutral-900"
                  : selected
                    ? "border-neutral-500 bg-neutral-900/60 text-neutral-100"
                    : empty
                      ? "border-neutral-800/70 text-neutral-500 hover:border-neutral-700 hover:text-neutral-300"
                      : "border-neutral-800 bg-neutral-900/40 text-neutral-300 hover:border-neutral-700 hover:bg-neutral-800/60 hover:text-neutral-100"
              )}
            >
              <Icon
                size={sheet ? 15 : 13}
                aria-hidden
                className={cn("shrink-0", filled ? "text-neutral-700" : empty ? "text-neutral-600" : "text-neutral-400")}
              />
              {tab.label}
              <span
                data-kind-count=""
                className={cn(
                  "ml-0.5 inline-flex min-w-[1.25rem] items-center justify-center rounded-full text-[10.5px] font-semibold leading-4 tabular-nums",
                  sheet ? "px-1.5" : "px-1",
                  filled
                    ? "bg-neutral-900 text-neutral-100"
                    : empty
                      ? "bg-neutral-900/60 text-neutral-600"
                      : "bg-neutral-800 text-neutral-400"
                )}
              >
                <span className="sr-only">, </span>
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>
      {searching ? (
        <p data-kind-tabs-searching="" className="flex items-center gap-1.5 px-0.5 text-[11px] leading-4 text-neutral-500">
          <Search size={11} aria-hidden className="shrink-0" />
          <span className="min-w-0 break-words">
            Searching all kinds — clear the search to return to {tabs.find((tab) => tab.id === value)?.label ?? "the tab"}
          </span>
        </p>
      ) : null}
    </div>
  );
};
