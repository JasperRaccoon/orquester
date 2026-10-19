import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { SECRET_FILE_MAX_BYTES } from "@orquester/api";

import {
  CloneFileError,
  compareContents,
  formatEnvValue,
  type GitRunner,
  lineDiffCounts,
  mergeEnvContents,
  parseEnv,
  readCloneFile,
  scanCandidates,
  trackedPaths,
  writeCloneFile
} from "./files";

const execFileAsync = promisify(execFile);
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

async function tempDir(t: test.TestContext): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "orquester-secret-files-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com"
    }
  });
  return stdout;
}

async function put(root: string, rel: string, content: string | Uint8Array = "X=1\n"): Promise<void> {
  const abs = join(root, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content);
}

async function rejectsWith(promise: Promise<unknown>, check: (error: CloneFileError) => void): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof CloneFileError, `expected a CloneFileError, got ${String(caught)}`);
  check(caught);
}

// ---------------------------------------------------------------------------
// readCloneFile
// ---------------------------------------------------------------------------

test("readCloneFile returns content, permission bits and mtime of a regular file", async (t) => {
  const root = await tempDir(t);
  await put(root, "apps/web/.env", "A=1\n");
  await chmod(join(root, "apps/web/.env"), 0o640);
  const read = await readCloneFile(root, "apps/web/.env");
  assert.equal(read.kind, "file");
  if (read.kind !== "file") return;
  assert.equal(dec(read.content), "A=1\n");
  assert.equal(read.mode, 0o640);
  assert.equal(read.mtimeMs, (await stat(join(root, "apps/web/.env"))).mtimeMs);
});

test("readCloneFile works through a clone root that is itself a symlink", async (t) => {
  const dir = await tempDir(t);
  await put(dir, "real/.env", "A=1\n");
  await symlink(join(dir, "real"), join(dir, "link"));
  const read = await readCloneFile(join(dir, "link"), ".env");
  assert.equal(read.kind, "file");
});

test("readCloneFile refuses a symlinked file, even one pointing inside the clone", async (t) => {
  const root = await tempDir(t);
  await put(root, ".env.real");
  await symlink(join(root, ".env.real"), join(root, ".env"));
  assert.deepEqual(await readCloneFile(root, ".env"), { kind: "refused", refusal: "symlink" });
});

test("readCloneFile refuses a symlink escaping the clone", async (t) => {
  const dir = await tempDir(t);
  const root = join(dir, "clone");
  await mkdir(root);
  await put(dir, "outside/.env", "SECRET=outside\n");
  await symlink(join(dir, "outside/.env"), join(root, ".env"));
  await symlink(join(dir, "outside"), join(root, "cfg"));
  assert.deepEqual(await readCloneFile(root, ".env"), { kind: "refused", refusal: "symlink" });
  assert.deepEqual(await readCloneFile(root, "cfg/.env"), { kind: "refused", refusal: "symlink" });
});

test("readCloneFile refuses a symlinked parent directory, also when the file is missing", async (t) => {
  const root = await tempDir(t);
  await put(root, "real/.env");
  await mkdir(join(root, "a"));
  await symlink(join(root, "real"), join(root, "a/linked"));
  assert.deepEqual(await readCloneFile(root, "a/linked/.env"), { kind: "refused", refusal: "symlink" });
  assert.deepEqual(await readCloneFile(root, "a/linked/.env.nope"), { kind: "refused", refusal: "symlink" });
});

test("readCloneFile refuses a directory", async (t) => {
  const root = await tempDir(t);
  await mkdir(join(root, ".env"));
  assert.deepEqual(await readCloneFile(root, ".env"), { kind: "refused", refusal: "not-a-file" });
});

test("readCloneFile refuses a file over the size limit and reads one exactly at it", async (t) => {
  const root = await tempDir(t);
  await put(root, "big", new Uint8Array(SECRET_FILE_MAX_BYTES + 1));
  await put(root, "edge", new Uint8Array(SECRET_FILE_MAX_BYTES).fill(65));
  assert.deepEqual(await readCloneFile(root, "big"), { kind: "refused", refusal: "too-large" });
  const edge = await readCloneFile(root, "edge");
  assert.equal(edge.kind, "file");
  if (edge.kind === "file") assert.equal(edge.content.byteLength, SECRET_FILE_MAX_BYTES);
});

