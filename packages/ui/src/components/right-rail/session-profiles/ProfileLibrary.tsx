/**
 * The Agent Profiles library (agent profiles spec §5.1): a header with
 * "+ New", the search, Global first as a dashed card (not editable here — it
 * is each agent's own setup, managed in Settings → Agent config), then one
 * card per profile: its icon, name, description, counts and a status pill
 * while it is being prepared or when preparing it failed. A card drills into
 * the profile's editor.
 *
 * Presentational: the container (`SessionProfilesPanel`) owns the store.
 */

import React from "react";
import { AlertTriangle, ArrowUpRight, ChevronRight, Loader2, Plus } from "lucide-react";

import type { SessionProfileListError, SessionProfileSummary } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { profileStatusPill } from "../../../lib/session-profiles/logic";
import type { SessionProfilesNotice } from "../../../lib/session-profiles/store";
import { Button } from "../../ui/button";
import { RailChip, RailEmptyState, RailSearchInput, railCardClass } from "../primitives";
import { NoticeLine } from "./NoticeLine";
import { ProfileIcon } from "./ProfileIcon";

const FOCUS_RING = "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500";

export interface ProfileLibraryProps {
  sheet: boolean;
  /** `null` while the first load runs. */
  profiles: readonly SessionProfileSummary[] | null;
  /** The profiles the search keeps. */
  shown: readonly SessionProfileSummary[];
  errors: readonly SessionProfileListError[];
  loadError: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  notice: SessionProfilesNotice | null;
  onDismissNotice: () => void;
  onNew: () => void;
  onOpen: (profileId: string) => void;
  onOpenAgentConfig: () => void;
  onRetry: () => void;
}

