/**
 * The composer's account chip (spec §3.4, §7.4) — the gate, the option list
 * and the labels, all pure.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentAccount } from "@orquester/api";
import type { AdapterGoalSupport, AgentGoal } from "@orquester/api/agent-chat";

import {
  buildChatAccountOptions,
  canSwitchChatAccount,
  chatAccountLabel,
  chatAccountSelectionId,
  chatAccountSwitchRefusal,
  chatAccountSwitchSupported,
  COMPACTION_SWITCH_REFUSAL,
  GOAL_CONTINUING_SWITCH_REFUSAL,
  identityChangeSummary,
  isGoalContinuing,
  isProxyLauncher,
  PROXY_ACCOUNT_FAMILY,
  type ChatAccountSwitchState
} from "./account-switch.ts";

const shortLabel = (label: string | undefined): string | undefined =>
  label === undefined ? undefined : label.split("@")[0];

function account(overrides: Partial<AgentAccount> & Pick<AgentAccount, "id" | "agent">): AgentAccount {
  return {
    label: `${overrides.id}@example.com`,
    email: null,
    plan: null,
    needsReauth: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    importedAt: "2026-09-01T00:00:00.000Z",
    ...overrides
  };
}

const ACCOUNTS: AgentAccount[] = [
  account({ id: "cla-1", agent: "claude" }),
  account({ id: "cla-2", agent: "claude", needsReauth: true }),
  account({ id: "cod-1", agent: "codex" }),
  account({ id: "grk-1", agent: "grok" })
];

const idle: ChatAccountSwitchState = {
  isTurnActive: false,
  hasPendingRequest: false,
  queuedCount: 0,
  reverting: false,
  connection: "synchronized",
  backgroundLive: false
};

describe("the option list", () => {
  it("offers System plus the launcher's OWN family", () => {
    const options = buildChatAccountOptions({
      refId: "claude",
      accounts: ACCOUNTS,
      shortLabel
    });
    assert.deepEqual(
      options.map((option) => option.id),
      ["system", "cla-1", "cla-2"]
    );
    assert.equal(options[0]!.label, "System");
    assert.equal(options[1]!.label, "cla-1");
    assert.equal(options[2]!.needsReauth, true, "a stale account is offered, flagged");
  });

  it("a proxy launcher draws from the MAPPED family and only what is seeded", () => {
    assert.deepEqual(PROXY_ACCOUNT_FAMILY, { claudemix: "claude", claudex: "codex" });
    assert.equal(isProxyLauncher("claudex"), true);
    assert.equal(isProxyLauncher("claude"), false);

    // claudex → codex accounts, and only the seeded ones: an unseeded pin
    // emits an `acc<hex>/` prefix no auth file serves.
    assert.deepEqual(
      buildChatAccountOptions({
        refId: "claudex",
        accounts: ACCOUNTS,
        seededAccountIds: ["cod-1"],
        shortLabel
      }).map((option) => option.id),
      ["system", "cod-1"]
    );
    assert.deepEqual(
      buildChatAccountOptions({
        refId: "claudex",
        accounts: ACCOUNTS,
        seededAccountIds: [],
        shortLabel
      }).map((option) => option.id),
      ["system"],
      "nothing seeded means System only"
    );
    assert.deepEqual(
      buildChatAccountOptions({
        refId: "claudemix",
        accounts: ACCOUNTS,
        seededAccountIds: ["cla-1", "cod-1"],
        shortLabel
      }).map((option) => option.id),
      ["system", "cla-1"]
    );
  });

  it("OpenCode has no per-thread account, decided without waiting for a snapshot", () => {
    assert.equal(chatAccountSwitchSupported({ refId: "opencode" }), false);
    assert.equal(
      chatAccountSwitchSupported({ refId: "opencode", adapterId: undefined }),
      false,
      "the registry id alone is enough — the snapshot may not have landed"
    );
    assert.equal(chatAccountSwitchSupported({ refId: "claude", adapterId: "opencode" }), false);
    assert.equal(chatAccountSwitchSupported({ refId: "claude", adapterId: "claude" }), true);
    assert.equal(chatAccountSwitchSupported({ refId: "claudex" }), true);
  });

  it("an empty accounts list is still a usable menu", () => {
    assert.deepEqual(
      buildChatAccountOptions({ refId: "claude", accounts: undefined, shortLabel }).map(
        (option) => option.id
      ),
      ["system"]
    );
  });
});

describe("the idle gate", () => {
  it("opens only when nothing is in flight", () => {
    assert.equal(canSwitchChatAccount(idle), true);
  });

  it("closes for every in-flight shape", () => {
    const closed: Array<Partial<ChatAccountSwitchState>> = [
      { isTurnActive: true },
      { hasPendingRequest: true },
      { queuedCount: 1 },
      { reverting: true },
      { connection: "connecting" },
      { connection: "reconnecting" },
      { backgroundLive: true },
      { compacting: true }
    ];
    for (const patch of closed) {
      assert.equal(
        canSwitchChatAccount({ ...idle, ...patch }),
        false,
        `closed for ${JSON.stringify(patch)}`
      );
    }
  });
});

describe("a continuing goal closes the gate (goals §5.5)", () => {
  const CODEX: AdapterGoalSupport = {
    command: "host",
    actions: ["pause", "resume", "clear"],
    continuesAcrossTurns: true
  };
  const CLAUDE: AdapterGoalSupport = {
    command: "provider",
    actions: ["continue", "clear"],
    continuesAcrossTurns: false
  };
  const GROK: AdapterGoalSupport = {
    command: "provider",
    actions: ["resume", "clear"],
    continuesAcrossTurns: false
  };
  const goal = (status: AgentGoal["status"]): AgentGoal => ({ objective: "Make CI green", status });
  /** The fallback predicate on a live session — no host summary in view. */
  const onLiveSession = (g: AgentGoal | null | undefined, support: AdapterGoalSupport | null | undefined) =>
    isGoalContinuing({ goal: g, support, sessionStatus: "ready" });

  it("an active goal on a provider that starts its own turns is continuing — and only that", () => {
    assert.equal(onLiveSession(goal("active"), CODEX), true, "Codex keeps working between turns");
    for (const status of ["paused", "blocked", "budget-limited", "usage-limited", "complete", "failed"] as const) {
      assert.equal(onLiveSession(goal(status), CODEX), false, `a ${status} Codex goal is not`);
    }
    assert.equal(onLiveSession(goal("active"), CLAUDE), false, "Claude's goal runs inside turns the user sends");
    assert.equal(onLiveSession(goal("active"), GROK), false, "so does Grok's");
    assert.equal(onLiveSession(null, CODEX), false, "no goal");
    assert.equal(onLiveSession(undefined, CODEX), false);
    assert.equal(onLiveSession(goal("active"), null), false, "no goal support (OpenCode, an older host)");
    assert.equal(onLiveSession(goal("active"), undefined), false);
  });

  it("final wave (8): only on a live session — a stopped or errored one may switch", () => {
    for (const sessionStatus of ["starting", "ready", "running"] as const) {
      assert.equal(isGoalContinuing({ goal: goal("active"), support: CODEX, sessionStatus }), true, sessionStatus);
    }
    for (const sessionStatus of ["stopped", "error", "idle", null, undefined] as const) {
      assert.equal(
        isGoalContinuing({ goal: goal("active"), support: CODEX, sessionStatus }),
        false,
        `${String(sessionStatus)}: nothing is there to start the next turn`
      );
      assert.equal(
        isGoalContinuing({ goal: goal("active"), support: CODEX, sessionStatus, resumeGoalAfterRestart: true }),
        true,
        `${String(sessionStatus)}, but marked for a resume after the restart: it will continue`
      );
    }
    const stopped = {
      ...idle,
      goalContinuing: isGoalContinuing({ goal: goal("active"), support: CODEX, sessionStatus: "stopped" })
    };
    assert.equal(canSwitchChatAccount(stopped), true, "a stopped session with an active Codex goal switches");
    assert.equal(chatAccountSwitchRefusal(stopped), null);
  });

  it("final wave (8): the host's own verdict wins whenever the view has it", () => {
    const summary = (continuing: unknown) => ({ objective: "Make CI green", status: "active", continuing });
    assert.equal(
      isGoalContinuing({ summaryGoal: summary(false), goal: goal("active"), support: CODEX, sessionStatus: "running" }),
      false,
      "the host says it is not continuing"
    );
    assert.equal(
      isGoalContinuing({ summaryGoal: summary(true), goal: goal("paused"), support: CODEX, sessionStatus: "stopped" }),
      true,
      "the host says it is — whatever the fold has caught up to"
    );
    assert.equal(
      isGoalContinuing({ summaryGoal: null, goal: goal("active"), support: CODEX, sessionStatus: "running" }),
      false,
      "`null`: the host has no unfinished goal for this thread"
    );
    for (const malformed of [summary("yes"), { objective: "x" }, "x", 7, [] as unknown[]]) {
      assert.equal(
        isGoalContinuing({ summaryGoal: malformed, goal: goal("active"), support: CODEX, sessionStatus: "running" }),
        true,
        `${JSON.stringify(malformed)} is not a verdict: the predicate decides`
      );
    }
  });

  it("an active Codex goal refuses the switch, with the host's own words", () => {
    const continuing = { ...idle, goalContinuing: onLiveSession(goal("active"), CODEX) };
    assert.equal(canSwitchChatAccount(continuing), false);
    assert.equal(chatAccountSwitchRefusal(continuing), GOAL_CONTINUING_SWITCH_REFUSAL);
    assert.equal(GOAL_CONTINUING_SWITCH_REFUSAL, "Pause the goal before switching accounts.");
  });

  it("a paused Codex goal, an active Claude or Grok goal, and no goal leave the gate open", () => {
    for (const [label, goalContinuing] of [
      ["paused Codex", onLiveSession(goal("paused"), CODEX)],
      ["active Claude", onLiveSession(goal("active"), CLAUDE)],
      ["active Grok", onLiveSession(goal("active"), GROK)],
      ["no goal", onLiveSession(null, CODEX)]
    ] as const) {
      const state = { ...idle, goalContinuing };
      assert.equal(canSwitchChatAccount(state), true, label);
      assert.equal(chatAccountSwitchRefusal(state), null, label);
    }
    assert.equal(canSwitchChatAccount(idle), true, "a state that never mentions a goal is unchanged");
  });

  it("goals §5.7: a goal a deploy HELD is continuing — paused or not, whatever the session says", () => {
    // Without a summary verdict, the head's `goalHeldForHandover` reads as
    // the host's `goalHeld`: the next host sets the goal going again by itself.
    for (const status of ["paused", "active"] as const) {
      for (const sessionStatus of ["starting", "ready", "running", "stopped", "error", "idle", null, undefined] as const) {
        assert.equal(
          isGoalContinuing({ goal: goal(status), support: CODEX, sessionStatus, goalHeldForHandover: true }),
          true,
          `${status} goal, ${String(sessionStatus)} session, held`
        );
      }
    }
    const held = {
      ...idle,
      goalContinuing: isGoalContinuing({
        goal: goal("paused"),
        support: CODEX,
        sessionStatus: "ready",
        goalHeldForHandover: true
      })
    };
    assert.equal(canSwitchChatAccount(held), false, "the switch stays refused while the goal is held");
    assert.equal(chatAccountSwitchRefusal(held), GOAL_CONTINUING_SWITCH_REFUSAL, "in the host's own words");
  });

  it("goals §5.7: the head's hold mark continues nothing the provider would not set going again", () => {
    for (const status of ["blocked", "budget-limited", "usage-limited", "complete", "failed"] as const) {
      assert.equal(
        isGoalContinuing({ goal: goal(status), support: CODEX, sessionStatus: "ready", goalHeldForHandover: true }),
        false,
        `a goal that went ${status} during its final turn holds nothing up`
      );
    }
    assert.equal(
      isGoalContinuing({ goal: goal("paused"), support: CLAUDE, sessionStatus: "ready", goalHeldForHandover: true }),
      false,
      "only an adapter that continues goals by itself (Codex) holds one"
    );
    assert.equal(
      isGoalContinuing({ goal: goal("paused"), support: null, sessionStatus: "ready", goalHeldForHandover: true }),
      false
    );
    assert.equal(
      isGoalContinuing({ goal: null, support: CODEX, sessionStatus: "ready", goalHeldForHandover: true }),
      false
    );
    assert.equal(
      isGoalContinuing({ goal: goal("paused"), support: CODEX, sessionStatus: "ready", goalHeldForHandover: false }),
      false,
      "without the mark a paused goal is an ordinary pause"
    );
  });

  it("goals §5.7: the host's verdict still wins over the head's hold mark", () => {
    // The mark is head-only: a snapshot refreshes it, no live event does, so
    // a hold the user ended (a Stop, `/goal …`) can outlive it here.
    const summary = (continuing: boolean) => ({ objective: "Make CI green", status: "paused", continuing });
    assert.equal(
      isGoalContinuing({
        summaryGoal: summary(false),
        goal: goal("paused"),
        support: CODEX,
        sessionStatus: "ready",
        goalHeldForHandover: true
      }),
      false
    );
    assert.equal(
      isGoalContinuing({ summaryGoal: summary(true), goal: goal("paused"), support: CODEX, sessionStatus: "ready" }),
      true,
      "the host holds it and says so"
    );
  });

  it("the goal's reason wins over the wait-for-idle one: between its turns, idle never comes", () => {
    const busy = { ...idle, isTurnActive: true, goalContinuing: true };
    assert.equal(canSwitchChatAccount(busy), false);
    assert.equal(chatAccountSwitchRefusal(busy), GOAL_CONTINUING_SWITCH_REFUSAL);
    assert.equal(
      chatAccountSwitchRefusal({ ...idle, isTurnActive: true }),
      null,
      "an ordinary busy thread keeps the chip's own 'available when idle'"
    );
  });
});

