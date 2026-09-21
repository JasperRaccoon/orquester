/**
 * The agent roster, docked below the composer (§7.6).
 *
 * What the product owner asked for, in the shape the Claude Code CLI has it:
 * the agents sit *below the input box* — a `main` row for the thread itself,
 * then one fixed-height row per subagent or background task with its type,
 * live description, elapsed time and tokens, with "N more" past the first few
 * — and a row can be entered to watch what that agent is doing
 * ({@link AgentDrillIn}).
 *
 * Everything about *which* rows render lives in `roster-rows.ts`, which is
 * pure and tested, because the three rules involved pull against each other:
 * spawn order is stable, rows past five collapse, finished rows fade at turn
 * end — and a live background row is exempt from the last two.
 *
 * *T3: `AgentsPanel.tsx:521-584` — the panel shell and its counts footer.
 * differs: T3's roster is a right-panel surface, its rows are not clickable,
 * and it neither collapses nor removes settled rows.*
 */

import React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { RuntimeSubagent } from "@orquester/api/agent-chat";
import { cn } from "../../../lib/cn";
import type { AgentRosterMainRow, AgentRosterProps } from "../contracts";
import { formatSubagentTokenCount, formatSubagentModelLabel } from "./format";
import {
  ROSTER_COLLAPSED_ROWS,
  selectRosterRows,
  type FinishedRowsPhase
} from "./roster-rows";
import { AgentRosterRow, RosterMainRow } from "./AgentRosterRow";
import { WorkflowGroup } from "./WorkflowGroup";

/** Matches the row's `duration-300` opacity transition. */
export const ROSTER_FADE_MS = 300;

/**
 * Where finished rows are in their exit.
 *
 * Opening a thread whose turn already ended starts at `removed`: the fade is
 * the turn *ending*, not the tab opening, and replaying it on every tab switch
 * would animate history.
 */
export function useFinishedRowsPhase(turnActive: boolean, fadeMs = ROSTER_FADE_MS): FinishedRowsPhase {
  const [phase, setPhase] = React.useState<FinishedRowsPhase>(turnActive ? "visible" : "removed");
  const wasActive = React.useRef(turnActive);

  React.useEffect(() => {
    if (turnActive) {
      wasActive.current = true;
      setPhase("visible");
      return;
    }
    if (!wasActive.current) {
      setPhase("removed");
      return;
    }
    wasActive.current = false;
    setPhase("fading");
    const timer = setTimeout(() => setPhase("removed"), fadeMs);
    return () => clearTimeout(timer);
  }, [turnActive, fadeMs]);

  return phase;
}

function mainRowVisuals(main: AgentRosterMainRow): {
  tone: "muted" | "info" | "warn" | "danger";
  pulse: boolean;
  statusLabel: string;
} {
  if (main.awaitingUser) return { tone: "warn", pulse: false, statusLabel: "Waiting for you" };
  if (main.turnActive) return { tone: "info", pulse: true, statusLabel: "Working" };
  if (main.failed) return { tone: "danger", pulse: false, statusLabel: "Failed" };
  return { tone: "muted", pulse: false, statusLabel: "Idle" };
}

function mainRowMetrics(main: AgentRosterMainRow): string[] {
  const parts: string[] = [];
  const model = formatSubagentModelLabel(main.model ?? null, main.effort ?? null);
  if (model) parts.push(model);
  parts.push(
    main.tokensUsed === null || main.tokensUsed === undefined
      ? "— tok"
      : `${formatSubagentTokenCount(main.tokensUsed)} tok`
  );
  return parts;
}

/**
 * The flat rows the cap applies to: the panel's direct spawns when the fold
 * produced a panel, otherwise the raw roster.
 *
 * The fallback is not defensive padding — a client whose panel model has not
 * been folded yet (or a provider that reports tasks with no grouping at all)
 * must still show its agents rather than an empty dock.
 */
function flatRows(
  agents: readonly RuntimeSubagent[],
  panel: AgentRosterProps["panel"]
): readonly RuntimeSubagent[] {
  if (panel.workflows.length === 0 && panel.directAgents.length === 0) return agents;
  return panel.directAgents;
}

