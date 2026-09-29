/**
 * The Agent profile panel as drawn (spec §7.3): the agent picker, the
 * instructions card, the search and the kind tabs pinned at the top; the
 * notice, the unreadable-files banner and the shown tab's items — or, while
 * searching, the matches of every kind grouped by kind — scrolling between;
 * "+ Add" (the shown tab's kind first) and its hint pinned at the bottom.
 *
 * Presentational — `AgentProfilePanel` owns the store, the editor bridge and
 * the confirms. The layout follows the panel's own width (`useElementWidth`),
 * never the viewport's: the dock spans 260–560 px on any screen.
 */

import React from "react";
import { AlertTriangle, Check, Plus, X } from "lucide-react";

import {
  AGENT_PROFILE_AGENT_LABELS,
  PROFILE_ITEM_KIND_LABELS,
  type AgentProfileAgentId,
  type AgentProfileSnapshot,
  type ProfileConflictPolicy,
  type ProfileItem,
  type ProfileItemKind
} from "@orquester/api";

import { useElementWidth } from "../../../hooks/use-element-width";
import { cn } from "../../../lib/cn";
import type { AgentProfileNotice } from "../../../lib/agent-profile/store";
import { AdaptiveMenu } from "../../ui/adaptive-menu";
import { Button } from "../../ui/button";
import { DropdownItem } from "../../ui/dropdown";
import { RailEmptyState, RailSearchInput, RailSectionLabel } from "../primitives";
import { AgentPicker } from "./AgentPicker";
import { InstructionsCard } from "./InstructionsCard";
import { KindTabs, kindTabId } from "./KindTabs";
import {
  addMenuKinds,
  agentPickerLayout,
  emptyKindTitle,
  isProfileSearchActive,
  NOT_INSTALLED_HINT,
  notInstalledTitle,
  type AgentProfileAgentOption,
  type AgentProfileEmptyState,
  type ProfileItemGroup,
  type ProfileKindTab
} from "./list.logic";
import { ProfileItemRow, type ProfileRowConfirm } from "./ProfileItemRow";

/** What a row does; the container wires each to the store, the editor or a confirm. */
export interface ProfileItemActions {
  toggle: (item: ProfileItem, enabled: boolean) => void;
  edit: (item: ProfileItem) => void;
  copyTo: (item: ProfileItem, agent: AgentProfileAgentId) => void;
  copyPath: (item: ProfileItem) => void;
  /** Ask to delete: a dialog docked, the row itself in the sheet. */
  remove: (item: ProfileItem) => void;
  trust: (item: ProfileItem) => void;
  manageIn: (agent: AgentProfileAgentId) => void;
  confirmRemove: () => void;
  resolveConflict: (policy: ProfileConflictPolicy) => void;
  cancelConfirm: () => void;
}

interface AgentProfilePanelViewProps {
  variant: "docked" | "sheet";
  agent: AgentProfileAgentId;
  agents: readonly AgentProfileAgentOption[];
  onAgentChange: (agent: AgentProfileAgentId) => void;
  query: string;
  onQueryChange: (query: string) => void;
  /** The kind tab shown (the search, while on, looks past it). */
  kind: ProfileItemKind;
  onKindChange: (kind: ProfileItemKind) => void;
  tabs: readonly ProfileKindTab[];
  snapshot: AgentProfileSnapshot | null;
  /** The shown tab's items, or while searching the matches of every kind — grouped by kind. */
  groups: readonly ProfileItemGroup[];
  /** What the list shows instead of rows, or `null`. */
  empty: AgentProfileEmptyState | null;
  /** A refresh that failed over a snapshot still shown. */
  loadError: string | null;
  onRetry: () => void;
  notice: AgentProfileNotice | null;
  onDismissNotice: () => void;
  /** The clock the instructions card's "edited 2h ago" reads. */
  now: number;
  /** Ids of this agent's items with a change in flight. */
  pendingIds: ReadonlySet<string>;
  /** The item the editor just saved. */
  highlightId: string | null;
  /** The question a row asks on itself (the sheet only). */
  confirming: ({ itemId: string } & ProfileRowConfirm) | null;
  copyTargetsFor: (item: ProfileItem) => readonly AgentProfileAgentId[];
  actions: ProfileItemActions;
  onOpenInstructions: () => void;
  /** The kinds "+ Add" offers for this agent. */
  creatableKinds: readonly ProfileItemKind[];
  onAdd: (kind: ProfileItemKind) => void;
  /** The scrolling list (where a saved item is scrolled into view). */
  listRef?: React.Ref<HTMLDivElement>;
}

