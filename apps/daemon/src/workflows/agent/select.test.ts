import assert from "node:assert/strict";
import test from "node:test";
import type { AgentAccount, AgentAccountsResponse, AgentUsage, UsageAccount, UsageResponse } from "@orquester/api";
import type { AccountCooldown, AccountPolicy, AgentChainEntry } from "@orquester/config";
import {
  burntWindowResetAt,
  rankChainEntry,
  sameFamilyAlternatives,
  selectAccount,
  type SelectAccountInput
} from "./select.ts";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();
const fresh = at(-2 * MIN);

function account(agent: AgentAccount["agent"], id: string, label = id, extra: Partial<AgentAccount> = {}): AgentAccount {
  return { id, agent, label, email: null, plan: null, needsReauth: false, createdAt: at(-DAY), importedAt: at(-DAY), ...extra };
}

function row(id: string, label: string, windows: { session?: [number, number] | null; weekly?: [number, number] | null; scoped?: [string, number, number][] }, extra: Partial<UsageAccount> = {}): UsageAccount {
  const w = (spec: [number, number] | null | undefined) => (spec ? { percent: spec[0], resetsAt: at(spec[1]) } : null);
  return {
    id,
    label,
    available: true,
    stale: false,
    session: w(windows.session),
    weekly: w(windows.weekly),
    ...(windows.scoped ? { scopedWindows: windows.scoped.map(([l, p, r]) => ({ label: l, percent: p, resetsAt: at(r) })) } : {}),
    asOf: fresh,
    ...extra
  };
}

function agentRow(id: string, accounts: UsageAccount[], extra: Partial<AgentUsage> = {}): AgentUsage {
  return {
    id,
    available: true,
    stale: false,
    session: null,
    weekly: null,
    asOf: fresh,
    accounts,
    aggregate: { strategy: "worst-account", accountCount: accounts.length },
    ...extra
  };
}

// The owner's example (spec §5.2).
const claudeAccounts = [
  account("claude", "a-jasperclaude", "jasperclaude"),
  account("claude", "a-arakuma", "arakuma.panama"),
  account("claude", "a-eduard", "therealeduard465"),
  account("claude", "a-jasperinuwu", "jasperinuwu")
];
const claudeUsage = agentRow("claude", [
  row("a-jasperclaude", "jasperclaude", { session: [15, 2 * HOUR], weekly: [63, 4 * DAY + 2 * HOUR] }),
  row("a-arakuma", "arakuma.panama", { weekly: [16, 5 * DAY + 8 * HOUR] }),
  row("a-eduard", "therealeduard465", { weekly: [90, DAY + 2 * HOUR], scoped: [["Fable", 48, DAY + 2 * HOUR]] }),
  row("a-jasperinuwu", "jasperinuwu", { session: [3, 4 * HOUR], weekly: [0, 6 * DAY + 22 * HOUR] })
]);

function accountsOf(...accounts: AgentAccount[]): AgentAccountsResponse {
  return { accounts, defaults: { claude: null, codex: null, grok: null } };
}

function entry(agent: string, model: string, policy: Partial<AccountPolicy> = {}): AgentChainEntry {
  return {
    agent,
    model,
    accounts: { strategy: "least-used", includeSystem: false, soonestResetWindow: "weekly", leastUsedMetric: "max", unknownUsage: "last", ...policy }
  };
}

function input(overrides: Partial<SelectAccountInput> & Pick<SelectAccountInput, "chain">): SelectAccountInput {
  return {
    usage: { agents: [claudeUsage] },
    accounts: accountsOf(...claudeAccounts),
    cooldowns: {},
    now: NOW,
    ...overrides
  };
}

const cooldown = (untilMs: number, reason: AccountCooldown["reason"] = "usage_limit"): AccountCooldown => ({
  until: at(untilMs),
  reason,
  setAt: at(-MIN)
});

