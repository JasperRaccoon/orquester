import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_PROJECT_EXECUTABLES,
  findProjectExecutables,
  parseDesktopEntry,
  scanDesktopEntries,
  stripFieldCodes
} from "./suggestions.ts";

test("Exec field codes are stripped, %% kept as %", () => {
  assert.equal(stripFieldCodes("gimp-2.10 %U"), "gimp-2.10");
  assert.equal(stripFieldCodes("blender %f --flag %F"), "blender --flag");
  assert.equal(stripFieldCodes("app --name=%c --icon %i %k"), "app --name= --icon");
  assert.equal(stripFieldCodes("printf 100%% done"), "printf 100% done");
});

test("desktop entry: Name/Exec/Icon from [Desktop Entry] only", () => {
  const entry = parseDesktopEntry(
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=GIMP",
      "Name[de]=GIMP-Bildbearbeitung",
      "Exec=gimp-2.10 %U",
      "Icon=gimp",
      "",
      "[Desktop Action new]",
      "Name=New Window",
      "Exec=gimp --new"
    ].join("\n"),
    "system"
  );
  assert.deepEqual(entry, { name: "GIMP", command: "gimp-2.10", icon: "gimp", source: "system" });
});

test("desktop entry: NoDisplay, Hidden, Terminal, non-Application and incomplete entries are skipped", () => {
  const base = "[Desktop Entry]\nType=Application\nName=X\nExec=x\n";
  assert.notEqual(parseDesktopEntry(base, "user"), null);
  assert.equal(parseDesktopEntry(`${base}NoDisplay=true\n`, "user"), null);
  assert.equal(parseDesktopEntry(`${base}Hidden=true\n`, "user"), null);
  assert.equal(parseDesktopEntry(`${base}Terminal=true\n`, "user"), null);
  assert.equal(parseDesktopEntry("[Desktop Entry]\nType=Link\nName=X\nExec=x\n", "user"), null);
  assert.equal(parseDesktopEntry("[Desktop Entry]\nName=X\n", "user"), null);
  assert.notEqual(parseDesktopEntry(`${base}Terminal=false\n`, "user"), null);
});

test("scan: a user file overrides (or hides) the system file of the same name", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orq-desktop-apps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const system = join(root, "system");
  const user = join(root, "user");
  await mkdir(system);
  await mkdir(user);
  await writeFile(join(system, "a.desktop"), "[Desktop Entry]\nName=Zed\nExec=zed %F\n");
  await writeFile(join(system, "b.desktop"), "[Desktop Entry]\nName=Beta\nExec=beta\n");
  await writeFile(join(system, "c.desktop"), "[Desktop Entry]\nName=Gamma\nExec=gamma\n");
  await writeFile(join(system, "notes.txt"), "ignored");
  await writeFile(join(user, "b.desktop"), "[Desktop Entry]\nName=Beta Mine\nExec=beta --mine\n");
  await writeFile(join(user, "c.desktop"), "[Desktop Entry]\nName=Gamma\nExec=gamma\nHidden=true\n");
  const entries = await scanDesktopEntries([
    { path: system, source: "system" },
    { path: user, source: "user" },
    { path: join(root, "missing"), source: "user" }
  ]);
  assert.deepEqual(entries, [
    { name: "Beta Mine", command: "beta --mine", icon: null, source: "user" },
    { name: "Zed", command: "zed", icon: null, source: "system" }
  ]);
});

test("project executables: root, bin/ and build/**/bin/ up to depth 4", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "orq-desktop-exec-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const exe = async (rel: string) => {
    await mkdir(join(project, rel, ".."), { recursive: true });
    await writeFile(join(project, rel), "#!/bin/sh\n", { mode: 0o755 });
  };
  await exe("run.sh");
  await writeFile(join(project, "README.md"), "not executable");
  await exe("bin/tool");
  await exe("build/linux/editor-install/bin/jasperengine-editor");
  await exe("build/bin/direct");
  await exe("build/a/b/c/bin/too-deep");
  await exe("build/linux/lib/not-in-bin");
  await exe("src/bin/not-under-build");
  await exe("build/.hidden/bin/hidden");
  await mkdir(join(project, "build/node_modules/x/bin"), { recursive: true });
  await writeFile(join(project, "build/node_modules/x/bin/nm"), "", { mode: 0o755 });
  await symlink(join(project, "build/linux"), join(project, "build/zz-link"));
  const found = await findProjectExecutables(project);
  assert.deepEqual(found.sort(), [
    "bin/tool",
    "build/bin/direct",
    "build/linux/editor-install/bin/jasperengine-editor",
    "run.sh"
  ]);
});

test("project executables are capped", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "orq-desktop-cap-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  for (let i = 0; i < MAX_PROJECT_EXECUTABLES + 10; i += 1) {
    await writeFile(join(project, `x${String(i).padStart(3, "0")}`), "", { mode: 0o755 });
  }
  assert.equal((await findProjectExecutables(project)).length, MAX_PROJECT_EXECUTABLES);
});
