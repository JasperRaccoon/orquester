import test from "node:test";
import assert from "node:assert/strict";
import type { Skill, SlashCommand } from "@orquester/api/agent-chat";

import {
  buildSkillMenuItems,
  buildSlashMenuItems,
  compactCommandAvailable,
  isProviderSkillUserInvocable,
  menuItemReplacement,
  providerCommandDescription,
  providerCommandsForSlashMenu,
  searchSlashMenuItems,
  skillsForSlashMenu,
  slashMenuItemsForPromptPosition,
  type SlashMenuItem
} from "./composer-menu.ts";

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
