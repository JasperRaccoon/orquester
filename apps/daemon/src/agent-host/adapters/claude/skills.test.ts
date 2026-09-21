/**
 * Skill discovery (§4.6.2, §4.6.4), `$name` dispatch (§4.6.8) and
 * `AskUserQuestion` parsing (§4.5).
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, before, describe, it } from "node:test";

import {
  dispatchableSkillNames,
  discoverClaudeSkills,
  parseFrontmatterBoolean,
  parseLenientJson,
  parseSkillFrontmatter,
  readSkillOverridesFromSettings,
  skillOverrideSettingsPaths
} from "./skills.ts";
import { planClaudeSkillDispatch, startsWithSlashCommand } from "./skill-dispatch.ts";
import { buildAskUserQuestionReply, parseAskUserQuestionInput } from "./questions.ts";

let root: string;
let configDir: string;
let cwd: string;

async function writeSkill(
  dir: string,
  name: string,
  frontmatter: string,
  body = "Do the thing."
): Promise<void> {
  const skillDir = nodePath.join(dir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(nodePath.join(skillDir, "SKILL.md"), `${frontmatter}\n${body}\n`, "utf8");
}

before(async () => {
  root = await fs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "orq-claude-skills-"));
  configDir = nodePath.join(root, "config");
  cwd = nodePath.join(root, "project");
  await fs.mkdir(nodePath.join(configDir, "skills"), { recursive: true });
  await fs.mkdir(nodePath.join(cwd, ".claude", "skills"), { recursive: true });

  await writeSkill(
    nodePath.join(configDir, "skills"),
    "deploy",
    "---\ndescription: Ship the app\n---"
  );
  await writeSkill(
    nodePath.join(configDir, "skills"),
    "shared",
    "---\ndescription: The user copy wins\n---"
  );
  await writeSkill(
    nodePath.join(configDir, "skills"),
    "agent-only",
    "---\ndescription: Reserved\nuser-invocable: no\n---"
  );
  await writeSkill(
    nodePath.join(configDir, "skills"),
    "user-only",
    "---\ndescription: The user must start it\ndisable-model-invocation: yes\n---"
  );
  await writeSkill(
    nodePath.join(configDir, "skills"),
    "probe-alias",
    "---\nname: probe-alias-frontmatter\ndescription: Named by its directory\n---"
  );
  // A frontmatter block that is a sequence, not a mapping: the CLI would not
  // load it either.
  await writeSkill(nodePath.join(configDir, "skills"), "broken", "---\n  - a\n  - b\n---");
  // No frontmatter at all is not malformed; the skill still exists.
  await writeSkill(nodePath.join(configDir, "skills"), "bare", "# Just a body");
  await writeSkill(
    nodePath.join(cwd, ".claude", "skills"),
    "shared",
    "---\ndescription: The project copy loses\n---"
  );
  await writeSkill(
    nodePath.join(cwd, ".claude", "skills"),
    "project-thing",
    "---\ndescription: Project scoped\n---"
  );
  await fs.writeFile(
    nodePath.join(cwd, ".claude", "settings.json"),
    '{\n  // a comment the CLI tolerates\n  "skillOverrides": { "deploy": "off" },\n}\n',
    "utf8"
  );
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("claude skills — filesystem discovery", () => {
  it("scans both roots, user first, and names a skill by its directory", async () => {
    const skills = await discoverClaudeSkills({ configDir, cwd });
    const byName = new Map(skills.map((skill) => [skill.name, skill]));

    assert.ok(byName.has("deploy"));
    assert.ok(byName.has("project-thing"));
    assert.equal(byName.get("project-thing")?.scope, "project");
    assert.equal(byName.get("deploy")?.scope, "user");

    // The user root wins on a name collision, matching the CLI.
    assert.equal(byName.get("shared")?.scope, "user");
    assert.equal(byName.get("shared")?.description, "The user copy wins");

    // Identity is the DIRECTORY name, not the frontmatter `name`.
    assert.ok(byName.has("probe-alias"));
    assert.ok(!byName.has("probe-alias-frontmatter"));

    // Malformed frontmatter means the CLI would not load it either.
    assert.ok(!byName.has("broken"));
    // Absent frontmatter is not malformed.
    assert.ok(byName.has("bare"));
    assert.equal(byName.get("bare")?.description, undefined);
  });

  it("reads the two inverse invocability flags, YAML-1.1 spellings included", async () => {
    const skills = await discoverClaudeSkills({ configDir, cwd });
    const byName = new Map(skills.map((skill) => [skill.name, skill]));
    assert.equal(byName.get("agent-only")?.userInvocable, false);
    assert.equal(byName.get("user-only")?.userInvocationOnly, true);
    assert.equal(byName.get("deploy")?.userInvocable, undefined);
  });

  it("honours skillOverrides from a lenient settings file", async () => {
    const skills = await discoverClaudeSkills({ configDir, cwd });
    const deploy = skills.find((skill) => skill.name === "deploy");
    // A disabled skill is reported disabled rather than dropped, so the picker
    // can grey it out instead of silently losing it.
    assert.ok(deploy);
    assert.equal(deploy.enabled, false);
  });

  it("only offers enabled, user-invocable skills to the dispatcher", async () => {
    const skills = await discoverClaudeSkills({ configDir, cwd });
    const names = dispatchableSkillNames(skills);
    assert.ok(names.has("user-only"));
    assert.ok(names.has("shared"));
    assert.ok(!names.has("agent-only"), "user-invocable: false is reserved for the agent");
    assert.ok(!names.has("deploy"), "a disabled skill is never dispatchable");
  });

  it("returns nothing rather than throwing for a missing config dir", async () => {
    const skills = await discoverClaudeSkills({ configDir: nodePath.join(root, "nope") });
    assert.deepEqual(skills, []);
  });

  it("lists the settings files in the CLI's precedence order", () => {
    const paths = skillOverrideSettingsPaths({
      configDir: "/cfg",
      cwd: "/repo/app",
      platform: "linux",
      repositoryRoot: "/repo"
    });
    assert.deepEqual(paths, [
      "/cfg/settings.json",
      "/repo/app/.claude/settings.json",
      "/repo/app/.claude/settings.local.json",
      "/repo/.claude/settings.local.json",
      "/etc/claude-code/managed-settings.json"
    ]);
  });
});

describe("claude skills — parsers", () => {
  it("accepts the YAML 1.1 booleans the CLI accepts", () => {
    for (const truthy of ["true", "yes", "on", "1", " Y "]) {
      assert.equal(parseFrontmatterBoolean(truthy), true, truthy);
    }
    for (const falsy of ["false", "no", "off", "0", "N"]) {
      assert.equal(parseFrontmatterBoolean(falsy), false, falsy);
    }
    assert.equal(parseFrontmatterBoolean("maybe"), undefined);
  });

  it("reports a missing frontmatter block as missing, not malformed", () => {
    assert.deepEqual(parseSkillFrontmatter("# Just a heading\n"), { kind: "missing" });
    assert.equal(parseSkillFrontmatter("---\ndescription: x\n---\nbody").kind, "parsed");
  });

  it("tolerates comments and trailing commas in a settings file", () => {
    assert.deepEqual(parseLenientJson('{ "a": 1, /* x */ "b": [2,], }'), { a: 1, b: [2] });
    assert.equal(parseLenientJson("{ not json"), undefined);
  });

  it("drops every override in a file when one entry is invalid, as the CLI does", () => {
    assert.equal(
      readSkillOverridesFromSettings('{"skillOverrides": {"a": "off", "b": "bogus"}}'),
      undefined
    );
    const good = readSkillOverridesFromSettings('{"skillOverrides": {"a": "off"}}');
    assert.equal(good?.get("a")?.enabled, false);
    const userOnly = readSkillOverridesFromSettings(
      '{"skillOverrides": {"a": "user-invocable-only"}}'
    );
    assert.equal(userOnly?.get("a")?.enabled, true);
    assert.equal(userOnly?.get("a")?.userInvocationOnly, true);
  });
});

