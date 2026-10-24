#!/usr/bin/env node
/**
 * `pnpm check:changed`: the fast checks for this branch's changes.
 *
 * - Typecheck: every workspace package with a changed file, plus its dependents
 *   (`pnpm --filter ...<name> typecheck`); every package when a root TypeScript or
 *   workspace file changed. Skipped when nothing a typecheck reads changed.
 * - Tests: the changed `*.test.*` / `*.check.*` files, plus the ones beside a changed
 *   file (`foo.ts` → `foo.test.ts`, `foo.<anything>.test.ts`). The import graph is not
 *   followed: it reaches most of a package. Each package's files run with that
 *   package's own `test` script runner (its `node --import … --test` preamble and
 *   concurrency), one package at a time; root `scripts/` and `deploy/` tests run
 *   with `node --test`.
 *
 * Changed files are those differing from the merge base with `main` (committed,
 * staged or not) plus untracked ones. A rerun on exactly the inputs of the last
 * passing run prints that run's summary instead (`--no-cache` runs anyway).
 * `pnpm test` stays the full gate.
 *
 *   node scripts/check-changed.mjs [--base <ref>] [--dry-run] [--no-cache]
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A test or check file, by name. */
export const TEST_FILE = /\.(test|check)\.[cm]?[jt]sx?$/;
const CHECK_FILE = /\.check\.[cm]?[jt]sx?$/;
const TYPESCRIPT = /\.[cm]?tsx?$/;
/** Root files every package's typecheck reads. */
const ROOT_TYPECHECK_INPUTS = /^(tsconfig[^/]*\.json|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/;

/** The workspace package (longest directory prefix) a repository path belongs to, or null. */
export function packageOf(file, packages) {
  let best = null;
  for (const pkg of packages) {
    if (file.startsWith(`${pkg.dir}/`) && (best === null || pkg.dir.length > best.dir.length)) best = pkg;
  }
  return best;
}

/**
 * The test files to run for `files` (repository paths, `/`-separated): each changed test or
 * check file that still exists, and every test or check file beside a changed file whose name
 * starts with the changed file's name minus its extension and a dot.
 * `fs.exists(path)` and `fs.readdir(dir)` read the tree (injected for tests).
 */
export function selectTests(files, fs) {
  const tests = new Set();
  const listed = new Map();
  const entriesOf = (dir) => {
    if (!listed.has(dir)) {
      let entries = [];
      try {
        entries = fs.readdir(dir);
      } catch {
        // A deleted directory has no siblings left.
      }
      listed.set(dir, entries);
    }
    return listed.get(dir);
  };
  for (const file of files) {
    if (TEST_FILE.test(file)) {
      if (fs.exists(file)) tests.add(file);
      continue;
    }
    const dir = posix.dirname(file);
    const name = posix.basename(file);
    const dot = name.lastIndexOf(".");
    if (dot <= 0) continue;
    const prefix = `${name.slice(0, dot)}.`;
    for (const entry of entriesOf(dir)) {
      if (entry.startsWith(prefix) && TEST_FILE.test(entry)) tests.add(dir === "." ? entry : `${dir}/${entry}`);
    }
  }
  return [...tests].sort();
}

/**
 * The runner of a package's `test` script: the shell words before its first `--test` run's
 * file list (env assignments, `node`, its `--import`s, `--test` and `--test-concurrency=…`),
 * and the same without the `--test` flags for `*.check.*` scripts. Null without a node runner.
 */
export function runnerOf(testScript) {
  if (typeof testScript !== "string") return null;
  const first = testScript.split("&&")[0];
  const match = /^\s*((?:\w+=\S+\s+)*node\b(?:\s+--import\s+\S+)*\s+--test\b(?:\s+--test-concurrency=\S+)?)/.exec(first);
  if (!match) return null;
  const test = match[1].trim();
  const check = test.replace(/\s+--test-concurrency=\S+/, "").replace(/\s+--test\b/, "");
  return { test, check };
}

/** A POSIX shell single-quoted word. */
export function shellQuote(word) {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * The test commands, one group per package (in package order, root last): its directory, the
 * files relative to it, and the shell commands to run them. Files in a package without a node
 * test runner are returned in `unrunnable`.
 */
export function planTests(tests, packages) {
  const groups = new Map();
  const unrunnable = [];
  for (const file of tests) {
    const pkg = packageOf(file, packages);
    const key = pkg ? pkg.dir : ".";
    const runner = pkg ? runnerOf(pkg.testScript) : { test: "node --test", check: "node" };
    if (!runner) {
      unrunnable.push(file);
      continue;
    }
    if (!groups.has(key)) groups.set(key, { dir: key, name: pkg ? pkg.name : "(root)", runner, files: [] });
    groups.get(key).files.push(pkg ? file.slice(pkg.dir.length + 1) : file);
  }
  const ordered = [...groups.values()].sort((a, b) => (a.dir === "." ? 1 : b.dir === "." ? -1 : a.dir.localeCompare(b.dir)));
  return {
    groups: ordered.map((group) => {
      const tests = group.files.filter((file) => !CHECK_FILE.test(file));
      const checks = group.files.filter((file) => CHECK_FILE.test(file));
      const commands = [];
      if (tests.length > 0) commands.push(`${group.runner.test} ${tests.map(shellQuote).join(" ")}`);
      for (const file of checks) commands.push(`${group.runner.check} ${shellQuote(file)}`);
      return { dir: group.dir, name: group.name, files: group.files, commands };
    }),
    unrunnable
  };
}

/**
 * The typecheck plan: null when no TypeScript, manifest or root config changed; else the
 * pnpm filter arguments — every package (`["-r"]`) for a root input, or `...<name>` (the
 * package and its dependents) for each package with a changed input.
 */
export function planTypecheck(files, packages) {
  const names = new Set();
  for (const file of files) {
    const pkg = packageOf(file, packages);
    if (!pkg) {
      if (ROOT_TYPECHECK_INPUTS.test(file)) return { args: ["-r"] };
      continue;
    }
    const rel = file.slice(pkg.dir.length + 1);
    if (TYPESCRIPT.test(rel) || /^(tsconfig[^/]*\.json|package\.json)$/.test(rel)) names.add(pkg.name);
  }
  if (names.size === 0) return null;
  return { args: [...names].sort().flatMap((name) => ["--filter", `...${name}`]) };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function git(...args) {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean);
}

function readPackages() {
  const packages = [];
  for (const parent of ["apps", "packages"]) {
    let entries = [];
    try {
      entries = readdirSync(join(ROOT, parent));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const manifest = join(ROOT, parent, entry, "package.json");
      if (!existsSync(manifest)) continue;
      const json = JSON.parse(readFileSync(manifest, "utf8"));
      packages.push({ dir: `${parent}/${entry}`, name: json.name, testScript: json.scripts?.test });
    }
  }
  return packages;
}

function parseArgs(argv) {
  const options = { base: null, dryRun: false, cache: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run" || arg === "-n") options.dryRun = true;
    else if (arg === "--no-cache") options.cache = false;
    else if (arg === "--base") options.base = argv[++i] ?? null;
    else if (arg.startsWith("--base=")) options.base = arg.slice("--base=".length);
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function mergeBase(ref) {
  for (const candidate of ref ? [ref] : ["main", "origin/main"]) {
    const result = spawnSync("git", ["merge-base", "HEAD", candidate], { cwd: ROOT, encoding: "utf8" });
    if (result.status === 0) return result.stdout.trim();
  }
  return null;
}

/** The inputs a pass depends on: the diff against the base, the untracked files' bytes, the install. */
function inputKey(base, files) {
  const hash = createHash("sha256");
  hash.update(`${process.version}\0${base}\0`);
  hash.update(execFileSync("git", ["diff", "--binary", "--no-renames", "--no-ext-diff", "--no-textconv", base, "--"], { cwd: ROOT, maxBuffer: 1024 * 1024 * 1024 }));
  for (const file of [...files, "node_modules/.modules.yaml"]) {
    hash.update(`\0${file}\0`);
    const path = join(ROOT, file);
    if (statSync(path, { throwIfNoEntry: false })?.isFile()) hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}

const CACHE_PATH = join(ROOT, "node_modules/.cache/check-changed.json");

function readCache() {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return undefined;
  }
}

/** Run one shell command in `cwd`, its output collected; resolves {ok, seconds, output}. */
function run(command, cwd) {
  return new Promise((resolve) => {
    const started = performance.now();
    const output = [];
    const child = spawn("sh", ["-c", command], { cwd, env: process.env });
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    child.on("error", (error) => output.push(Buffer.from(`${error.message}\n`)));
    child.on("close", (status) => resolve({ ok: status === 0, seconds: ((performance.now() - started) / 1000).toFixed(1), output: Buffer.concat(output) }));
  });
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("usage: pnpm check:changed [--base <ref>] [--dry-run] [--no-cache]");
    return 0;
  }
  const base = mergeBase(options.base);
  if (base === null) {
    console.error(`check:changed: no merge base with ${options.base ?? "main or origin/main"}; pass --base <ref>.`);
    return 1;
  }
  const files = [...new Set([...git("diff", "--name-only", "--no-renames", base, "--"), ...git("ls-files", "--others", "--exclude-standard")])].sort();
  if (files.length === 0) {
    console.log(`check:changed: no changes since ${base.slice(0, 12)}.`);
    return 0;
  }
  const packages = readPackages();
  const fs = { exists: (file) => existsSync(join(ROOT, file)), readdir: (dir) => readdirSync(join(ROOT, dir)) };
  const tests = selectTests(files, fs);
  const testPlan = planTests(tests, packages);
  const typecheck = planTypecheck(files, packages);
  const typecheckCommand = typecheck ? `pnpm ${typecheck.args.map((arg) => (arg.startsWith("...") ? shellQuote(arg) : arg)).join(" ")} run --if-present typecheck` : null;

  console.log(`check:changed: ${files.length} changed file(s) since ${base.slice(0, 12)}`);
  if (options.dryRun) {
    for (const file of files) console.log(`  ${file}`);
    console.log(typecheckCommand ? `\ntypecheck: ${typecheckCommand}` : "\ntypecheck: skipped (no TypeScript, manifest or root config changed)");
    if (testPlan.groups.length === 0) console.log("tests: none (no changed or sibling test files)");
    for (const group of testPlan.groups) {
      console.log(`\ntests in ${group.name} (${group.dir}), ${group.files.length} file(s):`);
      for (const command of group.commands) console.log(`  ${command}`);
    }
    for (const file of testPlan.unrunnable) console.log(`not runnable (no node test runner in its package): ${file}`);
    return 0;
  }

  const key = options.cache ? inputKey(base, files) : null;
  const cached = key ? readCache() : undefined;
  if (key && cached?.key === key) {
    console.log("Nothing changed since the last passing run.\n");
    for (const line of cached.summary) console.log(line);
    return 0;
  }

  const report = (name, result) => {
    console.log(`\n> ${name}  ${result.ok ? "pass" : "FAIL"}  ${result.seconds}s`);
    if (!result.ok || process.env.CHECK_CHANGED_VERBOSE) process.stdout.write(result.output);
    return { name, ok: result.ok, seconds: result.seconds };
  };
  // The typecheck and the tests run side by side; test groups run one package at a time.
  const typecheckDone = typecheckCommand ? run(typecheckCommand, ROOT).then((result) => report("typecheck", result)) : Promise.resolve(null);
  const testResults = [];
  for (const group of testPlan.groups) {
    const result = await run(group.commands.join(" && "), join(ROOT, group.dir));
    testResults.push(report(`tests ${group.name} (${group.files.length} file(s))`, result));
  }
  const results = [await typecheckDone, ...testResults].filter(Boolean);

  const summary = ["check:changed summary"];
  for (const result of results) summary.push(`  ${result.ok ? "pass" : "FAIL"}  ${result.name}  ${result.seconds}s`);
  if (!typecheckCommand) summary.push("  typecheck skipped: no TypeScript, manifest or root config changed");
  if (testPlan.groups.length === 0) summary.push("  no tests: no changed or sibling test files");
  for (const file of testPlan.unrunnable) summary.push(`  not run (no node test runner in its package): ${file}`);
  summary.push("  the full gate is still `pnpm test`");
  console.log(`\n${summary.join("\n")}`);

  if (results.some((result) => !result.ok) || testPlan.unrunnable.length > 0) return 1;
  if (key) {
    // Edits made during the run are never cached as passing.
    if (inputKey(base, files) !== key) {
      console.log("  pass not cached: files changed during the run");
    } else {
      try {
        const temp = `${CACHE_PATH}.${process.pid}`;
        mkdirSync(dirname(CACHE_PATH), { recursive: true });
        writeFileSync(temp, JSON.stringify({ key, summary }));
        renameSync(temp, CACHE_PATH);
      } catch (error) {
        console.warn(`  pass not cached: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`check:changed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  );
}
