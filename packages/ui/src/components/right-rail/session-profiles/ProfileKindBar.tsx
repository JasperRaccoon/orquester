/**
 * The profile editor's icon segmented bar (agent profiles spec §5.2, "Option
 * A"): five equal cells — MCP, Skills, Plugins, Hooks, Commands — each its
 * icon, its item count and a small label; the selected cell is raised.
 * Settings is not a cell (it is the header's gear).
 *
 * A WAI-ARIA tablist: one tab stop, ←/→ (wrapping) and Home/End move and
 * select. Only those keys are handled; Escape passes, for the dock.
 */

import React from "react";
import { Puzzle, Server, Sparkles, SquareSlash, Webhook, type LucideIcon } from "lucide-react";

import type { SessionProfileItemKind } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { PROFILE_KIND_LABELS, PROFILE_KIND_ORDER } from "../../../lib/session-profiles/logic";

export const PROFILE_KIND_ICONS: Record<SessionProfileItemKind, LucideIcon> = {
  mcp: Server,
  skill: Sparkles,
  plugin: Puzzle,
  hook: Webhook,
  command: SquareSlash
};

export function profileKindTabId(baseId: string, kind: SessionProfileItemKind): string {
  return `${baseId}-kind-${kind}`;
}

export const ProfileKindBar: React.FC<{
  value: SessionProfileItemKind;
  counts: Record<SessionProfileItemKind, number>;
  onChange: (kind: SessionProfileItemKind) => void;
  baseId: string;
  panelId: string;
  sheet: boolean;
}> = ({ value, counts, onChange, baseId, panelId, sheet }) => {
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const index = PROFILE_KIND_ORDER.indexOf(value);
    const count = PROFILE_KIND_ORDER.length;
    const target =
      event.key === "ArrowRight"
        ? (index + 1) % count
        : event.key === "ArrowLeft"
          ? (index - 1 + count) % count
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? count - 1
              : null;
    if (target === null) return;
    event.preventDefault();
    event.stopPropagation();
    const next = PROFILE_KIND_ORDER[target]!;
    onChange(next);
    event.currentTarget.ownerDocument.getElementById(profileKindTabId(baseId, next))?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Item kinds"
      onKeyDown={onKeyDown}
      className="grid grid-cols-5 gap-0.5 rounded-xl bg-neutral-900/60 p-0.5 ring-1 ring-neutral-800"
    >
      {PROFILE_KIND_ORDER.map((kind) => {
        const selected = kind === value;
        const Icon = PROFILE_KIND_ICONS[kind];
        const label = PROFILE_KIND_LABELS[kind].short;
        return (
          <button
            key={kind}
            id={profileKindTabId(baseId, kind)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            data-kind-cell={kind}
            title={`${PROFILE_KIND_LABELS[kind].many}: ${counts[kind]}`}
            onClick={() => onChange(kind)}
            className={cn(
              "flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg transition-colors",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
              sheet ? "h-14" : "h-12",
              selected
                ? "bg-neutral-700/70 text-neutral-50 shadow-sm ring-1 ring-neutral-600/60"
                : "text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200"
            )}
          >
            <span className="flex items-center gap-1">
              <Icon size={sheet ? 15 : 13} aria-hidden className={selected ? "text-neutral-200" : "text-neutral-500"} />
              <span className="text-[12px] font-semibold tabular-nums">{counts[kind]}</span>
            </span>
            <span className="w-full truncate px-0.5 text-center text-[10px] leading-3">{label}</span>
          </button>
        );
      })}
    </div>
  );
};
