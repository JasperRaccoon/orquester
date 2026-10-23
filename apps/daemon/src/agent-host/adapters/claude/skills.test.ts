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
  discoverClaudePluginSkills,
  discoverClaudeSkills,
  parseFrontmatterBoolean,
  readEnabledPluginsFromSettings,
  readSkillOverridesFromSettings
} from "./skills.ts";
import { planClaudeSkillDispatch } from "./skill-dispatch.ts";
import { claudePluginEntryIds } from "../../../agent-isolation/claude-names.ts";
import {
  buildAskUserQuestionReply,
  CLAUDE_QUESTION_PREVIEW_FORMAT,
  parseAskUserQuestionInput
} from "./questions.ts";

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

  it("lists the settings files in the CLI's precedence order", async () => {
    const config = nodePath.join(root, "precedence-user");
    const repo = nodePath.join(root, "precedence-repo");
    const project = nodePath.join(repo, "app");
    const names = ["project-over-user", "local-over-project", "root-over-local"];
    await fs.mkdir(nodePath.join(repo, ".git"), { recursive: true });
    await fs.mkdir(nodePath.join(project, ".claude"), { recursive: true });
    await fs.mkdir(nodePath.join(repo, ".claude"), { recursive: true });
    for (const name of names) {
      await writeSkill(nodePath.join(config, "skills"), name, "---\ndescription: Precedence\n---");
    }
    await fs.writeFile(nodePath.join(config, "settings.json"), JSON.stringify({
      skillOverrides: Object.fromEntries(names.map((name) => [name, "off"]))
    }));
    await fs.writeFile(nodePath.join(project, ".claude", "settings.json"), JSON.stringify({
      skillOverrides: { "project-over-user": "on", "local-over-project": "off" }
    }));
    await fs.writeFile(nodePath.join(project, ".claude", "settings.local.json"), JSON.stringify({
      skillOverrides: { "local-over-project": "on", "root-over-local": "off" }
    }));
    await fs.writeFile(nodePath.join(repo, ".claude", "settings.local.json"), JSON.stringify({
      skillOverrides: { "root-over-local": "on" }
    }));

    const skills = await discoverClaudeSkills({ configDir: config, cwd: project });
    for (const name of names) {
      assert.equal(skills.find((skill) => skill.name === name)?.enabled, true, name);
    }
  });
});

