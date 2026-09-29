/**
 * Render checks for the agent block's settings (`AgentSettings`,
 * `ChainEditor`, `AccountPolicyEditor`).
 *
 * `lib/workflows/agent-policy-text.test.ts` owns the wording and the
 * allow-list arithmetic; this exists because "a model the catalogue doesn't
 * list stays selected as unavailable with the reason under it", "a closed
 * choice says what it is in one line", "options no control shows are listed,
 * not dropped", "every validated field has its anchor", "fixed order can
 * leave an account out" and "a preview goes out of date" are claims about
 * MARKUP — a prop mistake typechecks perfectly while rendering nothing.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`.
 */

import assert from "node:assert/strict";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AccountPolicy, AgentBlockConfig, AgentChainEntry, WorkflowProblem } from "@orquester/api";
import type { ProviderSnapshot } from "@orquester/api/agent-chat";

import { OrquesterProvider } from "../../../context/orquester-context";
import { providersStore } from "../../../lib/agent-chat/providers";
import type { ApiClient } from "../../../lib/api-client";
import { accountName, type DecisionNames } from "../../../lib/workflows/agent-policy-text";
import { node as makeNode, workflow as makeWorkflow, edge } from "../../../lib/workflows/testing";
import { useAppStore } from "../../../store/app";
import { AccountPolicyEditor } from "./AccountPolicyEditor";
import { ReadOnlyFieldset } from "../ui/controls";
import { AgentSettings, savedText, withChatTitle, withContinueFrom, withMaxWaitHours, withPromptText } from "./AgentSettings";
import { DecisionView, fitCardIds, movedCardIds } from "./ChainEditor";
import { InspectorContext, type InspectorContextValue } from "./inspector-context";

/** What React's server renderer prints for every `useLayoutEffect` it cannot run (CodeMirror, popovers). */
const SSR_LAYOUT_EFFECT_WARNING = "Warning: useLayoutEffect does nothing on the server";

function render(element: ReactElement): string {
  const consoleError = console.error;
  console.error = (...args: unknown[]): void => {
    if (typeof args[0] === "string" && args[0].startsWith(SSR_LAYOUT_EFFECT_WARNING)) return;
    consoleError.apply(console, args);
  };
  try {
    return renderToStaticMarkup(element);
  } finally {
    console.error = consoleError;
  }
}

/** The markup's text entities decoded, so assertions read like the copy. */
const text = (html: string): string =>
  html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const NOOP = (): void => {};

// --- The host: agents, their catalogues, accounts, usage ----------------------

// A server render reads a zustand hook's INITIAL state (its server snapshot), not `setState`'s: the
// host goes into that object, which only this check process ever sees.
Object.assign(useAppStore.getInitialState(), {
  registry: {
    ...useAppStore.getState().registry,
    agents: [
      { id: "claude", name: "Claude", enabled: true, chat: { adapter: "claude" } },
      { id: "codex", name: "Codex", enabled: true, chat: { adapter: "codex" } },
      { id: "opencode", name: "OpenCode", enabled: true, chat: { adapter: "opencode" } }
    ] as never
  },
  agentAccounts: {
    accounts: [
      { id: "a1", agent: "claude", label: "jasper", email: null, plan: null, needsReauth: false, createdAt: "", importedAt: "" },
      { id: "a2", agent: "claude", label: "work", email: null, plan: null, needsReauth: false, createdAt: "", importedAt: "" }
    ],
    defaults: { claude: null, codex: null, grok: null }
  },
  usage: null
});

const snapshot = (id: string, models: unknown[]): ProviderSnapshot => ({ id, refIds: [id], status: "ready", models }) as unknown as ProviderSnapshot;
providersStore.setState({
  providers: [
    snapshot("claude", [
      {
        slug: "opus[1m]",
        name: "Claude Opus",
        shortName: "Opus",
        isDefault: true,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              options: [
                { id: "medium", label: "Medium", isDefault: true },
                { id: "high", label: "High", description: "Thinks longer." }
              ]
            }
          ]
        }
      },
      { slug: "haiku", name: "Claude Haiku", shortName: "Haiku", capabilities: null }
    ]),
    snapshot("codex", [{ slug: "gpt-5", name: "GPT-5", capabilities: null }])
  ]
});

const api = {
  agentChat: { stream: () => ({ close: NOOP }), command: () => new Promise<never>(() => {}), providers: async () => ({ providers: [] }) },
  previewWorkflowAccount: () => new Promise<never>(() => {})
} as unknown as ApiClient;

const SCOPE = { upstream: [], triggerTypes: [], inputFields: [], secretNames: [], promptVariables: true };