test("owner's example: soonest weekly reset under 85% picks jasperclaude and skips therealeduard465", () => {
  const decision = selectAccount(input({ chain: [entry("claude", "claude-opus-5", { strategy: "soonest-reset", maxWeeklyPct: 85 })] }));
  assert.equal(decision.chosen?.accountId, "a-jasperclaude");
  assert.equal(decision.chosen?.accountLabel, "jasperclaude");
  assert.equal(decision.chosen?.chainIndex, 0);
  assert.equal(decision.chosen?.agent, "claude");
  assert.equal(decision.usageAsOf, fresh);
  assert.deepEqual(decision.skipped.map(({ accountId, why }) => ({ accountId, why })), [{ accountId: "a-eduard", why: "threshold" }]);
});

test("soonest-reset without a threshold takes the earliest weekly reset", () => {
  const decision = selectAccount(input({ chain: [entry("claude", "m", { strategy: "soonest-reset" })] }));
  assert.equal(decision.chosen?.accountLabel, "therealeduard465");
  assert.deepEqual(decision.skipped, []);
});

test("soonest-reset on the session window: unknown resets go last", () => {
  const decision = selectAccount(input({ chain: [entry("claude", "m", { strategy: "soonest-reset", soonestResetWindow: "session" })] }));
  assert.equal(decision.chosen?.accountLabel, "jasperclaude", "session resets in 2h, before jasperinuwu's 4h; the others have no session window");
  const ranked = rankChainEntry(input({ chain: [entry("claude", "m", { strategy: "soonest-reset", soonestResetWindow: "session" })] }), 0).ranked;
  assert.deepEqual(ranked.map((c) => c.label), ["jasperclaude", "jasperinuwu", "arakuma.panama", "therealeduard465"]);
});

test("least-used (max) picks jasperinuwu", () => {
  const decision = selectAccount(input({ chain: [entry("claude", "m", { strategy: "least-used", maxWeeklyPct: 85 })] }));
  assert.equal(decision.chosen?.accountLabel, "jasperinuwu");
  const ranked = rankChainEntry(input({ chain: [entry("claude", "m", { strategy: "least-used" })] }), 0).ranked;
  assert.deepEqual(ranked.map((c) => c.label), ["jasperinuwu", "arakuma.panama", "jasperclaude", "therealeduard465"]);
});

test("least-used ties break on the soonest weekly reset, then the label", () => {
  const usage: UsageResponse = {
    agents: [
      agentRow("claude", [
        row("x", "zeta", { weekly: [20, 3 * DAY] }),
        row("y", "alpha", { weekly: [20, 5 * DAY] }),
        row("z", "beta", { weekly: [20, 5 * DAY] })
      ])
    ]
  };
  const ranked = rankChainEntry(
    input({ usage, accounts: accountsOf(account("claude", "y", "alpha"), account("claude", "z", "beta"), account("claude", "x", "zeta")), chain: [entry("claude", "m", { leastUsedMetric: "weekly" })] }),
    0
  ).ranked;
  assert.deepEqual(ranked.map((c) => c.label), ["zeta", "alpha", "beta"]);
});

test("fixed order [therealeduard465, jasperclaude] under 85% weekly picks jasperclaude — by label or by id", () => {
  for (const accounts of [["therealeduard465", "jasperclaude"], ["a-eduard", "a-jasperclaude"]]) {
    const decision = selectAccount(input({ chain: [entry("claude", "m", { strategy: "fixed", accounts, maxWeeklyPct: 85 })] }));
    assert.equal(decision.chosen?.accountId, "a-jasperclaude");
    assert.deepEqual(decision.skipped.map((skip) => [skip.accountId, skip.why]), [["a-eduard", "threshold"]]);
  }
  // Without the threshold the fixed order's first wins, however used it is.
  const first = selectAccount(input({ chain: [entry("claude", "m", { strategy: "fixed", accounts: ["therealeduard465", "jasperclaude"] })] }));
  assert.equal(first.chosen?.accountLabel, "therealeduard465");
});

