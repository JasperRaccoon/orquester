/**
 * One item of an agent's profile: its name (truncated, the full name in a
 * tooltip), a one-line description, the source badge, the on/off switch and
 * the "…" menu (Edit · Manage in … · Copy to … · Copy file path · Delete).
 * The second line is the adapter's `meta` as words (`profileItemMetaParts`)
 * and the description. Off rows are dimmed; locked rows carry a lock;
 * warnings are amber chips — with a Trust button where the agent offers one,
 * and Copy path where the fix is in a file; an inherited row says where it is
 * managed.
 *
 * The row never shifts: the switch and the menu keep fixed widths (the menu's
 * place is held when it has nothing to offer), the badge shrinks before the
 * name does. On a phone (`sheet`) every target is 40 px, and Delete and a
 * copy's name collision ask on the row itself; docked the panel asks in a
 * dialog.
 *
 * Presentational: everything arrives as props.
 */

import React from "react";
import { ArrowUpRight, FileText, Loader2, Lock, MoreHorizontal, Pencil, ShieldCheck, Trash2 } from "lucide-react";

import {
  AGENT_PROFILE_AGENT_LABELS,
  type AgentProfileAgentId,
  type ProfileConflictPolicy,
  type ProfileItem
} from "@orquester/api";

import { cn } from "../../../lib/cn";
import { AdaptiveMenu } from "../../ui/adaptive-menu";
import { Button } from "../../ui/button";
import { DropdownItem, DropdownLabel, DropdownSeparator } from "../../ui/dropdown";
import { menuFocusIndex } from "../saved-prompts/SavedPromptItem";
import { RailSwitch, railCardClass } from "../primitives";
import { agentIcon } from "./AgentPicker";
import { WarningChip } from "./InstructionsCard";
import { manageInAgent, profileItemMetaParts, switchDisabledReason, switchLabel, switchTitle } from "./list.logic";

const FOCUS_RING = "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500";
const DANGER_ACTION = "text-danger hover:bg-danger-500/10 hover:text-danger";

/** A question asked on the row itself (the sheet): delete it, or what to do about a name taken on a copy. */
export type ProfileRowConfirm = { kind: "delete" } | { kind: "conflict"; toAgent: AgentProfileAgentId };

export interface ProfileItemRowProps {
  item: ProfileItem;
  agent: AgentProfileAgentId;
  variant: "docked" | "sheet";
  /** A change to this item is in flight. */
  busy: boolean;
  /** Just saved by the editor: outlined for a moment. */
  highlighted: boolean;
  /** The agents "Copy to…" offers (installed, and having this kind). */
  copyTargets: readonly AgentProfileAgentId[];
  confirm: ProfileRowConfirm | null;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onCopyTo: (agent: AgentProfileAgentId) => void;
  onCopyPath: () => void;
  onDelete: () => void;
  onTrust: () => void;
  onManageIn: (agent: AgentProfileAgentId) => void;
  onConfirmDelete: () => void;
  onResolveConflict: (policy: ProfileConflictPolicy) => void;
  onCancelConfirm: () => void;
}

/** Arrow keys, Home and End move between the menu's items (the menu promises them). */
function moveMenuFocus(event: React.KeyboardEvent<HTMLElement>): void {
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'));
  const next = menuFocusIndex(event.key, items.length, items.indexOf(document.activeElement as HTMLElement));
  if (next === null) return;
  event.preventDefault();
  items[next]?.focus();
}

