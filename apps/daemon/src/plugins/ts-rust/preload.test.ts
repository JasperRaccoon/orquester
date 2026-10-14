// The tsc-rs preload (spec §3.2, §9), run for real: child Node processes with
// NODE_OPTIONS=--require <preload> against a fake appdir and workspaces root, a
// shell-script stand-in for tsc-rs, and fake `typescript` packages whose `tsc`
// prints "real tsc".

import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";

import { appendNodeRequireOption, pluginsConfigPath, tsRustPluginDir, tsRustPreloadPath } from "@orquester/config";

import { renderTsRustPreload, writeTsRustPreload } from "./preload.ts";

const VERSION = "0.7.0";
const posix = process.platform !== "win32";

let root = "";
let appdir = "";
let workspaces = "";
let preload = "";
/** `<ws>/enabled/app`: a project with an npm-style node_modules. */
let enabledProject = "";
/** `<ws>/disabled/app`: the same layout in a workspace the plugin is off for. */
let disabledProject = "";
/** `<ws>/enabled/pnpm-app`: node_modules/typescript links into a store outside the root. */
let pnpmProject = "";
/** A typescript package outside the workspaces root (an npx cache). */
let outsideTypescript = "";

const STUB_TSC_RS = `#!/bin/sh
printf 'tsc-rs %s\\n' "$*"
printf 'cwd %s\\n' "$PWD"
printf 'node-options %s\\n' "$NODE_OPTIONS"
if [ -n "$STUB_SIGNAL" ]; then kill -"$STUB_SIGNAL" $$; fi
exit "\${STUB_EXIT:-0}"
`;

/** A fake `typescript` package: bin/tsc → lib/tsc.js prints "real tsc <args>"; main exports its name. */
async function writeTypescriptPackage(dir: string): Promise<void> {
  await mkdir(join(dir, "bin"), { recursive: true });
  await mkdir(join(dir, "lib"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "typescript", version: "5.9.3", main: "lib/typescript.js" }));
  await writeFile(join(dir, "lib", "typescript.js"), 'module.exports = { version: "5.9.3" };\n');
  await writeFile(
    join(dir, "lib", "tsc.js"),
    'process.stdout.write("real tsc " + process.argv.slice(2).join(" ") + "\\n");\n'
  );
  await writeFile(join(dir, "bin", "tsc"), '#!/usr/bin/env node\nrequire("../lib/tsc.js");\n', { mode: 0o755 });
}

/** npm-style project: node_modules/typescript plus a node_modules/.bin/tsc symlink. */
async function writeNpmProject(project: string): Promise<void> {
  await writeTypescriptPackage(join(project, "node_modules", "typescript"));
  await mkdir(join(project, "node_modules", ".bin"), { recursive: true });
  await symlink("../typescript/bin/tsc", join(project, "node_modules", ".bin", "tsc"));
  await writeFile(join(project, "other.js"), 'process.stdout.write("other " + process.argv.slice(2).join(" ") + "\\n");\n');
  await mkdir(join(project, "scripts"), { recursive: true });
  await writeFile(join(project, "scripts", "tsc"), 'process.stdout.write("project script\\n");\n');
  await writeFile(
    join(project, "uses-api.js"),
    'process.stdout.write("api " + require("typescript").version + "\\n");\n'
  );
}

async function writeState(state: unknown): Promise<void> {
  await writeFile(pluginsConfigPath(appdir), typeof state === "string" ? state : JSON.stringify(state));
}

function enabledState(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    plugins: {
      "ts-rust": {
        enabledWorkspaces: ["enabled"],
        current: { version: VERSION, integrity: "sha512-x", installedAt: "2026-10-14T00:00:00.000Z" },
        ...overrides
      }
    }
  };
}

function runNode(
  script: string,
  args: string[] = [],
  options: { cwd?: string; env?: Record<string, string>; nodeOptions?: string } = {}
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? root,
      NODE_OPTIONS: appendNodeRequireOption(options.nodeOptions, preload),
      ...options.env
    }
  });
}

function assertRedirected(result: SpawnSyncReturns<string>, args: string): void {
  assert.equal(result.stderr, "", "no output on stderr");
  assert.match(result.stdout, new RegExp(`^tsc-rs ${args}\\n`), "tsc-rs ran with the arguments");
  assert.doesNotMatch(result.stdout, /real tsc/, "the real tsc did not run");
  assert.equal(result.status, 0);
}

function assertRealTsc(result: SpawnSyncReturns<string>, args: string): void {
  assert.equal(result.stdout, `real tsc ${args}\n`);
  assert.equal(result.status, 0);
}