export const AgentProfilePanelView: React.FC<AgentProfilePanelViewProps> = (props) => {
  const sheet = props.variant === "sheet";
  // Only the picker's layout is kept, so a dock drag re-renders the panel
  // when it crosses the breakpoint, never on every pixel.
  const [rootRef, measuredLayout] = useElementWidth<HTMLDivElement, "segmented" | "dropdown">(agentPickerLayout);
  const pickerLayout = measuredLayout ?? agentPickerLayout(null);
  const label = AGENT_PROFILE_AGENT_LABELS[props.agent];
  const { snapshot, empty } = props;
  const notInstalled = empty?.kind === "not-installed";
  const hasSnapshot = snapshot !== null && !notInstalled;
  const searching = isProfileSearchActive(props.query);
  const canAdd = hasSnapshot && props.creatableKinds.length > 0;
  const baseId = React.useId();
  const panelId = `${baseId}-list`;

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 px-3 pb-2 pt-1">
        <AgentPicker
          agents={props.agents}
          value={props.agent}
          onChange={props.onAgentChange}
          layout={pickerLayout}
          sheet={sheet}
        />
        {hasSnapshot ? (
          <>
            <InstructionsCard
              info={snapshot.instructions}
              now={props.now}
              sheet={sheet}
              compact={pickerLayout === "dropdown"}
              onOpen={props.onOpenInstructions}
            />
            <RailSearchInput
              value={props.query}
              onChange={props.onQueryChange}
              // Short, so the narrowest dock never clips it; the name says whose.
              placeholder="Search profile…"
              label={`Search ${label}'s profile`}
            />
            <KindTabs
              tabs={props.tabs}
              value={props.kind}
              onChange={props.onKindChange}
              searching={searching}
              sheet={sheet}
              baseId={baseId}
              panelId={panelId}
            />
          </>
        ) : null}
      </div>

      <div
        ref={props.listRef}
        id={panelId}
        tabIndex={-1}
        // The shown tab's panel; while searching, the results of every kind.
        role={hasSnapshot && !searching ? "tabpanel" : undefined}
        aria-labelledby={hasSnapshot && !searching ? kindTabId(baseId, props.kind) : undefined}
        aria-label={
          !hasSnapshot ? `${label}'s profile` : searching ? `Search results in ${label}'s profile` : undefined
        }
        aria-busy={empty?.kind === "loading" ? true : undefined}
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-3 focus:outline-none"
      >
        {props.notice !== null ? (
          <NoticeRow notice={props.notice} sheet={sheet} onDismiss={props.onDismissNotice} />
        ) : null}
        {props.loadError !== null && hasSnapshot ? (
          <div className="flex items-center gap-2 px-0.5 text-xs text-neutral-500">
            <span className="min-w-0 flex-1 break-words">{props.loadError}</span>
            <button
              type="button"
              onClick={props.onRetry}
              className={cn(
                "shrink-0 rounded px-1 text-neutral-300 underline-offset-2 hover:underline",
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
                sheet && "min-h-10"
              )}
            >
              Retry
            </button>
          </div>
        ) : null}
        {hasSnapshot && snapshot.fileErrors.length > 0 ? <FileErrorsBanner snapshot={snapshot} /> : null}

        {empty !== null ? (
          <EmptyState
            empty={empty}
            agentLabel={label}
            sheet={sheet}
            creatable={props.creatableKinds}
            onAdd={props.onAdd}
            onRetry={props.onRetry}
          />
        ) : (
          props.groups.map((group) => (
            // One section per kind; while searching (every kind), its label heads it.
            <section key={group.kind} aria-label={group.label} className={cn("space-y-1.5", searching && "pt-2")}>
              {searching ? (
                <RailSectionLabel>
                  {group.label}
                  <span className="ml-1.5 tabular-nums text-neutral-600">{group.items.length}</span>
                </RailSectionLabel>
              ) : null}
              {group.items.map((item) => (
                <ProfileItemRow
                  key={item.id}
                  item={item}
                  agent={props.agent}
                  variant={props.variant}
                  busy={props.pendingIds.has(item.id)}
                  highlighted={props.highlightId === item.id}
                  copyTargets={props.copyTargetsFor(item)}
                  confirm={
                    props.confirming?.itemId === item.id
                      ? props.confirming.kind === "delete"
                        ? { kind: "delete" }
                        : { kind: "conflict", toAgent: props.confirming.toAgent }
                      : null
                  }
                  onToggle={(enabled) => props.actions.toggle(item, enabled)}
                  onEdit={() => props.actions.edit(item)}
                  onCopyTo={(target) => props.actions.copyTo(item, target)}
                  onCopyPath={() => props.actions.copyPath(item)}
                  onDelete={() => props.actions.remove(item)}
                  onTrust={() => props.actions.trust(item)}
                  onManageIn={props.actions.manageIn}
                  onConfirmDelete={props.actions.confirmRemove}
                  onResolveConflict={props.actions.resolveConflict}
                  onCancelConfirm={props.actions.cancelConfirm}
                />
              ))}
            </section>
          ))
        )}
      </div>

      <div className="shrink-0 space-y-2 border-t border-neutral-800 px-3 py-3">
        {canAdd ? (
          <AdaptiveMenu
            align="left"
            width="w-56"
            title={`Add to ${label}`}
            focusOnOpen
            triggerClassName="flex w-full rounded-md focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
            trigger={
              // A span dressed as the primary button: the menu wraps it in its own <button>.
              <span
                className={cn(
                  "inline-flex w-full items-center justify-center gap-2 rounded-md bg-neutral-200 px-3 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-50",
                  sheet ? "h-10" : "h-8"
                )}
              >
                <Plus size={14} aria-hidden />
                Add
                <span className="sr-only"> to {label}'s profile</span>
              </span>
            }
          >
            {addMenuKinds(props.creatableKinds, props.kind).map((kind) => (
              <DropdownItem key={kind} onClick={() => props.onAdd(kind)} className={cn(sheet && "py-3")}>
                {PROFILE_ITEM_KIND_LABELS[kind].one}
              </DropdownItem>
            ))}
          </AdaptiveMenu>
        ) : (
          <Button type="button" disabled className={cn("w-full", sheet && "h-10")}>
            <Plus size={14} aria-hidden />
            Add
          </Button>
        )}
        {/* Wraps rather than clips: OpenCode's hint is two lines in a narrow dock. */}
        <p className="text-balance text-center text-[11px] leading-4 text-neutral-500">
          {props.agent === "opencode"
            ? "Applies to new sessions · OpenCode servers restart when idle"
            : "Changes apply to new sessions"}
        </p>
      </div>

      {/* The notice, read out: always mounted, so a new text is announced. */}
      <div role="status" className="sr-only">
        {props.notice?.tone === "ok" ? props.notice.text : ""}
      </div>
      <div role="alert" className="sr-only">
        {props.notice?.tone === "error" ? props.notice.text : ""}
      </div>
    </div>
  );
};