test("an allow-list filters the family, and names what it cannot find", () => {
  const decision = selectAccount(input({ chain: [entry("claude", "m", { accounts: ["jasperclaude", "arakuma.panama", "ghost"] })] }));
  assert.equal(decision.chosen?.accountLabel, "arakuma.panama", "least used of the two allowed");
  assert.deepEqual(decision.skipped.map((skip) => [skip.accountId, skip.why]), [["ghost", "unavailable"]]);
});

test("a scoped threshold applies only to the models it names", () => {
  const scoped = [{ label: "Fable", maxPct: 40, onlyForModels: ["claude-fable-5"] }];
  const opus = selectAccount(input({ chain: [entry("claude", "claude-opus-5", { strategy: "soonest-reset", scoped })] }));
  assert.equal(opus.chosen?.accountLabel, "therealeduard465");
  const fable = selectAccount(input({ chain: [entry("claude", "claude-fable-5", { strategy: "soonest-reset", scoped })] }));
  assert.equal(fable.chosen?.accountLabel, "jasperclaude");
  assert.deepEqual(fable.skipped.map((skip) => [skip.accountId, skip.why]), [["a-eduard", "threshold"]]);
  // No onlyForModels: every model.
  const all = selectAccount(input({ chain: [entry("claude", "claude-opus-5", { strategy: "soonest-reset", scoped: [{ label: "fable", maxPct: 40 }] })] }));
  assert.equal(all.chosen?.accountLabel, "jasperclaude");
});

test("a window at 100% is always burnt; a burnt scoped window stops only the models it covers", () => {
  const usage: UsageResponse = {
    agents: [
      agentRow("claude", [
        row("a", "a", { session: [100, HOUR], weekly: [10, 3 * DAY] }),
        row("b", "b", { weekly: [30, 4 * DAY], scoped: [["Fable", 100, 2 * DAY]] })
      ])
    ]
  };
  const accounts = accountsOf(account("claude", "a"), account("claude", "b"));
  const opus = selectAccount(input({ usage, accounts, chain: [entry("claude", "claude-opus-5")] }));
  assert.equal(opus.chosen?.accountId, "b");
  assert.deepEqual(opus.skipped.map((skip) => [skip.accountId, skip.why]), [["a", "threshold"]]);
  const fable = selectAccount(input({ usage, accounts, chain: [entry("claude", "claude-fable-5")] }));
  assert.equal(fable.chosen, null);
  assert.deepEqual(fable.skipped.map((skip) => [skip.accountId, skip.why]), [["a", "threshold"], ["b", "threshold"]]);
  assert.equal(fable.earliestResetAt, at(HOUR));
});

test("expired windows are ignored: a pre-reset 100% no longer blocks", () => {
  const usage: UsageResponse = { agents: [agentRow("claude", [row("a", "a", { session: [100, -MIN], weekly: [100, -HOUR] })])] };
  const decision = selectAccount(input({ usage, accounts: accountsOf(account("claude", "a")), chain: [entry("claude", "m", { maxWeeklyPct: 50 })] }));
  assert.equal(decision.chosen?.accountId, "a");
});

test("unknown usage is tried after every known account — or dropped with unknownUsage: exclude", () => {
  const usage: UsageResponse = {
    agents: [
      agentRow("claude", [
        row("known", "known", { weekly: [70, 3 * DAY] }),
        row("off", "off", { weekly: [1, 3 * DAY] }, { available: false }),
        row("old", "old", { weekly: [2, 3 * DAY] }, { asOf: at(-30 * MIN) })
        // "missing" has no row at all
      ])
    ]
  };
  const accounts = accountsOf(account("claude", "missing"), account("claude", "off"), account("claude", "old"), account("claude", "known"));
  const ranked = rankChainEntry(input({ usage, accounts, chain: [entry("claude", "m")] }), 0).ranked;
  assert.deepEqual(
    ranked.map((c) => [c.accountId, c.usage]),
    [["known", "known"], ["missing", "unknown"], ["off", "unknown"], ["old", "unknown"]]
  );

  // The known one is over the threshold: an unknown one still runs rather than nothing.
  const blocked = selectAccount(input({ usage, accounts, chain: [entry("claude", "m", { maxWeeklyPct: 50 })] }));
  assert.equal(blocked.chosen?.accountId, "missing");

  const excluded = selectAccount(input({ usage, accounts, chain: [entry("claude", "m", { maxWeeklyPct: 50, unknownUsage: "exclude" })] }));
  assert.equal(excluded.chosen, null);
  assert.deepEqual(excluded.skipped.map((s) => [s.accountId, s.why]), [
    ["missing", "unknownUsage"],
    ["off", "unknownUsage"],
    ["old", "unknownUsage"],
    ["known", "threshold"]
  ]);
  assert.equal(excluded.earliestResetAt, at(3 * DAY));
});

