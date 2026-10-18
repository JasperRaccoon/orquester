/**
 * One item of an Agent Profile (spec §5.2): its name, a short description,
 * the agent-scope tag ("all agents", "Claude only"), the on/off switch and a
 * "…" menu (Edit · Delete). Agents in scope that cannot load it (an MCP
 * transport the agent lacks) are an amber note — the item still loads for
 * the others. Off rows are dimmed; the row never shifts around its controls.
 *
 * Presentational: everything arrives as props.
 */

import React from "react";
import { Loader2, MoreHorizontal, Pencil, Trash2 } from "lucide-react";

import type { SessionProfileItem } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { agentLabel, scopeLabel } from "../../../lib/session-profiles/logic";
import { AdaptiveMenu } from "../../ui/adaptive-menu";
import { DropdownItem, DropdownSeparator } from "../../ui/dropdown";
import { WarningChip } from "../agent-profile/InstructionsCard";
import { RailSwitch, railCardClass } from "../primitives";

const FOCUS_RING = "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500";

export const SessionProfileItemRow: React.FC<{
  item: SessionProfileItem;
  sheet: boolean;
  busy: boolean;
  /** Just saved by the editor: outlined for a moment. */
  highlighted?: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}> = ({ item, sheet, busy, highlighted = false, onToggle, onEdit, onDelete }) => {
  const secondLine =
    item.description ??
    (item.kind === "mcp"
      ? item.mcp.transport === "stdio"
        ? [item.mcp.command, ...(item.mcp.args ?? [])].filter(Boolean).join(" ")
        : (item.mcp.url ?? "")
      : item.kind === "hook"
        ? `${item.hook.event}${item.hook.matcher ? ` · ${item.hook.matcher}` : ""}`
        : item.kind === "plugin"
          ? [item.plugin.marketplace, item.plugin.version].filter(Boolean).join(" · ")
          : "");
  const scope = scopeLabel(item.agents);
  return (
    <div
      data-session-profile-item={item.id}
      aria-busy={busy ? true : undefined}
      className={cn(railCardClass(false), highlighted && "border-neutral-500 bg-neutral-900/80 ring-1 ring-neutral-500/50")}
    >
      <div className={cn("flex items-center gap-1 pl-3 pr-1", sheet ? "min-h-14 py-1" : "min-h-12 py-1.5")}>
        <div className={cn("min-w-0 flex-1 transition-opacity", !item.enabled && "opacity-55")}>
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            <span title={item.name} className="min-w-0 truncate text-[13px] font-medium text-neutral-100">
              {item.name}
            </span>
            {!item.enabled ? <span className="sr-only">(off)</span> : null}
            <span
              data-scope-tag=""
              title={`Applies to ${scope}`}
              className="inline-block min-w-[2.5rem] shrink-[100] truncate rounded-md border border-neutral-700/80 px-1.5 py-px text-[10px] leading-4 text-neutral-400"
            >
              {scope}
            </span>
            {busy ? <Loader2 size={12} aria-hidden className="shrink-0 animate-spin text-neutral-500" /> : null}
          </div>
          {secondLine ? (
            <p title={secondLine} className="mt-0.5 line-clamp-1 break-words text-xs leading-4 text-neutral-400">
              {secondLine}
            </p>
          ) : null}
        </div>
        <RailSwitch
          checked={item.enabled}
          sheet={sheet}
          label={`${item.name} ${item.enabled ? "on" : "off"}`}
          title={item.enabled ? "On — click to turn it off for this profile" : "Off — click to turn it on"}
          busy={busy}
          onChange={onToggle}
        />
        <AdaptiveMenu
          align="right"
          width="w-48"
          title={item.name}
          focusOnOpen
          triggerClassName={cn("shrink-0 rounded-md", FOCUS_RING)}
          trigger={
            <span
              title="More actions"
              className={cn(
                "inline-flex shrink-0 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100",
                sheet ? "h-10 w-10" : "h-7 w-7"
              )}
            >
              <MoreHorizontal size={15} aria-hidden />
              <span className="sr-only">More actions for {item.name}</span>
            </span>
          }
        >
          <DropdownItem icon={<Pencil size={14} />} onClick={onEdit} className={cn(sheet && "py-3")}>
            {item.kind === "plugin" ? "Details" : "Edit"}
          </DropdownItem>
          <DropdownSeparator />
          <DropdownItem
            icon={<Trash2 size={14} />}
            onClick={onDelete}
            className={cn("text-danger hover:bg-danger-500/10 hover:text-danger", sheet && "py-3")}
          >
            Delete
          </DropdownItem>
        </AdaptiveMenu>
      </div>
      {item.unsupported && item.unsupported.length > 0 ? (
        <div className={cn("flex flex-wrap gap-1.5 px-3", sheet ? "-mt-2 pb-1" : "-mt-0.5 pb-2")}>
          {item.unsupported.map((entry) => (
            <WarningChip key={entry.agent} message={`Skipped for ${agentLabel(entry.agent)}: ${entry.reason}`} />
          ))}
        </div>
      ) : null}
    </div>
  );
};
