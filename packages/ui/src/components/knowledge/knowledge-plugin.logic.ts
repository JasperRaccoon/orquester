/**
 * Settings → Plugins → Knowledge Graph: the indexing settings form (account
 * policy, model, concurrency) and the Activity block's text. Pure: no React,
 * no store.
 */

import {
  KNOWLEDGE_CONCURRENCY_MAX,
  KNOWLEDGE_CONCURRENCY_MIN,
  KNOWLEDGE_DEFAULT_SETTINGS,
  knowledgeLegacyAccountId,
  type AccountPolicy,
  type AgentAccount,
  type KnowledgeRebuildEstimate,
  type KnowledgeRunSummary,
  type KnowledgeWorkerView,
  type UpdateKnowledgeSettingsRequest
} from "@orquester/api";

import { shortAccountLabel } from "../../lib/account-label";
import { parseKnowledgeSettings, type KnowledgeSettingsAnswer } from "../../lib/knowledge/validate";
import { formatDuration } from "../../lib/workflows/format";
import { compactCount } from "../topbar/usage-format";

// ---------------------------------------------------------------------------
// Settings form
// ---------------------------------------------------------------------------

/** Longest model name the daemon stores (`KNOWLEDGE_MODEL_MAX` in its settings service). */
export const KNOWLEDGE_MODEL_INPUT_MAX = 200;
/** The model indexing runs when none is set (the daemon's `DEFAULT_KNOWLEDGE_MODEL`); scoped usage limits are checked for it. */
export const KNOWLEDGE_DEFAULT_MODEL = "sonnet";

export interface KnowledgeSettingsForm {
  /**
   * Which Claude accounts indexing uses, as the workflow Agent block's account policy editor edits
   * it; null on a server that predates policies, where `accountId` is edited instead.
   */
  accountPolicy: AccountPolicy | null;
  /** The one account a server that predates policies takes (null = automatic). */
  accountId: string | null;
  /** "" = the default model. */
  model: string;
  /** As typed, so a half-typed value can be shown and refused. */
  concurrency: string;
}

/**
 * The settings as the daemon sent them, read field by field (see
 * `parseKnowledgeSettings`; a null `accountPolicy` is a server that predates
 * policies); an answer that is not an object reads as the defaults.
 */
export function readKnowledgeSettings(value: unknown): KnowledgeSettingsAnswer {
  return parseKnowledgeSettings(value) ?? { ...KNOWLEDGE_DEFAULT_SETTINGS };
}

export function knowledgeSettingsForm(settings: KnowledgeSettingsAnswer): KnowledgeSettingsForm {
  return {
    accountPolicy: settings.accountPolicy,
    accountId: settings.accountId,
    model: settings.model ?? "",
    concurrency: String(settings.concurrency)
  };
}

/** The same policy, whatever its key order (an unset field and an absent one are the same). */
export function sameAccountPolicy(a: AccountPolicy, b: AccountPolicy): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value !== "object" || value === null) return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, canonical(record[key])])
    );
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Why the form cannot be saved, or null. */
export function knowledgeSettingsProblem(form: KnowledgeSettingsForm): string | null {
  const text = form.concurrency.trim();
  const concurrency = Number(text);
  if (text === "" || !Number.isInteger(concurrency) || concurrency < KNOWLEDGE_CONCURRENCY_MIN || concurrency > KNOWLEDGE_CONCURRENCY_MAX) {
    return `Concurrency is a whole number from ${KNOWLEDGE_CONCURRENCY_MIN} to ${KNOWLEDGE_CONCURRENCY_MAX}.`;
  }
  if (form.model.trim().length > KNOWLEDGE_MODEL_INPUT_MAX) return `The model name is at most ${KNOWLEDGE_MODEL_INPUT_MAX} characters.`;
  return null;
}

/**
 * What a save sends: only the fields that changed from `saved` (an empty
 * object when nothing did), or the form's problem. A changed policy goes with
 * the legacy `accountId` it approximates (a current daemon ignores it beside a
 * policy). A server that predates policies (`saved.accountPolicy` null) is
 * sent only the `accountId` chosen for it, the one account field it applies.
 */
export function knowledgeSettingsPatch(
  saved: KnowledgeSettingsAnswer,
  form: KnowledgeSettingsForm
): { patch: UpdateKnowledgeSettingsRequest } | { error: string } {
  const problem = knowledgeSettingsProblem(form);
  if (problem) return { error: problem };
  const patch: UpdateKnowledgeSettingsRequest = {};
  if (saved.accountPolicy === null || form.accountPolicy === null) {
    if (form.accountId !== saved.accountId) patch.accountId = form.accountId;
  } else if (!sameAccountPolicy(form.accountPolicy, saved.accountPolicy)) {
    patch.accountPolicy = form.accountPolicy;
    patch.accountId = knowledgeLegacyAccountId(form.accountPolicy);
  }
  const model = form.model.trim() === "" ? null : form.model.trim();
  if (model !== saved.model) patch.model = model;
  const concurrency = Number(form.concurrency.trim());
  if (concurrency !== saved.concurrency) patch.concurrency = concurrency;
  return { patch };
}

