/**
 * `claudeSettingsNodeOptions` for a box chat (Ephemeral AI VMs §8.5): the project's settings files
 * live in the box — the host directory is an empty stub — so they are read through the box's
 * filesystem, while the user file stays the host account home's (the source of truth the box's
 * copy is synced from).
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ClaudeNamesFs } from "../../../agent-isolation/claude-names.ts";
import { claudeSettingsNodeOptions } from "./session.ts";

/** A read-only filesystem over a map of path → text, recording every path read. */
function mapFs(files: Record<string, string>): ClaudeNamesFs & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    stat: async (path: string) => (path in files ? ({ kind: "file", size: files[path]!.length } as never) : null),
    readdir: async () => [],
    read: async (path: string) => {
      reads.push(path);
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return Buffer.from(text, "utf8");
    }
  } as ClaudeNamesFs & { reads: string[] };
}

test("a box chat reads the project's settings in the box and the user's on the host", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "orq-claude-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "settings.json"), JSON.stringify({ env: { NODE_OPTIONS: "--user" } }));
  const project = "/var/lib/orquester/workspaces/ws/boxproj";
  const box = mapFs({
    [join(project, ".claude", "settings.json")]: JSON.stringify({ env: { NODE_OPTIONS: "--from-box-project" } })
  });

  const value = await claudeSettingsNodeOptions({ CLAUDE_CONFIG_DIR: home }, project, false, box);

  // user < project < local: the box's project file wins over the host user file.
  assert.equal(value, "--from-box-project");
  assert.deepEqual(box.reads.sort(), [join(project, ".claude", "settings.json"), join(project, ".claude", "settings.local.json")].sort());
  assert.ok(!box.reads.includes(join(home, "settings.json")), "the user file is never read from the box");
});

test("without a box filesystem the project files are read on the host, as before", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orq-claude-proj-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "proj");
  await mkdir(home, { recursive: true });
  await mkdir(join(project, ".claude"), { recursive: true });
  await writeFile(join(home, "settings.json"), JSON.stringify({ env: { NODE_OPTIONS: "--user" } }));
  await writeFile(join(project, ".claude", "settings.local.json"), JSON.stringify({ env: { NODE_OPTIONS: "--local" } }));

  assert.equal(await claudeSettingsNodeOptions({ CLAUDE_CONFIG_DIR: home }, project, false), "--local");
  // A profile chat carries the user's at the flag tier, so there it wins.
  assert.equal(await claudeSettingsNodeOptions({ CLAUDE_CONFIG_DIR: home }, project, true), "--user");
});