/** The agent block with `config` over its defaults, in a workflow after an earlier agent block. */
function agentInspector(config: Partial<AgentBlockConfig>, options: { problems?: WorkflowProblem[]; reveal?: string; extra?: Record<string, unknown>; readOnly?: boolean } = {}): string {
  const earlier = makeNode("n0", "agent", {}, { name: "Plan" });
  const current = makeNode("n1", "agent", config as Record<string, unknown>, { name: "Build", ...(options.extra ?? {}) });
  const wf = makeWorkflow([earlier, current], [edge("n0", "n1")]);
  const inspected = wf.nodes.find((candidate) => candidate.id === "n1")!;
  const value = {
    editor: { change: NOOP },
    workflow: wf,
    node: inspected,
    readOnly: options.readOnly ?? false,
    projectPath: "/w/ws/app",
    secretNames: [],
    scope: SCOPE,
    promptScope: SCOPE,
    problems: options.problems ?? [],
    openSecrets: NOOP,
    reveal: options.reveal ? { field: options.reveal, nonce: 1 } : null,
    revealField: NOOP
  } as unknown as InspectorContextValue;
  return render(
    h(OrquesterProvider, {
      runtime: "web",
      api,
      useTitlebar: false,
      children: h(InspectorContext.Provider, { value }, h(ReadOnlyFieldset, { readOnly: options.readOnly ?? false, children: h(AgentSettings) }))
    })
  );
}

const claude = (extra: Partial<AgentChainEntry> = {}): AgentChainEntry => ({ agent: "claude", model: "opus[1m]", accounts: {} as AccountPolicy, ...extra });

// --- Sections: titles, summaries, anchors -----------------------------------

{
  const html = text(agentInspector({ prompt: { kind: "text", text: "Fix the build." }, chain: [claude()] }));
  for (const title of ["Prompt", "Chat", "Who runs it", "When no one is watching"]) assert.ok(html.includes(`>${title}<`), `section ${title}`);
  // Closed sections say what they hold.
  assert.ok(html.includes(">New chat<"), "the closed Chat section's summary");
  assert.ok(html.includes("Told no one will reply · stops after 4 h · fails when out of quota"), "the closed unattended section's summary");
  // Open sections anchor their validated fields.
  for (const field of ["config.prompt.text", "config.chain", "config.chain.0.agent", "config.chain.0.model", "config.chain.0.accounts"]) {
    assert.ok(html.includes(`data-wf-field="${field}"`), `anchor ${field}`);
  }
  assert.ok(html.includes("Insert data"), "the prompt offers Insert data");
  // The first choice is open with its model by name and slug; its options have controls.
  assert.match(html, /<option value="opus\[1m\]" selected="">Opus \(default\)<\/option>/);
  assert.ok(html.includes("<code class=\"text-neutral-400\">opus[1m]</code>"), "the model's slug under the select");
  assert.ok(html.includes(">Effort<"), "the model's options");
  // Its account policy, in words.
  assert.ok(html.includes("Which account runs it") && html.includes("Most quota left") && html.includes("Whichever limit is closer to full (recommended)"));
  assert.ok(html.includes("No limit — only skipped when used up (100%)."), "an unset threshold says what still skips");
  assert.ok(html.includes("All 2 accounts"), "the account count");
  assert.ok(html.includes("Also use the daemon's own sign-in (System login)"));
  assert.ok(html.includes("Try it after the others"));
}

// --- A picked problem opens the section that holds it ------------------------

{
  const html = text(agentInspector({ chain: [claude()] }, { reveal: "config.maxMinutes", extra: { timeoutMinutes: 30 } }));
  assert.ok(html.includes('data-wf-field="config.maxMinutes"'), "the revealed field is rendered");
  assert.ok(html.includes("Stop after"));
  // The unused block-level timeout is Run behaviour's to explain (CommonSettings), not repeated here.
  assert.ok(!html.includes("under Run behaviour"));
}

{
  const problems: WorkflowProblem[] = [
    { severity: "error", code: "timeout_too_long", message: "Build: the working time is at most 24 h", nodeId: "n1", field: "config.maxMinutes" }
  ];
  const html = text(agentInspector({ chain: [claude()], maxMinutes: 2000 }, { problems }));
  assert.ok(html.includes("the working time is at most 24 h"), "an error opens the section and shows under its field");
}

// --- The model the catalogue doesn't list ------------------------------------

{
  const problems: WorkflowProblem[] = [
    {
      severity: "error",
      code: "unknown_model",
      message: 'Build: claude has no model "opus" (it has opus[1m], haiku)',
      nodeId: "n1",
      field: "config.chain.0.model"
    }
  ];
  const html = text(agentInspector({ chain: [claude({ model: "opus", options: [{ id: "effort", value: "high" }] })] }, { problems }));
  assert.match(html, /<option value="opus" selected="">opus \(unavailable\)<\/option>/, "the stored slug stays selected, marked");
  assert.ok(html.includes("Claude on this machine doesn't offer “opus”. Runs skip this choice until you pick a listed model."), "the reason in words");
  assert.ok(!html.includes("(it has opus[1m], haiku)"), "not the raw validation text");
  // Its options have no controls (no model to ask), so they are listed with a Clear.
  assert.ok(html.includes("data-chain-stray-options"), "the stored options are listed");
  assert.ok(html.includes("effort: <code class=\"text-neutral-400\">high</code>"));
  assert.ok(html.includes(">Clear<"));
}