describe("tsc-rs preload", { skip: posix ? false : "the stand-in tsc-rs is a shell script" }, () => {
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "orq-tsrs-preload-"));
    appdir = join(root, "appdir");
    workspaces = join(root, "workspaces");
    preload = tsRustPreloadPath(appdir);
    enabledProject = join(workspaces, "enabled", "app");
    disabledProject = join(workspaces, "disabled", "app");
    pnpmProject = join(workspaces, "enabled", "pnpm-app");
    outsideTypescript = join(root, "npx-cache", "node_modules", "typescript");

    await mkdir(dirname(pluginsConfigPath(appdir)), { recursive: true });
    const binary = join(tsRustPluginDir(appdir), "versions", VERSION, "tsc");
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, STUB_TSC_RS, { mode: 0o755 });

    await writeNpmProject(enabledProject);
    await writeNpmProject(disabledProject);
    // pnpm: the project's node_modules/typescript is a symlink into a store
    // OUTSIDE the workspaces root (its global virtual store), as is .bin's target.
    const store = join(root, "pnpm-store", "typescript@5.9.3", "node_modules", "typescript");
    await writeTypescriptPackage(store);
    await mkdir(join(pnpmProject, "node_modules"), { recursive: true });
    await symlink(store, join(pnpmProject, "node_modules", "typescript"));
    await writeTypescriptPackage(outsideTypescript);

    await writeTsRustPreload(preload, { statePath: pluginsConfigPath(appdir), workspacesRoot: workspaces });
    await writeState(enabledState());
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("the written preload is the rendered source, mode 0644", async () => {
    assert.equal(
      await readFile(preload, "utf8"),
      renderTsRustPreload({ statePath: pluginsConfigPath(appdir), workspacesRoot: workspaces })
    );
    assert.equal((await stat(preload)).mode & 0o777, 0o644);
  });

  test("tsc through node_modules/.bin, bin/tsc and lib/tsc.js runs tsc-rs in an enabled workspace", () => {
    const modules = join(enabledProject, "node_modules");
    for (const script of [join(modules, ".bin", "tsc"), join(modules, "typescript", "bin", "tsc"), join(modules, "typescript", "lib", "tsc.js")]) {
      const result = runNode(script, ["-p", "tsconfig.json", "--noEmit"], { cwd: enabledProject });
      assertRedirected(result, "-p tsconfig.json --noEmit");
      assert.match(result.stdout, new RegExp(`\\ncwd ${enabledProject}\\n`), "tsc-rs ran in the same cwd");
    }
  });

  test("tsc in a workspace the plugin is off for runs the real tsc", () => {
    const modules = join(disabledProject, "node_modules");
    for (const script of [join(modules, ".bin", "tsc"), join(modules, "typescript", "bin", "tsc"), join(modules, "typescript", "lib", "tsc.js")]) {
      assertRealTsc(runNode(script, ["--noEmit"], { cwd: disabledProject }), "--noEmit");
    }
  });

  test("a pnpm layout whose real path leaves the root resolves the workspace from the unresolved path", () => {
    const script = join(pnpmProject, "node_modules", "typescript", "bin", "tsc");
    // cwd in the disabled workspace: only argv[1] can name "enabled".
    assertRedirected(runNode(script, ["--noEmit"], { cwd: disabledProject }), "--noEmit");
  });

  test("a tsc outside the root uses the working directory's workspace", () => {
    const script = join(outsideTypescript, "bin", "tsc");
    assertRedirected(runNode(script, ["--version"], { cwd: enabledProject }), "--version");
    assertRealTsc(runNode(script, ["--version"], { cwd: disabledProject }), "--version");
    assertRealTsc(runNode(script, ["--version"], { cwd: root }), "--version");
  });

  test("non-tsc scripts and the typescript API are untouched", () => {
    const other = runNode(join(enabledProject, "other.js"), ["a"], { cwd: enabledProject });
    assert.equal(other.stdout, "other a\n");
    assert.equal(other.stderr, "");
    const named = runNode(join(enabledProject, "scripts", "tsc"), [], { cwd: enabledProject });
    assert.equal(named.stdout, "project script\n");
    const api = runNode(join(enabledProject, "uses-api.js"), [], { cwd: enabledProject });
    assert.equal(api.stdout, "api 5.9.3\n");
    const evaluated = spawnSync(process.execPath, ["-e", 'process.stdout.write("eval")'], {
      cwd: enabledProject,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", NODE_OPTIONS: appendNodeRequireOption(undefined, preload) }
    });
    assert.equal(evaluated.stdout, "eval");
    assert.equal(evaluated.stderr, "");
  });

  test("tsc-rs's exit code is the process's", () => {
    const script = join(enabledProject, "node_modules", "typescript", "bin", "tsc");
    const result = runNode(script, ["--noEmit"], { cwd: enabledProject, env: { STUB_EXIT: "3" } });
    assert.equal(result.status, 3);
    assert.match(result.stdout, /^tsc-rs --noEmit\n/);
  });

  test("a signal that ends tsc-rs ends the process with it", () => {
    const script = join(enabledProject, "node_modules", "typescript", "bin", "tsc");
    const result = runNode(script, [], { cwd: enabledProject, env: { STUB_SIGNAL: "TERM" } });
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.status, null);
    assert.doesNotMatch(result.stdout, /real tsc/);
  });

  test("an existing NODE_OPTIONS keeps working beside the preload and reaches tsc-rs", async () => {
    const other = join(root, "other-preload.cjs");
    await writeFile(other, 'process.stderr.write("other preload\\n");\n');
    const nodeOptions = `--require ${JSON.stringify(other)}`;
    const plain = runNode(join(enabledProject, "other.js"), [], { cwd: enabledProject, nodeOptions });
    assert.equal(plain.stderr, "other preload\n");
    assert.equal(plain.stdout, "other \n");
    const tsc = runNode(join(enabledProject, "node_modules", "typescript", "bin", "tsc"), [], { cwd: enabledProject, nodeOptions });
    assert.equal(tsc.stderr, "other preload\n");
    assert.match(tsc.stdout, /^tsc-rs \n/);
    assert.match(tsc.stdout, new RegExp(`\\nnode-options ${appendNodeRequireOption(nodeOptions, preload).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
  });

  describe("falls back to the real tsc", () => {
    const script = (): string => join(enabledProject, "node_modules", "typescript", "bin", "tsc");

    after(async () => {
      await writeState(enabledState());
    });

    test("when the current version's binary is missing, with one stderr line", async () => {
      await writeState(enabledState({ current: { version: "9.9.9", integrity: "sha512-x", installedAt: "x" } }));
      const result = runNode(script(), ["--noEmit"], { cwd: enabledProject });
      assert.equal(result.stderr, "orquester: tsc-rs failed to start (ENOENT); running tsc\n");
      assertRealTsc(result, "--noEmit");
    });

    test("when the binary cannot be executed, with one stderr line", async () => {
      const binary = join(tsRustPluginDir(appdir), "versions", "0.0.1", "tsc");
      await mkdir(dirname(binary), { recursive: true });
      await writeFile(binary, STUB_TSC_RS, { mode: 0o644 });
      await chmod(binary, 0o644);
      await writeState(enabledState({ current: { version: "0.0.1", integrity: "sha512-x", installedAt: "x" } }));
      const result = runNode(script(), ["--noEmit"], { cwd: enabledProject });
      assert.equal(result.stderr, "orquester: tsc-rs failed to start (EACCES); running tsc\n");
      assertRealTsc(result, "--noEmit");
    });

    test("when nothing is installed yet", async () => {
      await writeState(enabledState({ current: undefined }));
      const result = runNode(script(), [], { cwd: enabledProject });
      assert.equal(result.stderr, "");
      assertRealTsc(result, "");
    });

    test("when plugins.json is corrupt or missing", async () => {
      await writeState("{ not json");
      const corrupt = runNode(script(), [], { cwd: enabledProject });
      assert.equal(corrupt.stderr, "");
      assertRealTsc(corrupt, "");
      await rm(pluginsConfigPath(appdir));
      const missing = runNode(script(), [], { cwd: enabledProject });
      assert.equal(missing.stderr, "");
      assertRealTsc(missing, "");
    });

    test("when plugins.json has the wrong shapes", async () => {
      for (const state of [
        { plugins: { "ts-rust": { enabledWorkspaces: "enabled", current: { version: VERSION } } } },
        { plugins: { "ts-rust": { enabledWorkspaces: ["enabled"], current: { version: 7 } } } },
        { plugins: { "ts-rust": "on" } },
        { plugins: null },
        []
      ]) {
        await writeState(state);
        const result = runNode(script(), [], { cwd: enabledProject });
        assert.equal(result.stderr, "", JSON.stringify(state));
        assertRealTsc(result, "");
      }
    });

    test("when the version string could leave the versions dir", async () => {
      // A binary the unsafe version would reach if it were joined as is.
      const escaped = join(tsRustPluginDir(appdir), VERSION, "tsc");
      await mkdir(dirname(escaped), { recursive: true });
      await writeFile(escaped, STUB_TSC_RS, { mode: 0o755 });
      for (const version of [`../${VERSION}`, `..`, `a/b`, `a\\b`, `.hidden`, ""]) {
        await writeState(enabledState({ current: { version, integrity: "sha512-x", installedAt: "x" } }));
        const result = runNode(script(), [], { cwd: enabledProject });
        assert.equal(result.stderr, "", version);
        assertRealTsc(result, "");
      }
    });
  });
});