test("needsReauth, cooldowns and the exclude set drop candidates", () => {
  const accounts = accountsOf(
    account("claude", "a-jasperclaude", "jasperclaude"),
    account("claude", "a-arakuma", "arakuma.panama", { needsReauth: true }),
    account("claude", "a-eduard", "therealeduard465"),
    account("claude", "a-jasperinuwu", "jasperinuwu")
  );
  const decision = selectAccount(
    input({
      accounts,
      cooldowns: { "claude:a-jasperinuwu": cooldown(3 * HOUR), "codex:a-jasperclaude": cooldown(HOUR) },
      exclude: new Set(["claude:a-eduard"]),
      chain: [entry("claude", "m")]
    })
  );
  assert.equal(decision.chosen?.accountLabel, "jasperclaude", "a codex-keyed cooldown does not touch the claude account");
  assert.deepEqual(decision.skipped.map((s) => [s.label, s.why]), [
    ["arakuma.panama", "needsReauth"],
    ["therealeduard465", "unavailable"],
    ["jasperinuwu", "cooldown"]
  ]);
});

test("an expired cooldown no longer counts", () => {
  const decision = selectAccount(input({ cooldowns: { "claude:a-jasperinuwu": cooldown(-MIN) }, chain: [entry("claude", "m")] }));
  assert.equal(decision.chosen?.accountLabel, "jasperinuwu");
});

test("cross-family fallback: claude (all burnt or cooling) → codex (reauth, burnt) → grok", () => {
  const usage: UsageResponse = {
    agents: [
      claudeUsage,
      agentRow("codex", [row("c1", "c1", { weekly: [100, 2 * DAY] }), row("c2", "c2", { weekly: [5, 2 * DAY] })]),
      agentRow("grok", [row("g1", "g1", { weekly: [40, 3 * DAY] })])
    ]
  };
  const accounts = accountsOf(
    ...claudeAccounts,
    account("codex", "c1"),
    account("codex", "c2", "c2", { needsReauth: true }),
    account("grok", "g1")
  );
  const chain = [
    entry("claude", "claude-opus-5", { maxWeeklyPct: 60 }),
    entry("codex", "gpt-5.5", { strategy: "soonest-reset" }),
    entry("grok", "grok-build", { maxSessionPct: 50 })
  ];
  const decision = selectAccount(
    input({ usage, accounts, chain, cooldowns: { "claude:a-arakuma": cooldown(5 * HOUR), "claude:a-jasperinuwu": cooldown(2 * HOUR) } })
  );
  assert.deepEqual(decision.chosen, { agent: "grok", model: "grok-build", accountId: "g1", accountLabel: "g1", chainIndex: 2 });
  assert.deepEqual(decision.skipped.map((s) => [s.agent, s.accountId, s.why]), [
    ["claude", "a-jasperclaude", "threshold"],
    ["claude", "a-arakuma", "cooldown"],
    ["claude", "a-eduard", "threshold"],
    ["claude", "a-jasperinuwu", "cooldown"],
    ["codex", "c1", "threshold"],
    ["codex", "c2", "needsReauth"]
  ]);

  // fromChainIndex starts later in the chain; onlyChainIndex never falls through.
  assert.equal(selectAccount(input({ usage, accounts, chain, fromChainIndex: 2 })).chosen?.chainIndex, 2);
  assert.equal(selectAccount(input({ usage, accounts, chain, onlyChainIndex: 1 })).chosen, null);
});

