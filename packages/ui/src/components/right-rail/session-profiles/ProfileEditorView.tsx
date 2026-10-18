/**
 * One Agent Profile, drilled into from the library (agent profiles spec
 * §5.2, "Option A"): a header with the back arrow, the icon and name, the
 * gear (profile settings) and a "⋯" menu (Rename · Duplicate · Export · Delete); the
 * per-agent readiness line; the Instructions row; the icon segmented bar of
 * the five kinds; then "N of M on" with "+ Add <kind>" and the shown kind's
 * rows. The library and the editor are never side by side.
 *
 * Presentational: the container (`SessionProfilesPanel`) owns the store, the
 * dialogs and the item editor.
 */

import React from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Copy,
  Download,
  FileText,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings2,
  Trash2
} from "lucide-react";

import {
  SESSION_PROFILE_ITEM_KINDS,
  type SessionProfileDetail,
  type SessionProfileItem,
  type SessionProfileItemKind,
  type SessionProfilePrepareStatus
} from "@orquester/api";

import { cn } from "../../../lib/cn";
import {
  agentLabel,
  enabledLine,
  itemsOfKind,
  PROFILE_KIND_LABELS,
  readinessText,
  readinessTitle
} from "../../../lib/session-profiles/logic";
import type { SessionProfilesNotice } from "../../../lib/session-profiles/store";
import { AdaptiveMenu } from "../../ui/adaptive-menu";
import { Button } from "../../ui/button";
import { DropdownItem, DropdownSeparator } from "../../ui/dropdown";
import { RailEmptyState, railCardClass } from "../primitives";
import { NoticeLine } from "./NoticeLine";
import { ProfileIcon } from "./ProfileIcon";
import { ProfileImportActions, type ProfileImportActionHandlers } from "./ProfileImportActions";
import { profileKindTabId, ProfileKindBar } from "./ProfileKindBar";
import { SessionProfileItemRow } from "./SessionProfileItemRow";

const FOCUS_RING = "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500";

export interface ProfileEditorActions {
  back: () => void;
  openSettings: () => void;
  rename: () => void;
  duplicate: () => void;
  /** "⋯ → Export": a portable `.zip` (no secret values). Absent: not offered. */
  exportProfile?: () => void;
  remove: () => void;
  openInstructions: () => void;
  add: (kind: Exclude<SessionProfileItemKind, "plugin">) => void;
  toggle: (item: SessionProfileItem, enabled: boolean) => void;
  edit: (item: SessionProfileItem) => void;
  removeItem: (item: SessionProfileItem) => void;
  retry: () => void;
  dismissNotice: () => void;
}

export interface ProfileEditorViewProps {
  sheet: boolean;
  /** The profile, or `null` while it loads (the summary's name and icon stand in). */
  profile: SessionProfileDetail | null;
  fallback: { name: string; icon?: string } | null;
  loadError: string | null;
  kind: SessionProfileItemKind;
  onKindChange: (kind: SessionProfileItemKind) => void;
  pendingIds: ReadonlySet<string>;
  highlightId: string | null;
  notice: SessionProfilesNotice | null;
  actions: ProfileEditorActions;
  /**
   * The imports' quick actions and the Plugins tab's "+ Add plugin"
   * (`ProfileImportActions`). Absent: nothing is drawn for them.
   */
  importActions?: ProfileImportActionHandlers;
}