export function AgentRoster({
  sessionId,
  agents,
  panel,
  expanded,
  onExpandedChange,
  onOpenAgent,
  main = null,
  activeAgentId = null
}: AgentRosterProps): React.ReactElement | null {
  const phase = useFinishedRowsPhase(main?.turnActive ?? false);
  // Without a `main` row there is no turn signal, so there is nothing to fade
  // *on*: keep every row rather than dropping finished ones on a guess.
  const finished: FinishedRowsPhase = main ? phase : "visible";
  const selection = React.useMemo(
    () => selectRosterRows({ agents: flatRows(agents, panel), expanded, finished }),
    [agents, panel, expanded, finished]
  );

  const hasWorkflows = panel.workflows.length > 0;
  if (!main && selection.rows.length === 0 && !hasWorkflows) return null;

  const visuals = main ? mainRowVisuals(main) : null;
  const workingCount = panel.runningCount + panel.waitingCount || selection.liveCount;
  const showFooter = selection.hiddenCount > 0 || expanded || workingCount > 0;

  return (
    <section
      aria-label="Agents"
      data-session-id={sessionId}
      className="flex min-h-0 w-full flex-col border-t border-neutral-800 bg-neutral-950"
    >
      {/* Bounded twice: never more than 40% of the viewport, and never more
          than ~4.5 rows. The second bound is the mobile one — `vh` is the
          *layout* viewport, so with the soft keyboard up 40vh would be most of
          what the user can actually see. */}
      <div className="ac-scroll-thin flex max-h-[min(40vh,18rem)] min-h-0 flex-col gap-1 overflow-y-auto px-1.5 py-1">
        {main && visuals ? (
          <RosterMainRow
            title={main.title ?? "main"}
            tone={visuals.tone}
            pulse={visuals.pulse}
            statusLabel={visuals.statusLabel}
            activityLabel={main.activityLabel}
            startedAt={main.turnStartedAt}
            endedAt={main.turnEndedAt ?? null}
            live={main.turnActive}
            metrics={mainRowMetrics(main)}
          />
        ) : null}

        {panel.workflows.map((group) => (
          <WorkflowGroup
            key={group.workflow.id}
            group={group}
            activeAgentId={activeAgentId}
            onOpenAgent={onOpenAgent}
          />
        ))}

        {selection.rows.map((row) => (
          <AgentRosterRow
            key={row.agent.id}
            agent={row.agent}
            fading={row.fading}
            active={row.agent.id === activeAgentId}
            onOpen={onOpenAgent}
          />
        ))}
      </div>

      {showFooter ? (
        <footer className="flex h-6 shrink-0 items-center gap-2 px-2 font-mono text-[11px] text-neutral-500">
          {selection.hiddenCount > 0 || expanded ? (
            <button
              type="button"
              onClick={() => onExpandedChange(!expanded)}
              aria-expanded={expanded}
              className={cn(
                "ac-press -ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5",
                "hover:bg-neutral-800/40 hover:text-neutral-300 focus:outline-none",
                "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500"
              )}
            >
              {expanded ? (
                <ChevronUp size={12} aria-hidden />
              ) : (
                <ChevronDown size={12} aria-hidden />
              )}
              <span className="ac-tabular">
                {expanded ? "Show fewer" : `${selection.hiddenCount} more`}
              </span>
            </button>
          ) : null}
          <span className="ml-auto flex items-center gap-2">
            {workingCount > 0 ? (
              <span className="ac-tabular text-info-300">{workingCount} working</span>
            ) : null}
            {panel.idleCount > 0 ? (
              <span className="ac-tabular">{panel.idleCount} idle</span>
            ) : null}
            {panel.totalTokens > 0 ? (
              <span className="ac-tabular">Σ {formatSubagentTokenCount(panel.totalTokens)} tok</span>
            ) : null}
          </span>
        </footer>
      ) : null}
    </section>
  );
}

export { ROSTER_COLLAPSED_ROWS };
export default AgentRoster;