test("nothing eligible anywhere: chosen null and the earliest instant a candidate frees", () => {
  const decision = selectAccount(
    input({
      chain: [entry("claude", "m", { maxWeeklyPct: 0 }), entry("opencode", "anthropic/claude-sonnet")],
      cooldowns: { "claude:a-eduard": cooldown(20 * HOUR), "opencode:provider:anthropic": cooldown(30 * HOUR) }
    })
  );
  assert.equal(decision.chosen, null);
  // jasperclaude 4d2h, arakuma 5d8h, jasperinuwu 6d22h (thresholds), therealeduard465 20h (cooldown), opencode 30h.
  assert.equal(decision.earliestResetAt, at(20 * HOUR));
  assert.deepEqual(decision.skipped.map((s) => [s.agent, s.accountId, s.why]), [
    ["claude", "a-jasperclaude", "threshold"],
    ["claude", "a-arakuma", "threshold"],
    ["claude", "a-eduard", "cooldown"],
    ["claude", "a-jasperinuwu", "threshold"],
    ["opencode", "system", "cooldown"]
  ]);
});

test("a threshold breach with an unknown reset contributes no earliest instant", () => {
  const usage: UsageResponse = { agents: [agentRow("claude", [{ ...row("a", "a", {}), weekly: { percent: 95 } }])] };
  const decision = selectAccount(input({ usage, accounts: accountsOf(account("claude", "a")), chain: [entry("claude", "m", { maxWeeklyPct: 90 })] }));
  assert.equal(decision.chosen, null);
  assert.equal(decision.earliestResetAt, undefined);
});

test("opencode has no accounts: one system candidate, only its cooldown applies", () => {
  const decision = selectAccount(input({ chain: [entry("opencode", "anthropic/claude-sonnet", { maxWeeklyPct: 1, accounts: ["x"] })] }));
  assert.equal(decision.chosen?.accountId, "system");
  assert.equal(decision.chosen?.accountLabel, "System");
  assert.deepEqual(decision.skipped, []);
  const cooled = selectAccount(input({ chain: [entry("opencode", "m")], cooldowns: { "opencode:model:m": cooldown(HOUR) } }));
  assert.equal(cooled.chosen, null);
  assert.equal(cooled.earliestResetAt, at(HOUR));
  const tried = selectAccount(input({ chain: [entry("opencode", "m")], exclude: new Set(["opencode:model:m"]) }));
  assert.equal(tried.chosen, null);
  assert.equal(tried.skipped[0]!.why, "unavailable");
});

test("system: the family's system row, or its head row when it has no managed accounts", () => {
  // Grok with no managed accounts: the head row is the system login's reading; no 5h window, so a
  // session threshold is vacuous rather than unknown.
  const grokHead: AgentUsage = { id: "grok", available: true, stale: false, session: null, weekly: { percent: 30, resetsAt: at(2 * DAY) }, asOf: fresh };
  const solo = rankChainEntry(
    input({ usage: { agents: [grokHead] }, accounts: accountsOf(), chain: [entry("grok", "grok-build", { includeSystem: true, maxSessionPct: 10 })] }),
    0
  ).ranked;
  assert.deepEqual(solo.map((c) => [c.accountId, c.usage, c.label]), [["system", "known", "System"]]);

  // With managed accounts the system row is `.system`; hidden (undefined) → unknown, tried last.
  const managedUsage = agentRow("claude", claudeUsage.accounts!, {
    system: row("system", "System", { weekly: [1, DAY] })
  });
  const withSystem = selectAccount(input({ usage: { agents: [managedUsage] }, chain: [entry("claude", "m", { includeSystem: true })] }));
  assert.equal(withSystem.chosen?.accountId, "system");
  const hidden = rankChainEntry(input({ chain: [entry("claude", "m", { includeSystem: true })] }), 0).ranked;
  assert.equal(hidden.at(-1)?.accountId, "system");
  assert.equal(hidden.at(-1)?.usage, "unknown");
  // Naming "system" in the allow-list includes it without includeSystem.
  const named = selectAccount(input({ usage: { agents: [managedUsage] }, chain: [entry("claude", "m", { strategy: "fixed", accounts: ["system", "jasperclaude"] })] }));
  assert.equal(named.chosen?.accountId, "system");
});

