import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { generateClaudeLocalPlugin } from "./claude-plugin.ts";

describe("generateClaudeLocalPlugin", () => {
  let root: string;
  let pluginDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "claude-plugin-"));
    pluginDir = join(root, "prepared", "claude", "plugin");
    await mkdir(join(root, "src", "pdf", "scripts"), { recursive: true });
    await writeFile(join(root, "src", "pdf", "SKILL.md"), "---\nname: pdf\ndescription: PDFs\n---\nBody\n");
    await writeFile(join(root, "src", "pdf", "scripts", "run.sh"), "#!/bin/sh\n");
    await symlink("/etc/passwd", join(root, "src", "pdf", "leak"));
    // A skill whose source is itself a symlink (the host links skill directories).
    await mkdir(join(root, "real-review"), { recursive: true });
    await writeFile(join(root, "real-review", "SKILL.md"), "---\nname: code-review\ndescription: r\n---\n");
    await symlink(join(root, "real-review"), join(root, "src", "code-review"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const input = () => ({
    dir: pluginDir,
    name: "orquester-profile",
    skills: [
      { name: "pdf", sourceDir: join(root, "src", "pdf") },
      { name: "code-review", sourceDir: join(root, "src", "code-review") }
    ],
    commands: [
      { name: "deploy", markdown: "---\ndescription: Deploy\n---\nDeploy $ARGUMENTS\n" },
      { name: "git/pr", markdown: "Open a PR\n" }
    ]
  });

  it("writes a valid plugin layout and returns Claude's ids", async () => {
    const result = await generateClaudeLocalPlugin(input());
    assert.deepEqual(result, {
      path: pluginDir,
      name: "orquester-profile",
      skillIds: ["orquester-profile:pdf", "orquester-profile:code-review"],
      commandIds: ["orquester-profile:deploy", "orquester-profile:git:pr"],
      allowlist: [
        "orquester-profile:pdf",
        "orquester-profile:code-review",
        "orquester-profile:deploy",
        "orquester-profile:git:pr"
      ]
    });
    const manifest = JSON.parse(await readFile(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8")) as Record<string, unknown>;
    assert.equal(manifest.name, "orquester-profile");
    assert.equal(typeof manifest.description, "string");
    assert.deepEqual((await readdir(pluginDir)).sort(), [".claude-plugin", "commands", "skills"]);
    assert.equal(await readFile(join(pluginDir, "skills", "pdf", "SKILL.md"), "utf8"), "---\nname: pdf\ndescription: PDFs\n---\nBody\n");
    assert.equal(await readFile(join(pluginDir, "skills", "pdf", "scripts", "run.sh"), "utf8"), "#!/bin/sh\n");
    // A symlink inside a skill is not carried into the plugin.
    await assert.rejects(lstat(join(pluginDir, "skills", "pdf", "leak")));
    // A symlinked skill source is copied as a real directory.
    assert.ok((await lstat(join(pluginDir, "skills", "code-review"))).isDirectory());
    assert.equal(await readFile(join(pluginDir, "commands", "deploy.md"), "utf8"), "---\ndescription: Deploy\n---\nDeploy $ARGUMENTS\n");
    assert.equal(await readFile(join(pluginDir, "commands", "git", "pr.md"), "utf8"), "Open a PR\n");
  });

  it("replaces a previous generation as a whole and leaves no staging behind", async () => {
    await generateClaudeLocalPlugin(input());
    const result = await generateClaudeLocalPlugin({ ...input(), skills: [], commands: [{ name: "only", markdown: "x" }] });
    assert.deepEqual(result.allowlist, ["orquester-profile:only"]);
    assert.deepEqual((await readdir(pluginDir)).sort(), [".claude-plugin", "commands"]);
    assert.deepEqual(await readdir(join(pluginDir, "commands")), ["only.md"]);
    assert.deepEqual(await readdir(join(root, "prepared", "claude")), ["plugin"]);
  });

  it("writes an empty plugin (manifest only) for an empty kit", async () => {
    const result = await generateClaudeLocalPlugin({ dir: pluginDir, name: "p", skills: [], commands: [] });
    assert.deepEqual(result.allowlist, []);
    assert.deepEqual(await readdir(pluginDir), [".claude-plugin"]);
  });

  it("refuses bad names, clashing ids and a skill without SKILL.md, keeping the previous plugin", async () => {
    await generateClaudeLocalPlugin(input());
    await assert.rejects(generateClaudeLocalPlugin({ ...input(), name: "bad:name" }), /plugin name/);
    await assert.rejects(generateClaudeLocalPlugin({ ...input(), name: "a b" }), /plugin name/);
    await assert.rejects(
      generateClaudeLocalPlugin({ ...input(), skills: [{ name: "Bad_Name", sourceDir: join(root, "src", "pdf") }] }),
      /skill name/
    );
    await assert.rejects(generateClaudeLocalPlugin({ ...input(), commands: [{ name: "../x", markdown: "" }] }), /command name/);
    await assert.rejects(
      generateClaudeLocalPlugin({ ...input(), commands: [{ name: "pdf", markdown: "" }] }),
      /both be named "orquester-profile:pdf"/
    );
    await assert.rejects(
      generateClaudeLocalPlugin({ ...input(), skills: [{ name: "empty", sourceDir: join(root, "nowhere") }] }),
      /no SKILL\.md/
    );
    assert.deepEqual((await readdir(pluginDir)).sort(), [".claude-plugin", "commands", "skills"]);
    assert.deepEqual(await readdir(join(root, "prepared", "claude")), ["plugin"]);
  });
});
