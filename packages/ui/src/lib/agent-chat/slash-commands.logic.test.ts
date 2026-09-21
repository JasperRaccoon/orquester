import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AdapterCapabilities, ProviderSnapshot, Skill } from "@orquester/api/agent-chat";

import {
  applyCommandSelection,
  blockedProviderCommandMessage,
  buildCommandMenuItems,
  buildSkillMenuItems,
  commandItemDescription,
  detectComposerTrigger,
  isHostNativeCompactSubmission,
  isSkillUserInvocable,
  parseEffortArgument,
  parseStandaloneClientSlashCommand,
  providerCatalogForCwd,
  providerCommandsForSlashMenu,
  replaceTextRange,
  searchCommandMenuItems,
  skillMentionsInText,
  skillsForSlashMenu,
  type ComposerCommandItem
} from "./slash-commands.logic";

const capabilities = (overrides: Partial<AdapterCapabilities> = {}): AdapterCapabilities => ({
  sessionModelSwitch: "in-session",
  showPlanModeToggle: true,
  reportsContextWindow: true,
  compaction: { type: "native" },
  ...overrides
});

const skill = (name: string, overrides: Partial<Skill> = {}): Skill => ({
  name,
  path: `/skills/${name}/SKILL.md`,
  enabled: true,
  ...overrides
});