test("readCloneFile reports an unreadable file", { skip: isRoot ? "root reads anything" : false }, async (t) => {
  const root = await tempDir(t);
  await put(root, ".env");
  await chmod(join(root, ".env"), 0o000);
  assert.deepEqual(await readCloneFile(root, ".env"), { kind: "refused", refusal: "unreadable" });
});

test("readCloneFile reports missing files and whether their folder exists", async (t) => {
  const root = await tempDir(t);
  await mkdir(join(root, "apps/web"), { recursive: true });
  await put(root, "afile");
  assert.deepEqual(await readCloneFile(root, "apps/web/.env"), { kind: "missing", parentExists: true });
  assert.deepEqual(await readCloneFile(root, ".env"), { kind: "missing", parentExists: true });
  assert.deepEqual(await readCloneFile(root, "apps/api/.env"), { kind: "missing", parentExists: false });
  assert.deepEqual(await readCloneFile(root, "afile/.env"), { kind: "missing", parentExists: false });
  assert.deepEqual(await readCloneFile(join(root, "nope"), ".env"), { kind: "missing", parentExists: false });
});

test("readCloneFile throws on a path that fails secretFilePathProblem", async (t) => {
  const root = await tempDir(t);
  for (const bad of ["../.env", "/etc/passwd", "a/../.env", ".git/config", "a\\b", ""]) {
    await assert.rejects(readCloneFile(root, bad), /Invalid secret file path/, bad);
  }
});

// ---------------------------------------------------------------------------
// writeCloneFile
// ---------------------------------------------------------------------------

test("writeCloneFile creates a new file 0600 without leaving temp files", async (t) => {
  const root = await tempDir(t);
  await mkdir(join(root, "apps"));
  await writeCloneFile(root, "apps/.env", enc("A=1\n"));
  assert.equal(await readFile(join(root, "apps/.env"), "utf8"), "A=1\n");
  assert.equal((await stat(join(root, "apps/.env"))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(root, "apps")), [".env"]);
});

test("writeCloneFile replaces atomically and keeps the given mode", async (t) => {
  const root = await tempDir(t);
  await put(root, ".env", "OLD=1\n");
  await chmod(join(root, ".env"), 0o644);
  const before = await stat(join(root, ".env"));
  const read = await readCloneFile(root, ".env");
  assert.equal(read.kind, "file");
  if (read.kind !== "file") return;
  await writeCloneFile(root, ".env", enc("NEW=2\n"), read.mode);
  const after = await stat(join(root, ".env"));
  assert.equal(await readFile(join(root, ".env"), "utf8"), "NEW=2\n");
  assert.equal(after.mode & 0o777, 0o644);
  assert.notEqual(after.ino, before.ino, "a new inode means the content arrived by rename");
  assert.deepEqual(await readdir(root), [".env"]);
});

test("writeCloneFile sets exactly the mode given, regardless of the umask", async (t) => {
  const root = await tempDir(t);
  await writeCloneFile(root, ".env", enc("A=1\n"), 0o664);
  assert.equal((await stat(join(root, ".env"))).mode & 0o777, 0o664);
});

test("writeCloneFile refuses a symlink target and never writes through it", async (t) => {
  const dir = await tempDir(t);
  const root = join(dir, "clone");
  await mkdir(root);
  await put(dir, "outside.txt", "untouched");
  await symlink(join(dir, "outside.txt"), join(root, ".env"));
  await rejectsWith(writeCloneFile(root, ".env", enc("A=1\n")), (error) => assert.equal(error.refusal, "symlink"));
  assert.equal(await readFile(join(dir, "outside.txt"), "utf8"), "untouched");
  assert.ok((await lstat(join(root, ".env"))).isSymbolicLink());
  assert.deepEqual((await readdir(root)).sort(), [".env"]);
});

test("writeCloneFile refuses a symlinked parent directory", async (t) => {
  const dir = await tempDir(t);
  const root = join(dir, "clone");
  await mkdir(root);
  await mkdir(join(dir, "elsewhere"));
  await symlink(join(dir, "elsewhere"), join(root, "cfg"));
  await rejectsWith(writeCloneFile(root, "cfg/.env", enc("A=1\n")), (error) => assert.equal(error.refusal, "symlink"));
  assert.deepEqual(await readdir(join(dir, "elsewhere")), []);
});