const NoticeRow: React.FC<{ notice: AgentProfileNotice; sheet: boolean; onDismiss: () => void }> = ({
  notice,
  sheet,
  onDismiss
}) => (
  <div
    data-profile-notice={notice.tone}
    className="flex items-start gap-2 rounded-lg border border-neutral-800 bg-neutral-900/60 py-2 pl-2.5 pr-1.5 text-xs"
  >
    {notice.tone === "ok" ? (
      <Check size={13} aria-hidden className="mt-px shrink-0 text-neutral-400" />
    ) : (
      <AlertTriangle size={13} aria-hidden className="mt-px shrink-0 text-danger" />
    )}
    <span className={cn("min-w-0 flex-1 break-words leading-5", notice.tone === "ok" ? "text-neutral-300" : "text-danger")}>
      {notice.text}
    </span>
    <button
      type="button"
      title="Dismiss"
      onClick={onDismiss}
      className={cn(
        "-my-1 inline-flex shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
        sheet ? "h-10 w-10" : "h-6 w-6"
      )}
    >
      <X size={12} aria-hidden />
      <span className="sr-only">Dismiss</span>
    </button>
  </div>
);

/** A partial snapshot: the files the agent's adapter could not parse — writes to them are refused. */
const FileErrorsBanner: React.FC<{ snapshot: AgentProfileSnapshot }> = ({ snapshot }) => (
  <div
    role="note"
    data-profile-file-errors=""
    className="space-y-1.5 rounded-lg border border-warn-500/40 bg-warn-500/10 px-2.5 py-2 text-xs"
  >
    <p className="flex items-start gap-1.5 leading-5 text-warn">
      <AlertTriangle size={13} aria-hidden className="mt-[3px] shrink-0" />
      <span className="min-w-0 break-words">
        {snapshot.fileErrors.length === 1 ? "A file could not be read" : "Some files could not be read"} — this list
        is partial, and changes to {snapshot.fileErrors.length === 1 ? "it" : "them"} are refused until fixed.
      </span>
    </p>
    <ul className="space-y-1 pl-5">
      {snapshot.fileErrors.map((error) => (
        <li key={error.path} className="min-w-0">
          <span title={error.path} className="block truncate font-mono text-[11px] text-neutral-200">
            {error.path}
          </span>
          <span className="block break-words text-[11px] leading-4 text-neutral-400">{error.message}</span>
        </li>
      ))}
    </ul>
  </div>
);