// Adapted from T3 Code (MIT): apps/server/src/provider/Drivers/ClaudeSkills.test.ts
describe("claude skills — installed plugins", () => {
  /** A plugin install dir with an optional manifest and `skills/<name>/SKILL.md` entries. */
  async function writePlugin(
    dir: string,
    manifest: string | undefined,
    skills: Record<string, string>
  ): Promise<string> {
    await fs.mkdir(dir, { recursive: true });
    if (manifest !== undefined) {
      await fs.mkdir(nodePath.join(dir, ".claude-plugin"), { recursive: true });
      await fs.writeFile(nodePath.join(dir, ".claude-plugin", "plugin.json"), manifest, "utf8");
    }
    for (const [name, frontmatter] of Object.entries(skills)) {
      await writeSkill(nodePath.join(dir, "skills"), name, frontmatter);
    }
    return dir;
  }

  /** A fresh account config dir whose registry and user settings are these. */
  async function account(
    name: string,
    plugins: Record<string, unknown>,
    enabledPlugins: Record<string, unknown>
  ): Promise<string> {
    const dir = nodePath.join(root, name);
    await fs.mkdir(nodePath.join(dir, "plugins"), { recursive: true });
    await fs.writeFile(
      nodePath.join(dir, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins })
    );
    await fs.writeFile(nodePath.join(dir, "settings.json"), JSON.stringify({ enabledPlugins }));
    return dir;
  }

  const user = (installPath: string): Record<string, unknown> => ({
    scope: "user",
    installPath,
    version: "1.0.0"
  });

  it("lists an enabled plugin's skills as plugin:skill, and none of a disabled or uninstalled one", async () => {
    const cache = nodePath.join(root, "plugin-cache-a");
    const alpha = await writePlugin(nodePath.join(cache, "alpha"), '{"name":"alpha"}', {
      review: "---\ndescription: Review the diff\n---",
      "agent-side": "---\nuser-invocable: false\n---",
      "with space": "---\ndescription: Sanitised\n---",
      broken: "---\n  - a\n---"
    });
    const beta = await writePlugin(nodePath.join(cache, "beta"), '{"name":"beta"}', { lint: "---\n---" });
    const config = await account(
      "plugins-a",
      { "alpha@market": [user(alpha)], "beta@market": [user(beta)] },
      { "alpha@market": true, "beta@market": false, "ghost@market": true }
    );

    const skills = await discoverClaudeSkills({ configDir: config, cwd });
    const plugin = skills.filter((skill) => skill.scope === "plugin");
    assert.deepEqual(
      plugin.map((skill) => skill.name),
      ["alpha:agent-side", "alpha:review", "alpha:with-space"]
    );
    const review = plugin.find((skill) => skill.name === "alpha:review")!;
    assert.equal(review.description, "Review the diff");
    assert.equal(review.path, nodePath.join(alpha, "skills", "review", "SKILL.md"));
    assert.equal(review.enabled, true);
    assert.equal(plugin.find((skill) => skill.name === "alpha:agent-side")?.userInvocable, false);
    assert.ok(dispatchableSkillNames(skills).has("alpha:review"), "a plugin skill dispatches as /plugin:skill");
    // The project's own skills are still there beside them.
    assert.ok(skills.some((skill) => skill.name === "project-thing"));
  });

  it("follows the settings precedence for enabledPlugins, an extended value replacing without enabling", async () => {
    const cache = nodePath.join(root, "plugin-cache-b");
    const alpha = await writePlugin(nodePath.join(cache, "alpha"), '{"name":"alpha"}', { one: "---\n---" });
    const beta = await writePlugin(nodePath.join(cache, "beta"), '{"name":"beta"}', { two: "---\n---" });
    const gamma = await writePlugin(nodePath.join(cache, "gamma"), '{"name":"gamma"}', { three: "---\n---" });
    const config = await account(
      "plugins-b",
      { "alpha@m": [user(alpha)], "beta@m": [user(beta)], "gamma@m": [user(gamma)] },
      { "alpha@m": true, "beta@m": true, "gamma@m": false }
    );
    const project = nodePath.join(root, "plugins-b-project");
    await fs.mkdir(nodePath.join(project, ".claude"), { recursive: true });
    await fs.writeFile(
      nodePath.join(project, ".claude", "settings.json"),
      '{ "enabledPlugins": { "alpha@m": false, "beta@m": { "source": "x" }, "gamma@m": true, }, }'
    );
    const names = (await discoverClaudeSkills({ configDir: config, cwd: project }))
      .filter((skill) => skill.scope === "plugin")
      .map((skill) => skill.name);
    assert.deepEqual(names, ["gamma:three"]);
  });

  it("tolerates a malformed manifest or registry, and keeps a plugin's skills inside the plugin", async () => {
    const cache = nodePath.join(root, "plugin-cache-c");
    const outside = nodePath.join(cache, "outside");
    await writeSkill(outside, "escaped", "---\n---");
    const nameless = await writePlugin(nodePath.join(cache, "nameless"), "{ not json", { tidy: "---\n---" });
    const declared = await writePlugin(
      nodePath.join(cache, "declared"),
      JSON.stringify({ name: "declared", skills: ["./extra", "../outside"] }),
      { base: "---\n---" }
    );
    await writeSkill(nodePath.join(declared, "extra"), "added", "---\n---");
    await fs.symlink(outside, nodePath.join(declared, "linked"));
    await fs.writeFile(
      nodePath.join(declared, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "declared", skills: ["./extra", "../outside", "./linked"] })
    );
    const single = nodePath.join(cache, "single");
    await fs.mkdir(single, { recursive: true });
    await fs.writeFile(nodePath.join(single, "SKILL.md"), "---\nname: single:solo\ndescription: One\n---\nBody\n");
    const dotted = await writePlugin(nodePath.join(cache, "dotted"), '{"name":"my.plugin"}', { x: "---\n---" });
    const config = await account(
      "plugins-c",
      {
        "nameless@m": [user(nameless)],
        "declared@m": [user(declared)],
        "single@m": [user(single)],
        "dotted@m": [user(dotted)],
        "junk@m": [{ scope: "galaxy", installPath: nameless }, "nope"],
        "notalist@m": { scope: "user" }
      },
      {
        "nameless@m": true,
        "declared@m": true,
        "single@m": true,
        "dotted@m": true,
        "junk@m": true,
        "notalist@m": true
      }
    );
    const names = (await discoverClaudeSkills({ configDir: config }))
      .filter((skill) => skill.scope === "plugin")
      .map((skill) => skill.name);
    // A manifest that does not read names the plugin after its id; `../outside` and a
    // symlink out of the plugin are refused; a single-skill plugin keeps its declared name;
    // a dotted plugin name loads as written, as Claude Code loads it (`my.plugin:x`).
    assert.deepEqual(names, ["declared:added", "declared:base", "my.plugin:x", "nameless:tidy", "single:solo"]);

    const broken = nodePath.join(root, "plugins-broken");
    await fs.mkdir(nodePath.join(broken, "plugins"), { recursive: true });
    await fs.writeFile(nodePath.join(broken, "plugins", "installed_plugins.json"), "{ truncated");
    await fs.writeFile(nodePath.join(broken, "settings.json"), JSON.stringify({ enabledPlugins: { "x@m": true } }));
    await writeSkill(nodePath.join(broken, "skills"), "still-here", "---\n---");
    assert.deepEqual(
      (await discoverClaudeSkills({ configDir: broken })).map((skill) => skill.name),
      ["still-here"]
    );
  });

  it("lists a plugin once, from its first install that exists, and a project install only in its project", async () => {
    const cache = nodePath.join(root, "plugin-cache-d");
    const installed = await writePlugin(nodePath.join(cache, "dup"), '{"name":"dup"}', { only: "---\n---" });
    const scoped = await writePlugin(nodePath.join(cache, "scoped"), '{"name":"scoped"}', { here: "---\n---" });
    const elsewhere = nodePath.join(root, "plugins-d-elsewhere");
    await fs.mkdir(elsewhere, { recursive: true });
    const config = await account(
      "plugins-d",
      {
        "dup@m": [user(nodePath.join(cache, "gone")), user(installed), user(installed)],
        "scoped@m": [{ scope: "project", installPath: scoped, projectPath: cwd }]
      },
      { "dup@m": true, "scoped@m": true }
    );
    const inProject = await discoverClaudeSkills({ configDir: config, cwd });
    assert.deepEqual(
      inProject.filter((skill) => skill.scope === "plugin").map((skill) => [skill.name, skill.path]),
      [
        ["dup:only", nodePath.join(installed, "skills", "only", "SKILL.md")],
        ["scoped:here", nodePath.join(scoped, "skills", "here", "SKILL.md")]
      ]
    );
    const outside = await discoverClaudeSkills({ configDir: config, cwd: elsewhere });
    assert.deepEqual(
      outside.filter((skill) => skill.scope === "plugin").map((skill) => skill.name),
      ["dup:only"]
    );
  });

  it("applies a project install to a linked worktree of the same repository", async () => {
    const repo = nodePath.join(root, "plugins-e-repo");
    const worktree = nodePath.join(root, "plugins-e-worktree");
    const gitDir = nodePath.join(repo, ".git", "worktrees", "wt");
    await fs.mkdir(gitDir, { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await fs.writeFile(nodePath.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    await fs.writeFile(nodePath.join(gitDir, "commondir"), "../..\n");
    await fs.writeFile(nodePath.join(gitDir, "gitdir"), `${nodePath.join(worktree, ".git")}\n`);
    const plugin = await writePlugin(nodePath.join(root, "plugin-cache-e", "wt"), '{"name":"wt"}', { s: "---\n---" });
    const config = await account(
      "plugins-e",
      { "wt@m": [{ scope: "local", installPath: plugin, projectPath: repo }] },
      { "wt@m": true }
    );
    const names = (await discoverClaudeSkills({ configDir: config, cwd: worktree }))
      .filter((skill) => skill.scope === "plugin")
      .map((skill) => skill.name);
    assert.deepEqual(names, ["wt:s"]);
  });

  it("reads each account's own config dir, and CLAUDE_CODE_PLUGIN_CACHE_DIR when the CLI is given one", async () => {
    const plugin = await writePlugin(nodePath.join(root, "plugin-cache-f", "acct"), '{"name":"acct"}', { s: "---\n---" });
    const first = await account("plugins-f1", { "acct@m": [user(plugin)] }, { "acct@m": true });
    const second = await account("plugins-f2", {}, { "acct@m": true });
    const pluginNames = async (input: Parameters<typeof discoverClaudeSkills>[0]): Promise<string[]> =>
      (await discoverClaudeSkills(input)).filter((skill) => skill.scope === "plugin").map((skill) => skill.name);
    assert.deepEqual(await pluginNames({ configDir: first }), ["acct:s"]);
    assert.deepEqual(await pluginNames({ configDir: second }), [], "another account installed nothing");
    assert.deepEqual(
      await pluginNames({ configDir: second, pluginCacheDir: nodePath.join(first, "plugins") }),
      ["acct:s"]
    );
  });

  it("an Agent Profile's plugins replace the installed ones, named by manifest, else their directory", async () => {
    const plugin = await writePlugin(nodePath.join(root, "plugin-cache-g", "installed"), '{"name":"installed"}', { s: "---\n---" });
    const config = await account("plugins-g", { "installed@m": [user(plugin)] }, { "installed@m": true });
    const generated = await writePlugin(nodePath.join(root, "prepared-g", "plugin"), '{"name":"developer"}', {
      review: "---\ndescription: Profile review\n---"
    });
    const copied = await writePlugin(nodePath.join(root, "prepared-g", "plugins", "item-1"), undefined, { fmt: "---\n---" });

    const skills = await discoverClaudeSkills({
      configDir: config,
      cwd,
      pluginDirs: [generated, copied]
    });
    assert.deepEqual(
      skills.filter((skill) => skill.scope === "plugin").map((skill) => skill.name),
      ["developer:review", "item-1:fmt"]
    );
    assert.deepEqual((await discoverClaudePluginSkills([copied])).map((skill) => skill.name), ["item-1:fmt"]);
  });

  it("a plugin whose manifest names it invalidly loads nothing, as the CLI refuses it", async () => {
    const bad = await writePlugin(nodePath.join(root, "plugin-cache-h", "bad"), '{"name":"bad name"}', { s: "---\n---" });
    assert.deepEqual(await discoverClaudePluginSkills([bad]), []);
  });

  it("lists a profile plugin's skills under exactly the ids its skills allow-list carries", async () => {
    // The live session filters its list by the prepared allow-list (`claudePluginEntryIds`):
    // any naming drift between the two hides a skill the composer offers.
    const dir = nodePath.join(root, "prepared-i", "plugins", "item-9");
    await writePlugin(dir, '{"name":"dot.plug","skills":["./one"]}', {
      "my.folder": "---\nname: front-name\n---",
      "with space": "---\n---",
      plain: "---\ndescription: d\n---"
    });
    await fs.mkdir(nodePath.join(dir, "one"), { recursive: true });
    await fs.writeFile(nodePath.join(dir, "one", "SKILL.md"), "---\nname: dot.plug:So Lo\n---\nx\n");
    const nameless = nodePath.join(root, "prepared-i", "plugins", "item-10");
    await writePlugin(nameless, undefined, { fmt: "---\n---" });

    for (const [path, pluginName] of [[dir, "dot.plug"], [nameless, "item-10"]] as const) {
      const listed = (await discoverClaudePluginSkills([path])).map((skill) => skill.name).sort();
      const allowed = (await claudePluginEntryIds(path, pluginName)).sort();
      assert.deepEqual(listed, allowed, pluginName);
    }
    assert.deepEqual((await discoverClaudePluginSkills([dir])).map((skill) => skill.name), [
      "dot.plug:my-folder",
      "dot.plug:plain",
      "dot.plug:So-Lo",
      "dot.plug:with-space"
    ]);
    // ...and each dispatches as `/name`.
    const names = dispatchableSkillNames(await discoverClaudePluginSkills([dir]));
    assert.equal(planClaudeSkillDispatch("$dot.plug:my-folder now", names)?.commandText, "/dot.plug:my-folder now");
    assert.equal(planClaudeSkillDispatch("costs $1.50.", names), undefined);
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

  it("reads enabledPlugins leniently, an extended value as a replacement that enables nothing", () => {
    const map = readEnabledPluginsFromSettings('{ "enabledPlugins": { "a@m": true, "b@m": false, "c@m": {}, }, // x\n }');
    assert.deepEqual([...(map ?? [])], [["a@m", true], ["b@m", false], ["c@m", null]]);
    assert.equal(readEnabledPluginsFromSettings('{ "enabledPlugins": [] }'), undefined);
    assert.equal(readEnabledPluginsFromSettings("not json"), undefined);
  });

  it("drops every override in a file when one entry is invalid, as the CLI does", () => {
    assert.equal(readSkillOverridesFromSettings("{ not json"), undefined);
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
    assert.equal("annotations" in reply, false, "no option had a preview: nothing to annotate");
  });
});

describe("claude AskUserQuestion — option previews (SDK 0.3.278 `preview`, `annotations`)", () => {
  // The SDK's own shape: `preview` on an option, single-select only.
  const input = {
    questions: [
      {
        question: "Which layout?",
        header: "Layout",
        options: [
          { label: "Sidebar (Recommended)", description: "Nav on the left", preview: "┌──┬──────┐\n│ ▤│ main │\n└──┴──────┘" },
          { label: "Top bar", description: "Nav on top", preview: "┌─────────┐\n│ ▤ ▤ ▤   │\n└─────────┘" },
          { label: "None", description: "No navigation" }
        ],
        multiSelect: false
      },
      {
        question: "Which features?",
        header: "Features",
        options: [
          { label: "Search", description: "", preview: "[ search… ]" },
          { label: "Export", description: "" }
        ],
        multiSelect: true
      }
    ]
  };

  it("carries an option's preview, tagged with the format the session asked for", () => {
    const parsed = parseAskUserQuestionInput(input);
    const [sidebar, top, none] = parsed.questions[0]!.options;
    assert.deepEqual(sidebar, {
      label: "Sidebar (Recommended)",
      description: "Nav on the left",
      preview: "┌──┬──────┐\n│ ▤│ main │\n└──┴──────┘",
      previewFormat: CLAUDE_QUESTION_PREVIEW_FORMAT
    });
    assert.equal(CLAUDE_QUESTION_PREVIEW_FORMAT, "markdown");
    assert.equal(top!.preview, "┌─────────┐\n│ ▤ ▤ ▤   │\n└─────────┘");
    assert.deepEqual(none, { label: "None", description: "No navigation" }, "no preview, no format");
  });

  it("drops a preview of any other shape, and an empty one, but keeps the option", () => {
    const parsed = parseAskUserQuestionInput({
      questions: [
        {
          question: "Pick?",
          options: [
            { label: "A", description: "", preview: { html: "<b>A</b>" } },
            { label: "B", description: "", preview: "" },
            { label: "C", description: "", preview: 3 }
          ]
        }
      ]
    });
    assert.deepEqual(parsed.questions[0]!.options, [
      { label: "A", description: "" },
      { label: "B", description: "" },
      { label: "C", description: "" }
    ]);
  });

  it("sends the chosen option's preview back as `annotations`, keyed by question text", () => {
    const reply = buildAskUserQuestionReply(input, {
      "Which layout?": "Sidebar (Recommended)",
      "Which features?": ["Search"]
    });
    assert.deepEqual(reply.answers, { "Which layout?": "Sidebar (Recommended)", "Which features?": ["Search"] });
    assert.deepEqual(reply.annotations, {
      "Which layout?": { preview: "┌──┬──────┐\n│ ▤│ main │\n└──┴──────┘" }
    }, "single-select only: the tool supports previews on single-select questions alone");
    assert.deepEqual(reply.questions, input.questions, "the original questions ride back untouched");
  });

  it("annotates nothing for a typed answer or an option without a preview", () => {
    assert.equal("annotations" in buildAskUserQuestionReply(input, { "Which layout?": "Something else" }), false);
    assert.equal("annotations" in buildAskUserQuestionReply(input, { "Which layout?": "None" }), false);
    assert.equal("annotations" in buildAskUserQuestionReply(input, {}), false);
  });
});
