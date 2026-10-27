/**
 * Agent chat — what a chat stopped on its usage limit shows (`@orquester/api`
 * `agent-chat/usage-limit.ts`): the banner above the composer, the notice after
 * an automatic account switch, and the "Limited" marker on every surface that
 * lists the chat. Everything reads `SessionSummary.usageLimit` /
 * `.limitFailover`, which the daemon publishes live, so no surface polls.
 *
 * Pure (no React), so the wording and the countdown are testable without a DOM.
 */

import { SYSTEM_ACCOUNT_ID, type AgentAccount, type SessionSummary } from "@orquester/api";
import type { ChatLimitFailover, ChatUsageLimitState } from "@orquester/api/agent-chat";

import { shortAccountLabel } from "../account-label";
import { chatAccountSwitchSupported } from "./account-switch";

/** Locale and zone overrides, for tests; the user's own by default. */
export interface LimitClockOptions {
  locale?: string;
  timeZone?: string;
}

/** "2d 3h", "1h 12m", "12m", "<1m" — floored, never negative. */
export function formatLimitCountdown(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

function dayKey(date: Date, timeZone: string | undefined): string {
  return date.toLocaleDateString("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
}

/**
 * The wall clock a limit resets (or the chat resumes) at: "3:40 PM" today, "Tue 3:40 PM" within
 * the week, "Oct 28, 3:40 PM" further out. "" for an unreadable stamp.
 */
export function formatLimitClock(iso: string, now: number, opts: LimitClockOptions = {}): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  // ICU puts a narrow no-break space before the day period ("3:40\u202fPM"); a plain one reads the same everywhere.
  const time = date
    .toLocaleTimeString(opts.locale, { hour: "numeric", minute: "2-digit", timeZone: opts.timeZone })
    .replace(/[\u202f\u00a0]/g, " ");
  if (dayKey(date, opts.timeZone) === dayKey(new Date(now), opts.timeZone)) return time;
  const ahead = date.getTime() - now;
  if (ahead > 0 && ahead < 6 * 24 * 60 * 60_000) {
    return `${date.toLocaleDateString(opts.locale, { weekday: "short", timeZone: opts.timeZone })} ${time}`;
  }
  return `${date.toLocaleDateString(opts.locale, { month: "short", day: "numeric", timeZone: opts.timeZone })}, ${time}`;
}

/** An account id as the chat surfaces name it: "System" for the system login, else its short label. */
export function limitAccountLabel(accountId: string | undefined, accounts: readonly AgentAccount[] | undefined): string {
  if (!accountId || accountId === SYSTEM_ACCOUNT_ID) return "System";
  const account = (accounts ?? []).find((candidate) => candidate.id === accountId);
  return shortAccountLabel(account?.label) || accountId;
}

/** "at 3:40 PM (in 1h 12m)", or "shortly" once the time is (about) here. */
function when(iso: string, now: number, opts: LimitClockOptions): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t - now < 60_000) return "shortly";
  return `at ${formatLimitClock(iso, now, opts)} (in ${formatLimitCountdown(t - now)})`;
}

/** The one line after the title: where the automatic resume stands. */
export function usageLimitStatusText(state: ChatUsageLimitState, now: number, opts: LimitClockOptions = {}): string {
  if (state.kind === "overloaded") {
    // `resetAt` is the retry's own time, not an account reset.
    switch (state.autoResume) {
      case "resuming":
        return "Retrying…";
      case "armed":
        return state.resumeAt ? `Retries automatically ${when(state.resumeAt, now, opts)}` : "Retries automatically";
      default:
        return "Not retrying automatically";
    }
  }
  switch (state.autoResume) {
    case "resuming":
      return "Resuming…";
    case "armed":
      return state.resumeAt ? `Resumes automatically ${when(state.resumeAt, now, opts)}` : "Resumes automatically";
    case "off": {
      if (!state.resetAt) return "Reset time unknown";
      const t = Date.parse(state.resetAt);
      return Number.isFinite(t) && t > now ? `Resets ${when(state.resetAt, now, opts)}` : `Reset at ${formatLimitClock(state.resetAt, now, opts)}`;
    }
    default:
      // `unscheduled`, and any status a newer daemon may send.
      return state.resetAt ? `Resets ${when(state.resetAt, now, opts)}` : "Reset time unknown";
  }
}

export interface UsageLimitBannerModel {
  /** "Usage limit reached on <account>", or "Model at capacity" (an overload). */
  title: string;
  /** "· Resumes automatically at 3:40 PM (in 1h 12m)", "· Resets at …", "· Reset time unknown". */
  detail: string;
  /** The provider's own message, for the banner's tooltip. */
  tooltip: string;
  /** The toggle: its label and the value it sends (`armed`); null when nothing can be toggled. */
  toggle: { label: "Cancel auto-resume" | "Resume at reset" | "Cancel auto-retry" | "Retry automatically"; armed: boolean } | null;
  /** A resume or switch is under way: every action waits. */
  busy: boolean;
  /** "Switch account & continue" is offered: another usable account of the chat's agent exists. */
  canSwitch: boolean;
}

/** The banner of a limited chat. */
export function usageLimitBannerModel(input: {
  state: ChatUsageLimitState;
  refId: string;
  accounts: readonly AgentAccount[] | undefined;
  now: number;
  clock?: LimitClockOptions;
}): UsageLimitBannerModel {
  const { state } = input;
  const busy = state.autoResume === "resuming";
  const overloaded = state.kind === "overloaded";
  const toggle: UsageLimitBannerModel["toggle"] =
    state.autoResume === "armed"
      ? { label: overloaded ? "Cancel auto-retry" : "Cancel auto-resume", armed: false }
      : state.autoResume === "off" && state.resetAt !== null
        ? { label: overloaded ? "Retry automatically" : "Resume at reset", armed: true }
        : null;
  const current = state.accountId || SYSTEM_ACCOUNT_ID;
  // Another account does not help when the provider itself has no capacity.
  const canSwitch =
    !overloaded &&
    chatAccountSwitchSupported({ refId: input.refId }) &&
    (input.accounts ?? []).some((account) => account.agent === input.refId && account.id !== current && !account.needsReauth);
  return {
    title: overloaded ? "Model at capacity" : `Usage limit reached on ${limitAccountLabel(state.accountId, input.accounts)}`,
    detail: `· ${usageLimitStatusText(state, input.now, input.clock)}`,
    tooltip: state.message ?? (overloaded ? "The provider had no capacity for the model." : "The agent's account ran out of quota."),
    toggle,
    busy,
    canSwitch
  };
}

/** The notice after a switch: "Switched to <to> after a usage limit on <from>". */
export function limitFailoverText(failover: ChatLimitFailover, accounts: readonly AgentAccount[] | undefined): { title: string; detail: string } {
  return {
    title: `Switched to ${limitAccountLabel(failover.toAccountId, accounts)}`,
    detail: `after a usage limit on ${limitAccountLabel(failover.fromAccountId, accounts)}`
  };
}

/** The "Limited" marker of a session row: its tooltip names the reset; null when the chat is not limited. */
export function limitedMarker(
  session: Pick<SessionSummary, "usageLimit">,
  now: number,
  opts: LimitClockOptions = {}
): { label: "Limited" | "At capacity"; title: string } | null {
  const state = session.usageLimit;
  if (!state) return null;
  if (state.kind === "overloaded") return { label: "At capacity", title: `Model at capacity · ${usageLimitStatusText(state, now, opts)}` };
  return { label: "Limited", title: `Usage limit reached · ${usageLimitStatusText(state, now, opts)}` };
}
