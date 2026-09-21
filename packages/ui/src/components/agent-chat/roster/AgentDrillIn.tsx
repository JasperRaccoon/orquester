/**
 * The subagent drill-in (§7.6).
 *
 * Clicking a roster row swaps the **main area** — not the whole view — to that
 * agent's own timeline: its prompt at the top, then its items filtered by
 * `agentId`, streaming live, rendered with the same row components, read-only,
 * with a breadcrumb and Escape back to main.
 *
 * Two constraints shape the component:
 *
 *  - **It must not remount the parent.** The composer and the roster stay
 *    mounted around it so the parent thread can still be steered while the
 *    user watches a child, which is why this renders only the scrolling area
 *    and takes `onBack` rather than owning any navigation.
 *  - **The child view dispatches no commands.** Every timeline callback here
 *    is inert: there is no revert, no approval and no queue inside a child.
 *    The one exception is opening a file, which is navigation, not a command —
 *    and even that is left to the parent through props we do not have, so it
 *    is a no-op here too.
 *
 * §7.2's rule holds on the way in: items stamped with an `agentId` never
 * render in the parent timeline, they are re-homed here. On OpenCode and Grok
 * the surface shows whatever their protocols report and nothing more — when a
 * provider reports a task but no per-agent items, this falls back to the
 * roster row's own recent-activity ring rather than inventing lineage.
 *
 * *T3 has no equivalent: its rows are not clickable and there is no per-agent
 * timeline (`AgentsPanel.tsx:139-140`, "Flat, non-interactive agent status
 * line. No unfold."). The closest thing is an "Open Agents panel ›" link
 * (`MessagesTimeline.tsx:4654-4660`). This surface is new.*
 */

import React from "react";
import { ArrowLeft, Bot, Terminal } from "lucide-react";
import { cn } from "../../../lib/cn";
import type { DisclosureState } from "../../../lib/agent-chat/contracts";
import type { AgentDrillInProps } from "../contracts";
import { ChatTimeline } from "../timeline/ChatTimeline";
import { ElapsedTicker, StatusDot } from "../primitives";
import { agentActivityText, rosterRowMetrics } from "./format";
import { rosterRowTicks, rosterStatusVisual } from "./roster-rows";

const EMPTY_DISCLOSURES: DisclosureState = {
  expandedTurnIds: [],
  expandedGroupIds: [],
  expandedAgentIds: [],
  expandedReasoningIds: [],
  toolOutputOffsets: {}
};

const noop = (): void => {};

/** Editable targets own Escape — in the composer it interrupts the turn (§7.4). */
function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.closest !== "function") return false;
  return element.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']") !== null;
}

export function AgentDrillIn({
  sessionId,
  agentId,
  agent,
  rows,
  onBack,
  roster,
  projectPath
}: AgentDrillInProps): React.ReactElement {
  const [disclosures, setDisclosures] = React.useState<DisclosureState>(EMPTY_DISCLOSURES);
  const onDisclosureChange = React.useCallback((patch: Partial<DisclosureState>) => {
    setDisclosures((current) => ({ ...current, ...patch }));
  }, []);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      onBack();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onBack]);

  const visuals = agent ? rosterStatusVisual(agent.status) : null;
  const background = agent?.agentKind === "background";
  const Icon = background ? Terminal : Bot;
  // The agent's prompt is the task description the provider reported: the
  // live/settled precedence of the roster's own activity line, so a settled
  // child leads with its outcome here too.
  const prompt = agent ? agentActivityText(agent) : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-neutral-950" data-agent-drill-in={agentId}>
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-800 px-2">
        <button
          type="button"
          onClick={onBack}
          className={cn(
            "ac-press inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-xs",
            "text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
          )}
        >
          <ArrowLeft size={12} aria-hidden />
          <span>Back</span>
        </button>
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-xs">
          <span className="shrink-0 text-neutral-500">Agents</span>
          <span aria-hidden className="shrink-0 text-neutral-600">/</span>
          <Icon size={13} strokeWidth={1.8} aria-hidden className="shrink-0 text-neutral-500" />
          <span className="min-w-0 truncate font-medium text-neutral-200">
            {agent?.title ?? agentId}
          </span>
        </nav>
        {agent && visuals ? (
          <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px] text-neutral-500">
            <StatusDot tone={visuals.tone} size="xs" pulse={visuals.pulse} label={visuals.label} />
            <span>{visuals.label}</span>
            <ElapsedTicker
              startedAt={agent.startedAt}
              endedAt={agent.completedAt}
              live={rosterRowTicks(agent.status)}
            />
          </span>
        ) : null}
      </header>

      {agent ? (
        <div className="shrink-0 border-b border-neutral-800 px-3 py-2 sm:px-5">
          <div className="mx-auto w-full max-w-3xl">
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-neutral-300">
              {prompt ?? visuals?.label ?? ""}
            </p>
            <p className="ac-tabular mt-1 truncate font-mono text-[11px] text-neutral-500">
              {rosterRowMetrics(agent).join(" · ")}
            </p>
          </div>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <ChatTimeline
          sessionId={sessionId}
          // `agentId` is what makes the timeline a child view: W12 forces
          // read-only from it, and we say so explicitly as well.
          agentId={agentId}
          readOnly
          roster={roster}
          projectPath={projectPath}
          rows={rows}
          follow
          onFollowChange={noop}
          disclosures={disclosures}
          onDisclosureChange={onDisclosureChange}
          bottomInset={0}
          canRevert={false}
          onRevert={noop}
          onOpenTurnDiff={noop}
          onOpenFile={noop}
          onLoadFullOutput={noop}
          onOpenAgent={noop}
          onSendQueuedNow={noop}
          onReturnQueuedToComposer={noop}
          errorBanner={null}
          onDismissErrorBanner={noop}
        />
      ) : (
        <AgentFallbackLog
          entries={agent?.recentActivity ?? []}
          empty={
            agent
              ? "This agent has not reported any work of its own yet."
              : "That agent is no longer in this thread's roster."
          }
        />
      )}
    </div>
  );
}

/**
 * What a provider that reports task progress but no per-agent items can still
 * show: the roster fold's own bounded activity ring. It is the truth we have,
 * and it is labelled as such rather than dressed up as a timeline.
 */
function AgentFallbackLog({
  entries,
  empty
}: {
  entries: readonly { at: string; summary: string }[];
  empty: string;
}): React.ReactElement {
  return (
    <div className="ac-scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-5">
      <div className="mx-auto w-full max-w-3xl">
        {entries.length === 0 ? (
          <p className="text-sm italic text-neutral-600">{empty}</p>
        ) : (
          <ol className="ac-rows flex flex-col">
            {entries.map((entry) => (
              <li
                key={`${entry.at}:${entry.summary}`}
                className="flex min-w-0 items-baseline gap-2 py-0.5 text-sm leading-relaxed text-neutral-500"
              >
                <span aria-hidden className="shrink-0 text-neutral-600">
                  ·
                </span>
                <span className="min-w-0 break-words">{entry.summary}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

export default AgentDrillIn;