test("writeCloneFile never creates directories", async (t) => {
  const root = await tempDir(t);
  await rejectsWith(writeCloneFile(root, "apps/web/.env", enc("A=1\n")), (error) => {
    assert.equal(error.parentMissing, true);
    assert.equal(error.refusal, undefined);
  });
  assert.deepEqual(await readdir(root), []);
});

test("writeCloneFile refuses a directory target and oversized content", async (t) => {
  const root = await tempDir(t);
  await mkdir(join(root, ".env"));
  await rejectsWith(writeCloneFile(root, ".env", enc("A=1\n")), (error) => assert.equal(error.refusal, "not-a-file"));
  await rejectsWith(writeCloneFile(root, ".env.big", new Uint8Array(SECRET_FILE_MAX_BYTES + 1)), (error) =>
    assert.equal(error.refusal, "too-large")
  );
  await assert.rejects(writeCloneFile(root, "../x", enc("A=1\n")), /Invalid secret file path/);
});

// ---------------------------------------------------------------------------
// scanCandidates / trackedPaths (real git)
// ---------------------------------------------------------------------------

async function makeRepo(t: test.TestContext): Promise<string> {
  const root = join(await tempDir(t), "repo");
  await mkdir(root);
  await git(root, "init", "-q", "-b", "main");
  await put(root, ".gitignore", ".env*\n!.env.example\n!loose/.env\nnode_modules/\n.claude/\nnested/\n");
  await put(root, "README.md", "hi\n");
  await put(root, "config/.env", "TRACKED=1\n");
  await git(root, "add", ".gitignore", "README.md");
  await git(root, "add", "-f", "config/.env");
  await git(root, "commit", "-q", "-m", "init");
  return root;
}

test("scanCandidates lists ignored .env files at any depth and nothing else", async (t) => {
  const root = await makeRepo(t);
  await put(root, ".env");
  await put(root, ".env.local");
  await put(root, ".env.we ird");
  await put(root, ".env.example"); // a template, and not ignored
  await put(root, ".env.sample"); // ignored, but a template
  await put(root, ".envrc"); // ignored, not .env / .env.*
  await put(root, "x.env");
  await put(root, "apps/web/.env.production");
  await put(root, "apps/web/.env.production.template");
  await put(root, "loose/.env"); // untracked, not ignored
  await put(root, "node_modules/pkg/.env");
  await put(root, "apps/web/node_modules/pkg/.env.local");
  // A linked worktree and a nested repository with their own .env files.
  await git(root, "worktree", "add", "-q", ".claude/worktrees/w1", "-b", "w1");
  await put(root, ".claude/worktrees/w1/.env");
  await mkdir(join(root, "nested"));
  await git(join(root, "nested"), "init", "-q");
  await put(root, "nested/.env");
  // Even when the nested repo is not ignored, git does not descend into it.
  await mkdir(join(root, "vendor/lib"), { recursive: true });
  await git(join(root, "vendor/lib"), "init", "-q");
  await put(root, "vendor/lib/.env");

  assert.deepEqual(await scanCandidates(root), [".env", ".env.local", ".env.we ird", "apps/web/.env.production"]);
});

test("scanCandidates returns [] outside a repository or when git fails", async (t) => {
  const dir = await tempDir(t);
  await put(dir, ".env");
  assert.deepEqual(await scanCandidates(dir), []);
  const failing: GitRunner = () => Promise.reject(new Error("timeout"));
  assert.deepEqual(await scanCandidates(dir, failing), []);
});

test("scanCandidates filters, dedupes and sorts what git returns", async () => {
  let seen: string[] = [];
  const runner: GitRunner = (_cwd, args) => {
    seen = args;
    return Promise.resolve(
      ["b/.env", "a/.env.local", "b/.env", "nested/", "node_modules/x/.env", ".env.example", "a/.git/../.env", "c/.env\u0001", ""].join("\0")
    );
  };
  assert.deepEqual(await scanCandidates("/clone", runner), ["a/.env.local", "b/.env"]);
  assert.deepEqual(seen, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ":(glob)**/.env", ":(glob)**/.env.*"]);
});

