import test from "node:test";
import assert from "node:assert/strict";
import type { Skill, SlashCommand } from "@orquester/api/agent-chat";

import {
  blockedProviderCommandMessage,
  buildSkillMenuItems,
  buildSlashMenuItems,
  compactCommandAvailable,
  isProviderSkillUserInvocable,
  menuItemAction,
  menuItemReplacement,
  providerCommandDescription,
  providerCommandsForSlashMenu,
  searchSlashMenuItems,
  skillsForSlashMenu,
  slashMenuItemsForPromptPosition,
  type SlashMenuItem
} from "./composer-menu.ts";
import {
  detectComposerTrigger,
  extendReplacementRangeForTrailingSpace,
  replaceTextRange
} from "./composer-trigger.ts";

function skill(name: string, overrides: Partial<Skill> = {}): Skill {
  return { name, path: `/skills/${name}/SKILL.md`, enabled: true, ...overrides };
}

function command(name: string, description?: string): SlashCommand {
  return description === undefined ? { name } : { name, description };
}

const BASE = {
  slashCommands: [],
  skills: [],
  showPlanModeToggle: true,
  hasEffortOption: true,
  compactAvailable: false,
  showSkillsInSlashMenu: true,
  isAtPromptStart: true,
  query: ""
} as const;

test("a disabled skill is never offered, and userInvocable:false hides one", () => {
  assert.equal(isProviderSkillUserInvocable(skill("a")), true);
  assert.equal(isProviderSkillUserInvocable(skill("a", { enabled: false })), false);
  assert.equal(isProviderSkillUserInvocable(skill("a", { userInvocable: false })), false);
});

test("userInvocationOnly does not hide a skill — it is the reason to show it", () => {
  const only = skill("release", { userInvocationOnly: true });
  assert.deepEqual(skillsForSlashMenu([only], true), [only]);
});

test("the slash-menu skill setting is honoured; the $ menu ignores it", () => {
  const s = skill("brainstorm");
  assert.deepEqual(skillsForSlashMenu([s], false), []);
  assert.equal(buildSkillMenuItems([s], "").length, 1);
});

test("a skill that is also advertised as a command is listed once, as the skill", () => {
  const visible = [skill("review")];
  const kept = providerCommandsForSlashMenu([command("review"), command("init")], visible);
  assert.deepEqual(
    kept.map((entry) => entry.name),
    ["init"]
  );

  const items = buildSlashMenuItems({
    ...BASE,
    slashCommands: [command("review")],
    skills: visible
  });
  const reviewRows = items.filter(
    (item) =>
      (item.type === "skill" && item.skill.name === "review") ||
      (item.type === "provider-command" && item.command.name === "review")
  );
  assert.equal(reviewRows.length, 1);
  assert.equal(reviewRows[0]?.type, "skill");
});

test("away from offset 0 provider commands are dropped; host commands and skills stay", () => {
  const items: SlashMenuItem[] = [
    { id: "h", type: "host-command", command: "model", label: "/model", description: "" },
    { id: "p", type: "provider-command", command: command("init"), label: "/init", description: "" },
    { id: "s", type: "skill", skill: skill("x"), label: "/x", description: "" }
  ];
  assert.equal(slashMenuItemsForPromptPosition(items, true).length, 3);
  assert.deepEqual(
    slashMenuItemsForPromptPosition(items, false).map((item) => item.type),
    ["host-command", "skill"]
  );
});

test("/plan and /default appear only where the plan toggle is shown", () => {
  const withPlan = buildSlashMenuItems(BASE).filter((item) => item.type === "host-command");
  assert.deepEqual(
    withPlan.map((item) => (item.type === "host-command" ? item.command : "")),
    ["model", "effort", "plan", "default"]
  );
  const withoutPlan = buildSlashMenuItems({ ...BASE, showPlanModeToggle: false });
  assert.equal(
    withoutPlan.some((item) => item.type === "host-command" && item.command === "plan"),
    false
  );
});

