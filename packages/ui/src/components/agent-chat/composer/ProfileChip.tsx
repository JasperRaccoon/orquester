/**
 * The composer's Agent Profile chip (agent profiles spec §5.3), between the
 * permission / plan controls and the account chip: the thread's profile icon
 * and name, or "Global". Its menu lists Global, a separator, then every
 * profile with its counts; a profile not ready for this chat's agent
 * (preparing, or preparing it failed) is disabled with the reason as its
 * second line. Picking one switches the running chat — the agent restarts
 * with it and the conversation is kept — and the menu says so in one line.
 *
 * Gated like the account chip: only while the thread is idle.
 */

import React from "react";
import { Check, Globe, Layers } from "lucide-react";

import type { SessionProfileAgentId, SessionProfileSummary } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { PROFILE_SWITCH_NOTE, profileChipEntries, profileChipLabel } from "../../../lib/session-profiles/logic";
import { ComposerMenuRow, ComposerPopover } from "./ComposerPopover";

const CHIP =
  "ac-press inline-flex h-7 max-w-40 items-center gap-1 rounded-md px-2 text-xs " +
  "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 " +
  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 " +
  "disabled:pointer-events-none disabled:opacity-40";

const BUSY_TITLE = "Available when the agent is idle";

export interface ProfileChipProps {
  /** The chat's agent, for each profile's readiness; `null` when it has none a profile serves. */
  agent: SessionProfileAgentId | null;
  /** Every profile, or `null` while the list loads. */
  profiles: readonly SessionProfileSummary[] | null;
  /** The thread's profile (`ThreadHead.profileId`); absent = Global. */
  selectedId: string | null;
  /** False while a turn, a request, a queue or a revert is in flight. */
  canSwitch: boolean;
  /** Why a closed chip is closed, when the host said; absent ⇒ "available when idle". */
  disabledReason?: string | null;
  onChange: (profileId: string | null) => void;
  returnFocusTo?: () => HTMLElement | null;
}

const glyph = (icon: string | undefined, size = 12): React.ReactNode =>
  icon ? <span className="text-[12px] leading-none">{icon}</span> : <Layers size={size} aria-hidden />;

export function ProfileChip({
  agent,
  profiles,
  selectedId,
  canSwitch,
  disabledReason = null,
  onChange,
  returnFocusTo
}: ProfileChipProps): React.ReactElement {
  const shown = profileChipLabel(selectedId, profiles);
  const entries = profileChipEntries(profiles ?? [], agent);
  return (
    <ComposerPopover
      label="Agent Profile"
      width="w-72"
      returnFocusTo={returnFocusTo}
      renderTrigger={(triggerProps) => (
        <button
          {...triggerProps}
          type="button"
          disabled={!canSwitch}
          data-composer-profile-chip=""
          title={
            canSwitch
              ? `${selectedId ? `Agent Profile: ${shown.label}` : "Global — the agent's own setup"} — click to switch`
              : (disabledReason ?? BUSY_TITLE)
          }
          className={cn(CHIP, shown.missing && "text-warn")}
        >
          <span className="flex shrink-0 items-center text-neutral-500">
            {selectedId ? glyph(shown.icon) : <Globe size={12} aria-hidden />}
          </span>
          <span className="truncate text-neutral-200">{shown.label}</span>
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="px-2 py-1 text-[11px] text-neutral-500">Agent Profile</div>
          <ComposerMenuRow
            icon={<Globe size={13} aria-hidden />}
            selected={!selectedId}
            hint="Each agent's own setup"
            trailing={!selectedId ? <Check size={13} className="text-info" aria-hidden /> : undefined}
            onClick={() => {
              close();
              if (selectedId) onChange(null);
            }}
          >
            Global
          </ComposerMenuRow>
          <div role="separator" className="my-1 h-px bg-neutral-800" />
          {profiles === null ? (
            <div className="px-2 py-1.5 text-[12px] text-neutral-500">Loading profiles…</div>
          ) : entries.length === 0 ? (
            <div className="px-2 py-1.5 text-[12px] text-neutral-500">No profiles yet — create one in Agent Profiles.</div>
          ) : (
            entries.map((entry) => (
              <ComposerMenuRow
                key={entry.id}
                icon={glyph(entry.icon, 13)}
                selected={entry.id === selectedId}
                disabled={entry.disabledReason !== null && entry.id !== selectedId}
                data-profile-entry={entry.id}
                hint={entry.disabledReason ?? entry.counts}
                trailing={entry.id === selectedId ? <Check size={13} className="text-info" aria-hidden /> : undefined}
                onClick={() => {
                  close();
                  if (entry.id !== selectedId) onChange(entry.id);
                }}
              >
                {entry.name}
              </ComposerMenuRow>
            ))
          )}
          <p className="px-2 pb-1 pt-1.5 text-[11px] leading-snug text-neutral-500">{PROFILE_SWITCH_NOTE}</p>
        </>
      )}
    </ComposerPopover>
  );
}