export const ProfileItemRow: React.FC<ProfileItemRowProps> = (props) => {
  const { item, variant } = props;
  const sheet = variant === "sheet";
  const disabledReason = switchDisabledReason(item);
  const owner = manageInAgent(item);
  const hasMenu =
    item.editable || owner !== null || props.copyTargets.length > 0 || item.path !== undefined || item.deletable;
  const secondLine = [...profileItemMetaParts(item), ...(item.description ? [item.description] : [])].join(" · ");
  const menuButton = cn(
    "inline-flex shrink-0 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100",
    sheet ? "h-10 w-10" : "h-7 w-7"
  );
  const showFooter = item.warnings.length > 0 || owner !== null;

  return (
    <div
      data-profile-item={item.id}
      aria-busy={props.busy ? true : undefined}
      className={cn(
        railCardClass(false),
        props.highlighted && "border-neutral-500 bg-neutral-900/80 ring-1 ring-neutral-500/50"
      )}
    >
      <div className={cn("flex items-center gap-1 pl-3 pr-1", sheet ? "min-h-14 py-1" : "min-h-12 py-1.5")}>
        <div className={cn("min-w-0 flex-1 transition-opacity", !item.enabled && "opacity-55")}>
          <div className="flex min-w-0 items-center gap-1.5">
            {item.locked ? (
              <span className="inline-flex shrink-0 text-neutral-500" title={disabledReason ?? "Locked"}>
                <Lock size={11} aria-hidden />
                <span className="sr-only">(locked)</span>
              </span>
            ) : null}
            <span title={item.name} className="min-w-0 truncate text-[13px] font-medium text-neutral-100">
              {item.name}
            </span>
            {!item.enabled ? <span className="sr-only">(off)</span> : null}
            {item.source.type !== "user" ? (
              <span
                title={item.source.label}
                // Shrinks first (a large shrink factor), down to a stub.
                className="inline-block min-w-[2.5rem] shrink-[100] truncate rounded-md border border-neutral-700/80 px-1.5 py-px text-[10px] leading-4 text-neutral-400"
              >
                {item.source.label}
              </span>
            ) : null}
            {props.busy ? <Loader2 size={12} aria-hidden className="shrink-0 animate-spin text-neutral-500" /> : null}
          </div>
          {secondLine.length > 0 ? (
            <p title={secondLine} className="mt-0.5 line-clamp-1 break-words text-xs leading-4 text-neutral-400">
              {secondLine}
            </p>
          ) : null}
        </div>

        {/* A span carries the reason: a disabled button shows no tooltip in every browser. */}
        <span className="inline-flex shrink-0" title={disabledReason ?? undefined}>
          <RailSwitch
            checked={item.enabled}
            sheet={sheet}
            label={switchLabel(item)}
            title={disabledReason === null ? switchTitle(item) : undefined}
            disabled={disabledReason !== null}
            busy={props.busy}
            onChange={props.onToggle}
          />
        </span>

        {hasMenu ? (
          <AdaptiveMenu
            align="right"
            width="w-56"
            title={item.name}
            focusOnOpen
            triggerClassName={cn("shrink-0 rounded-md", FOCUS_RING)}
            trigger={
              // A span, not a button: the menu wraps its trigger in its own <button>.
              <span title="More actions" className={menuButton}>
                <MoreHorizontal size={15} aria-hidden />
                <span className="sr-only">More actions for {item.name}</span>
              </span>
            }
          >
            <div role="none" onKeyDown={moveMenuFocus}>
              {item.editable ? (
                <DropdownItem icon={<Pencil size={14} />} onClick={props.onEdit} className={cn(sheet && "py-3")}>
                  Edit
                </DropdownItem>
              ) : null}
              {owner !== null ? (
                <DropdownItem
                  icon={<ArrowUpRight size={14} />}
                  onClick={() => props.onManageIn(owner)}
                  className={cn(sheet && "py-3")}
                >
                  Manage in {AGENT_PROFILE_AGENT_LABELS[owner]}
                </DropdownItem>
              ) : null}
              {props.copyTargets.length > 0 ? (
                <>
                  <DropdownLabel>Copy to…</DropdownLabel>
                  {props.copyTargets.map((target) => (
                    <DropdownItem
                      key={target}
                      icon={agentIcon(target)}
                      onClick={() => props.onCopyTo(target)}
                      className={cn(sheet && "py-3")}
                    >
                      Copy to {AGENT_PROFILE_AGENT_LABELS[target]}
                    </DropdownItem>
                  ))}
                </>
              ) : null}
              {item.path !== undefined ? (
                <DropdownItem
                  icon={<FileText size={14} />}
                  title={item.path}
                  onClick={props.onCopyPath}
                  className={cn(sheet && "py-3")}
                >
                  Copy file path
                </DropdownItem>
              ) : null}
              {item.deletable ? (
                <>
                  <DropdownSeparator />
                  <DropdownItem
                    icon={<Trash2 size={14} />}
                    onClick={props.onDelete}
                    className={cn(DANGER_ACTION, sheet && "py-3")}
                  >
                    Delete
                  </DropdownItem>
                </>
              ) : null}
            </div>
          </AdaptiveMenu>
        ) : (
          // Nothing to offer: hold the menu's place so every row lines up.
          <span aria-hidden className={cn("shrink-0", sheet ? "w-10" : "w-7")} />
        )}
      </div>

      {showFooter ? (
        <div className="-mt-0.5 flex flex-wrap items-center gap-1.5 px-3 pb-2">
          {item.warnings.map((warning, index) => (
            <span key={`${index}:${warning.code}`} className="inline-flex min-w-0 max-w-full items-center gap-1.5">
              <WarningChip message={warning.message} />
              {warning.action === "trust" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={props.busy}
                  title={`Trust ${item.name} as it is now`}
                  onClick={props.onTrust}
                  className={cn("shrink-0 gap-1 px-2", sheet ? "h-10" : "h-6")}
                >
                  <ShieldCheck size={12} aria-hidden />
                  Trust
                </Button>
              ) : warning.action === "open-file" && item.path !== undefined ? (
                // The fix is in the file itself, on the daemon's host: hand over its path.
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  title={`Copy ${item.path}`}
                  onClick={props.onCopyPath}
                  className={cn("shrink-0 gap-1 px-2", sheet ? "h-10" : "h-6")}
                >
                  <FileText size={12} aria-hidden />
                  Copy path
                </Button>
              ) : null}
            </span>
          ))}
          {owner !== null ? (
            <button
              type="button"
              onClick={() => props.onManageIn(owner)}
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded text-[11px] text-neutral-400 underline-offset-2 hover:text-neutral-200 hover:underline",
                FOCUS_RING,
                sheet && "min-h-10 px-1"
              )}
            >
              Manage in {AGENT_PROFILE_AGENT_LABELS[owner]}
              <ArrowUpRight size={11} aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}

      {props.confirm !== null ? <RowConfirm {...props} confirm={props.confirm} sheet={sheet} /> : null}
    </div>
  );
};