test("trackedPaths matches names literally, including glob characters", async (t) => {
  const root = await makeRepo(t);
  await put(root, "a*b/.env");
  await put(root, "[x].env");
  await put(root, "sub/inner.txt");
  await put(root, ".env.local");
  await git(root, "add", "-f", "a*b/.env", "[x].env", "sub/inner.txt");
  await git(root, "commit", "-q", "-m", "weird");
  const tracked = await trackedPaths(root, ["a*b/.env", "a?b/.env", "[x].env", "x.env", "sub", ".env.local", "config/.env", "nope/.env"]);
  assert.deepEqual([...tracked].sort(), ["[x].env", "a*b/.env", "config/.env"]);
});

test("trackedPaths skips git for no paths and treats a failing git as nothing tracked", async (t) => {
  let calls = 0;
  const counting: GitRunner = () => {
    calls++;
    return Promise.resolve("");
  };
  assert.equal((await trackedPaths("/clone", [], counting)).size, 0);
  assert.equal(calls, 0);
  const failing: GitRunner = () => Promise.reject(new Error("not a git repository"));
  assert.equal((await trackedPaths("/clone", [".env"], failing)).size, 0);
  const dir = await tempDir(t);
  assert.equal((await trackedPaths(dir, [".env"])).size, 0);
});

// ---------------------------------------------------------------------------
// parseEnv
// ---------------------------------------------------------------------------

function env(text: string): Record<string, string> | null {
  const parsed = parseEnv(enc(text));
  return parsed ? Object.fromEntries(parsed) : null;
}

test("parseEnv reads plain, exported, quoted and commented assignments", () => {
  assert.deepEqual(
    env(
      [
        "# a comment",
        "",
        "  PLAIN=value  ",
        "export EXPORTED=1",
        "export\tTABBED = spaced value # trailing comment",
        "HASH=pa#ss",
        "EMPTY=",
        "ONLY_COMMENT= # nothing",
        "SINGLE='lit $X \\n # not a comment'",
        'DOUBLE="a\\nb \\"q\\" \\\\ \\x" # c',
        "TICK=`raw`",
        "dotted.key-name=ok",
        "export=is-a-key",
        "export = also",
        "CRLF=yes\r",
        ""
      ].join("\n")
    ),
    {
      PLAIN: "value",
      EXPORTED: "1",
      TABBED: "spaced value",
      HASH: "pa#ss",
      EMPTY: "",
      ONLY_COMMENT: "",
      SINGLE: "lit $X \\n # not a comment",
      DOUBLE: 'a\nb "q" \\ \\x',
      TICK: "raw",
      "dotted.key-name": "ok",
      export: "also",
      CRLF: "yes"
    }
  );
});

test("parseEnv takes multi-line quoted values as one value and keeps the last assignment", () => {
  assert.deepEqual(env('KEY="-----BEGIN-----\nline\n-----END-----"\nA=1\nA=2\n'), {
    KEY: "-----BEGIN-----\nline\n-----END-----",
    A: "2"
  });
  assert.deepEqual(env("S='one\ntwo'\n"), { S: "one\ntwo" });
  assert.deepEqual([...parseEnv(enc("A=1\nB=2\nA=3\n"))!.keys()], ["A", "B"]);
});

test("parseEnv accepts empty and comment-only text and a UTF-8 BOM", () => {
  assert.deepEqual(env(""), {});
  assert.deepEqual(env("# only\n\n   \n"), {});
  assert.deepEqual(env("﻿A=1\n"), { A: "1" });
});

test("parseEnv returns null for text that isn't KEY=VALUE", () => {
  for (const text of [
    "just words\n",
    "A=1\nnot an assignment\n",
    "1KEY=x\n",
    "KEY\n",
    "export KEY\n",
    "KEY: value\n",
    'A="unterminated\n',
    "A='unterminated\n",
    'A="x" trailing\n',
    "{\n  \"json\": true\n}\n",
    "[section]\nk=v\n"
  ]) {
    assert.equal(parseEnv(enc(text)), null, JSON.stringify(text));
  }
  assert.equal(parseEnv(new Uint8Array([0x41, 0x3d, 0xff, 0xfe, 0x0a])), null, "invalid UTF-8");
});

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

