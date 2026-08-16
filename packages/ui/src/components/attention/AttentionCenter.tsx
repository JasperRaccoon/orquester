import React, { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Bot } from "lucide-react";
import { cn } from "../../lib/cn";
import { AdaptiveMenu, DropdownContext } from "../ui";
import { SessionStatusDot } from "../ui/session-status-dot";
import { getRegistryIcon } from "../../icons";
import { useApi } from "../../context/orquester-context";
import { refreshProjectIndex, useProjectIndex } from "../../lib/project-index";
import { useAppStore } from "../../store/app";
import {
  attentionKey,
  focusAgentSession,
  isFlaggedBucket,
  nextSeenKeys,
  summarizeAgentSessions,
  useAgentSessions,
  verifiedAgentSessions,
  type AgentSessionEntry,
  type AttentionBucket
} from "./agent-sessions";

const GROUPS: Array<{ bucket: AttentionBucket; title: string }> = [
  { bucket: "attention", title: "Needs Attention" },
  { bucket: "finished", title: "Finished" },
  { bucket: "active", title: "Active" },
  { bucket: "idle", title: "Idle" }
];

const AgentRow: React.FC<{ entry: AgentSessionEntry }> = ({ entry }) => {
  const { close } = useContext(DropdownContext);
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        focusAgentSession(entry);
        close();
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-neutral-300",
        "transition-colors hover:bg-neutral-800 hover:text-neutral-100"
      )}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-neutral-500">
        {getRegistryIcon(entry.session.kind, entry.session.refId, 14)}
      </span>
      <span className="min-w-0 flex-1 truncate">{entry.session.title}</span>
      {/* `shrink` (not `shrink-0`) so a long workspace/project yields to the
          title instead of crushing it; `min-w-0` is what lets it truncate. */}
      <span className="min-w-0 shrink truncate text-[10px] text-neutral-500">
        {entry.project.workspace ? `${entry.project.workspace}/` : ""}
        {entry.project.name}
      </span>
      <SessionStatusDot sessionId={entry.session.id} status={entry.session.status} />
    </button>
  );
};

const AgentGroup: React.FC<{ title: string; items: AgentSessionEntry[] }> = ({ title, items }) => {
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="pb-1 last:pb-0">
      <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
        {title}
      </div>
      {items.map((entry) => (
        <AgentRow key={entry.session.id} entry={entry} />
      ))}
    </div>
  );
};

/**
 * Panel body. Mounted only while the menu is open (both Dropdown and
 * BottomSheet render children lazily), so its effect doubles as "the user is
 * looking at the summary" — that clears the *badge* only. Per-session
 * attention still clears the way it always has: on focusing that tab.
 *
 * Opening is also what re-verifies the archived curtain: the mount refreshes
 * the shared project index, which the trigger reads too, so the count and the
 * rows can never disagree.
 */
export const AttentionPanel: React.FC<{
  entries: AgentSessionEntry[];
  /** No verified index yet — the rows below are not "none", they are "not known". */
  loading: boolean;
  incomplete: boolean;
  onSeen: (keys: string[]) => void;
}> = ({ entries, loading, incomplete, onSeen }) => {
  const api = useApi();
  const keyString = entries
    .filter((e) => isFlaggedBucket(e.bucket))
    .map(attentionKey)
    .join("|");

  useEffect(() => {
    onSeen(keyString ? keyString.split("|") : []);
  }, [keyString, onSeen]);

  // Workspaces read imperatively: a background refresh of that list must not
  // re-run the fetch under an open panel.
  useEffect(() => {
    const controller = new AbortController();
    void refreshProjectIndex(api, useAppStore.getState().workspaces, controller.signal);
    return () => controller.abort();
  }, [api]);

  if (loading) {
    return <div className="px-2 py-1.5 text-sm italic text-neutral-600">Loading…</div>;
  }

  if (entries.length === 0) {
    return (
      <div className="px-2 py-1.5 text-sm italic text-neutral-600">
        {incomplete ? "No agent sessions in the workspaces that loaded" : "No agent sessions"}
      </div>
    );
  }
  // No scroll container of its own: the Dropdown panel (viewport-derived
  // maxHeight) and the BottomSheet (max-h-[75vh]) already scroll, and nesting a
  // second scroller inside either strands rows on a phone.
  return (
    <>
      {/* Discovery for the cycling shortcut. Only one binding is advertised:
          desktop Chrome reserves Ctrl+Shift+A for "Search tabs", so the web PWA
          may never see it — the command palette and its topbar button are the
          reliable path there. */}
      <div className="flex items-center justify-between gap-2 px-2 pb-0.5 pt-1">
        <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-600">
          Agents
        </span>
        <kbd className="rounded border border-neutral-800 px-1 py-px font-sans text-[9px] text-neutral-600">
          Ctrl+Shift+A
        </kbd>
      </div>
      {GROUPS.map(({ bucket, title }) => (
        <AgentGroup key={bucket} title={title} items={entries.filter((e) => e.bucket === bucket)} />
      ))}
    </>
  );
};

/**
 * Topbar Attention Center: every agent session across every workspace, grouped
 * by whether it is blocked on the user, finished, busy, or quiet. The count of
 * calling sessions is always on the trigger; it turns amber while one of them
 * is still calling and hasn't been looked at. `Ctrl+Shift+A` walks the same
 * Needs-Attention list (see GlobalShortcutListener).
 */
export const AttentionCenter: React.FC = () => {
  const derived = useAgentSessions();
  const index = useProjectIndex();
  // Attention episodes the user has already looked at, replaced wholesale each
  // time the panel renders — an episode that clears and re-raises gets a new
  // key (see `attentionKey`) and so counts as unseen again.
  const [seenKeys, setSeenKeys] = useState<ReadonlySet<string>>(() => new Set());

  const onSeen = useCallback((keys: string[]) => {
    setSeenKeys((prev) => nextSeenKeys(prev, keys));
  }, []);

  const entries = useMemo(() => verifiedAgentSessions(derived, index), [derived, index]);

  // Before any index has resolved there is nothing verified, so the badge falls
  // back to the store-derived list: it can over-count by sessions living in
  // archived projects of other workspaces, but a fail-closed zero would hide
  // the trigger entirely and leave no way to open the panel that fixes it. The
  // count settles to the verified one as soon as the panel is opened.
  const summarized = index === null ? derived : entries;
  const { total, flaggedCount, unseenCount, label } = useMemo(
    () => summarizeAgentSessions(summarized, seenKeys),
    [summarized, seenKeys]
  );

  // Nothing to show and nothing to report — stay out of the topbar entirely
  // (the UsageWidget convention). A finished-only list still renders, so the
  // last thing an agent did stays reachable.
  if (total === 0 && flaggedCount === 0) {
    return null;
  }

  const trigger = (
    <span
      title={label}
      aria-label={label}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium hover:bg-neutral-800",
        unseenCount > 0 ? "text-warn" : "text-neutral-300"
      )}
    >
      <Bot size={13} className={unseenCount > 0 ? "text-warn" : "text-neutral-500"} />
      <span>{total}</span>
      {flaggedCount > 0 && (
        <span className={unseenCount > 0 ? "text-warn" : "text-neutral-500"}>
          · {flaggedCount}
        </span>
      )}
    </span>
  );

  return (
    <AdaptiveMenu title="Agents" trigger={trigger} align="right" width="w-72">
      <AttentionPanel
        entries={entries}
        loading={index === null}
        incomplete={index?.incomplete ?? false}
        onSeen={onSeen}
      />
    </AdaptiveMenu>
  );
};
