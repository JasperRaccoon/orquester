// The engine preload (spec §3.2, §9), run for real: child Node processes with
// NODE_OPTIONS=--require <preload> against a fake appdir and workspaces root,
// shell-script stand-ins for tsc-rs and tsrs, and fake `typescript` packages
// whose `tsc` prints "real tsc". Most tests run tsc-rs (the preload's default
// engine when the daemon names none); "engine choice" covers tsrs.

import assert from "node:assert/strict";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  appendNodeRequireOption,
  pluginsConfigPath,
  tsRustPluginDir,
  tsRustPreloadPath,
  tsrsEngineDir
} from "@orquester/config";

import { writeTsRustPreload } from "./preload.ts";

const VERSION = "0.7.0";
const TSRS_VERSION = "0.16.0-ts7.1.0-dev.20260929";
const posix = process.platform !== "win32";

let root = "";
let appdir = "";
let workspaces = "";
let preload = "";
/** `<ws>/enabled/app`: a project with an npm-style node_modules. */
let enabledProject = "";
/** `<ws>/other/app`: the same layout in another workspace. */
let otherProject = "";
/** `<ws>/enabled/pnpm-app`: node_modules/typescript links into a store outside the root. */
let pnpmProject = "";
/** A typescript package outside the workspaces root (an npx cache). */
let outsideTypescript = "";
/** `<ws>/enabled/ts7-app`: typescript 7 (an ES module bin/tsc upstream, so never skipped). */
let ts7Project = "";
/** A symlink to the workspaces root: the root as configured, when it is not the real path. */
let linkedWorkspaces = "";

// STUB_BLOCK=<file>: wait until SIGTERM, record it in <file>, then die by it.
const STUB_TSC_RS = `#!/bin/sh
printf 'tsc-rs %s\\n' "$*"
printf 'cwd %s\\n' "$PWD"
printf 'node-options %s\\n' "$NODE_OPTIONS"
if [ -n "$STUB_SIGNAL" ]; then kill -"$STUB_SIGNAL" $$; fi
if [ -n "$STUB_BLOCK" ]; then
  trap 'printf term > "$STUB_BLOCK"; kill "$sleeper"; trap - TERM; kill -TERM $$' TERM
  sleep 1000 &
  sleeper=$!
  printf 'ready %s\\n' "$$"
  wait "$sleeper"
fi
exit "\${STUB_EXIT:-0}"
`;

const STUB_TSRS = `#!/bin/sh
printf 'tsrs %s\\n' "$*"
exit "\${STUB_EXIT:-0}"
`;

/**
 * A fake `typescript` package: bin/tsc → lib/tsc.js prints "real tsc <args>" (and
 * writes $REAL_TSC_MARKER when set); main exports its version.
 */
async function writeTypescriptPackage(dir: string, version = "5.9.3"): Promise<void> {
  await mkdir(join(dir, "bin"), { recursive: true });
  await mkdir(join(dir, "lib"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "typescript", version, main: "lib/typescript.js" }));
  await writeFile(join(dir, "lib", "typescript.js"), `module.exports = { version: ${JSON.stringify(version)} };\n`);
  await writeFile(
    join(dir, "lib", "tsc.js"),
    [
      'if (process.env.REAL_TSC_MARKER) require("fs").writeFileSync(process.env.REAL_TSC_MARKER, "ran");',
      'process.stdout.write("real tsc " + process.argv.slice(2).join(" ") + "\\n");',
      ""
    ].join("\n")
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
        enabled: true,
        current: { version: VERSION, integrity: "sha512-x", installedAt: "2026-10-14T00:00:00.000Z" },
        ...overrides
      }
    }
  };
}

function runNode(
  script: string,
  args: string[] = [],
  options: { cwd?: string; env?: Record<string, string>; nodeOptions?: string; preload?: string } = {}
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: childEnv(options)
  });
}