const LoadingRows: React.FC = () => (
  <div role="status" aria-label="Loading the profile" className="space-y-1.5 pt-1">
    <div className="h-2.5 w-20 rounded bg-neutral-800/70" />
    <div className="flex items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-900/40 p-3">
      <span className="h-8 w-8 shrink-0 rounded-lg bg-neutral-800/80 motion-safe:animate-pulse" />
      <span className="flex-1 space-y-2">
        <span className="block h-3 w-1/3 rounded bg-neutral-800/80 motion-safe:animate-pulse" />
        <span className="block h-2.5 w-1/2 rounded bg-neutral-800/60 motion-safe:animate-pulse" />
      </span>
    </div>
    <div className="h-2.5 w-24 rounded bg-neutral-800/70 pt-2" />
    {[0, 1, 2, 3].map((index) => (
      <div key={index} className="flex items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-900/40 px-3 py-3">
        <span className="flex-1 space-y-2">
          <span className="block h-3 w-2/5 rounded bg-neutral-800/80 motion-safe:animate-pulse" />
          <span className="block h-2.5 w-3/5 rounded bg-neutral-800/60 motion-safe:animate-pulse" />
        </span>
        <span className="h-5 w-9 shrink-0 rounded-full bg-neutral-800/80" />
        <span className="h-4 w-4 shrink-0 rounded bg-neutral-800/60" />
      </div>
    ))}
  </div>
);

const EmptyState: React.FC<{
  empty: AgentProfileEmptyState;
  agentLabel: string;
  sheet: boolean;
  creatable: readonly ProfileItemKind[];
  onAdd: (kind: ProfileItemKind) => void;
  onRetry: () => void;
}> = ({ empty, agentLabel, sheet, creatable, onAdd, onRetry }) => {
  switch (empty.kind) {
    case "loading":
      return <LoadingRows />;
    case "not-installed":
      return <RailEmptyState title={notInstalledTitle(empty.agent)} hint={NOT_INSTALLED_HINT} />;
    case "error":
      return (
        <RailEmptyState
          title={`Couldn't load ${agentLabel}'s profile`}
          hint={empty.message}
          action={
            <Button type="button" size="sm" variant="outline" onClick={onRetry} className={cn(sheet && "h-10")}>
              Retry
            </Button>
          }
        />
      );
    case "empty-kind":
      return (
        <RailEmptyState
          title={emptyKindTitle(empty.itemKind)}
          action={
            creatable.includes(empty.itemKind) ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onAdd(empty.itemKind)}
                className={cn(sheet && "h-10")}
              >
                <Plus size={13} aria-hidden />
                Add {PROFILE_ITEM_KIND_LABELS[empty.itemKind].one.replace(/^(?!MCP)./, (c) => c.toLowerCase())}
              </Button>
            ) : undefined
          }
        />
      );
    case "no-matches":
      return <RailEmptyState title={`Nothing matches “${empty.query}”`} />;
  }
};