export const ProfileLibrary: React.FC<ProfileLibraryProps> = (props) => {
  const { sheet, profiles } = props;
  const searching = props.query.trim() !== "";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Docked, the sidebar's own header already names the panel: "+ New" sits beside the search. */}
      <div className="shrink-0 space-y-2 px-3 pb-2 pt-1">
        {sheet ? (
          <div className="flex items-center gap-2">
            <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-neutral-100">Agent Profiles</h3>
            <NewButton sheet onNew={props.onNew} />
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <RailSearchInput value={props.query} onChange={props.onQueryChange} placeholder="Search profiles…" />
          </div>
          {sheet ? null : <NewButton sheet={false} onNew={props.onNew} />}
        </div>
      </div>

      <div
        aria-label="Agent Profiles"
        aria-busy={profiles === null && props.loadError === null ? true : undefined}
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-3"
      >
        {props.notice !== null ? <NoticeLine notice={props.notice} sheet={sheet} onDismiss={props.onDismissNotice} /> : null}

        {searching ? null : <GlobalCard sheet={sheet} onOpenAgentConfig={props.onOpenAgentConfig} />}

        {profiles === null ? (
          props.loadError !== null ? (
            <RailEmptyState
              title="Couldn't load the profiles"
              hint={props.loadError}
              action={
                <Button type="button" size="sm" variant="outline" onClick={props.onRetry} className={cn(sheet && "h-10")}>
                  Retry
                </Button>
              }
            />
          ) : (
            <div role="status" aria-label="Loading the profiles" className="flex justify-center py-6 text-neutral-500">
              <Loader2 size={16} aria-hidden className="animate-spin" />
            </div>
          )
        ) : props.shown.length === 0 ? (
          searching ? (
            <RailEmptyState title={`Nothing matches “${props.query.trim()}”`} />
          ) : (
            <RailEmptyState
              title="No profiles yet"
              hint="A profile is a kit for one kind of work: chats with it load only its skills, MCP servers, plugins and instructions."
              action={
                <Button type="button" size="sm" variant="outline" onClick={props.onNew} className={cn(sheet && "h-10")}>
                  <Plus size={13} aria-hidden />
                  New profile
                </Button>
              }
            />
          )
        ) : (
          props.shown.map((profile) => (
            <ProfileCard key={profile.id} profile={profile} sheet={sheet} onOpen={() => props.onOpen(profile.id)} />
          ))
        )}

        {props.errors.length > 0 ? (
          <div role="note" className="space-y-1 rounded-lg border border-warn-500/40 bg-warn-500/10 px-2.5 py-2 text-xs">
            <p className="flex items-start gap-1.5 leading-5 text-warn">
              <AlertTriangle size={13} aria-hidden className="mt-[3px] shrink-0" />
              <span className="min-w-0 break-words">
                {props.errors.length === 1 ? "A profile could not be read" : "Some profiles could not be read"} — it is
                kept on disk and never loaded.
              </span>
            </p>
            <ul className="space-y-0.5 pl-5 text-[11px] text-neutral-400">
              {props.errors.map((error) => (
                <li key={error.profileId} className="break-words">
                  <span className="font-mono text-neutral-300">{error.profileId}</span>: {error.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
};

const NewButton: React.FC<{ sheet: boolean; onNew: () => void }> = ({ sheet, onNew }) => (
  <Button type="button" size="sm" onClick={onNew} title="New Agent Profile" className={cn("shrink-0 gap-1", sheet ? "h-10" : "h-9")}>
    <Plus size={13} aria-hidden />
    New
  </Button>
);

const GlobalCard: React.FC<{ sheet: boolean; onOpenAgentConfig: () => void }> = ({ sheet, onOpenAgentConfig }) => (
  <div
    data-profile-card="global"
    className="flex items-start gap-3 rounded-xl border border-dashed border-neutral-700 bg-transparent px-3 py-2.5"
  >
    <ProfileIcon global />
    <div className="min-w-0 flex-1">
      <div className="text-[13px] font-medium text-neutral-100">Global</div>
      <p className="mt-0.5 text-xs leading-4 text-neutral-400">
        Each agent's own setup: its global skills, MCP servers, plugins and instructions. Chats without a profile use it.
      </p>
      <button
        type="button"
        onClick={onOpenAgentConfig}
        className={cn(
          "mt-1 inline-flex items-center gap-1 rounded text-[11px] text-neutral-400 underline-offset-2 hover:text-neutral-200 hover:underline",
          FOCUS_RING,
          sheet && "min-h-10"
        )}
      >
        Settings → Agent config
        <ArrowUpRight size={11} aria-hidden />
      </button>
    </div>
  </div>
);

const ProfileCard: React.FC<{ profile: SessionProfileSummary; sheet: boolean; onOpen: () => void }> = ({
  profile,
  sheet,
  onOpen
}) => {
  const pill = profileStatusPill(profile);
  const chips: string[] = [];
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  chips.push(count(profile.counts.skill.total, "skill", "skills"));
  chips.push(count(profile.counts.mcp.total, "MCP", "MCPs"));
  chips.push(count(profile.counts.plugin.total, "plugin", "plugins"));
  return (
    <button
      type="button"
      data-profile-card={profile.id}
      onClick={onOpen}
      className={cn(railCardClass(false), "group flex w-full items-start gap-3 pl-3 pr-1 text-left", FOCUS_RING, sheet ? "py-3" : "py-2.5")}
    >
      <ProfileIcon icon={profile.icon} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-neutral-100">{profile.name}</span>
        {profile.description ? (
          <span className="mt-0.5 line-clamp-2 block break-words text-xs leading-4 text-neutral-400">{profile.description}</span>
        ) : null}
        <span className="mt-1.5 flex flex-wrap items-center gap-1">
          {chips.map((chip) => (
            <RailChip key={chip} className="text-neutral-400">
              {chip}
            </RailChip>
          ))}
          {pill !== null ? (
            <span
              data-profile-status={pill.tone}
              title={pill.title}
              className={cn(
                "inline-flex max-w-full items-center gap-1 truncate rounded-md border px-1.5 py-px text-[11px] leading-4",
                pill.tone === "busy"
                  ? "border-info-500/40 bg-info-soft/30 text-info-300"
                  : "border-danger-500/40 bg-danger-500/10 text-danger"
              )}
            >
              {pill.tone === "busy" ? (
                <Loader2 size={10} aria-hidden className="shrink-0 animate-spin" />
              ) : (
                <AlertTriangle size={10} aria-hidden className="shrink-0" />
              )}
              {pill.text}
            </span>
          ) : null}
        </span>
      </span>
      <span
        aria-hidden
        className={cn(
          "flex shrink-0 items-center justify-center self-center text-neutral-500 transition-colors group-hover:text-neutral-200",
          sheet ? "w-10" : "w-7"
        )}
      >
        <ChevronRight size={15} />
      </span>
    </button>
  );
};
