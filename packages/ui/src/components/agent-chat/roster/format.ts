// Ported from T3 Code (MIT): apps/web/src/components/AgentsPanel.tsx:120-190
// and packages/client-runtime/src/state/subagentRuntime.ts:869-892

/**
 * Roster text formatting (spec §7.6).
 *
 * Every string a roster row shows is built here, so the three places that
 * render one — the agent row, the collapsed workflow summary and the drill-in
 * header — cannot drift apart. All of it is pure and unit-tested; the
 * components below do no formatting of their own.
 */

import type { RuntimeSubagent } from "@orquester/api/agent-chat";
import {
  agentActivityText as activityTextFor,
  isActiveSubagentStatus,
  isLoopOrGoalRow
} from "../../../lib/agent-chat/roster.logic";

/** U+25B8 + space. The mark that says "this line names a tool, not a summary". */
export const TOOL_PREFIX = "▸ ";

/** The chip that tells a shell row from an agent row at a glance (§7.6). */
export const BACKGROUND_SHELL_CHIP = "shell";

/** The shell row's third line — where an agent row names its model. */
export const BACKGROUND_SHELL_METRIC = "background shell";

/** The chips of the two rows that drive work rather than do it (§7.6). */
export const LOOP_CHIP = "loop";
export const GOAL_CHIP = "goal";

/** A loop's third line: what it is — it has no model, and its fires spend the tokens. */
export const LOOP_METRIC = "scheduled prompt";

/** A goal's third line leads with what it is, then the tokens it reported spending. */
export const GOAL_METRIC = "goal";

/** The row's kind, where a caller has it: a loop and a goal present as themselves. */
type MaybeKind = { kind?: RuntimeSubagent["kind"] };

/**
 * The model chip's text: the provider's slug with the noise stripped, plus the
 * effort when there is one.
 *
 * *T3: `state/subagentRuntime.ts:869-881`.*
 */
export function formatSubagentModelLabel(
  model: string | null | undefined,
  effort: string | null | undefined
): string | null {
  if (!model) return null;
  const compact = model
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "");
  return effort ? `${compact} · ${effort}` : compact;
}

/**
 * Token counts in the roster's own scale: exact below 1 000, then `k`, then
 * `M`. Deliberately coarser than the context meter's
 * {@link formatContextTokens}, because a roster row is metadata read at a
 * glance and a ticking `12 483` would fight the fixed-width rule.
 *
 * *T3: `state/subagentRuntime.ts:883-892`.*
 */
export function formatSubagentTokenCount(totalTokens: number | null | undefined): string {
  const value = typeof totalTokens === "number" && Number.isFinite(totalTokens) ? totalTokens : 0;
  if (value < 1000) return `${Math.max(0, Math.round(value))}`;
  if (value < 1_000_000) {
    const thousands = value / 1000;
    return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}k`;
  }
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** The three in-flight statuses (§7.6: they all present as one "working" look). */
export const isLiveStatus = isActiveSubagentStatus;

/**
 * The activity line, whose **order flips with status**: a live row leads with
 * what is happening now, a settled row leads with its outcome. An error is the
 * only inline preview on a failed row, because it explains a red row at a
 * glance.
 *
 * ```
 * live:    progress ?? lastToolName ?? result ?? error
 * settled: error ?? result ?? progress ?? lastToolName
 * ```
 *
 * The precedence is W11's `agentActivityText`; this adds the one thing a *row*
 * needs and a selector should not encode — the `▸ ` marker that says the line
 * is a tool name rather than a sentence the agent wrote.
 *
 * *T3: `AgentsPanel.tsx:120-137`.*
 */
export function agentActivityText(
  agent: Pick<
    RuntimeSubagent,
    "agentKind" | "status" | "progress" | "lastToolName" | "result" | "error" | "exitCode"
  > &
    MaybeKind
): string | null {
  const text = activityTextFor(agent as RuntimeSubagent);
  if (text === null) return null;
  // A shell has no tools, so the `▸ ` marker would be a lie about what the
  // line names — and a shell whose progress happens to equal a tool name is
  // exactly how it would sneak in. Nor has a loop or a goal.
  if (agent.agentKind === "background" || isLoopOrGoalRow(agent)) return text;
  const tool = agent.lastToolName?.trim();
  return tool !== undefined && tool.length > 0 && text === tool ? `${TOOL_PREFIX}${text}` : text;
}

/**
 * The third line: `model · N tok · N tools · run N`, with only the parts the
 * provider actually reported. The token slot always renders (as `— tok` when
 * unknown) so the line's shape does not change as usage arrives — the row is
 * fixed-height, and a slot that appears mid-run shifts everything after it.
 *
 * *T3: `AgentsPanel.tsx:150-156`.*
 */
export function rosterRowMetrics(
  agent: Pick<
    RuntimeSubagent,
    "agentKind" | "model" | "effort" | "usage" | "activationCount" | "exitCode"
  > &
    MaybeKind
): string[] {
  const run = agent.activationCount > 1 ? [`run ${agent.activationCount}`] : [];
  // A loop and a goal say what they are, as a shell does — neither has a
  // model of its own. A goal's tokens are the ones it reported spending (its
  // turns' and agents', which the roster never sums twice); a loop's fires
  // spend theirs on their own rows.
  if (agent.kind === "loop") return [LOOP_METRIC, ...run];
  if (agent.kind === "goal") {
    return [
      GOAL_METRIC,
      agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : "— tok",
      ...run
    ];
  }
  // A shell has no model and spends no tokens: the launching agent's model
  // leaked onto the row (and `— tok` beside it) is precisely what made a
  // background command read as a subagent. The line says what the row IS.
  if (agent.agentKind === "background") {
    return typeof agent.exitCode === "number"
      ? [BACKGROUND_SHELL_METRIC, `exit ${agent.exitCode}`]
      : [BACKGROUND_SHELL_METRIC];
  }
  const parts: string[] = [];
  const model = formatSubagentModelLabel(agent.model, agent.effort);
  if (model) parts.push(model);
  parts.push(agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : "— tok");
  if (agent.usage?.toolUses !== undefined) parts.push(`${agent.usage.toolUses} tools`);
  if (agent.activationCount > 1) parts.push(`run ${agent.activationCount}`);
  return parts;
}

/**
 * The role chip, suppressed when it case-folds equal to the title — no
 * "Reviewer · reviewer".
 *
 * A background shell always chips {@link BACKGROUND_SHELL_CHIP} instead: the
 * Terminal glyph alone was too quiet to tell a shell from a subagent at a
 * glance, and the chip slot is the one place on the row that says *what kind
 * of thing this is*. It is not suppressed against the title, because it names
 * the row's kind rather than a role the provider reported.
 *
 * *T3: `AgentsPanel.tsx:146-149`.*
 */
export function rosterRoleChip(
  agent: Pick<RuntimeSubagent, "agentKind" | "title" | "role"> & MaybeKind
): string | null {
  // A loop and a goal chip their kind, as a shell does: the one slot on the
  // row that says what kind of thing it is.
  if (agent.kind === "loop") return LOOP_CHIP;
  if (agent.kind === "goal") return GOAL_CHIP;
  if (agent.agentKind === "background") return BACKGROUND_SHELL_CHIP;
  const role = agent.role?.trim();
  if (!role) return null;
  return role.toLocaleLowerCase() === agent.title.trim().toLocaleLowerCase() ? null : role;
}