describe("labels", () => {
  it("reads System for the sentinel, an absent id and an unknown id", () => {
    assert.equal(chatAccountLabel({ accountId: "system", accounts: ACCOUNTS, shortLabel }), "System");
    assert.equal(chatAccountLabel({ accountId: undefined, accounts: ACCOUNTS, shortLabel }), "System");
    assert.equal(chatAccountLabel({ accountId: "", accounts: ACCOUNTS, shortLabel }), "System");
    assert.equal(chatAccountLabel({ accountId: "gone", accounts: ACCOUNTS, shortLabel }), "System");
  });

  it("resolves a managed account through the live list, not the log", () => {
    assert.equal(chatAccountLabel({ accountId: "cla-1", accounts: ACCOUNTS, shortLabel }), "cla-1");
  });

  it("the system identity's two spellings map onto the menu's one id", () => {
    // The head and the tab record say `""`/`undefined`; the menu says `system`.
    // Without this the System row never shows its checkmark.
    assert.equal(chatAccountSelectionId(""), "system");
    assert.equal(chatAccountSelectionId(undefined), "system");
    assert.equal(chatAccountSelectionId("cla-1"), "cla-1");
    const options = buildChatAccountOptions({ refId: "claude", accounts: ACCOUNTS, shortLabel });
    assert.ok(options.some((option) => option.id === chatAccountSelectionId("")));
  });

  it("the timeline row names the account it switched to, and degrades gracefully", () => {
    assert.equal(
      identityChangeSummary({
        payload: { accountId: "cla-1", home: "account" },
        accounts: ACCOUNTS,
        shortLabel
      }),
      "Switched to cla-1"
    );
    assert.equal(
      identityChangeSummary({
        payload: { accountId: "", home: "system" },
        accounts: ACCOUNTS,
        shortLabel
      }),
      "Switched to System"
    );
    // An older bundle's payload, or none at all.
    assert.equal(
      identityChangeSummary({ payload: {}, accounts: ACCOUNTS, shortLabel }),
      "Switched account"
    );
    assert.equal(
      identityChangeSummary({ payload: null, accounts: ACCOUNTS, shortLabel }),
      "Switched account"
    );
  });
});

describe("fix round 2 (4): the refusal names what the host names, in the host's order", () => {
  it("a running compaction outranks the goal — the host checks it first", () => {
    const both = { ...idle, compacting: true, goalContinuing: true };
    assert.equal(canSwitchChatAccount(both), false);
    assert.equal(chatAccountSwitchRefusal(both), COMPACTION_SWITCH_REFUSAL);
    assert.equal(
      COMPACTION_SWITCH_REFUSAL,
      "Wait for the context compaction to finish before switching accounts.",
      "the host's own words (`identitySwitchRefusal`)"
    );
  });

  it("each reason alone, and neither", () => {
    assert.equal(chatAccountSwitchRefusal({ ...idle, compacting: true }), COMPACTION_SWITCH_REFUSAL);
    assert.equal(chatAccountSwitchRefusal({ ...idle, compacting: true, isTurnActive: true }), COMPACTION_SWITCH_REFUSAL);
    assert.equal(chatAccountSwitchRefusal({ ...idle, goalContinuing: true }), GOAL_CONTINUING_SWITCH_REFUSAL);
    assert.equal(chatAccountSwitchRefusal(idle), null);
    assert.equal(canSwitchChatAccount({ ...idle, compacting: false, goalContinuing: false }), true);
  });
});