{
  // A listed model that takes no options: the engine passes the choice over while options are set.
  const html = text(agentInspector({ chain: [claude({ model: "haiku", options: [{ id: "effort", value: "high" }] })] }));
  assert.ok(html.includes("Haiku doesn't take this option: runs skip this choice until you clear it."));
}

// --- Closed choices say what they are -----------------------------------------

{
  const html = text(
    agentInspector({
      chain: [
        claude({ options: [{ id: "effort", value: "high" }] }),
        claude({ accounts: { strategy: "fixed", maxWeeklyPct: 85, accounts: ["a2"] } as AccountPolicy }),
        { agent: "opencode", model: "x", accounts: {} as AccountPolicy }
      ]
    })
  );
  assert.ok(html.includes(">First choice<") && html.includes(">Fallback 1<") && html.includes(">Fallback 2<"));
  assert.ok(html.includes("Claude · Opus · High effort — Most quota left · All 2 accounts") === false, "the open first card shows its fields, not its summary");
  assert.ok(html.includes("Claude · Opus — Fixed order · skip at 85% weekly · 1 of 2 accounts"), "a closed fallback's summary");
  assert.ok(html.includes("OpenCode · X — runs on the daemon's own sign-in"), "an accountless agent's summary");
  // Only the first is open.
  assert.equal((html.match(/data-wf-field="config\.chain\.\d+\.agent"/g) ?? []).length, 1);
}

{
  // A closed choice with a problem opens itself.
  const problems: WorkflowProblem[] = [
    { severity: "error", code: "unknown_agent", message: 'Build: "nope" is not a chat agent on this host', nodeId: "n1", field: "config.chain.1.agent" }
  ];
  const html = text(agentInspector({ chain: [claude(), { agent: "nope", model: "m", accounts: {} as AccountPolicy }] }, { problems }));
  assert.ok(html.includes('data-wf-field="config.chain.1.agent"'), "the card with the error is open");
  assert.ok(html.includes("“nope” isn't a chat agent on this machine. Runs skip this choice until you pick one that is."));
}

// --- Chat --------------------------------------------------------------------

{
  const problems: WorkflowProblem[] = [
    { severity: "error", code: "continue_invalid", message: 'Build: cannot continue a session — there is no block named "Gone"', nodeId: "n1", field: "config.session.fromNode" }
  ];
  const html = text(agentInspector({ session: { kind: "continue", fromNode: "Gone" }, chain: [claude()] }, { problems }));
  assert.ok(html.includes("Gone (not an earlier agent block)"), "an orphaned block name stays visible");
  assert.ok(html.includes('there is no block named "Gone"'), "its error shows under the field");
  assert.ok(html.includes("it runs on that chat's agent, model and account"), "the choices don't apply while continuing");
}

// --- Fixed order can leave an account out -----------------------------------

{
  const policy = { strategy: "fixed", includeSystem: false, soonestResetWindow: "weekly", leastUsedMetric: "max", unknownUsage: "last", accounts: ["a2"] } as AccountPolicy;
  const value = { problems: [], reveal: null } as unknown as InspectorContextValue;
  const html = text(
    render(
      h(
        InspectorContext.Provider,
        { value },
        h(AccountPolicyEditor, { family: "claude", agentLabel: "Claude", policy, onChange: NOOP, model: "opus[1m]", models: [], anchor: "config.chain.0.accounts" })
      )
    )
  );
  assert.ok(html.includes("Accounts, in the order tried"));
  assert.ok(html.includes("1 of 2 accounts") && html.includes(">Use all<"));
  const boxes = [...html.matchAll(/<input type="checkbox"([^>]*)\/>/g)].map((match) => match[1]!);
  // work is allowed, first, and the last one allowed, so it can't be unticked; jasper is left out.
  assert.ok(boxes.some((attributes) => attributes.includes('checked=""') && attributes.includes('disabled=""')), "the last allowed account can't be unticked");
  assert.ok(html.indexOf(">work<") < html.indexOf(">jasper<"), "allowed accounts first, in order");
  assert.ok(html.includes("Try work earlier") && !html.includes("Try jasper earlier"), "arrows only on accounts in the order");
}

// --- Who would run now, in words ---------------------------------------------