export const ProfileEditorView: React.FC<ProfileEditorViewProps> = (props) => {
  const { sheet, profile, kind, actions } = props;
  const name = profile?.name ?? props.fallback?.name ?? "Profile";
  const icon = profile?.icon ?? props.fallback?.icon;
  const baseId = React.useId();
  const panelId = `${baseId}-items`;
  const iconButton = cn(
    "inline-flex shrink-0 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100",
    FOCUS_RING,
    sheet ? "h-10 w-10" : "h-7 w-7"
  );

  const counts = {} as Record<SessionProfileItemKind, number>;
  for (const each of SESSION_PROFILE_ITEM_KINDS) counts[each] = profile ? itemsOfKind(profile.items, each).length : 0;
  const shown = profile ? itemsOfKind(profile.items, kind) : [];
  const addable = kind !== "plugin";
  const addPlugin = kind === "plugin" && profile !== null ? props.importActions?.addPlugin : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 px-3 pb-2 pt-1">
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={actions.back} title="Back to all profiles" className={cn(iconButton, "-ml-1")}>
            <ArrowLeft size={15} aria-hidden />
            <span className="sr-only">Back to all profiles</span>
          </button>
          <ProfileIcon icon={icon} size="sm" />
          <h3 title={name} className="min-w-0 flex-1 truncate text-[13px] font-semibold text-neutral-100">
            {name}
          </h3>
          <button
            type="button"
            onClick={actions.openSettings}
            disabled={profile === null}
            title="Profile settings"
            className={cn(iconButton, "disabled:opacity-40")}
          >
            <Settings2 size={15} aria-hidden />
            <span className="sr-only">Profile settings</span>
          </button>
          <AdaptiveMenu
            align="right"
            width="w-52"
            title={name}
            focusOnOpen
            triggerClassName={cn("shrink-0 rounded-md", FOCUS_RING)}
            trigger={
              <span title="More actions" className={iconButton}>
                <MoreHorizontal size={15} aria-hidden />
                <span className="sr-only">More actions for {name}</span>
              </span>
            }
          >
            <DropdownItem icon={<Pencil size={14} />} onClick={actions.rename} className={cn(sheet && "py-3")}>
              Rename
            </DropdownItem>
            <DropdownItem icon={<Copy size={14} />} onClick={actions.duplicate} className={cn(sheet && "py-3")}>
              Duplicate
            </DropdownItem>
            {actions.exportProfile ? (
              <DropdownItem icon={<Download size={14} />} onClick={actions.exportProfile} className={cn(sheet && "py-3")}>
                Export…
              </DropdownItem>
            ) : null}
            <DropdownSeparator />
            <DropdownItem
              icon={<Trash2 size={14} />}
              onClick={actions.remove}
              className={cn("text-danger hover:bg-danger-500/10 hover:text-danger", sheet && "py-3")}
            >
              Delete…
            </DropdownItem>
          </AdaptiveMenu>
        </div>
        {profile !== null ? (
          <>
            <ReadinessLine preparation={profile.preparation} />
            {profile.description ? (
              <p className="line-clamp-2 break-words px-0.5 text-xs leading-4 text-neutral-500">{profile.description}</p>
            ) : null}
            <button
              type="button"
              onClick={actions.openInstructions}
              data-profile-instructions=""
              className={cn(railCardClass(false), "group flex w-full items-center gap-3 pl-3 pr-1 text-left", FOCUS_RING, sheet ? "min-h-14 py-2.5" : "min-h-11 py-2")}
            >
              <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-neutral-800/80 text-neutral-300 ring-1 ring-neutral-700/60">
                <FileText size={14} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-neutral-100">Instructions</span>
                <span className="block truncate text-xs text-neutral-500">
                  {profile.hasInstructions ? "Every agent reads them in this profile's chats" : "None yet — write what every chat should know"}
                </span>
              </span>
              <span aria-hidden className={cn("flex shrink-0 items-center justify-center text-neutral-500 group-hover:text-neutral-200", sheet ? "w-10" : "w-7")}>
                <ChevronRight size={15} />
              </span>
            </button>
            <ProfileKindBar value={kind} counts={counts} onChange={props.onKindChange} baseId={baseId} panelId={panelId} sheet={sheet} />
          </>
        ) : null}
      </div>

      <div
        id={panelId}
        role={profile !== null ? "tabpanel" : undefined}
        aria-labelledby={profile !== null ? profileKindTabId(baseId, kind) : undefined}
        aria-busy={profile === null && props.loadError === null ? true : undefined}
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-3"
      >
        {props.notice !== null ? <NoticeLine notice={props.notice} sheet={sheet} onDismiss={actions.dismissNotice} /> : null}
        {profile === null ? (
          props.loadError !== null ? (
            <RailEmptyState
              title="Couldn't load the profile"
              hint={props.loadError}
              action={
                <Button type="button" size="sm" variant="outline" onClick={actions.retry} className={cn(sheet && "h-10")}>
                  Retry
                </Button>
              }
            />
          ) : (
            <div role="status" aria-label="Loading the profile" className="flex justify-center py-6 text-neutral-500">
              <Loader2 size={16} aria-hidden className="animate-spin" />
            </div>
          )
        ) : (
          <>
            <div className="flex items-center gap-2 px-0.5 pt-0.5">
              <span data-enabled-line="" className="min-w-0 flex-1 text-[11px] tabular-nums text-neutral-500">
                {enabledLine(shown)}
              </span>
              {addable ? (
                <button
                  type="button"
                  onClick={() => actions.add(kind as Exclude<SessionProfileItemKind, "plugin">)}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100",
                    FOCUS_RING,
                    sheet ? "h-10" : "h-7"
                  )}
                >
                  <Plus size={13} aria-hidden />
                  Add {PROFILE_KIND_LABELS[kind].one}
                </button>
              ) : addPlugin ? (
                <button
                  type="button"
                  onClick={() => addPlugin(profile)}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100",
                    FOCUS_RING,
                    sheet ? "h-10" : "h-7"
                  )}
                >
                  <Plus size={13} aria-hidden />
                  Add plugin
                </button>
              ) : null}
            </div>
            {props.importActions ? (
              <ProfileImportActions profile={profile} kind={kind} handlers={props.importActions} sheet={sheet} />
            ) : null}
            {shown.length === 0 ? (
              <RailEmptyState title={`No ${PROFILE_KIND_LABELS[kind].many.replace(/^(?!MCP)./, (c) => c.toLowerCase())} in this profile`} />
            ) : (
              shown.map((item) => (
                <SessionProfileItemRow
                  key={item.id}
                  item={item}
                  sheet={sheet}
                  busy={props.pendingIds.has(item.id)}
                  highlighted={props.highlightId === item.id}
                  onToggle={(enabled) => actions.toggle(item, enabled)}
                  onEdit={() => actions.edit(item)}
                  onDelete={() => actions.removeItem(item)}
                />
              ))
            )}
            {profile.itemErrors.length > 0 ? (
              <div role="note" className="space-y-1 rounded-lg border border-warn-500/40 bg-warn-500/10 px-2.5 py-2 text-xs">
                <p className="flex items-start gap-1.5 leading-5 text-warn">
                  <AlertTriangle size={13} aria-hidden className="mt-[3px] shrink-0" />
                  <span className="min-w-0 break-words">
                    {profile.itemErrors.length === 1 ? "An item could not be read" : "Some items could not be read"} — kept
                    on disk, never loaded.
                  </span>
                </p>
                <ul className="space-y-0.5 pl-5 text-[11px] text-neutral-400">
                  {profile.itemErrors.map((error, index) => (
                    <li key={`${error.itemId ?? "item"}:${index}`} className="break-words">
                      {error.itemId ? <span className="font-mono text-neutral-300">{error.itemId}: </span> : null}
                      {error.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
};

const READINESS_DOT: Record<SessionProfilePrepareStatus["state"], string> = {
  ready: "bg-ok",
  preparing: "bg-info animate-pulse",
  failed: "bg-danger",
  "not-prepared": "bg-neutral-600"
};

/** Claude · Codex · Grok · OpenCode — each ready / preparing / failed (the reason on hover). */
export const ReadinessLine: React.FC<{ preparation: readonly SessionProfilePrepareStatus[] }> = ({ preparation }) => (
  <ul aria-label="Readiness per agent" className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-0.5 text-[11px] text-neutral-400">
    {preparation.map((status) => (
      <li
        key={status.agent}
        data-readiness={status.agent}
        data-state={status.state}
        title={readinessTitle(status)}
        className="inline-flex items-center gap-1"
      >
        <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", READINESS_DOT[status.state])} />
        <span className={cn(status.state === "failed" && "text-danger")}>{agentLabel(status.agent)}</span>
        <span className="sr-only">: {readinessText(status)}</span>
      </li>
    ))}
  </ul>
);