test("/effort appears only when the selected model has a reasoning descriptor", () => {
  const items = buildSlashMenuItems({ ...BASE, hasEffortOption: false });
  assert.equal(
    items.some((item) => item.type === "host-command" && item.command === "effort"),
    false
  );
});

test("/compact is hidden until its full precondition list holds", () => {
  const withCompact = { ...BASE, slashCommands: [command("compact")] };
  assert.equal(
    buildSlashMenuItems(withCompact).some(
      (item) => item.type === "provider-command" && item.command.name === "compact"
    ),
    false
  );
  assert.equal(
    buildSlashMenuItems({ ...withCompact, compactAvailable: true }).some(
      (item) => item.type === "provider-command" && item.command.name === "compact"
    ),
    true
  );
});

test("the compact precondition rejects a non-empty draft or any attachment", () => {
  const ok = {
    threadHasContent: true,
    textBeforeTrigger: "",
    textAfterTrigger: "",
    attachmentCount: 0,
    contextCount: 0
  };
  assert.equal(compactCommandAvailable(ok), true);
  assert.equal(compactCommandAvailable({ ...ok, threadHasContent: false }), false);
  assert.equal(compactCommandAvailable({ ...ok, textAfterTrigger: " now" }), false);
  assert.equal(compactCommandAvailable({ ...ok, textBeforeTrigger: "hi " }), false);
  assert.equal(compactCommandAvailable({ ...ok, attachmentCount: 1 }), false);
  assert.equal(compactCommandAvailable({ ...ok, contextCount: 1 }), false);
});

test("a name match outranks a description match", () => {
  const items: SlashMenuItem[] = [
    {
      id: "p:init",
      type: "provider-command",
      command: command("init"),
      label: "/init",
      description: ""
    },
    {
      id: "p:setup",
      type: "provider-command",
      command: command("setup", "initialise the repository"),
      label: "/setup",
      description: "initialise the repository"
    }
  ];
  assert.deepEqual(
    searchSlashMenuItems(items, "init").map((item) => item.id),
    ["p:init", "p:setup"]
  );
});

test("ties break host commands, then provider commands, then skills", () => {
  const items: SlashMenuItem[] = [
    { id: "s:plan", type: "skill", skill: skill("plan"), label: "/plan", description: "" },
    {
      id: "p:plan",
      type: "provider-command",
      command: command("plan"),
      label: "/plan",
      description: ""
    },
    { id: "h:plan", type: "host-command", command: "plan", label: "/plan", description: "" }
  ];
  assert.deepEqual(
    searchSlashMenuItems(items, "plan").map((item) => item.id),
    ["h:plan", "p:plan", "s:plan"]
  );
});

test("an empty query keeps the input order and its position gating", () => {
  const items = buildSlashMenuItems({ ...BASE, slashCommands: [command("init")] });
  assert.equal(items.length, 5);
  assert.equal(items[0]?.type, "host-command");
});

test("a leading slash in the query is stripped before ranking", () => {
  const items = buildSlashMenuItems({ ...BASE, query: "/mod" });
  assert.equal(items[0]?.type, "host-command");
  assert.equal(items[0]?.type === "host-command" && items[0].command, "model");
});

test("an argument hint becomes the row's secondary line when there is no description", () => {
  assert.equal(providerCommandDescription({ name: "goal", input: { hint: "<text>" } }), "<text>");
  assert.equal(providerCommandDescription({ name: "goal", description: "Set a goal" }), "Set a goal");
  assert.equal(providerCommandDescription({ name: "goal" }), "Run provider command");
});

