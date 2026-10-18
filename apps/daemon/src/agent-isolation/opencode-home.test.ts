import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { OPENCODE_TEST_HOME_ENV, opencodeHomeConfigItems, probeOpencodeTestHome } from "./opencode-home.ts";

const FAKE = fileURLToPath(new URL("./testing/fake-opencode-debug-config.mjs", import.meta.url));

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orq-opencode-home-"));
  roots.push(root);
  return root;
}

async function write(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

describe("opencodeHomeConfigItems", () => {
  it("names the config files and non-empty item dirs of ~/.opencode that OpenCode would load", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const dot = join(home, ".opencode");
    await write(join(dot, "opencode.json"), "{}");
    await write(join(dot, "command", "x.md"), "x");
    await write(join(dot, "agents", "a.md"), "a");
    await write(join(dot, "plugin", "p.js"), "p");
    await mkdir(join(dot, "skills"), { recursive: true }); // empty: loads nothing
    await write(join(root, "shared-tools", "t.ts"), "t");
    await symlink(join(root, "shared-tools"), join(dot, "tools")); // a symlinked item dir counts
    await symlink(join(root, "gone.jsonc"), join(dot, "opencode.jsonc")); // dangling: nothing to load
    // What OpenCode or its installer writes there by itself is not config.
    await write(join(dot, "bin", "opencode"), "bin");
    await write(join(dot, "package.json"), "{}");
    await write(join(dot, "node_modules", "x", "index.js"), "x");
    await write(join(dot, ".gitignore"), "x");
    await write(join(dot, "bun.lock"), "x");
    assert.deepEqual(await opencodeHomeConfigItems(home), ["agents/", "command/", "opencode.json", "plugin/", "tools/"]);
  });

  it("answers nothing for a home without ~/.opencode, or with only non-config entries", async () => {
    const root = await tempRoot();
    assert.deepEqual(await opencodeHomeConfigItems(join(root, "none")), []);
    await write(join(root, "bin-only", ".opencode", "bin", "opencode"), "bin");
    assert.deepEqual(await opencodeHomeConfigItems(join(root, "bin-only")), []);
  });
});

describe("probeOpencodeTestHome", () => {
  const probe = async (flags: string[], timeoutMs = 60_000) => {
    const root = await tempRoot();
    const scratchDir = join(root, "scratch");
    const result = await probeOpencodeTestHome({ opencodeBin: process.execPath, args: [FAKE, ...flags], scratchDir, timeoutMs });
    assert.deepEqual(await readdir(root), [], "the scratch dir is removed");
    return result;
  };

  it("names the variable it probes", () => {
    assert.equal(OPENCODE_TEST_HOME_ENV, "OPENCODE_TEST_HOME");
  });

  it("is effective when the canary loads without the override and not with it", async () => {
    assert.deepEqual(await probe([]), { effective: true });
  });

  it("is not effective for an OpenCode that ignores the variable", async () => {
    const result = await probe(["--ignore-test-home"]);
    assert.equal(result.effective, false);
    assert.match(!result.effective ? result.reason : "", /still loads ~\/\.opencode/);
  });

  it("is inconclusive (not effective) when the control run does not load ~/.opencode", async () => {
    const result = await probe(["--no-home-config"]);
    assert.equal(result.effective, false);
    assert.match(!result.effective ? result.reason : "", /control/);
  });

  it("is not effective when OpenCode fails, prints no JSON or hangs", async () => {
    const failed = await probe(["--exit=3"]);
    assert.match(!failed.effective ? failed.reason : "", /exited with code 3: boom/);
    const garbage = await probe(["--garbage"]);
    assert.match(!garbage.effective ? garbage.reason : "", /did not print JSON/);
    const hung = await probe(["--hang"], 300);
    assert.match(!hung.effective ? hung.reason : "", /timed out/);
  });

  it("is not effective for a binary that cannot start", async () => {
    const root = await tempRoot();
    const result = await probeOpencodeTestHome({ opencodeBin: "/nonexistent/opencode", scratchDir: join(root, "scratch") });
    assert.equal(result.effective, false);
  });
});