export interface KnowledgeAccountOption {
  /** "" = automatic (null on the wire). */
  value: string;
  label: string;
}

export const KNOWLEDGE_AUTOMATIC_ACCOUNT_LABEL = "Automatic (with failover)";

/**
 * The one-account picker a server that predates policies gets: automatic,
 * then the user's Claude accounts (never the System login, which such a server
 * refuses). A chosen account this client does not list (removed, or the list
 * not read yet) stays as an option of its own, so the picker never shows a
 * choice the daemon does not have.
 */
export function knowledgeAccountOptions(
  accounts: readonly Pick<AgentAccount, "id" | "agent" | "label" | "needsReauth">[] | undefined,
  selected: string | null
): KnowledgeAccountOption[] {
  const claude = (accounts ?? []).filter((account) => account.agent === "claude");
  const options: KnowledgeAccountOption[] = [{ value: "", label: KNOWLEDGE_AUTOMATIC_ACCOUNT_LABEL }];
  for (const account of claude) {
    const label = shortAccountLabel(account.label) || account.id;
    options.push({ value: account.id, label: account.needsReauth ? `${label} (needs sign-in)` : label });
  }
  if (selected !== null && !claude.some((account) => account.id === selected)) {
    options.push({ value: selected, label: accounts === undefined ? selected : `Unknown account (${selected})` });
  }
  return options;
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

/** "1.2M in · 340k out", "None yet" when nothing was used. */
export function knowledgeTokensText(tokens: { in: number; out: number }): string {
  if (tokens.in <= 0 && tokens.out <= 0) return "None yet";
  return `${compactCount(Math.max(0, tokens.in))} in · ${compactCount(Math.max(0, tokens.out))} out`;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

const RUN_OUTCOME: Record<KnowledgeRunSummary["outcome"], string> = {
  running: "running",
  ok: "finished",
  failed: "failed",
  cancelled: "cancelled"
};

const RUN_MODE: Record<KnowledgeRunSummary["mode"], string> = {
  full: "Full run",
  update: "Update",
  "grow-schema": "Schema growth",
  rebuild: "Rebuild"
};

export interface KnowledgeRunLine {
  /** "Update · finished" */
  title: string;
  /** When it started, e.g. "3h ago" ("" when the time does not parse). */
  when: string;
  /** "4m 12s"-style, "" while running or unknown. */
  took: string;
  /** "12 entries · 48 tasks · 1.2M in · 340k out". */
  detail: string;
  failed: boolean;
}

/** The last run as the Activity block shows it; `ago` formats the start time. */
export function knowledgeRunLine(run: KnowledgeRunSummary, ago: (iso: string) => string): KnowledgeRunLine {
  const elapsed =
    run.durationMs !== null && run.durationMs >= 0
      ? run.durationMs
      : run.finishedAt
        ? Date.parse(run.finishedAt) - Date.parse(run.startedAt)
        : NaN;
  return {
    title: `${RUN_MODE[run.mode] ?? "Run"} · ${RUN_OUTCOME[run.outcome] ?? run.outcome}`,
    when: ago(run.startedAt),
    took: run.outcome === "running" ? "" : formatDuration(elapsed),
    detail: [
      plural(run.entries, "entry", "entries"),
      plural(run.tasks, "task", "tasks"),
      knowledgeTokensText({ in: run.tokensIn, out: run.tokensOut }).replace("None yet", "no tokens")
    ].join(" · "),
    failed: run.outcome === "failed"
  };
}

/** How many worker sessions the Activity block lists. */
export const KNOWLEDGE_WORKERS_SHOWN = 5;

/** Running workers first, then the most recently started; at most {@link KNOWLEDGE_WORKERS_SHOWN}. */
export function knowledgeWorkersShown(workers: readonly KnowledgeWorkerView[]): KnowledgeWorkerView[] {
  const rank = (w: KnowledgeWorkerView) => (w.state === "running" ? 0 : 1);
  return [...workers]
    .sort((a, b) => rank(a) - rank(b) || Date.parse(b.startedAt) - Date.parse(a.startedAt) || a.sessionId.localeCompare(b.sessionId))
    .slice(0, KNOWLEDGE_WORKERS_SHOWN);
}

/** "Running · 3 tasks". */
export function knowledgeWorkerText(worker: Pick<KnowledgeWorkerView, "state" | "tasks">): string {
  const state = worker.state === "running" ? "Running" : worker.state === "done" ? "Done" : "Failed";
  return `${state} · ${plural(worker.tasks, "task", "tasks")}`;
}

/** The rebuild confirmation: what it re-does and the estimate (information only), or why there is none. */
export function knowledgeRebuildMessage(estimate: KnowledgeRebuildEstimate | null, estimateError: string | null): string {
  const head = "Rebuilding extracts the concepts of every entry again from scratch, through the indexing account's Claude sessions.";
  if (estimate) {
    return `${head} That is about ${plural(estimate.tasks, "task", "tasks")} (model calls) for ${plural(estimate.entries, "entry", "entries")}.`;
  }
  if (estimateError) return `${head} The estimate is unavailable: ${estimateError}`;
  return `${head} Estimating…`;
}