test("insertion: provider commands and skills insert text, host commands insert nothing", () => {
  assert.equal(
    menuItemReplacement({
      id: "p",
      type: "provider-command",
      command: command("init"),
      label: "",
      description: ""
    }),
    "/init "
  );
  assert.equal(
    menuItemReplacement({ id: "s", type: "skill", skill: skill("rev"), label: "", description: "" }),
    "$rev "
  );
  assert.equal(
    menuItemReplacement({ id: "h", type: "host-command", command: "model", label: "", description: "" }),
    ""
  );
  assert.equal(
    menuItemReplacement({
      id: "f",
      type: "path",
      path: "src/index.ts",
      pathKind: "file",
      label: "",
      description: ""
    }),
    "@src/index.ts "
  );
});

// ---------------------------------------------------------------------------
// Fix wave
// ---------------------------------------------------------------------------

test("R2-2: a synthesised provider /effort never duplicates the host row", () => {
  // Codex and OpenCode both synthesise an `effort` entry; `/effort` is
  // client-only, so the provider row would insert literal text and reach a CLI
  // that does not implement it.
  const items = buildSlashMenuItems({
    ...BASE,
    hasEffortOption: true,
    slashCommands: [command("effort"), command("init")]
  });
  const effortRows = items.filter(
    (item) =>
      (item.type === "host-command" && item.command === "effort") ||
      (item.type === "provider-command" && item.command.name === "effort")
  );
  assert.equal(effortRows.length, 1);
  assert.equal(effortRows[0]?.type, "host-command");
});

test("R2-2: the host dedupe is by name, case- and whitespace-insensitively", () => {
  assert.deepEqual(
    providerCommandsForSlashMenu([command(" Effort "), command("init")], [], ["effort"]).map(
      (entry) => entry.name
    ),
    ["init"]
  );
});

test("R2-2: /compact stays a provider row — the host path reads it from the sent text", () => {
  const items = buildSlashMenuItems({
    ...BASE,
    compactAvailable: true,
    slashCommands: [command("compact")]
  });
  assert.equal(
    items.some((item) => item.type === "provider-command" && item.command.name === "compact"),
    true
  );
});

test("R2-5: Grok's /always-approve is refused with a pointer at the mode chip", () => {
  assert.match(blockedProviderCommandMessage("grok", "/always-approve") ?? "", /mode chip/);
  assert.match(blockedProviderCommandMessage("grok", "  /ALWAYS-APPROVE now ") ?? "", /mode chip/);
});

test("R2-5: the refusal is Grok-only and never fires on a lookalike", () => {
  assert.equal(blockedProviderCommandMessage("claude", "/always-approve"), null);
  assert.equal(blockedProviderCommandMessage(undefined, "/always-approve"), null);
  assert.equal(blockedProviderCommandMessage("grok", "/always-approve-not"), null);
  assert.equal(blockedProviderCommandMessage("grok", "tell me about /always-approve"), null);
});

// ---------------------------------------------------------------------------
// Goals §8.5 — `/goal` where the host parses it
// ---------------------------------------------------------------------------

const isGoalRow = (item: SlashMenuItem): boolean =>
  (item.type === "host-command" && item.command === "goal") ||
  (item.type === "provider-command" && item.command.name === "goal");

test("goals §8.5: a host-parsed /goal (Codex) joins the host commands, with its description and hint", () => {
  const goal = buildSlashMenuItems({ ...BASE, hostGoalCommand: true }).find(isGoalRow);
  assert.ok(goal && goal.type === "host-command");
  assert.equal(goal.label, "/goal");
  assert.equal(goal.description, "Set, check, pause, resume or clear a goal");
  assert.equal(goal.hint, "<objective> | pause | resume | clear | edit <objective>");
  assert.equal(
    buildSlashMenuItems(BASE).some(isGoalRow),
    false,
    "no host row where the host does not parse it"
  );
});

test("goals §8.5: a provider adapter's own /goal entry is used unchanged", () => {
  // Claude and Grok forward `/goal` verbatim; the CLI's catalog row is the one.
  const grokGoal: SlashCommand = {
    name: "goal",
    description: "Set, manage, or check an autonomous goal",
    input: { hint: "<objective> [--budget <tokens>] | status | pause | resume | clear" }
  };
  const rows = buildSlashMenuItems({ ...BASE, slashCommands: [grokGoal] }).filter(isGoalRow);
  assert.equal(rows.length, 1);
  assert.ok(rows[0]?.type === "provider-command");
  assert.equal(rows[0].command, grokGoal, "the provider's own entry, untouched");
});