const provider = (overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot =>
  ({
    id: "claude",
    refIds: ["claude"],
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [{ name: "init", description: "Initialise" }],
    skills: [skill("review")],
    capabilities: capabilities(),
    ...overrides
  }) as ProviderSnapshot;

const menuInput = (overrides: Partial<Parameters<typeof buildCommandMenuItems>[0]> = {}) => ({
  provider: provider(),
  isAtPromptStart: true,
  showSkillsInSlashMenu: true,
  modelHasEffortDescriptor: true,
  threadHasContent: true,
  draftIsEmptyApartFromTrigger: true,
  hasAttachments: false,
  hasContextChips: false,
  ...overrides
});

const names = (items: readonly ComposerCommandItem[]) =>
  items.map((item) =>
    item.type === "provider" ? item.command.name : item.type === "skill" ? item.skill.name : item.command
  );

describe("detectComposerTrigger", () => {
  it("opens the command menu only at the start of the current LINE", () => {
    const trigger = detectComposerTrigger("/mod", 4);
    assert.equal(trigger?.kind, "slash-command");
    assert.equal(trigger?.query, "mod");
    assert.equal(detectComposerTrigger("hi /mod", 7), null);
    const second = detectComposerTrigger("hello\n/mod", 10);
    assert.equal(second?.kind, "slash-command");
    assert.equal(second?.rangeStart, 6);
  });

  it("closes the command menu once the query has whitespace", () => {
    assert.equal(detectComposerTrigger("/init now", 9), null);
  });

  it("opens the skill menu on any currency symbol", () => {
    assert.equal(detectComposerTrigger("$rev", 4)?.kind, "skill");
    assert.equal(detectComposerTrigger("£rev", 4)?.kind, "skill");
    assert.equal(detectComposerTrigger("write $rev", 10)?.query, "rev");
  });

  it("keeps the existing file search on @", () => {
    const trigger = detectComposerTrigger("see @src/a", 10);
    assert.equal(trigger?.kind, "path");
    assert.equal(trigger?.query, "src/a");
  });
});

describe("client commands (§4.6.5a)", () => {
  it("recognises /plan and /default on submit, and nothing else", () => {
    assert.equal(parseStandaloneClientSlashCommand("  /plan  "), "plan");
    assert.equal(parseStandaloneClientSlashCommand("/DEFAULT"), "default");
    assert.equal(parseStandaloneClientSlashCommand("/model"), null);
    assert.equal(parseStandaloneClientSlashCommand("/plan this"), null);
  });

  it("applies /effort <id> directly", () => {
    assert.equal(parseEffortArgument("/effort high"), "high");
    assert.equal(parseEffortArgument("/effort"), null);
  });
});

describe("host-native /compact (§4.6.5b)", () => {
  it("is exact and deliberately narrow", () => {
    assert.equal(isHostNativeCompactSubmission({ text: " /COMPACT ", attachmentCount: 0 }), true);
    assert.equal(isHostNativeCompactSubmission({ text: "/compact now", attachmentCount: 0 }), false);
    assert.equal(isHostNativeCompactSubmission({ text: "/compact", attachmentCount: 1 }), false);
  });
});

describe("menu gating (§4.6.7)", () => {
  it("removes PROVIDER commands mid-message but keeps host commands and skills", () => {
    const atStart = buildCommandMenuItems(menuInput());
    assert.ok(names(atStart).includes("init"));
    const midMessage = buildCommandMenuItems(menuInput({ isAtPromptStart: false }));
    assert.ok(!names(midMessage).includes("init"));
    assert.ok(names(midMessage).includes("model"));
    assert.ok(names(midMessage).includes("review"));
  });

  it("offers /plan and /default only where showPlanModeToggle", () => {
    const without = buildCommandMenuItems(
      menuInput({ provider: provider({ capabilities: capabilities({ showPlanModeToggle: false }) }) })
    );
    assert.ok(!names(without).includes("plan"));
    assert.ok(names(buildCommandMenuItems(menuInput())).includes("plan"));
  });

  it("offers /effort only when the model has a reasoning descriptor", () => {
    assert.ok(!names(buildCommandMenuItems(menuInput({ modelHasEffortDescriptor: false }))).includes("effort"));
  });

  it("offers /compact only with something to compact and an otherwise-empty draft", () => {
    assert.ok(names(buildCommandMenuItems(menuInput())).includes("compact"));
    assert.ok(!names(buildCommandMenuItems(menuInput({ threadHasContent: false }))).includes("compact"));
    assert.ok(!names(buildCommandMenuItems(menuInput({ hasAttachments: true }))).includes("compact"));
    assert.ok(!names(buildCommandMenuItems(menuInput({ hasContextChips: true }))).includes("compact"));
    assert.ok(
      !names(buildCommandMenuItems(menuInput({ draftIsEmptyApartFromTrigger: false }))).includes("compact")
    );
  });
});

describe("skills (§4.6.8)", () => {
  it("hides a skill the provider reserves for the agent, and a disabled one", () => {
    assert.equal(isSkillUserInvocable(skill("a", { userInvocable: false })), false);
    assert.equal(isSkillUserInvocable(skill("a", { enabled: false })), false);
    assert.equal(isSkillUserInvocable(skill("a", { userInvocationOnly: true })), true);
  });

  it("is a user setting in the / menu, but $ always lists them", () => {
    assert.deepEqual(skillsForSlashMenu([skill("a")], false), []);
    assert.equal(skillsForSlashMenu([skill("a")], true).length, 1);
    assert.equal(buildSkillMenuItems(provider()).length, 1);
  });

  it("lists a colliding name once, as the skill", () => {
    const commands = providerCommandsForSlashMenu(
      [{ name: "review" }, { name: "init" }],
      [skill("Review")]
    );
    assert.deepEqual(commands.map((command) => command.name), ["init"]);
  });

  it("prefers the per-cwd overlay of the catalog", () => {
    const withWorkspace = provider({
      workspaceSnapshots: [
        {
          cwd: "/w/p",
          checkedAt: "2026-01-01T00:00:00.000Z",
          slashCommands: [{ name: "local" }],
          skills: []
        }
      ]
    });
    assert.deepEqual(
      providerCatalogForCwd(withWorkspace, "/w/p").slashCommands.map((c) => c.name),
      ["local"]
    );
    assert.deepEqual(
      providerCatalogForCwd(withWorkspace, "/other").slashCommands.map((c) => c.name),
      ["init"]
    );
  });
});

describe("ranking (§4.6.7)", () => {
  it("lets a name match beat a description match", () => {
    const items: ComposerCommandItem[] = [
      { type: "provider", command: { name: "zebra", description: "init things" } },
      { type: "provider", command: { name: "init", description: "start" } }
    ];
    assert.deepEqual(names(searchCommandMenuItems(items, "init")), ["init", "zebra"]);
  });

  it("breaks ties host → provider → skill", () => {
    const items: ComposerCommandItem[] = [
      { type: "skill", skill: skill("compact") },
      { type: "provider", command: { name: "compact" } },
      { type: "host", command: "compact", label: "/compact", description: "Compact" }
    ];
    const ranked = searchCommandMenuItems(items, "compact");
    assert.deepEqual(ranked.map((item) => item.type), ["host", "provider", "skill"]);
  });

  it("ranks a client command like a host command on a tie", () => {
    const items: ComposerCommandItem[] = [
      { type: "skill", skill: skill("model") },
      { type: "client", command: "model", label: "/model", description: "Pick the model" }
    ];
    assert.deepEqual(
      searchCommandMenuItems(items, "model").map((item) => item.type),
      ["client", "skill"]
    );
  });

  it("returns everything for an empty query, trigger character stripped", () => {
    const items = buildCommandMenuItems(menuInput());
    assert.equal(searchCommandMenuItems(items, "/").length, items.length);
  });
});

describe("insertion (§4.6.7)", () => {
  const trigger = { kind: "slash-command" as const, query: "", rangeStart: 0, rangeEnd: 1 };

  it("inserts a provider command with a trailing space", () => {
    const result = applyCommandSelection("/", trigger, {
      type: "provider",
      command: { name: "init" }
    });
    assert.deepEqual(result, { action: "insert", text: "/init ", cursor: 6 });
  });

  it("inserts a skill as $name", () => {
    const result = applyCommandSelection("/", trigger, { type: "skill", skill: skill("review") });
    assert.equal(result.text, "$review ");
  });

  it("erases the trigger for a client command and acts instead", () => {
    const result = applyCommandSelection("/", trigger, {
      type: "client",
      command: "model",
      label: "/model",
      description: ""
    });
    assert.equal(result.action, "client");
    assert.equal(result.text, "");
  });

  it("replaceTextRange clamps out-of-range indices", () => {
    assert.deepEqual(replaceTextRange("abc", -5, 99, "X"), { text: "X", cursor: 1 });
  });
});

describe("argument hints and re-chipping", () => {
  it("falls back to the argument hint, then to a generic line", () => {
    assert.equal(
      commandItemDescription({ type: "provider", command: { name: "a", input: { hint: "<file>" } } }),
      "<file>"
    );
    assert.equal(commandItemDescription({ type: "provider", command: { name: "a" } }), "Run provider command");
  });

  it("re-chips $skill mentions from the stored text alone", () => {
    assert.deepEqual(skillMentionsInText("run $review and $ghost", ["review"]), ["review"]);
    assert.deepEqual(skillMentionsInText("cost $5", ["review"]), []);
  });
});

describe("blocked provider commands", () => {
  it("refuses Grok's /always-approve with a pointer at the permission chip", () => {
    assert.match(
      blockedProviderCommandMessage("grok", "/always-approve") ?? "",
      /permission mode/
    );
    assert.equal(blockedProviderCommandMessage("claude", "/always-approve"), null);
    assert.equal(blockedProviderCommandMessage("grok", "/init"), null);
  });
});
