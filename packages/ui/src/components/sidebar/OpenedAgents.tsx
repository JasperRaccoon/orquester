import React, { useEffect, useMemo, useState } from "react";
import { Dot, Workflow as WorkflowIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import { SessionStatusDot } from "../ui/session-status-dot";
import { ContextMenu } from "../ui/context-menu";
import {
  resolveSidebarThreadStatus,
  shouldRecedeSidebarThread
} from "../../lib/agent-chat/status.logic";
import { getRegistryIcon } from "../../icons";
import { useApi } from "../../context/orquester-context";
import { useIsDesktop } from "../../hooks";
import {
  cachedProjectIndex,
  ensureProjectIndex,
  refreshProjectIndex,
  useProjectIndex
} from "../../lib/project-index";
import { groupAgentSessionsByRepo, matchesSidebarQuery } from "../../lib/opened-agents";
import { useAppStore, useThreadUnread } from "../../store/app";
import { WorkflowAttention, useWorkflowAttention } from "../workflows/runs/WorkflowAttention";
import {
  attentionKey,
  focusAgentSession,
  isFlaggedBucket,
  nextSeenKeys,
  summarizeAgentSessions,
  useAgentSessions,
  verifiedAgentSessions,
  type AgentSessionEntry
} from "../attention";
import { CountPill, SectionHeader } from "./parts";

/**
 * One agent, as a card: its icon, title and `workspace / project`, with the
 * status dot on the right. The visible chat reads as selected (a raised card
 * with a ring).
 *
 * Cards **recede** when they want nothing from you (§7.7).
 *
 * *T3: `Sidebar.logic.ts:820-833`.* The rule itself lives in `status.logic.ts`;
 * this supplies the card's three inputs and paints the result. `isUnread` is
 * the per-device "finished since you last looked" signal, which is what keeps a
 * settled agent loud until it has been read — the daemon's `needsAttentionAt`
 * still drives the status dot and the Attention Center, and this refines that
 * rather than replacing it.
 */
const AgentCard: React.FC<{ entry: AgentSessionEntry }> = ({ entry }) => {
  const markTabUnread = useAppStore((s) => s.markTabUnread);
  const unread = useThreadUnread(entry.session.id);
  const activeInProject = useAppStore(
    (s) => s.activeTabByProject[entry.session.projectPath] === entry.session.id
  );
  const inOpenProject = useAppStore((s) => s.currentProject?.path === entry.session.projectPath);
  const onScreen = activeInProject && inOpenProject;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const recede =
    entry.session.kind === "agent-chat" &&
    shouldRecedeSidebarThread({
      status: resolveSidebarThreadStatus(entry.session),
      isUnread: unread,
      isSelected: activeInProject
    });

  // Offered only where there is a turn to have missed — the same rule the tab
  // strip's menu uses.
  const canMarkUnread =
    entry.session.kind === "agent-chat" && Boolean(entry.session.latestTurn?.completedAt);

  return (
    <>
      <button
        type="button"
        onClick={() => focusAgentSession(entry)}
        onContextMenu={(event) => {
          if (!canMarkUnread) return;
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
        aria-current={onScreen ? "page" : undefined}
        className={cn(
          "flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left",
          "transition-[background-color,border-color,opacity]",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
          onScreen
            ? "border-neutral-600 bg-neutral-800/80"
            : "border-neutral-800 bg-neutral-900/60 hover:border-neutral-700 hover:bg-neutral-800/50",
          recede ? "opacity-60 hover:opacity-100" : "opacity-100"
        )}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-neutral-400">
          {getRegistryIcon(entry.session.kind, entry.session.refId, 17)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] text-neutral-100">{entry.session.title}</span>
          <span className="truncate text-xs text-neutral-500">
            {entry.project.workspace ? `${entry.project.workspace} / ` : ""}
            {entry.project.name}
          </span>
        </span>
        {unread && (
          <span
            aria-label="Unread"
            title="Finished since you last looked"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-300"
          />
        )}
        <SessionStatusDot
          sessionId={entry.session.id}
          status={entry.session.status}
          backgroundLiveness={entry.session.backgroundLiveness}
          goal={entry.session.goal}
          unread={unread}
        />
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            {
              label: "Mark unread",
              icon: <Dot size={13} />,
              onClick: () => markTabUnread(entry.session.id)
            }
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
};

/**
 * Sidebar "Opened agents" section: every agent session across every
 * workspace, as cards, in a stable order — by the git repo its project
 * belongs to (every checkout of one remote side by side), never reshuffled by
 * activity. Status stays on each card's dot.
 *
 * Every agent is shown; a search (`query`) narrows the cards to those whose
 * title, project or workspace matches. `Ctrl+Shift+A` still walks the bucket-derived Needs-Attention
 * list (see GlobalShortcutListener) — display order doesn't change it.
 *
 * "Seen" semantics: an attention episode counts as looked-at only while the
 * cards are actually on screen — on mobile, with the drawer open, since the
 * drawer stays mounted off-canvas. The count turns amber only for episodes the
 * user has genuinely not seen.
 */
export const OpenedAgents: React.FC<{ query: string }> = ({ query }) => {
  const api = useApi();
  const isDesktop = useIsDesktop();
  const drawerOpen = useAppStore((s) => s.sidebarDrawerOpen);
  const workspaces = useAppStore((s) => s.workspaces);
  const workspacesLoading = useAppStore((s) => s.workspacesLoading);
  const derived = useAgentSessions();
  const index = useProjectIndex();
  // Failed workflow runs: the Attention Center's other source (workflows spec §5.11).
  const workflowFailures = useWorkflowAttention().length;
  const [seenKeys, setSeenKeys] = useState<ReadonlySet<string>>(() => new Set());

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

  // Re-verify the archived curtain whenever the session list changes shape
  // or the *workspace list* changes (`wsKey` — membership or archive flags).
  // The workspaces key is load-bearing at boot: the
  // mount fetch runs against a still-empty workspace list and publishes an
  // empty index, and without this dep nothing would ever re-verify it — the
  // section sat on "No agent sessions" until something forced a refresh. A cold
  // cache goes through `ensure` so this dedupes with the command palette /
  // cycle shortcut instead of racing them.
  const pathsKey = useMemo(
    () =>
      Array.from(new Set(derived.map((entry) => entry.session.projectPath)))
        .sort()
        .join("|"),
    [derived]
  );
  const wsKey = useMemo(
    () => workspaces.map((w) => `${w.name}:${w.isArchived ? 1 : 0}`).join("|"),
    [workspaces]
  );
  useEffect(() => {
    if (cachedProjectIndex() === null) {
      void ensureProjectIndex(api, useAppStore.getState().workspaces);
      return;
    }
    const controller = new AbortController();
    void refreshProjectIndex(api, useAppStore.getState().workspaces, controller.signal);
    return () => controller.abort();
  }, [api, pathsKey, wsKey]);

  // Invalidation (archive/restore, disconnect) nulls the cache out-of-band;
  // refetch so the section doesn't sit on "Loading…" until something changes.
  useEffect(() => {
    if (index === null) {
      void ensureProjectIndex(api, useAppStore.getState().workspaces);
    }
  }, [api, index]);

  // Mark the flagged episodes seen only while the cards are genuinely visible.
  const contentVisible = isDesktop || drawerOpen;
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

  const searching = query.trim().length > 0;
  const ordered = useMemo(() => {
    if (index === null) return [];
    const matching = entries.filter((entry) =>
      matchesSidebarQuery(query, entry.session.title, entry.project.name, entry.project.workspace)
    );
    return groupAgentSessionsByRepo(matching, index).flatMap((group) => group.items);
  }, [entries, index, query]);

  // A search with no matching agent drops the section; the workspaces below
  // may still match.
  if (searching && ordered.length === 0) {
    return null;
  }

  return (
    <section aria-label="Opened agents" className="space-y-1.5">
      <SectionHeader
        title="Opened agents"
        count={
          <>
            {(total > 0 || flaggedCount > 0) && (
              <CountPill
                tone={unseenCount > 0 ? "warn" : "default"}
                title={`${label} — Ctrl+Shift+A cycles the agents needing attention`}
              >
                {total}
                {flaggedCount > 0 && <span>· {flaggedCount}</span>}
              </CountPill>
            )}
            {workflowFailures > 0 && (
              <CountPill
                tone="danger"
                title={`${workflowFailures} failed workflow run${workflowFailures === 1 ? "" : "s"}`}
              >
                <WorkflowIcon size={11} aria-hidden />
                {workflowFailures}
              </CountPill>
            )}
          </>
        }
      />

      <WorkflowAttention touch={!isDesktop} />
      {/* An index built before the workspace list loaded is empty-but-
          resolved — that's "still loading", not "no sessions". */}
      {index === null || (entries.length === 0 && workspacesLoading) ? (
        <p className="px-2 py-1.5 text-xs text-neutral-600">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="rounded-xl border border-dashed border-neutral-800 px-3 py-2.5 text-xs text-neutral-500">
          {index.incomplete
            ? "No agent sessions in the workspaces that loaded"
            : "No agents running. Open a project and start a chat from its tab bar."}
        </p>
      ) : (
        <div className="space-y-1.5">
          {ordered.map((entry) => (
            <AgentCard key={entry.session.id} entry={entry} />
          ))}
        </div>
      )}
    </section>
  );
};
