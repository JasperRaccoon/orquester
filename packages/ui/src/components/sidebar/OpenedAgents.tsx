import React, { useEffect, useMemo, useState } from "react";
import { Bot, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../../lib/cn";
import { SessionStatusDot } from "../ui/session-status-dot";
import { getRegistryIcon } from "../../icons";
import { useApi } from "../../context/orquester-context";
import { useIsDesktop } from "../../hooks";
import {
  cachedProjectIndex,
  ensureProjectIndex,
  refreshProjectIndex,
  useProjectIndex
} from "../../lib/project-index";
import { loadOpenedAgentsCollapsed, saveOpenedAgentsCollapsed } from "../../lib/opened-agents";
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
} from "../attention";

const GROUPS: Array<{ bucket: AttentionBucket; title: string }> = [
  { bucket: "attention", title: "Needs Attention" },
  { bucket: "finished", title: "Finished" },
  { bucket: "active", title: "Active" },
  { bucket: "idle", title: "Idle" }
];

const AgentRow: React.FC<{ entry: AgentSessionEntry }> = ({ entry }) => (
  <button
    type="button"
    onClick={() => focusAgentSession(entry)}
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

const AgentGroup: React.FC<{ title: string; items: AgentSessionEntry[] }> = ({ title, items }) => {
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="pb-1 last:pb-0">
      <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-neutral-600">
        {title}
      </div>
      {items.map((entry) => (
        <AgentRow key={entry.session.id} entry={entry} />
      ))}
    </div>
  );
};

/**
 * Sidebar "Opened Agents" section: every agent session across every workspace,
 * grouped by whether it is blocked on the user, finished, busy, or quiet —
 * above the workspace/project lists, collapsible, with the counts always on
 * the header. `Ctrl+Shift+A` walks the same Needs-Attention list (see
 * GlobalShortcutListener).
 *
 * "Seen" semantics survive the move from the top-bar popover: an attention
 * episode counts as looked-at only while the rows are actually on screen —
 * expanded, and (on mobile) with the drawer open, since the drawer stays
 * mounted off-canvas. Collapsing keeps the previous seen set, so the header
 * badge turns amber only for episodes the user has genuinely not seen.
 */
export const OpenedAgents: React.FC = () => {
  const api = useApi();
  const isDesktop = useIsDesktop();
  const drawerOpen = useAppStore((s) => s.sidebarDrawerOpen);
  const derived = useAgentSessions();
  const index = useProjectIndex();

  const [collapsed, setCollapsed] = useState(loadOpenedAgentsCollapsed);
  const [seenKeys, setSeenKeys] = useState<ReadonlySet<string>>(() => new Set());
  const expanded = !collapsed;

  const entries = useMemo(() => verifiedAgentSessions(derived, index), [derived, index]);

  // Before any index has resolved there is nothing verified, so the badge falls
  // back to the store-derived list: it can over-count by sessions living in
  // archived projects of other workspaces, but a fail-closed zero would blank
  // the header counts for no reason. It settles as soon as the index resolves.
  const summarized = index === null ? derived : entries;
  const { total, flaggedCount, unseenCount, label } = useMemo(
    () => summarizeAgentSessions(summarized, seenKeys),
    [summarized, seenKeys]
  );

  // Re-verify the archived curtain whenever the session list changes shape or
  // the section is toggled (the moral successor of the old popover's
  // refresh-on-open). A cold cache goes through `ensure` so this dedupes with
  // the command palette / cycle shortcut instead of racing them.
  const pathsKey = useMemo(
    () =>
      Array.from(new Set(derived.map((entry) => entry.session.projectPath)))
        .sort()
        .join("|"),
    [derived]
  );
  useEffect(() => {
    if (cachedProjectIndex() === null) {
      void ensureProjectIndex(api, useAppStore.getState().workspaces);
      return;
    }
    const controller = new AbortController();
    void refreshProjectIndex(api, useAppStore.getState().workspaces, controller.signal);
    return () => controller.abort();
  }, [api, pathsKey, expanded]);

  // Invalidation (archive/restore, disconnect) nulls the cache out-of-band;
  // refetch so the section doesn't sit on "Loading…" until something changes.
  useEffect(() => {
    if (index === null) {
      void ensureProjectIndex(api, useAppStore.getState().workspaces);
    }
  }, [api, index]);

  // Mark the flagged episodes seen only while the rows are genuinely visible.
  const contentVisible = expanded && (isDesktop || drawerOpen);
  const flaggedKeyString = entries
    .filter((entry) => isFlaggedBucket(entry.bucket))
    .map(attentionKey)
    .join("|");
  useEffect(() => {
    if (!contentVisible) {
      return;
    }
    const keys = flaggedKeyString ? flaggedKeyString.split("|") : [];
    setSeenKeys((prev) => nextSeenKeys(prev, keys));
  }, [contentVisible, flaggedKeyString]);

  const toggle = () => {
    setCollapsed((prev) => {
      saveOpenedAgentsCollapsed(!prev);
      return !prev;
    });
  };

  return (
    <div className="flex shrink-0 flex-col border-b border-neutral-800">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        title={`${label} — Ctrl+Shift+A cycles the agents needing attention`}
        className="flex h-9 w-full items-center gap-1 px-2 text-left hover:bg-neutral-800/50"
      >
        {expanded ? (
          <ChevronDown size={13} className="shrink-0 text-neutral-500" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-neutral-500" />
        )}
        <span className="flex-1 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
          Opened Agents
        </span>
        {(total > 0 || flaggedCount > 0) && (
          <span
            className={cn(
              "flex items-center gap-1 text-xs font-medium tabular-nums",
              unseenCount > 0 ? "text-warn" : "text-neutral-500"
            )}
          >
            <Bot size={12} />
            <span>{total}</span>
            {flaggedCount > 0 && <span>· {flaggedCount}</span>}
          </span>
        )}
      </button>

      {expanded && (
        // Bounded so a long agent list can't crowd the workspace/project list
        // out of the sidebar; it scrolls on its own past that.
        <div className="max-h-[40vh] overflow-y-auto px-2 pb-2">
          {index === null ? (
            <div className="px-2 py-1.5 text-sm italic text-neutral-600">Loading…</div>
          ) : entries.length === 0 ? (
            <div className="px-2 py-1.5 text-sm italic text-neutral-600">
              {index.incomplete
                ? "No agent sessions in the workspaces that loaded"
                : "No agent sessions"}
            </div>
          ) : (
            GROUPS.map(({ bucket, title }) => (
              <AgentGroup
                key={bucket}
                title={title}
                items={entries.filter((entry) => entry.bucket === bucket)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
};
