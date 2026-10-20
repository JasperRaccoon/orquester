import assert from "node:assert/strict";
import test from "node:test";

import type { AgentAccount } from "@orquester/api";
import type { ChatUsageLimitState } from "@orquester/api/agent-chat";

import {
  formatLimitClock,
  formatLimitCountdown,
  limitAccountLabel,
  limitFailoverText,
  limitedMarker,
  usageLimitBannerModel,
  usageLimitStatusText
} from "./usage-limit.logic.ts";

const NOW = Date.parse("2026-10-20T14:28:00.000Z");
const UTC = { locale: "en-US", timeZone: "UTC" };
const iso = (ms: number): string => new Date(ms).toISOString();

function account(id: string, label: string, agent: AgentAccount["agent"] = "claude", needsReauth = false): AgentAccount {
  return { id, agent, label, email: null, plan: null, needsReauth, createdAt: iso(NOW), importedAt: iso(NOW) };
}

const ACCOUNTS = [account("acc1", "work@example.com"), account("acc2", "personal"), account("cx1", "codex-one", "codex")];

function state(extra: Partial<ChatUsageLimitState> = {}): ChatUsageLimitState {
  return {
    noticeId: "a1",
    turnId: "t1",
    detectedAt: iso(NOW),
    limitedAt: iso(NOW),
    resetAt: "2026-10-20T15:40:00.000Z",
    accountId: "acc1",
    parked: false,
    autoResume: "armed",
    resumeAt: "2026-10-20T15:40:45.000Z",
    ...extra
  };
}

test("countdowns are floored to the minute and never negative", () => {
  assert.equal(formatLimitCountdown(72 * 60_000 + 59_000), "1h 12m");
  assert.equal(formatLimitCountdown(60 * 60_000), "1h");
  assert.equal(formatLimitCountdown(12 * 60_000), "12m");
  assert.equal(formatLimitCountdown(59_000), "<1m");
  assert.equal(formatLimitCountdown(-5_000), "<1m");
  assert.equal(formatLimitCountdown((2 * 1440 + 3 * 60 + 7) * 60_000), "2d 3h");
  assert.equal(formatLimitCountdown(3 * 1440 * 60_000), "3d");
});

test("the clock reads today's time alone, a weekday within the week, a date beyond", () => {
  assert.equal(formatLimitClock("2026-10-20T15:40:00.000Z", NOW, UTC), "3:40 PM");
  assert.equal(formatLimitClock("2026-10-22T09:05:00.000Z", NOW, UTC), "Thu 9:05 AM");
  assert.equal(formatLimitClock("2026-11-02T09:05:00.000Z", NOW, UTC), "Nov 2, 9:05 AM");
  assert.equal(formatLimitClock("not a time", NOW, UTC), "");
});

test("the status line follows the automatic resume", () => {
  assert.equal(usageLimitStatusText(state(), NOW, UTC), "Resumes automatically at 3:40 PM (in 1h 12m)");
  assert.equal(usageLimitStatusText(state({ autoResume: "off", resumeAt: null }), NOW, UTC), "Resets at 3:40 PM (in 1h 12m)");
  assert.equal(usageLimitStatusText(state({ autoResume: "off", resumeAt: null, resetAt: iso(NOW - 60_000) }), NOW, UTC), "Reset at 2:27 PM");
  assert.equal(usageLimitStatusText(state({ autoResume: "unscheduled", resetAt: null, resumeAt: null }), NOW, UTC), "Reset time unknown");
  assert.equal(usageLimitStatusText(state({ autoResume: "resuming", resumeAt: null }), NOW, UTC), "Resuming…");
  assert.equal(usageLimitStatusText(state({ resumeAt: iso(NOW + 30_000) }), NOW, UTC), "Resumes automatically shortly");
});

test("the banner: title, detail, toggle and switch", () => {
  const armed = usageLimitBannerModel({ state: state(), refId: "claude", accounts: ACCOUNTS, now: NOW, clock: UTC });
  assert.equal(armed.title, "Usage limit reached on work");
  assert.equal(armed.detail, "· Resumes automatically at 3:40 PM (in 1h 12m)");
  assert.deepEqual(armed.toggle, { label: "Cancel auto-resume", armed: false });
  assert.equal(armed.canSwitch, true);
  assert.equal(armed.busy, false);

  const off = usageLimitBannerModel({ state: state({ autoResume: "off", resumeAt: null }), refId: "claude", accounts: ACCOUNTS, now: NOW, clock: UTC });
  assert.deepEqual(off.toggle, { label: "Resume at reset", armed: true });
  assert.equal(off.detail, "· Resets at 3:40 PM (in 1h 12m)");

  const unknown = usageLimitBannerModel({
    state: state({ autoResume: "unscheduled", resetAt: null, resumeAt: null }),
    refId: "claude",
    accounts: ACCOUNTS,
    now: NOW
  });
  assert.equal(unknown.toggle, null, "nothing to schedule without a reset");

  const resuming = usageLimitBannerModel({ state: state({ autoResume: "resuming" }), refId: "claude", accounts: ACCOUNTS, now: NOW });
  assert.equal(resuming.busy, true);
  assert.equal(resuming.toggle, null);
});

test("switching is offered only with another usable account of the same agent, never for OpenCode", () => {
  const only = [account("acc1", "work"), account("acc2", "stale", "claude", true), account("cx1", "codex", "codex")];
  assert.equal(usageLimitBannerModel({ state: state(), refId: "claude", accounts: only, now: NOW }).canSwitch, false);
  assert.equal(
    usageLimitBannerModel({ state: state({ accountId: "" }), refId: "claude", accounts: [account("acc1", "work")], now: NOW }).canSwitch,
    true,
    "a chat on the system login may move to a managed account"
  );
  assert.equal(usageLimitBannerModel({ state: state({ accountId: "" }), refId: "opencode", accounts: ACCOUNTS, now: NOW }).canSwitch, false);
  assert.equal(usageLimitBannerModel({ state: state(), refId: "claude", accounts: undefined, now: NOW }).canSwitch, false);
});

test("account labels, the failover notice and the Limited marker", () => {
  assert.equal(limitAccountLabel("", ACCOUNTS), "System");
  assert.equal(limitAccountLabel("system", ACCOUNTS), "System");
  assert.equal(limitAccountLabel("acc2", ACCOUNTS), "personal");
  assert.equal(limitAccountLabel("gone", ACCOUNTS), "gone");
  assert.deepEqual(limitFailoverText({ fromAccountId: "acc1", toAccountId: "acc2", at: iso(NOW), automatic: true }, ACCOUNTS), {
    title: "Switched to personal",
    detail: "after a usage limit on work"
  });
  assert.equal(limitedMarker({ usageLimit: null }, NOW), null);
  assert.equal(limitedMarker({}, NOW), null);
  assert.deepEqual(limitedMarker({ usageLimit: state() }, NOW, UTC), {
    label: "Limited",
    title: "Usage limit reached · Resumes automatically at 3:40 PM (in 1h 12m)"
  });
});