function childEnv(options: { env?: Record<string, string>; nodeOptions?: string; preload?: string }): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? root,
    NODE_OPTIONS: appendNodeRequireOption(options.nodeOptions, options.preload ?? preload),
    ...options.env
  };
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
    otherProject = join(workspaces, "other", "app");
    pnpmProject = join(workspaces, "enabled", "pnpm-app");
    outsideTypescript = join(root, "npx-cache", "node_modules", "typescript");
    ts7Project = join(workspaces, "enabled", "ts7-app");
    linkedWorkspaces = join(root, "workspaces-link");

    await mkdir(dirname(pluginsConfigPath(appdir)), { recursive: true });
    const binary = join(tsRustPluginDir(appdir), "versions", VERSION, "tsc");
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, STUB_TSC_RS, { mode: 0o755 });

    await writeNpmProject(enabledProject);
    await writeNpmProject(otherProject);
    // pnpm: the project's node_modules/typescript is a symlink into a store
    // OUTSIDE the workspaces root (its global virtual store), as is .bin's target.
    const store = join(root, "pnpm-store", "typescript@5.9.3", "node_modules", "typescript");
    await writeTypescriptPackage(store);
    await mkdir(join(pnpmProject, "node_modules"), { recursive: true });
    await symlink(store, join(pnpmProject, "node_modules", "typescript"));
    await writeTypescriptPackage(outsideTypescript);
    await writeTypescriptPackage(join(ts7Project, "node_modules", "typescript"), "7.1.0");
    await symlink(workspaces, linkedWorkspaces);

    await writeTsRustPreload(preload, { statePath: pluginsConfigPath(appdir), workspacesRoot: workspaces });
    await writeState(enabledState());
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("tsc through node_modules/.bin, bin/tsc and lib/tsc.js runs tsc-rs in every workspace while the plugin is on", async () => {
    assert.equal((await stat(preload)).mode & 0o777, 0o644);
    for (const project of [enabledProject, otherProject]) {
      const modules = join(project, "node_modules");
      for (const script of [join(modules, ".bin", "tsc"), join(modules, "typescript", "bin", "tsc"), join(modules, "typescript", "lib", "tsc.js")]) {
        const result = runNode(script, ["-p", "tsconfig.json", "--noEmit"], { cwd: project });
        assertRedirected(result, "-p tsconfig.json --noEmit");
        assert.match(result.stdout, new RegExp(`\\ncwd ${project}\\n`), "tsc-rs ran in the same cwd");
      }
    }
  });

  test("tsc runs the real tsc while the plugin is off, including a per-workspace record not yet turned on", async () => {
    const current = { version: VERSION, integrity: "sha512-x", installedAt: "x" };
    const modules = join(enabledProject, "node_modules");
    try {
      for (const record of [{ current }, { enabled: false, current }, { enabledWorkspaces: ["enabled"], current }]) {
        await writeState({ version: 1, plugins: { "ts-rust": record } });
        for (const script of [join(modules, ".bin", "tsc"), join(modules, "typescript", "bin", "tsc"), join(modules, "typescript", "lib", "tsc.js")]) {
          assertRealTsc(runNode(script, ["--noEmit"], { cwd: enabledProject }), "--noEmit");
        }
      }
    } finally {
      await writeState(enabledState());
    }
  });

  test("a pnpm layout whose real path leaves the root resolves the workspace from the unresolved path", () => {
    const script = join(pnpmProject, "node_modules", "typescript", "bin", "tsc");
    // cwd outside every workspace: only argv[1] is inside one.
    assertRedirected(runNode(script, ["--noEmit"], { cwd: root }), "--noEmit");
  });

  test("a tsc outside the root uses the working directory, and runs the real tsc outside every workspace", () => {
    const script = join(outsideTypescript, "bin", "tsc");
    assertRedirected(runNode(script, ["--version"], { cwd: enabledProject }), "--version");
    assertRedirected(runNode(script, ["--version"], { cwd: otherProject }), "--version");
    assertRealTsc(runNode(script, ["--version"], { cwd: root }), "--version");
    assertRealTsc(runNode(script, ["--version"], { cwd: workspaces }), "--version");
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

  test("a SIGTERM to the node process ends tsc-rs too, and the real tsc never runs", async () => {
    for (const script of [
      join(enabledProject, "node_modules", "typescript", "bin", "tsc"),
      join(enabledProject, "node_modules", "typescript", "lib", "tsc.js")
    ]) {
      const marker = join(root, `blocked-${script.endsWith(".js") ? "lib" : "bin"}`);
      const realMarker = `${marker}.real`;
      const child = spawn(process.execPath, [script, "--watch"], {
        cwd: enabledProject,
        env: childEnv({ env: { STUB_BLOCK: marker, REAL_TSC_MARKER: realMarker } }),
        stdio: ["ignore", "pipe", "pipe"]
      });
      const exited = once(child, "exit");
      let stdout = "";
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      // tsc-rs says it is ready (with its pid) once its SIGTERM trap is set.
      const stubPid = await new Promise<number>((resolve, reject) => {
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          const ready = /\nready (\d+)\n/.exec(stdout);
          if (ready) resolve(Number(ready[1]));
        });
        child.once("exit", () => reject(new Error(`exited before tsc-rs was ready: ${stdout} ${stderr}`)));
      });
      process.kill(child.pid!, "SIGTERM");
      const [code, signal] = await exited;
      try {
        assert.equal(signal, "SIGTERM", `exit ${code}, stderr ${stderr}`);
        assert.equal(await readFile(marker, "utf8"), "term", "tsc-rs got the SIGTERM");
        assert.throws(() => process.kill(stubPid, 0), { code: "ESRCH" }, "tsc-rs is gone, not orphaned");
        assert.equal(existsSync(realMarker), false, "the real tsc did not run");
        assert.match(stdout, /^tsc-rs --watch\n/);
        assert.equal(stderr, "");
      } finally {
        // On a failure, an orphaned tsc-rs would hold the pipes (and this file) open.
        try {
          process.kill(stubPid, "SIGTERM");
        } catch {
          // Gone, as it should be.
        }
        child.stdout.destroy();
        child.stderr.destroy();
      }
    }
  });

  test("a native tsc-rs preserves its exit status without running the real tsc", async (t) => {
    const shell = ["/bin/sh", "/usr/bin/sh"].find((candidate) => existsSync(candidate));
    if (!shell) return t.skip("no /bin/sh");
    // A native executable standing in for tsc-rs: the shell, whose `-c` the arguments supply.
    const binary = join(tsRustPluginDir(appdir), "versions", "0.0.3", "tsc");
    await mkdir(dirname(binary), { recursive: true });
    await symlink(shell, binary);
    await writeState(enabledState({ current: { version: "0.0.3", integrity: "sha512-x", installedAt: "x" } }));
    try {
      const script = join(enabledProject, "node_modules", "typescript", "bin", "tsc");
      const result = runNode(script, ["-c", 'printf "native %s\\n" "$$"; exit 4'], { cwd: enabledProject });
      assert.equal(result.stderr, "");
      assert.equal(result.status, 4);
      assert.match(result.stdout, /^native \d+\n$/);
      assert.doesNotMatch(result.stdout, /real tsc/);
    } finally {
      await writeState(enabledState());
    }
  });

  test("typescript 7's tsc (not skippable from a preload) is redirected and passes the exit code", () => {
    const script = join(ts7Project, "node_modules", "typescript", "bin", "tsc");
    assertRedirected(runNode(script, ["--noEmit"], { cwd: ts7Project }), "--noEmit");
    const failing = runNode(script, ["--noEmit"], { cwd: ts7Project, env: { STUB_EXIT: "2" } });
    assert.equal(failing.status, 2);
    assert.doesNotMatch(failing.stdout, /real tsc/);
  });

  test("a tsc reached through a symlinked workspaces root matches the configured root too", async () => {
    const aliased = join(root, "aliased-preload.cjs");
    await writeTsRustPreload(aliased, {
      statePath: pluginsConfigPath(appdir),
      workspacesRoot: workspaces,
      configuredWorkspacesRoot: linkedWorkspaces
    });
    // The real path is in the pnpm store, outside both roots; the cwd is outside every workspace.
    const script = join(linkedWorkspaces, "enabled", "pnpm-app", "node_modules", "typescript", "bin", "tsc");
    assertRedirected(runNode(script, ["--noEmit"], { cwd: root, preload: aliased }), "--noEmit");
    assertRealTsc(runNode(script, ["--noEmit"], { cwd: root }), "--noEmit");
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

  describe("engine choice", () => {
    const script = (): string => join(enabledProject, "node_modules", "typescript", "bin", "tsc");
    /** A preload of a host where tsrs is the default (both engines have builds). */
    let tsrsDefault = "";
    /** A preload of a host where only tsc-rs has a build. */
    let tscRsOnly = "";
    const tsrsCurrent = { version: TSRS_VERSION, integrity: "sha512-y", installedAt: "x" };

    before(async () => {
      const binary = join(tsrsEngineDir(appdir), "versions", TSRS_VERSION, "tsrs");
      await mkdir(dirname(binary), { recursive: true });
      await writeFile(binary, STUB_TSRS, { mode: 0o755 });
      tsrsDefault = join(root, "tsrs-default-preload.cjs");
      await writeTsRustPreload(tsrsDefault, {
        statePath: pluginsConfigPath(appdir),
        workspacesRoot: workspaces,
        supportedEngines: ["tsrs", "tsc-rs"],
        defaultEngine: "tsrs"
      });
      tscRsOnly = join(root, "tsc-rs-only-preload.cjs");
      await writeTsRustPreload(tscRsOnly, {
        statePath: pluginsConfigPath(appdir),
        workspacesRoot: workspaces,
        supportedEngines: ["tsc-rs"],
        defaultEngine: "tsc-rs"
      });
    });

    after(async () => {
      await writeState(enabledState());
    });

    test("no engine named: the host's default, tsrs with its own versions, given 4 checker threads", async () => {
      await writeState(enabledState({ tsrs: { current: tsrsCurrent } }));
      const result = runNode(script(), ["-p", "tsconfig.json", "--noEmit"], { cwd: enabledProject, preload: tsrsDefault });
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, "tsrs -p tsconfig.json --noEmit --checkers 4\n");
      assert.equal(result.status, 0);
      // The tsc-rs default runs tsc-rs's own version, unchanged arguments.
      assertRedirected(runNode(script(), ["--noEmit"], { cwd: enabledProject }), "--noEmit");
    });

    test("the named engine runs when this host has it; tsc-rs gets no extra arguments", async () => {
      await writeState(enabledState({ engine: "tsc-rs", tsrs: { current: tsrsCurrent } }));
      assertRedirected(runNode(script(), ["--noEmit"], { cwd: enabledProject, preload: tsrsDefault }), "--noEmit");
      await writeState(enabledState({ engine: "tsrs", tsrs: { current: tsrsCurrent } }));
      const tsrs = runNode(script(), ["--noEmit"], { cwd: enabledProject });
      assert.equal(tsrs.stdout, "tsrs --noEmit --checkers 4\n");
      // lib/tsc.js (the CommonJS path) passes the same arguments.
      const lib = runNode(join(enabledProject, "node_modules", "typescript", "lib", "tsc.js"), ["-w"], { cwd: enabledProject });
      assert.equal(lib.stdout, "tsrs -w --checkers 4\n");
      const exit = runNode(script(), [], { cwd: enabledProject, env: { STUB_EXIT: "2" } });
      assert.equal(exit.status, 2);
    });

    test("a named engine this host has no build of, or one this build does not know, is the default", async () => {
      await writeState(enabledState({ engine: "tsrs", tsrs: { current: tsrsCurrent } }));
      assertRedirected(runNode(script(), ["--noEmit"], { cwd: enabledProject, preload: tscRsOnly }), "--noEmit");
      for (const engine of ["tsgo", 7, null, { id: "tsrs" }]) {
        await writeState(enabledState({ engine, tsrs: { current: tsrsCurrent } }));
        const result = runNode(script(), ["--noEmit"], { cwd: enabledProject, preload: tsrsDefault });
        assert.equal(result.stdout, "tsrs --noEmit --checkers 4\n", JSON.stringify(engine));
      }
    });

    test("arguments that choose the checkers, and build mode, are passed as they are", async () => {
      await writeState(enabledState({ engine: "tsrs", tsrs: { current: tsrsCurrent } }));
      for (const args of [
        ["-p", "tsconfig.json", "--checkers", "2"],
        ["--Checkers", "8"],
        ["--singleThreaded"],
        ["--noEmit", "--SINGLETHREADED"],
        ["-b"],
        ["-b", "tsconfig.json", "--verbose"],
        ["--build", "packages/a"],
        ["-B", "tsconfig.json"]
      ]) {
        const result = runNode(script(), args, { cwd: enabledProject });
        assert.equal(result.stdout, `tsrs ${args.join(" ")}\n`, args.join(" "));
      }
      // Not build mode when -b is not the first argument (tsc requires it first).
      const later = runNode(script(), ["--noEmit", "-b"], { cwd: enabledProject });
      assert.equal(later.stdout, "tsrs --noEmit -b --checkers 4\n");
    });

    test("tsrs with nothing installed runs the real tsc silently; a missing binary says so once", async () => {
      await writeState(enabledState({ engine: "tsrs" }));
      const none = runNode(script(), ["--noEmit"], { cwd: enabledProject });
      assert.equal(none.stderr, "");
      assertRealTsc(none, "--noEmit");
      await writeState(enabledState({ engine: "tsrs", tsrs: { current: { ...tsrsCurrent, version: "0.99.0" } } }));
      const missing = runNode(script(), ["--noEmit"], { cwd: enabledProject });
      assert.equal(missing.stderr, "orquester: tsrs failed to start (ENOENT); running tsc\n");
      assertRealTsc(missing, "--noEmit");
      for (const tsrs of ["on", [], { current: "x" }, { current: { version: "../0.7.0" } }]) {
        await writeState(enabledState({ engine: "tsrs", tsrs }));
        const result = runNode(script(), [], { cwd: enabledProject });
        assert.equal(result.stderr, "", JSON.stringify(tsrs));
        assertRealTsc(result, "");
      }
    });
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

    test("when tsc-rs passes the pre-check but fails to start, from bin/tsc and lib/tsc.js", async () => {
      // Executable, but its interpreter does not exist: only the spawn itself fails.
      const binary = join(tsRustPluginDir(appdir), "versions", "0.0.2", "tsc");
      await mkdir(dirname(binary), { recursive: true });
      await writeFile(binary, "#!/nonexistent/interpreter\n", { mode: 0o755 });
      await writeState(enabledState({ current: { version: "0.0.2", integrity: "sha512-x", installedAt: "x" } }));
      for (const entry of [script(), join(enabledProject, "node_modules", "typescript", "lib", "tsc.js")]) {
        const result = runNode(entry, ["--noEmit"], { cwd: enabledProject });
        assert.equal(result.stderr, "orquester: tsc-rs failed to start (ENOENT); running tsc\n", entry);
        assertRealTsc(result, "--noEmit");
      }
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
        { plugins: { "ts-rust": { enabled: "true", current: { version: VERSION } } } },
        { plugins: { "ts-rust": { enabled: 1, current: { version: VERSION } } } },
        { plugins: { "ts-rust": { enabled: true, current: { version: 7 } } } },
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