/** The question asked on the row (the sheet). Escape answers Cancel. */
const RowConfirm: React.FC<ProfileItemRowProps & { confirm: ProfileRowConfirm; sheet: boolean }> = ({
  item,
  agent,
  confirm,
  sheet,
  onConfirmDelete,
  onResolveConflict,
  onCancelConfirm
}) => {
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onCancelConfirm();
  };
  const button = cn("w-full", sheet && "h-10");
  if (confirm.kind === "delete") {
    return (
      <div
        role="group"
        aria-label={`Delete ${item.name}`}
        onKeyDown={onKeyDown}
        className="mx-2 mb-2 space-y-2 rounded-lg border border-neutral-700 bg-neutral-950/40 p-2.5"
      >
        <p className="break-words text-xs leading-5 text-neutral-300">
          Delete <span className="font-medium text-neutral-100">{item.name}</span> from{" "}
          {AGENT_PROFILE_AGENT_LABELS[agent]}? A backup of the file is kept.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" variant="outline" autoFocus onClick={onCancelConfirm} className={button}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={onConfirmDelete}
            className={cn(button, "bg-danger-600 text-white hover:bg-danger-500")}
          >
            Delete
          </Button>
        </div>
      </div>
    );
  }
  const target = AGENT_PROFILE_AGENT_LABELS[confirm.toAgent];
  return (
    <div
      role="group"
      aria-label={`${target} already has ${item.name}`}
      onKeyDown={onKeyDown}
      className="mx-2 mb-2 space-y-2 rounded-lg border border-neutral-700 bg-neutral-950/40 p-2.5"
    >
      <p className="break-words text-xs leading-5 text-neutral-300">
        {target} already has <span className="font-medium text-neutral-100">{item.name}</span>. Replace it, or keep
        both (the copy gets a new name)?
      </p>
      <div className="grid grid-cols-3 gap-2">
        <Button type="button" onClick={() => onResolveConflict("replace")} className={button}>
          Replace
        </Button>
        <Button type="button" variant="outline" onClick={() => onResolveConflict("keep-both")} className={button}>
          Keep both
        </Button>
        <Button type="button" variant="ghost" autoFocus onClick={onCancelConfirm} className={button}>
          Cancel
        </Button>
      </div>
    </div>
  );
};
