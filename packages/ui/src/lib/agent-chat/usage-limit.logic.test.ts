import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import type { AgentAccount } from "@orquester/api";
import type { ChatUsageLimitState } from "@orquester/api/agent-chat";
import { limitFailoverText, limitedMarker, usageLimitBannerModel } from "./usage-limit.logic.ts";

const NOW = Date.parse("2026-10-20T14:28:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function account(id: string, label: string, agent: AgentAccount["agent"] = "claude", needsReauth = false): AgentAccount {
  return { id, agent, label, email: null, plan: null, needsReauth, createdAt: iso(NOW), importedAt: iso(NOW) };
}

const ACCOUNTS = [account("acc1", "work@example.com"), account("acc2", "personal"), account("cx1", "codex-one", "codex")];

function state(extra: Partial<ChatUsageLimitState> = {}): ChatUsageLimitState {
  return {
    noticeId: "a1", turnId: "t1", detectedAt: iso(NOW), limitedAt: iso(NOW),
    resetAt: "2026-10-20T15:40:00.000Z", accountId: "acc1", parked: false,
    autoResume: "armed", resumeAt: "2026-10-20T15:40:45.000Z", ...extra,
  };
}

const banner = (extra: Partial<ChatUsageLimitState>) =>
  usageLimitBannerModel({ state: state(extra), refId: "claude", accounts: ACCOUNTS, now: NOW });

test("the banner uses the user's local clock and the actual reset or resume time", () => {
  // Intl reads its default locale at process startup. Use the real environment, without
  // formatting overrides or mocking Intl. Pacific midnight and DST differ from UTC here.
  const worker = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { usageLimitBannerModel } from ${JSON.stringify(new URL("./usage-limit.logic.ts", import.meta.url).href)};
    const base = ${JSON.stringify(state())};
    const details = ["2026-10-20T06:40:00Z", "2026-10-20T09:05:00Z", "2026-11-02T09:05:00Z", "2026-10-20T06:40:00Z"].map((resetAt, i) =>
      usageLimitBannerModel({ state: { ...base, resetAt, autoResume: i === 3 ? "armed" : "off",
        resumeAt: i === 3 ? "2026-10-20T07:05:00Z" : null }, refId: "claude", accounts: [],
        now: Date.parse("2026-10-20T06:28:00Z") }).detail);
    console.log(JSON.stringify(details));
  `], { encoding: "utf8", env: { ...process.env, LANG: "en_GB.UTF-8", LC_ALL: "en_GB.UTF-8", TZ: "America/Los_Angeles", TSX_DISABLE_CACHE: "1" } });
  assert.equal(worker.status, 0, worker.stderr);
  const details = JSON.parse(worker.stdout) as string[];
  assert.match(details[0]!, /\b23:40\b/);
  assert.match(details[1]!, /\b0?2:05\b/);
  assert.match(details[2]!, /\b0?1:05\b/);
  assert.match(details[3]!, /\b0?0:05\b/, "an armed resume uses resumeAt, not the account's resetAt");
});

test("banner actions reflect whether automatic resume is armed, off, unknown or running", () => {
  const armed = banner({});
  assert.equal(armed.toggle?.armed, false);
  assert.equal(armed.canSwitch, true);
  assert.equal(armed.busy, false);
  assert.equal(banner({ autoResume: "off", resumeAt: null }).toggle?.armed, true);
  assert.equal(banner({ autoResume: "unscheduled", resetAt: null, resumeAt: null }).toggle, null);
  const resuming = banner({ autoResume: "resuming" });
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

test("failover identifies its accounts and only limited sessions have a marker", () => {
  const notice = limitFailoverText({ fromAccountId: "acc1", toAccountId: "acc2", at: iso(NOW), automatic: true }, ACCOUNTS);
  assert.ok(notice.title.includes("personal"));
  assert.ok(notice.detail.includes("work"));
  assert.notEqual(limitedMarker({ usageLimit: state() }, NOW), null);
  assert.equal(limitedMarker({ usageLimit: null }, NOW), null);
  assert.equal(limitedMarker({}, NOW), null);
});

test("an overload retries on its account instead of offering an account switch", () => {
  const retryAt = iso(NOW + 30_000);
  const overloaded = state({ kind: "overloaded", resetAt: retryAt, resumeAt: retryAt, message: "Selected model is at capacity." });
  const armed = banner(overloaded);
  assert.equal(armed.canSwitch, false);
  assert.ok(!armed.title.includes("work"), "provider capacity is not attributed to the account");
  assert.equal(armed.toggle?.armed, false);
  assert.equal(armed.tooltip, overloaded.message);
  assert.equal(banner({ ...overloaded, autoResume: "off", resumeAt: null }).toggle?.armed, true);
});