test("sameFamilyAlternatives: the next eligible account of the same chain entry, never another entry", () => {
  const usage: UsageResponse = { agents: [claudeUsage, agentRow("codex", [row("c1", "c1", { weekly: [5, DAY] })])] };
  const accounts = accountsOf(...claudeAccounts, account("codex", "c1"));
  const chain = [entry("claude", "m", { strategy: "soonest-reset", maxWeeklyPct: 85 }), entry("codex", "gpt-5.5")];
  const next = sameFamilyAlternatives(input({ usage, accounts, chain, exclude: new Set(["claude:a-jasperclaude"]) }), 0);
  assert.equal(next.chosen?.accountLabel, "arakuma.panama");
  const none = sameFamilyAlternatives(
    input({ usage, accounts, chain, fromChainIndex: 0, exclude: new Set(["claude:a-jasperclaude", "claude:a-arakuma", "claude:a-jasperinuwu"]) }),
    0
  );
  assert.equal(none.chosen, null);
  assert.equal(none.earliestResetAt, at(DAY + 2 * HOUR), "therealeduard465's weekly reset");
});

test("chosen carries the entry's model options", () => {
  const chain: AgentChainEntry[] = [{ ...entry("claude", "claude-opus-5"), options: [{ id: "effort", value: "high" }] }];
  assert.deepEqual(selectAccount(input({ chain })).chosen?.options, [{ id: "effort", value: "high" }]);
});

test("burntWindowResetAt: the latest reset among burnt windows", () => {
  const usage: UsageResponse = {
    agents: [
      agentRow("claude", [
        row("a", "a", { session: [100, 2 * HOUR], weekly: [100, 3 * DAY] }),
        row("b", "b", { session: [40, 2 * HOUR], weekly: [60, 3 * DAY] }),
        row("c", "c", { weekly: [100, -HOUR] })
      ])
    ]
  };
  assert.equal(burntWindowResetAt({ usage, family: "claude", accountId: "a", now: NOW }), at(3 * DAY));
  assert.equal(burntWindowResetAt({ usage, family: "claude", accountId: "b", now: NOW }), undefined);
  assert.equal(burntWindowResetAt({ usage, family: "claude", accountId: "c", now: NOW }), undefined, "an expired window is no reading");
  assert.equal(burntWindowResetAt({ usage, family: "claude", accountId: "zzz", now: NOW }), undefined);
});

test("accountless cooldowns are per provider: one provider's limit never cools another's entries", () => {
  const chain = [
    entry("opencode", "anthropic/claude-sonnet"),
    entry("opencode", "openai/gpt-5"),
    entry("opencode", "bare-model"),
    entry("codex", "gpt-5.5", { includeSystem: true })
  ];
  const cooldowns = { "opencode:provider:anthropic": cooldown(HOUR), "opencode:model:bare-model": cooldown(HOUR) };
  const chosenAt = (index: number): number | undefined =>
    selectAccount(input({ cooldowns, chain, onlyChainIndex: index, accounts: accountsOf() })).chosen?.chainIndex;
  assert.equal(chosenAt(0), undefined, "anthropic is cooling");
  assert.equal(chosenAt(1), 1, "openai is another provider");
  assert.equal(chosenAt(2), undefined, "a prefix-less model is keyed by itself");
  assert.equal(chosenAt(3), 3, "an accountless provider's limit is not codex's system login");
});