test("goals §8.5: the host row replaces a provider row of the same name — one /goal, never two", () => {
  const rows = buildSlashMenuItems({
    ...BASE,
    hostGoalCommand: true,
    slashCommands: [command("goal", "Codex's own"), command("init")]
  }).filter(isGoalRow);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.type, "host-command");
});

test("goals §8.5: picking /goal TYPES it — the host parses the sent text, so it must reach the draft", () => {
  assert.equal(
    menuItemReplacement({
      id: "host:goal",
      type: "host-command",
      command: "goal",
      label: "/goal",
      description: ""
    }),
    "/goal "
  );
});

test("goals §8.5: /goal is offered only at the start of the prompt — the host recognises nothing else", () => {
  const midway = buildSlashMenuItems({ ...BASE, hostGoalCommand: true, isAtPromptStart: false });
  assert.equal(midway.some(isGoalRow), false, "`fix it /goal x` would reach the model as text");
  assert.equal(
    midway.some((item) => item.type === "host-command" && item.command === "model"),
    true,
    "the client-only host commands still apply from anywhere"
  );
});

test("goals §8.5: typing `go` ranks /goal first", () => {
  const [first] = buildSlashMenuItems({
    ...BASE,
    hostGoalCommand: true,
    slashCommands: [command("init")],
    query: "go"
  });
  assert.ok(first && isGoalRow(first));
});

test("goals §8.5: picking /goal ACTS on nothing — the insertion is the whole pick, nothing is sent", () => {
  const goalItem = {
    id: "host:goal",
    type: "host-command" as const,
    command: "goal" as const,
    label: "/goal",
    description: ""
  };
  assert.equal(menuItemAction(goalItem), null);
  // The client-only host commands still act, exactly as before.
  for (const command of ["model", "effort", "plan", "default"] as const) {
    assert.equal(
      menuItemAction({ id: `host:${command}`, type: "host-command", command, label: "", description: "" }),
      command
    );
  }
  // …and every other row only inserts.
  assert.equal(
    menuItemAction({ id: "p", type: "provider-command", command: command("init"), label: "", description: "" }),
    null
  );
  assert.equal(menuItemAction({ id: "s", type: "skill", skill: skill("rev"), label: "", description: "" }), null);
  assert.equal(
    menuItemAction({ id: "f", type: "path", path: "a.ts", pathKind: "file", label: "", description: "" }),
    null
  );
});

test("goals §8.5: picking /goal replaces the typed trigger with `/goal ` and leaves the caret after the space", () => {
  const goalItem = buildSlashMenuItems({ ...BASE, hostGoalCommand: true, query: "go" }).find(
    (item) => item.type === "host-command" && item.command === "goal"
  );
  assert.ok(goalItem);
  // The composer's own pick, step for step: detect, replace, place the caret.
  const pick = (text: string, cursor: number) => {
    const trigger = detectComposerTrigger(text, cursor);
    assert.ok(trigger && trigger.kind === "slash-command", text);
    const replacement = menuItemReplacement(goalItem);
    const rangeEnd = extendReplacementRangeForTrailingSpace(text, trigger.rangeEnd, replacement);
    return replaceTextRange(text, trigger.rangeStart, rangeEnd, replacement);
  };
  assert.deepEqual(pick("/go", 3), { text: "/goal ", cursor: 6 }, "typed on, for the objective");
  assert.deepEqual(
    pick("/g fix the flaky tests", 2),
    { text: "/goal fix the flaky tests", cursor: 6 },
    "a space already after the caret is not doubled, and the caret sits before the objective"
  );
});