describe("claude skill dispatch — §4.6.8", () => {
  const known = new Set(["deploy", "review", "pdf"]);

  it("rewrites the LAST known mention into a trailing /name block", () => {
    const plan = planClaudeSkillDispatch("please $deploy the app now", known);
    assert.equal(plan?.skillName, "deploy");
    assert.equal(plan?.leadingText, "please");
    assert.equal(plan?.commandText, "/deploy the app now");
  });

  it("opens the command block when the mention starts the prompt", () => {
    const plan = planClaudeSkillDispatch("$deploy staging", known);
    assert.equal(plan?.leadingText, undefined);
    assert.equal(plan?.commandText, "/deploy staging");
  });

  it("rewrites earlier mentions inline so the model can still start them", () => {
    const plan = planClaudeSkillDispatch("first $review then $deploy", known);
    assert.equal(plan?.skillName, "deploy");
    assert.equal(plan?.leadingText, "first /review then");
    assert.equal(plan?.commandText, "/deploy");
  });

  it("leaves an unknown mention literal — a $HOME in prose is not a command", () => {
    assert.equal(planClaudeSkillDispatch("set $HOME to /tmp", known), undefined);
    assert.equal(planClaudeSkillDispatch("costs $5k this month", known), undefined);
  });

  it("recognises a prompt that already opens with a slash command (§4.6.9)", () => {
    assert.equal(startsWithSlashCommand("/compact"), true);
    assert.equal(startsWithSlashCommand("/review the diff"), true);
    assert.equal(startsWithSlashCommand("please /review"), false);
    assert.equal(startsWithSlashCommand("//not-a-command"), false);
  });
});

describe("claude AskUserQuestion — the id is the question text", () => {
  const input = {
    questions: [
      {
        question: "Which file should I read?",
        header: "File choice",
        options: [
          { label: "a.txt", description: "Read a.txt" },
          { label: "b.txt", description: "Read b.txt" }
        ],
        multiSelect: false
      }
    ]
  };

  it("keys every question on its exact text", () => {
    const parsed = parseAskUserQuestionInput(input);
    assert.equal(parsed.questions.length, 1);
    assert.equal(parsed.questions[0]!.id, "Which file should I read?");
    assert.equal(parsed.questions[0]!.header, "File choice");
    assert.equal(parsed.questions[0]!.multiSelect, false);
    assert.equal(parsed.duplicateQuestionText, undefined);
  });

  it("never trims or normalises the id", () => {
    const parsed = parseAskUserQuestionInput({
      questions: [{ question: "  spaced?  ", options: [] }]
    });
    assert.equal(parsed.questions[0]!.id, "  spaced?  ");
  });

  it("reports two questions with identical text rather than answering one", () => {
    const parsed = parseAskUserQuestionInput({
      questions: [
        { question: "Same?", options: [] },
        { question: "Same?", options: [] }
      ]
    });
    assert.equal(parsed.duplicateQuestionText, "Same?");
  });

  it("builds the reply shape the SDK looks up by text", () => {
    const reply = buildAskUserQuestionReply(input, { "Which file should I read?": "a.txt" });
    assert.deepEqual(reply.questions, input.questions);
    assert.deepEqual(reply.answers, { "Which file should I read?": "a.txt" });
  });
});