const MB = 1024 * 1024;

test("parseEnv stays linear on 1 MB adversarial input", () => {
  const inputs: Record<string, string> = {
    words: "a".repeat(MB),
    hashes: "#".repeat(MB),
    spaces: " ".repeat(MB) + "x",
    unterminatedDouble: 'A="' + "\\\"".repeat(MB / 2),
    unterminatedSingle: "A='" + "x\n".repeat(MB / 2),
    blankHashes: "A=" + " #".repeat(MB / 2),
    tabsThenNothing: "A=" + "\t".repeat(MB) + "x # y",
    escapes: 'A="' + "\\n".repeat(MB / 2) + '"\n',
    manyKeys: "K_ABCDEF=v\n".repeat(MB / 11),
    exports: "export ".repeat(MB / 7) + "A=1",
    manyQuotes: "A=''\n".repeat(MB / 5),
    longKey: "A".repeat(MB) + "=1"
  };
  for (const [name, text] of Object.entries(inputs)) {
    const bytes = enc(text);
    const { ms } = timed(() => parseEnv(bytes));
    assert.ok(ms < 500, `${name} took ${ms.toFixed(0)} ms`);
  }
});

// ---------------------------------------------------------------------------
// compareContents
// ---------------------------------------------------------------------------

test("compareContents reports a missing side", () => {
  assert.deepEqual(compareContents(null, enc("A=1")), { format: "missing", side: "left" });
  assert.deepEqual(compareContents(enc("A=1"), null), { format: "missing", side: "right" });
});

test("compareContents compares env files by key name only", () => {
  const left = enc("SAME=s3cr3t-same\nCHANGED=s3cr3t-left\nADDED=s3cr3t-added\n");
  const right = enc("export SAME='s3cr3t-same'\nCHANGED=s3cr3t-right\nREMOVED=s3cr3t-removed\n");
  const result = compareContents(left, right);
  assert.deepEqual(result, {
    format: "env",
    keys: [
      { key: "ADDED", change: "added" },
      { key: "CHANGED", change: "changed" },
      { key: "REMOVED", change: "removed" },
      { key: "SAME", change: "same" }
    ]
  });
  assert.doesNotMatch(JSON.stringify(result), /s3cr3t/);
});

test("compareContents counts lines when either side isn't env", () => {
  const result = compareContents(enc("host: s3cr3t-a\nport: 1\nuser: x\n"), enc("host: s3cr3t-b\nport: 1\n"));
  assert.deepEqual(result, { format: "lines", linesAdded: 2, linesRemoved: 1 });
  assert.doesNotMatch(JSON.stringify(result), /s3cr3t/);
  assert.deepEqual(compareContents(enc("A=1\n"), enc("not env\n")), { format: "lines", linesAdded: 1, linesRemoved: 1 });
  assert.deepEqual(compareContents(new Uint8Array([0xff, 0x0a]), new Uint8Array([0xff, 0x0a])), {
    format: "lines",
    linesAdded: 0,
    linesRemoved: 0
  });
});

test("lineDiffCounts is an exact LCS diff for small inputs", () => {
  assert.deepEqual(lineDiffCounts(["a", "b", "c"], ["a", "x", "c"]), { added: 1, removed: 1 });
  assert.deepEqual(lineDiffCounts(["a", "b", "c"], ["c", "a", "b"]), { added: 1, removed: 1 });
  assert.deepEqual(lineDiffCounts([], ["a", "b"]), { added: 0, removed: 2 });
  assert.deepEqual(lineDiffCounts(["a", "b"], []), { added: 2, removed: 0 });
  assert.deepEqual(lineDiffCounts(["x", "a", "b", "y"], ["a", "b"]), { added: 2, removed: 0 });
  assert.deepEqual(lineDiffCounts(["a", "b", "a", "b"], ["b", "a", "b", "a"]), { added: 1, removed: 1 });
});

test("lineDiffCounts falls back to a multiset count for large inputs", () => {
  const a = Array.from({ length: 6000 }, (_, i) => `l${i}`);
  const b = [...a].reverse();
  // Order-blind: the same lines in another order count as no change.
  assert.deepEqual(lineDiffCounts(a, b), { added: 0, removed: 0 });
  assert.deepEqual(lineDiffCounts([...a, "extra"], ["first", ...b]), { added: 1, removed: 1 });
});

