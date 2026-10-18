import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildXdgConfigShadow } from "./xdg-shadow.ts";

describe("buildXdgConfigShadow", () => {
  let root: string;
  let real: string;
  let shadow: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "xdg-shadow-"));
    real = join(root, "home", ".config");
    shadow = join(root, "profile", "xdg");
    await mkdir(join(real, "opencode"), { recursive: true });
    await writeFile(join(real, "opencode", "opencode.json"), "{}");
    await mkdir(join(real, "gh"), { recursive: true });
    await writeFile(join(real, "gh", "hosts.yml"), "github.com: {}\n");
    await mkdir(join(real, "git"), { recursive: true });
    await writeFile(join(real, "user-dirs.dirs"), "x");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function snapshotReal(): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(real, { recursive: true })) out.push(String(entry));
    return out.sort();
  }

  it("links every real entry except the excluded ones, in a 0700 directory", async () => {
    const before = await snapshotReal();
    const result = await buildXdgConfigShadow({ realConfigHome: real, shadowDir: shadow, exclude: ["opencode"] });
    assert.deepEqual(result, { linked: ["gh", "git", "user-dirs.dirs"], removed: [], shadowed: [] });
    assert.deepEqual((await readdir(shadow)).sort(), ["gh", "git", "user-dirs.dirs"]);
    for (const name of ["gh", "git", "user-dirs.dirs"]) {
      assert.equal(await readlink(join(shadow, name)), join(real, name));
    }
    assert.equal(await readFile(join(shadow, "gh", "hosts.yml"), "utf8"), "github.com: {}\n");
    assert.equal((await stat(shadow)).mode & 0o777, 0o700);
    assert.deepEqual(await snapshotReal(), before, "the real directory is untouched");
  });

  it("is idempotent", async () => {
    await buildXdgConfigShadow({ realConfigHome: real, shadowDir: shadow, exclude: ["opencode"] });
    const again = await buildXdgConfigShadow({ realConfigHome: real, shadowDir: shadow, exclude: ["opencode"] });
    assert.deepEqual(again, { linked: [], removed: [], shadowed: [] });
  });

  it("refreshes: links new entries, removes stale and newly excluded links, retargets wrong ones", async () => {
    await buildXdgConfigShadow({ realConfigHome: real, shadowDir: shadow, exclude: ["opencode"] });
    await rm(join(real, "user-dirs.dirs"));
    await mkdir(join(real, "nvim"));
    await rm(join(shadow, "git"));
    await symlink(join(root, "somewhere-else"), join(shadow, "git"));
    const result = await buildXdgConfigShadow({ realConfigHome: real, shadowDir: shadow, exclude: ["opencode", "gh"] });
    assert.deepEqual(result, { linked: ["git", "nvim"], removed: ["gh", "user-dirs.dirs"], shadowed: [] });
    assert.deepEqual((await readdir(shadow)).sort(), ["git", "nvim"]);
    assert.equal(await readlink(join(shadow, "git")), join(real, "git"));
  });

  it("leaves a real entry a tool created in the shadow alone", async () => {
    await mkdir(join(shadow, "gh"), { recursive: true });
    await writeFile(join(shadow, "gh", "config.yml"), "mine");
    await mkdir(join(shadow, "newtool"));
    const result = await buildXdgConfigShadow({ realConfigHome: real, shadowDir: shadow, exclude: ["opencode"] });
    assert.deepEqual(result.shadowed, ["gh"]);
    assert.ok((await lstat(join(shadow, "gh"))).isDirectory());
    assert.equal(await readFile(join(shadow, "gh", "config.yml"), "utf8"), "mine");
    assert.ok((await lstat(join(shadow, "newtool"))).isDirectory());
  });

  it("never links an excluded entry, even when it is the only one", async () => {
    await rm(join(real, "gh"), { recursive: true });
    await rm(join(real, "git"), { recursive: true });
    await rm(join(real, "user-dirs.dirs"));
    await buildXdgConfigShadow({ realConfigHome: real, shadowDir: shadow, exclude: ["opencode"] });
    assert.deepEqual(await readdir(shadow), []);
  });

  it("builds an empty shadow when the real directory does not exist", async () => {
    const result = await buildXdgConfigShadow({ realConfigHome: join(root, "nope"), shadowDir: shadow, exclude: ["opencode"] });
    assert.deepEqual(result, { linked: [], removed: [], shadowed: [] });
    assert.deepEqual(await readdir(shadow), []);
  });

  it("refuses a shadow inside the real directory, and relative paths", async () => {
    await assert.rejects(
      buildXdgConfigShadow({ realConfigHome: real, shadowDir: join(real, "shadow"), exclude: ["opencode"] }),
      /must not overlap/
    );
    await assert.rejects(buildXdgConfigShadow({ realConfigHome: real, shadowDir: real, exclude: [] }), /must not overlap/);
    await assert.rejects(buildXdgConfigShadow({ realConfigHome: "rel", shadowDir: shadow, exclude: [] }), /absolute/);
    assert.deepEqual((await readdir(real)).sort(), ["gh", "git", "opencode", "user-dirs.dirs"]);
  });
});
