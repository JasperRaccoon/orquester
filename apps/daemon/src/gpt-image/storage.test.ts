import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { GptImageError } from "./errors.ts";
import { plannedSave, saveIntoProject } from "./storage.ts";

async function workspace(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orq-gpt-image-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fsRoot = join(root, "workspaces");
  const project = join(fsRoot, "ws", "app");
  await mkdir(project, { recursive: true });
  const outside = join(root, "outside");
  await mkdir(outside);
  return { root, fsRoot, project, outside };
}

const CHAT = { kind: "chat" } as const;

test("concurrent saves of one name never collide: each gets its own -vN file with its own bytes", async (t) => {
  const { fsRoot, project } = await workspace(t);
  const target = plannedSave({ saveAs: "public/icon.png", setting: CHAT, projectPath: project, inBox: false });
  assert.equal(target.kind, "project");
  if (target.kind !== "project") return;
  const saves = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      saveIntoProject({ fsRoot, projectPath: project, target: target.target, prompt: "an icon", bytes: Buffer.from(`image ${index}`), ext: ".png" })
    )
  );
  const names = saves.map((save) => save.relativePath).sort();
  assert.deepEqual(names, ["public/icon-v2.png", "public/icon-v3.png", "public/icon-v4.png", "public/icon-v5.png", "public/icon-v6.png", "public/icon-v7.png", "public/icon-v8.png", "public/icon.png"]);
  const contents = await Promise.all(saves.map((save) => readFile(save.path, "utf8")));
  assert.equal(new Set(contents).size, 8, "every file holds the bytes of the call that created it");
});

test("an existing file is never overwritten, nor a symlink at the name followed", async (t) => {
  const { fsRoot, project, outside } = await workspace(t);
  await mkdir(join(project, "public"));
  await writeFile(join(project, "public", "icon.png"), "keep me");
  await symlink(join(outside, "victim.png"), join(project, "public", "icon-v2.png"));
  const saved = await saveIntoProject({ fsRoot, projectPath: project, target: "public/icon.png", prompt: "x", bytes: Buffer.from("new"), ext: ".png" });
  assert.equal(saved.relativePath, "public/icon-v3.png");
  assert.equal(await readFile(join(project, "public", "icon.png"), "utf8"), "keep me");
  assert.deepEqual(await readdir(outside), [], "nothing was written through the symlink");
});

test("save_as outside the project is refused before anything is generated", () => {
  const project = "/w/ws/app";
  for (const saveAs of ["../other/x.png", "/etc/x.png", "assets/../../x.png", "/w/ws/other/x.png"]) {
    assert.throws(() => plannedSave({ saveAs, setting: CHAT, projectPath: project, inBox: false }), (error: unknown) => error instanceof GptImageError && error.code === "INVALID_ARGUMENT", saveAs);
  }
  // An absolute path inside the project is the same as its relative spelling.
  assert.deepEqual(plannedSave({ saveAs: "/w/ws/app/assets/", setting: CHAT, projectPath: project, inBox: false }), { kind: "project", projectPath: project, target: "assets/" });
});

test("a folder that leads outside the project after realpath is refused and nothing is written there", async (t) => {
  const { fsRoot, project, outside } = await workspace(t);
  await symlink(outside, join(project, "escape"));
  await assert.rejects(
    saveIntoProject({ fsRoot, projectPath: project, target: "escape/sub/", prompt: "a cat", bytes: Buffer.from("x"), ext: ".png" }),
    (error: unknown) => error instanceof GptImageError && /outside/.test(error.message)
  );
  assert.deepEqual(await readdir(outside), [], "no folder or file was created outside");
});

test("a folder target is named from the prompt; the image's own extension wins", async (t) => {
  const { fsRoot, project } = await workspace(t);
  const folder = await saveIntoProject({ fsRoot, projectPath: project, target: "assets/generated/", prompt: "A dog in snow — très mignon, 4K!", bytes: Buffer.from("x"), ext: ".png" });
  assert.equal(folder.relativePath, "assets/generated/a-dog-in-snow-tres-mignon-4k.png");
  const renamed = await saveIntoProject({ fsRoot, projectPath: project, target: "icon.jpg", prompt: "x", bytes: Buffer.from("x"), ext: ".png" });
  assert.equal(renamed.relativePath, "icon.png");
  const long = await saveIntoProject({ fsRoot, projectPath: project, target: "./", prompt: "猫 ".repeat(5) + "an extraordinarily detailed watercolor painting of mountains", bytes: Buffer.from("x"), ext: ".png" });
  assert.ok(/^[a-z0-9-]{1,40}\.png$/.test(long.relativePath), long.relativePath);
});

test("no project, or a box chat: the image stays with the chat and the reason says why", () => {
  const project = { kind: "project", folder: "assets/generated" } as const;
  assert.deepEqual(plannedSave({ setting: CHAT, projectPath: "/w/ws/app", inBox: false }), { kind: "chat" });
  const none = plannedSave({ saveAs: "a.png", setting: CHAT, projectPath: "", inBox: false });
  assert.ok(none.kind === "chat" && /no project/.test(none.reason ?? ""));
  const box = plannedSave({ setting: project, projectPath: "/w/ws/app", inBox: true });
  assert.ok(box.kind === "chat" && /box/.test(box.reason ?? ""));
  assert.deepEqual(plannedSave({ setting: project, projectPath: "/w/ws/app", inBox: false }), { kind: "project", projectPath: "/w/ws/app", target: "assets/generated/" });
});