test("compareContents stays fast on 1 MB adversarial input", () => {
  const cases: Array<[string, string, string]> = [
    ["distinct lines", "a\n".repeat(MB / 2), "b\n".repeat(MB / 2)],
    ["one long line each", "x".repeat(MB), "y".repeat(MB)],
    ["middle change", "line\n".repeat(MB / 10) + "mid\n" + "line\n".repeat(MB / 10), "line\n".repeat(MB / 10) + "MID\n" + "line\n".repeat(MB / 10)],
    [
      "max distance under the line cap",
      Array.from({ length: 5000 }, (_, i) => `left-${i}`).join("\n"),
      Array.from({ length: 5000 }, (_, i) => `right-${i}`).join("\n")
    ],
    ["interleaved", "a\nb\n".repeat(MB / 8), "b\na\n".repeat(MB / 8)],
    [
      "env keys",
      Array.from({ length: 80000 }, (_, i) => `KEY_${i}=left`).join("\n"),
      Array.from({ length: 80000 }, (_, i) => `KEY_${79999 - i}=right`).join("\n")
    ]
  ];
  for (const [name, left, right] of cases) {
    const l = enc(left);
    const r = enc(right);
    const { ms } = timed(() => compareContents(l, r));
    assert.ok(ms < 500, `${name} took ${ms.toFixed(0)} ms`);
  }
});

// ---------------------------------------------------------------------------
// mergeEnvContents
// ---------------------------------------------------------------------------

test("mergeEnvContents keeps primary bytes and appends missing keys in first-seen order", () => {
  const primary = enc("# keep me\nA=primary\nB='quoted'");
  const merged = mergeEnvContents(primary, [enc("A=other\nC=from-1\n"), enc("D=from-2\nC=ignored\n")]);
  assert.ok(merged);
  const text = dec(merged);
  assert.ok(text.startsWith("# keep me\nA=primary\nB='quoted'\n"), "primary text unchanged, then a newline");
  assert.deepEqual(Object.fromEntries(parseEnv(merged)!), { A: "primary", B: "quoted", C: "from-1", D: "from-2" });
  assert.equal(text.slice("# keep me\nA=primary\nB='quoted'\n".length), "C=from-1\nD=from-2\n");
});

test("mergeEnvContents returns the primary bytes unchanged when nothing is missing", () => {
  const primary = enc("A=1\r\nB=2");
  assert.deepEqual(mergeEnvContents(primary, [enc("A=9\n")]), primary);
  assert.deepEqual(mergeEnvContents(primary, []), primary);
});

test("mergeEnvContents returns null when any input isn't env", () => {
  assert.equal(mergeEnvContents(enc("not env"), [enc("A=1")]), null);
  assert.equal(mergeEnvContents(enc("A=1"), [enc("B=2"), enc("not env")]), null);
});

test("mergeEnvContents quotes values so they read back exactly", () => {
  const values = [
    "",
    "plain-value_1.2/3:4@5%6+7,8=9",
    "has space",
    " leading and trailing ",
    "a#b",
    "a #b",
    "#start",
    'quote"s',
    "'single'",
    "`tick`",
    "back\\slash",
    "\\n literal",
    "multi\nline\r\nvalue",
    "tab\there",
    "日本語 ✓",
    "$HOME ${X}"
  ];
  const other = values.map((value, i) => `K${i}=${formatEnvValue(value)}`).join("\n");
  const otherEnv = parseEnv(enc(other));
  assert.ok(otherEnv, "the formatted values parse");
  values.forEach((value, i) => assert.equal(otherEnv.get(`K${i}`), value, `formatEnvValue(${JSON.stringify(value)})`));
  const merged = mergeEnvContents(enc("BASE=1\n"), [enc(other)]);
  assert.ok(merged);
  const reparsed = parseEnv(merged);
  assert.ok(reparsed);
  values.forEach((value, i) => assert.equal(reparsed.get(`K${i}`), value, `merged ${JSON.stringify(value)}`));
  assert.equal(reparsed.get("BASE"), "1");
});