{
  const names: DecisionNames = {
    agent: (id) => ({ claude: "Claude" })[id] ?? id,
    account: (_agent, id, label) => accountName(id, label, { a1: "jasper" }[id]),
    model: () => "Opus"
  };
  const decision = {
    chosen: { agent: "claude", model: "opus[1m]", accountId: "a1", accountLabel: "jasper", chainIndex: 0 },
    reason: "jasper: least used (max 40%)",
    skipped: [{ agent: "claude", accountId: "a2", label: "work", why: "threshold" as const, detail: "weekly 90% ≥ 85%" }]
  };
  const fresh = text(render(h(DecisionView, { decision, names, now: 0, stale: false, onRefresh: NOOP })));
  assert.ok(fresh.includes("Claude · Opus · jasper"));
  assert.ok(fresh.includes("It has the most quota left (40% used on its fuller limit)."));
  assert.ok(fresh.includes("Claude · work</span>: weekly usage is 90%, over your 85% limit"));
  assert.ok(!fresh.includes("Out of date"));
  const stale = text(render(h(DecisionView, { decision, names, now: 0, stale: true, onRefresh: NOOP })));
  assert.ok(stale.includes("Out of date: the choices changed since this check.") && stale.includes("Check again"));
}

// --- Choice cards keep their identity through a reorder ---------------------

{
  const html = agentInspector({ chain: [claude(), claude({ model: "haiku" })] });
  assert.match(html, /data-chain-card="1"[\s\S]*data-chain-card="2"/, "each card carries its client id");
  assert.ok(html.includes('data-chain-move="up"') && html.includes('data-chain-move="down"'), "the arrows are marked for focus after a move");
  let minted = 0;
  const mint = (): number => ++minted;
  let ids = fitCardIds([], 3, mint);
  assert.deepEqual(ids, [1, 2, 3]);
  ids = movedCardIds(ids, 0, 2);
  assert.deepEqual(ids, [2, 3, 1], "the moved entry keeps its id");
  ids = movedCardIds(ids, 2, 1);
  assert.deepEqual(ids, [2, 1, 3]);
  assert.deepEqual(fitCardIds(ids, 3, mint), [2, 1, 3], "same length: untouched");
  assert.deepEqual(fitCardIds(ids, 4, mint), [2, 1, 3, 4], "an entry added elsewhere gets a new id");
  assert.deepEqual(fitCardIds(ids, 2, mint), [2, 1], "one removed elsewhere: kept by position");
}

// --- Edits keep what else the objects hold ------------------------------------

{
  const base = makeNode("n1", "agent").config as AgentBlockConfig;
  const written = withPromptText({ ...base, prompt: { kind: "text", text: "a", extra: 1 } as never }, "b");
  assert.deepEqual(written.prompt, { kind: "text", text: "b", extra: 1 });
  assert.deepEqual(withPromptText({ ...base, prompt: { kind: "saved", promptId: "p", append: "x" } }, "b").prompt, { kind: "text", text: "b" });
  const titled = withChatTitle({ ...base, session: { kind: "new", title: "old", extra: 2 } as never }, "new");
  assert.deepEqual(titled.session, { kind: "new", title: "new", extra: 2 });
  assert.deepEqual(withChatTitle({ ...base, session: { kind: "new", title: "old", extra: 2 } as never }, "").session, { kind: "new", extra: 2 });
  assert.deepEqual(withChatTitle({ ...base, session: { kind: "continue", fromNode: "A" } }, "t").session, { kind: "new", title: "t" });
  assert.deepEqual(withContinueFrom({ ...base, session: { kind: "continue", fromNode: "A", extra: 3 } as never }, "B").session, { kind: "continue", fromNode: "B", extra: 3 });
  const waiting = withMaxWaitHours({ ...base, whenAllBurnt: { kind: "wait-for-reset", maxWaitHours: 6, extra: 4 } as never }, 12);
  assert.deepEqual(waiting.whenAllBurnt, { kind: "wait-for-reset", maxWaitHours: 12, extra: 4 });
  // Switching a saved prompt to "Write it here" starts from what the daemon sent (promptSource).
  assert.equal(savedText("Body", "More"), "Body\n\nMore");
  assert.equal(savedText("Body", "  "), "Body");
  assert.equal(savedText("Body", undefined), "Body");
}

// --- Read-only ---------------------------------------------------------------

{
  const html = text(agentInspector({ prompt: { kind: "text", text: "Fix it." }, chain: [claude()] }, { readOnly: true }));
  assert.ok(!html.includes("Insert data"), "nothing to insert into a read-only prompt");
  assert.ok(html.includes("View larger"), "the prompt can still be read larger");
  assert.match(html, /<span role="button" tabindex="0"[^>]*aria-expanded="true"/, "view-only toggles stay usable read-only");
}

console.log("agent settings render checks passed");
