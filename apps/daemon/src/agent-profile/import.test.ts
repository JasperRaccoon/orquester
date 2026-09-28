import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { crc32, deflateRawSync } from "node:zlib";
import type { AgentProfileAgentId } from "@orquester/api";
import { isAgentProfileError } from "./errors.ts";
import { type GitCloneFn, ProfileImportStore, type ProfileImportStoreOptions, gitClone, gitCloneArgs, parseGitImportUrl } from "./import.ts";
import { parseMarkdownDocument, serializeMarkdownDocument } from "./infra/index.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Scratch space, a fixture tree, a tiny zip writer
// ---------------------------------------------------------------------------

interface Scratch {
  root: string;
  dir: string;
  clock: { now: number };
  clones: { url: string; ref: string | undefined }[];
  store: ProfileImportStore;
}

async function scratch(
  t: test.TestContext,
  options: { fixture?: string; existingItems?: string[] } & Partial<ProfileImportStoreOptions> = {}
): Promise<Scratch> {
  const { fixture, existingItems, ...storeOptions } = options;
  const root = await realpath(await mkdtemp(join(tmpdir(), "orquester-profile-import-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "appdir", "tmp", "agent-profile-imports");
  const clock = { now: Date.parse("2026-09-28T12:00:00.000Z") };
  const clones: Scratch["clones"] = [];
  const clone: GitCloneFn =
    storeOptions.clone ??
    (async (url, ref, dest) => {
      clones.push({ url, ref });
      if (fixture === undefined) throw new Error("no fixture");
      await cp(fixture, dest, { recursive: true, verbatimSymlinks: true });
    });
  const store = new ProfileImportStore({
    dir,
    existing: async () => new Set(existingItems ?? []),
    now: () => new Date(clock.now),
    logger: { info: () => undefined, warn: () => undefined },
    ...storeOptions,
    clone
  });
  t.after(() => store.stop());
  return { root, dir, clock, clones, store };
}

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const skillText = (frontmatter: Record<string, unknown>, body = "Use it.\n"): string => serializeMarkdownDocument(frontmatter, body);

/** A repo-shaped tree with skills, commands and the traps the scan must avoid. */
async function makeFixture(root: string): Promise<string> {
  const repo = join(root, "fixture");
  await put(join(repo, "README.md"), "# Skills\n");
  await put(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  await put(
    join(repo, "skills", "alpha", "SKILL.md"),
    skillText({ name: "alpha", description: "Alpha", when_to_use: "Often", "x-custom": 1 })
  );
  await put(join(repo, "skills", "alpha", "scripts", "run.sh"), "echo alpha\n");
  await put(join(repo, "skills", "Beta Skill", "SKILL.md"), skillText({ name: "Not Valid", description: "Beta" }));
  await put(join(repo, "skills", "linked", "SKILL.md"), skillText({ name: "linked", description: "Linked" }));
  await symlink("/etc/passwd", join(repo, "skills", "linked", "passwd"));
  await mkdir(join(repo, "skills", "link-skill"), { recursive: true });
  await symlink("/etc/hostname", join(repo, "skills", "link-skill", "SKILL.md"));
  await symlink("../skills/alpha", join(repo, "skills", "alias"));
  await put(join(repo, "node_modules", "dep", "SKILL.md"), skillText({ name: "dep", description: "Dep" }));
  await put(join(repo, "a", "b", "c", "d", "e", "six", "SKILL.md"), skillText({ name: "six", description: "Deep" }));
  await put(join(repo, "a", "b", "c", "d", "e", "f", "seven", "SKILL.md"), skillText({ name: "seven", description: "Too deep" }));
  await put(join(repo, "commands", "review.md"), skillText({ description: "Review", model: "opus", "x-custom": 2 }, "Review $ARGUMENTS\n"));
  await put(join(repo, "commands", "git", "pr.md"), skillText({ description: "Open a PR" }, "Open a PR\n"));
  await put(join(repo, "commands", "git", "deep", "no.md"), "too deep\n");
  await put(join(repo, "commands", "notes.txt"), "not markdown\n");
  await symlink("/etc/passwd", join(repo, "commands", "evil.md"));
  await put(join(repo, ".claude", "commands", "Hello World.md"), "Say hello\n");
  await put(join(repo, "skills", "broken", "SKILL.md"), "---\nname: [oops\n---\n");
  return repo;
}

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(isAgentProfileError(error), `an AgentProfileError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return true;
  };
}

interface ZipEntrySpec {
  name: string;
  data?: Buffer | string;
  /** Unix mode (type bits included) put in the external attributes. */
  mode?: number;
  deflate?: boolean;
  /** Overrides the uncompressed size the headers declare. */
  declaredSize?: number;
}

/** A minimal zip (stored or deflated entries, unix attributes) — enough for yauzl. */
function makeZip(entries: ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "", "utf8");
    const data = entry.deflate ? deflateRawSync(raw) : raw;
    const method = entry.deflate ? 8 : 0;
    const size = entry.declaredSize ?? raw.length;
    const crc = crc32(raw);
    const mode = entry.mode ?? (entry.name.endsWith("/") ? 0o040755 : 0o100644);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

async function writeUpload(root: string, name: string, bytes: Buffer | string): Promise<string> {
  const path = join(root, "uploads", name);
  await put(path, "");
  await writeFile(path, bytes);
  return path;
}

async function importDirs(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Git URLs
// ---------------------------------------------------------------------------

test("git URLs: accepted forms and what they clone", () => {
  assert.deepEqual(parseGitImportUrl("https://github.com/acme/skills"), {
    cloneUrl: "https://github.com/acme/skills",
    repoName: "skills"
  });
  assert.deepEqual(parseGitImportUrl("  https://gitlab.com/acme/skills.git#readme  "), {
    cloneUrl: "https://gitlab.com/acme/skills.git",
    repoName: "skills"
  });
  assert.deepEqual(parseGitImportUrl("ssh://git@github.com:22/acme/skills.git"), {
    cloneUrl: "ssh://git@github.com:22/acme/skills.git",
    repoName: "skills"
  });
  assert.deepEqual(parseGitImportUrl("git@github.com:acme/skills.git"), {
    cloneUrl: "git@github.com:acme/skills.git",
    repoName: "skills"
  });
  assert.deepEqual(parseGitImportUrl("https://github.com/anthropics/skills/tree/main/document-skills/pdf"), {
    cloneUrl: "https://github.com/anthropics/skills.git",
    ref: "main",
    subPath: "document-skills/pdf",
    repoName: "skills"
  });
  assert.deepEqual(parseGitImportUrl("https://github.com/acme/skills/tree/v1.2"), {
    cloneUrl: "https://github.com/acme/skills.git",
    ref: "v1.2",
    subPath: undefined,
    repoName: "skills"
  });
  assert.deepEqual(parseGitImportUrl("https://gitlab.example.com/group/sub/repo/-/tree/dev/skills%20dir?ref_type=heads"), {
    cloneUrl: "https://gitlab.example.com/group/sub/repo.git",
    ref: "dev",
    subPath: "skills dir",
    repoName: "repo"
  });
});

test("git URLs: refused forms", () => {
  const refused = [
    "",
    "   ",
    "file:///srv/repo.git",
    "FILE:///srv/repo",
    "/srv/repo.git",
    "./repo",
    "../repo",
    "~/repo",
    "C:\\repo",
    "--upload-pack=touch /tmp/x",
    "-c core.sshCommand=x",
    "https://user:pass@github.com/acme/skills",
    "https://ghp_token@github.com/acme/skills",
    "ssh://git:secret@github.com/acme/skills",
    "user:pass@github.com:acme/skills",
    "http://github.com/acme/skills",
    "git://github.com/acme/skills",
    "ext::sh -c touch% /tmp/pwned",
    "ftp://example.com/repo",
    "https://github.com/acme/sk\nills",
    "https://github.com/acme/skills repo",
    "ssh://-oProxyCommand=touch/x",
    "ssh://-oProxyCommand@host/x",
    "https://",
    "https://github.com/",
    "https://github.com/acme/skills/tree/main/a%2F..%2F..%2Fetc",
    "https://github.com/acme/skills/tree/main/%2e%2e%5cetc",
    "https://github.com/acme/skills/tree/-main/x",
    "https://github.com/acme/skills/tree/a..b/x",
    `https://github.com/${"a".repeat(2100)}`
  ];
  for (const url of refused) {
    assert.throws(() => parseGitImportUrl(url), expectCode("IMPORT_FAILED"), url);
  }
  assert.throws(() => parseGitImportUrl("https://user:hunter2@github.com/a/b"), (error: unknown) => {
    assert.ok(isAgentProfileError(error));
    assert.ok(!error.message.includes("hunter2"), "the credential is not echoed");
    return true;
  });
});

test("the git clone argv keeps the URL after -- and never uses a shell", () => {
  assert.deepEqual(gitCloneArgs("https://github.com/a/b.git", "main", "/tmp/x"), [
    "clone",
    "--depth",
    "1",
    "--branch",
    "main",
    "--no-tags",
    "--single-branch",
    "-c",
    "core.symlinks=false",
    "--",
    "https://github.com/a/b.git",
    "/tmp/x"
  ]);
  assert.deepEqual(gitCloneArgs("git@h:a/b", undefined, "/d").slice(-3), ["--", "git@h:a/b", "/d"]);
});

// ---------------------------------------------------------------------------
// Git scans (injected clone copying a fixture)
// ---------------------------------------------------------------------------

test("a git scan lists skills and commands, skipping symlinks, depth and node_modules", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orquester-profile-fixture-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await makeFixture(root);
  const { store, clones, dir } = await scratch(t, { fixture, existingItems: ["skill:alpha", "command:review"] });

  const scan = await store.scanGit("claude", "https://github.com/acme/skills");
  assert.deepEqual(clones, [{ url: "https://github.com/acme/skills", ref: undefined }]);
  assert.deepEqual(
    scan.candidates.map((c) => [c.ref, c.kind, c.name, c.exists]),
    [
      [".claude/commands/Hello World.md", "command", "hello-world", false],
      ["a/b/c/d/e/six", "skill", "six", false],
      ["commands/git/pr.md", "command", "git/pr", false],
      ["commands/review.md", "command", "review", true],
      ["skills/Beta Skill", "skill", "beta-skill", false],
      ["skills/alpha", "skill", "alpha", true]
    ]
  );
  assert.equal(scan.candidates.find((c) => c.name === "alpha")?.description, "Alpha");
  const notes = scan.notes.join("\n");
  assert.match(notes, /Skipped skills\/linked: it contains a symlink \(passwd\)/);
  assert.match(notes, /Skipped skills\/link-skill: its SKILL.md is a symlink/);
  assert.match(notes, /Skipped commands\/evil.md: it is a symlink/);
  assert.match(notes, /Skipped symlink skills\/alias/);
  assert.match(notes, /Skipped skills\/broken: SKILL.md could not be read/);
  assert.ok(!notes.includes("seven") && !notes.includes("dep"));

  const [importDir] = await importDirs(dir);
  assert.equal(importDir, scan.importId);
  await assert.rejects(lstat(join(dir, scan.importId, "tree", ".git")), { code: "ENOENT" }, ".git is removed");
});

test("a tree URL clones the repo at the ref and scans only the folder", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orquester-profile-fixture-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await makeFixture(root);
  const { store, clones } = await scratch(t, { fixture });
  const scan = await store.scanGit("claude", "https://github.com/acme/skills/tree/main/skills/alpha");
  assert.deepEqual(clones, [{ url: "https://github.com/acme/skills.git", ref: "main" }]);
  assert.deepEqual(scan.candidates, [{ ref: ".", kind: "skill", name: "alpha", description: "Alpha", exists: false }]);

  await assert.rejects(store.scanGit("claude", "https://github.com/acme/skills/tree/main/nope"), expectCode("IMPORT_FAILED"));
  await assert.rejects(store.scanGit("claude", "https://github.com/acme/skills/tree/main/skills/alias"), (error: unknown) => {
    assert.ok(isAgentProfileError(error));
    assert.match(error.message, /symlink/);
    return true;
  });
});

test("a skill at the repository root is named after the repository", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orquester-profile-fixture-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(join(root, "repo", "SKILL.md"), skillText({ description: "Root skill" }));
  const { store } = await scratch(t, { fixture: join(root, "repo") });
  const scan = await store.scanGit("grok", "git@github.com:acme/My_Skill.git");
  assert.deepEqual(scan.candidates, [{ ref: ".", kind: "skill", name: "my-skill", description: "Root skill", exists: false }]);
});

test("a refused URL never reaches the clone", async (t) => {
  const { store, clones } = await scratch(t, { fixture: "/nonexistent" });
  await assert.rejects(store.scanGit("claude", "file:///etc"), expectCode("IMPORT_FAILED"));
  await assert.rejects(store.scanGit("claude", "https://tok@github.com/a/b"), expectCode("IMPORT_FAILED"));
  assert.deepEqual(clones, []);
});

test("a failed clone is an IMPORT_FAILED and leaves nothing behind", async (t) => {
  const { store, dir } = await scratch(t, {
    clone: async (_url, _ref, dest) => {
      await mkdir(dest, { recursive: true });
      throw new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled");
    }
  });
  await assert.rejects(store.scanGit("claude", "https://github.com/a/private"), (error: unknown) => {
    assert.ok(isAgentProfileError(error));
    assert.equal(error.code, "IMPORT_FAILED");
    assert.match(error.message, /Could not clone https:\/\/github.com\/a\/private: fatal/);
    return true;
  });
  assert.deepEqual(await importDirs(dir), []);
});

test("an empty scan is a 400 IMPORT_FAILED and removes the clone", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orquester-profile-fixture-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(join(root, "repo", "README.md"), "nothing\n");
  const { store, dir } = await scratch(t, { fixture: join(root, "repo") });
  await assert.rejects(store.scanGit("claude", "https://github.com/a/b"), (error: unknown) => {
    assert.ok(isAgentProfileError(error));
    assert.equal(error.status, 400);
    assert.equal(error.code, "IMPORT_FAILED");
    assert.match(error.message, /^No skills or commands found/);
    return true;
  });
  assert.deepEqual(await importDirs(dir), []);
});

test("a checkout over 50 MB is refused and removed", async (t) => {
  const { store, dir } = await scratch(t, {
    clone: async (_url, _ref, dest) => {
      await put(join(dest, "skills", "big", "SKILL.md"), skillText({ name: "big", description: "Big" }));
      // Sparse: counts as 51 MB without writing it.
      await put(join(dest, "skills", "big", "blob.bin"), "");
      await truncate(join(dest, "skills", "big", "blob.bin"), 51 * 1024 * 1024);
    }
  });
  await assert.rejects(store.scanGit("claude", "https://github.com/a/big"), (error: unknown) => {
    assert.ok(isAgentProfileError(error));
    assert.equal(error.code, "IMPORT_FAILED");
    assert.match(error.message, /larger than 50 MB/);
    return true;
  });
  assert.deepEqual(await importDirs(dir), []);
});

test("the .git directory does not count toward the size cap", async (t) => {
  const { store } = await scratch(t, {
    clone: async (_url, _ref, dest) => {
      await put(join(dest, "skills", "s", "SKILL.md"), skillText({ name: "s", description: "S" }));
      await put(join(dest, ".git", "pack.bin"), "");
      await truncate(join(dest, ".git", "pack.bin"), 60 * 1024 * 1024);
    }
  });
  const scan = await store.scanGit("claude", "https://github.com/a/b");
  assert.equal(scan.candidates.length, 1);
});

// ---------------------------------------------------------------------------
// Codex and Grok candidates
// ---------------------------------------------------------------------------

test("Codex: commands are offered as skills and converted when taken", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orquester-profile-fixture-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await makeFixture(root);
  const { store, dir } = await scratch(t, { fixture, existingItems: ["skill:git-pr"] });
  const scan = await store.scanGit("codex", "https://github.com/acme/skills");
  const pr = scan.candidates.find((c) => c.ref === "commands/git/pr.md");
  assert.deepEqual(pr, { ref: "commands/git/pr.md", kind: "skill", name: "git-pr", description: "Open a PR", exists: true });
  assert.ok(scan.notes.some((note) => /Codex has no custom commands: 3 commands are offered as skills/.test(note)));

  const taken = await store.take("codex", scan.importId, ["commands/git/pr.md", "commands/review.md", "skills/alpha"]);
  assert.equal(taken.items.length, 3);
  const [prItem, reviewItem, alphaItem] = taken.items;
  assert.ok(prItem?.kind === "skill" && reviewItem?.kind === "skill" && alphaItem?.kind === "skill");
  assert.equal(prItem.name, "git-pr");
  assert.ok(prItem.dir.startsWith(join(dir, scan.importId)), "inside the import");
  const prDoc = parseMarkdownDocument(await readFile(join(prItem.dir, "SKILL.md"), "utf8"));
  assert.deepEqual(prDoc.frontmatter, { name: "git-pr", description: "Open a PR" });
  assert.equal(prDoc.body, "Open a PR\n");
  const reviewDoc = parseMarkdownDocument(await readFile(join(reviewItem.dir, "SKILL.md"), "utf8"));
  assert.deepEqual(reviewDoc.frontmatter, { name: "review", description: "Review" });
  const alphaDoc = parseMarkdownDocument(await readFile(join(alphaItem.dir, "SKILL.md"), "utf8"));
  assert.deepEqual(alphaDoc.frontmatter, { name: "alpha", description: "Alpha" }, "Codex skills keep name and description");
  assert.ok(taken.notes.some((note) => note.startsWith("git-pr: Codex has no custom commands")));
  assert.ok(taken.notes.some((note) => note === "alpha: Dropped frontmatter keys Codex does not use: when_to_use, x-custom."));
  await taken.release();
  assert.deepEqual(await importDirs(dir), []);
});

test("Grok: nested commands are offered flat", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orquester-profile-fixture-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await makeFixture(root);
  const { store } = await scratch(t, { fixture, existingItems: ["command:git-pr"] });
  const scan = await store.scanGit("grok", "https://github.com/acme/skills");
  assert.deepEqual(
    scan.candidates.find((c) => c.ref === "commands/git/pr.md"),
    { ref: "commands/git/pr.md", kind: "command", name: "git-pr", description: "Open a PR", exists: true }
  );
  const taken = await store.take("grok", scan.importId, ["commands/git/pr.md", "skills/alpha"]);
  assert.deepEqual(taken.items[0], { kind: "command", name: "git-pr", frontmatter: { description: "Open a PR" }, body: "Open a PR\n" });
  const alpha = taken.items[1];
  assert.ok(alpha?.kind === "skill");
  const doc = parseMarkdownDocument(await readFile(join(alpha.dir, "SKILL.md"), "utf8"));
  assert.deepEqual(doc.frontmatter, { name: "alpha", description: "Alpha", "when-to-use": "Often" });
  assert.ok(await readFile(join(alpha.dir, "scripts", "run.sh"), "utf8"));
  await taken.release();
});

// ---------------------------------------------------------------------------
// take / release / expiry / stop
// ---------------------------------------------------------------------------

test("take: commands carry parsed frontmatter mapped to the agent; skills stay in the import until release", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orquester-profile-fixture-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await makeFixture(root);
  const { store, dir } = await scratch(t, { fixture });
  const scan = await store.scanGit("opencode", "https://github.com/acme/skills");

  await assert.rejects(store.take("opencode", scan.importId, ["nope"]), expectCode("INVALID_REQUEST"));
  await assert.rejects(store.take("opencode", scan.importId, []), expectCode("INVALID_REQUEST"));
  await assert.rejects(store.take("claude", scan.importId, ["commands/review.md"]), expectCode("IMPORT_NOT_FOUND"), "another agent's import");
  await assert.rejects(store.take("opencode", "unknown", ["commands/review.md"]), expectCode("IMPORT_NOT_FOUND"));

  const taken = await store.take("opencode", scan.importId, ["commands/review.md", "commands/review.md", "skills/alpha"]);
  assert.equal(taken.items.length, 2, "picks are deduplicated");
  assert.deepEqual(taken.items[0], {
    kind: "command",
    name: "review",
    frontmatter: { description: "Review", model: "opus" },
    body: "Review $ARGUMENTS\n"
  });
  assert.ok(taken.notes.includes("review: Dropped frontmatter keys OpenCode does not use: x-custom."));
  const skill = taken.items[1];
  assert.ok(skill?.kind === "skill");
  assert.ok((await lstat(skill.dir)).isDirectory());

  await assert.rejects(store.take("opencode", scan.importId, ["skills/alpha"]), expectCode("IMPORT_NOT_FOUND"), "single-use");
  await taken.release();
  await taken.release();
  await Promise.all([taken.release(), taken.release()]);
  await assert.rejects(lstat(skill.dir), { code: "ENOENT" });
  assert.deepEqual(await importDirs(dir), []);
});

test("an import expires after the TTL, swept lazily on the next call", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orquester-profile-fixture-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await makeFixture(root);
  const { store, clock, dir } = await scratch(t, { fixture, ttlMs: 60_000 });
  const first = await store.scanGit("claude", "https://github.com/acme/skills");
  clock.now += 59_999;
  const second = await store.scanGit("claude", "https://github.com/acme/skills");
  assert.deepEqual((await importDirs(dir)).sort(), [first.importId, second.importId].sort());
  clock.now += 1;
  await assert.rejects(store.take("claude", first.importId, ["skills/alpha"]), expectCode("IMPORT_NOT_FOUND"));
  assert.deepEqual(await importDirs(dir), [second.importId], "the expired tree is removed");

  // A taken import gets one more TTL, then goes even without release().
  const taken = await store.take("claude", second.importId, ["skills/alpha"]);
  clock.now += 60_000;
  await assert.rejects(store.take("claude", second.importId, ["skills/alpha"]), expectCode("IMPORT_NOT_FOUND"));
  assert.deepEqual(await importDirs(dir), []);
  await taken.release();
});

test("the sweep removes directories a previous run leaked once they are old", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orquester-profile-fixture-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await makeFixture(root);
  const { store, clock, dir } = await scratch(t, { fixture });
  clock.now = Date.now();
  await put(join(dir, "old-import", "tree", "x"), "x");
  await put(join(dir, "convert-abc123", "SKILL.md"), "x");
  await put(join(dir, "fresh", "x"), "x");
  const old = new Date(clock.now - 16 * 60_000);
  await utimes(join(dir, "old-import"), old, old);
  await utimes(join(dir, "convert-abc123"), old, old);
  const scan = await store.scanGit("claude", "https://github.com/acme/skills");
  assert.deepEqual((await importDirs(dir)).sort(), ["fresh", scan.importId].sort());
});

test("stop() removes every import and refuses new ones", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orquester-profile-fixture-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await makeFixture(root);
  const { store, dir } = await scratch(t, { fixture });
  const scan = await store.scanGit("claude", "https://github.com/acme/skills");
  await store.stop();
  await assert.rejects(lstat(dir), { code: "ENOENT" });
  await assert.rejects(store.take("claude", scan.importId, ["skills/alpha"]), expectCode("IMPORT_NOT_FOUND"));
  await assert.rejects(store.scanGit("claude", "https://github.com/acme/skills"), expectCode("IMPORT_FAILED"));
});

test("open imports are capped", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orquester-profile-fixture-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await makeFixture(root);
  const { store } = await scratch(t, { fixture, limits: { maxOpenImports: 2 } });
  const first = await store.scanGit("claude", "https://github.com/acme/skills");
  await store.scanGit("claude", "https://github.com/acme/skills");
  await assert.rejects(store.scanGit("claude", "https://github.com/acme/skills"), expectCode("IMPORT_FAILED"));
  const taken = await store.take("claude", first.importId, ["skills/alpha"]);
  await taken.release();
  await store.scanGit("claude", "https://github.com/acme/skills");
});

// ---------------------------------------------------------------------------
// Real git against a local bare repository
// ---------------------------------------------------------------------------

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }
  });
}

test("real git: a shallow clone of a local bare repo, symlinks refused, subfolder selected", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orquester-profile-git-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, "work");
  await put(join(work, "skills", "alpha", "SKILL.md"), skillText({ name: "alpha", description: "Alpha" }));
  await put(join(work, "skills", "linked", "SKILL.md"), skillText({ name: "linked", description: "Linked" }));
  await symlink("/etc/passwd", join(work, "skills", "linked", "passwd"));
  await put(join(work, "other", "gamma", "SKILL.md"), skillText({ name: "gamma", description: "Gamma" }));
  await git(root, "init", "-q", work);
  await git(work, "add", "-A");
  await git(work, "commit", "-q", "-m", "skills");
  await git(root, "clone", "-q", "--bare", work, join(root, "bare.git"));

  const bareUrl = `file://${join(root, "bare.git")}`;
  const seen: string[] = [];
  // file:// is permitted ONLY here: the store is handed an https URL and this clone redirects it.
  const clone: GitCloneFn = (url, ref, dest, options) => {
    seen.push(`${url}@${ref}`);
    return gitClone(bareUrl, ref, dest, { ...options, allowProtocols: "file" });
  };
  const { store, dir } = await scratch(t, { clone });
  const scan = await store.scanGit("claude", "https://git.example.invalid/acme/skills/tree/main/skills");
  assert.deepEqual(seen, ["https://git.example.invalid/acme/skills.git@main"]);
  assert.deepEqual(scan.candidates.map((c) => c.name), ["alpha"]);
  assert.ok(scan.notes.some((note) => /Skipped linked: it contains a symlink \(passwd\)/.test(note)), scan.notes.join("|"));
  await assert.rejects(lstat(join(dir, scan.importId, "tree", ".git")), { code: "ENOENT" });

  // The default protocol allowlist refuses file:// even when a caller forgets the URL check.
  await assert.rejects(
    gitClone(bareUrl, undefined, join(root, "refused"), { timeoutMs: 30_000 }),
    expectCode("IMPORT_FAILED")
  );
  await assert.rejects(gitClone(bareUrl, "no-such-branch", join(root, "nobranch"), { timeoutMs: 30_000, allowProtocols: "file" }), expectCode("IMPORT_FAILED"));
});

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

test("upload: a zip is extracted and scanned", async (t) => {
  const { store, root } = await scratch(t);
  const zip = makeZip([
    { name: "pack/" },
    { name: "pack/skills/alpha/SKILL.md", data: skillText({ name: "alpha", description: "Alpha" }), deflate: true },
    { name: "pack/skills/alpha/run.sh", data: "echo hi\n", mode: 0o100755 },
    { name: "pack/commands/review.md", data: skillText({ description: "Review" }, "Review\n") },
    { name: "__MACOSX/pack/._x", data: "junk" }
  ]);
  const file = await writeUpload(root, "pack.zip", zip);
  const scan = await store.scanUpload("claude", "pack.zip", file);
  assert.deepEqual(
    scan.candidates.map((c) => [c.ref, c.kind, c.name]),
    [
      ["pack/commands/review.md", "command", "review"],
      ["pack/skills/alpha", "skill", "alpha"]
    ]
  );
  const taken = await store.take("claude", scan.importId, ["pack/skills/alpha"]);
  const item = taken.items[0];
  assert.ok(item?.kind === "skill");
  assert.equal((await lstat(join(item.dir, "run.sh"))).mode & 0o777, 0o755);
  await taken.release();
});

test("upload: a zip with a traversal, an absolute path, a drive letter or a symlink is refused whole", async (t) => {
  const { store, root, dir } = await scratch(t);
  const good = { name: "skills/a/SKILL.md", data: skillText({ name: "a", description: "A" }) };
  const cases: [string, ZipEntrySpec[]][] = [
    ["traversal", [good, { name: "../evil.md", data: "x" }]],
    ["nested traversal", [good, { name: "skills/../../evil.md", data: "x" }]],
    ["backslash traversal", [good, { name: "..\\evil.md", data: "x" }]],
    ["absolute", [good, { name: "/tmp/evil.md", data: "x" }]],
    ["drive letter", [good, { name: "C:/evil.md", data: "x" }]],
    ["symlink", [good, { name: "skills/a/link", data: "/etc/passwd", mode: 0o120777 }]]
  ];
  for (const [label, entries] of cases) {
    const file = await writeUpload(root, `${label}.zip`, makeZip(entries));
    await assert.rejects(store.scanUpload("claude", `${label}.zip`, file), expectCode("IMPORT_FAILED"), label);
    assert.deepEqual(await importDirs(dir), [], `${label}: nothing left behind`);
  }
  await assert.rejects(lstat(join(root, "evil.md")), { code: "ENOENT" });
  await assert.rejects(lstat(join(dirname(dir), "evil.md")), { code: "ENOENT" });
});

test("upload: zip entry and size caps", async (t) => {
  const { store, root, dir } = await scratch(t, { limits: { maxZipEntries: 3, maxZipBytes: 1000 } });
  const skill = { name: "s/SKILL.md", data: skillText({ name: "s", description: "S" }) };
  const many = await writeUpload(root, "many.zip", makeZip([skill, { name: "a" }, { name: "b" }, { name: "c" }]));
  await assert.rejects(store.scanUpload("claude", "many.zip", many), (error: unknown) => {
    assert.ok(isAgentProfileError(error));
    assert.match(error.message, /more than 3 entries/);
    return true;
  });
  const big = await writeUpload(root, "big.zip", makeZip([skill, { name: "s/blob", data: Buffer.alloc(2000), deflate: true }]));
  await assert.rejects(store.scanUpload("claude", "big.zip", big), (error: unknown) => {
    assert.ok(isAgentProfileError(error));
    assert.match(error.message, /more than 1000 bytes/);
    return true;
  });
  // A header that under-declares its size is caught while inflating.
  const lying = await writeUpload(
    root,
    "lying.zip",
    makeZip([skill, { name: "s/blob", data: Buffer.alloc(5000), deflate: true, declaredSize: 10 }])
  );
  await assert.rejects(store.scanUpload("claude", "lying.zip", lying), expectCode("IMPORT_FAILED"));
  assert.deepEqual(await importDirs(dir), []);
});

test("upload: the default caps are 5000 entries and 100 MB", async (t) => {
  const { store, root } = await scratch(t);
  const entries: ZipEntrySpec[] = [];
  for (let i = 0; i < 5001; i += 1) entries.push({ name: `d${i}/` });
  const many = await writeUpload(root, "many.zip", makeZip(entries));
  await assert.rejects(store.scanUpload("claude", "many.zip", many), (error: unknown) => {
    assert.ok(isAgentProfileError(error));
    assert.match(error.message, /more than 5000 entries/);
    return true;
  });
  const tenMb = Buffer.alloc(10 * 1024 * 1024);
  const huge: ZipEntrySpec[] = [];
  for (let i = 0; i < 11; i += 1) huge.push({ name: `blob${i}`, data: tenMb, deflate: true });
  const bomb = await writeUpload(root, "bomb.zip", makeZip(huge));
  await assert.rejects(store.scanUpload("claude", "bomb.zip", bomb), (error: unknown) => {
    assert.ok(isAgentProfileError(error));
    assert.match(error.message, /more than 104857600 bytes/);
    return true;
  });
});

test("upload: a file that is not a zip is refused", async (t) => {
  const { store, root } = await scratch(t);
  const file = await writeUpload(root, "fake.zip", "not a zip at all");
  await assert.rejects(store.scanUpload("claude", "fake.zip", file), expectCode("IMPORT_FAILED"));
});

test("upload: a SKILL.md is one skill, any other .md one command, anything else refused", async (t) => {
  const { store, root } = await scratch(t);
  const skillFile = await writeUpload(root, "SKILL.md", skillText({ name: "pdf-tools", description: "PDF" }));
  const skill = await store.scanUpload("claude", "SKILL.md", skillFile);
  assert.deepEqual(skill.candidates, [{ ref: "skill", kind: "skill", name: "pdf-tools", description: "PDF", exists: false }]);

  const unnamed = await writeUpload(root, "unnamed/SKILL.md", skillText({ description: "No name" }));
  const noName = await store.scanUpload("claude", "SKILL.md", unnamed);
  assert.equal(noName.candidates[0]?.name, "skill");

  const commandFile = await writeUpload(root, "Fix Bug.md", skillText({ description: "Fix" }, "Fix $ARGUMENTS\n"));
  const command = await store.scanUpload("claude", "C:\\Users\\me\\Fix Bug.md", commandFile);
  assert.deepEqual(command.candidates, [
    { ref: "commands/fix-bug.md", kind: "command", name: "fix-bug", description: "Fix", exists: false }
  ]);
  const taken = await store.take("claude", command.importId, ["commands/fix-bug.md"]);
  assert.deepEqual(taken.items, [{ kind: "command", name: "fix-bug", frontmatter: { description: "Fix" }, body: "Fix $ARGUMENTS\n" }]);
  await taken.release();

  const codex = await store.scanUpload("codex", "Fix Bug.md", commandFile);
  assert.equal(codex.candidates[0]?.kind, "skill");

  const bad = await writeUpload(root, "bad.md", "---\nname: [oops\n---\n");
  await assert.rejects(store.scanUpload("claude", "bad.md", bad), expectCode("IMPORT_FAILED"));
  await assert.rejects(store.scanUpload("claude", "!!!.md", commandFile), expectCode("IMPORT_FAILED"));
  await assert.rejects(store.scanUpload("claude", "notes.txt", commandFile), expectCode("IMPORT_FAILED"));
  await assert.rejects(store.scanUpload("claude", "archive.tar.gz", commandFile), expectCode("IMPORT_FAILED"));
});

test("upload: the upload file is not needed after the scan", async (t) => {
  const { store, root } = await scratch(t);
  const file = await writeUpload(root, "x.zip", makeZip([{ name: "s/SKILL.md", data: skillText({ name: "s", description: "S" }) }]));
  const scan = await store.scanUpload("claude", "x.zip", file);
  await rm(file);
  const taken = await store.take("claude", scan.importId, ["s"]);
  assert.equal(taken.items[0]?.kind, "skill");
  await taken.release();
});

test("existing(agent) is asked for the scanning agent", async (t) => {
  const asked: AgentProfileAgentId[] = [];
  const { store, root } = await scratch(t, {
    existing: async (agent) => {
      asked.push(agent);
      return new Set(["command:review"]);
    }
  });
  const file = await writeUpload(root, "review.md", "Review\n");
  const scan = await store.scanUpload("opencode", "review.md", file);
  assert.deepEqual(asked, ["opencode"]);
  assert.equal(scan.candidates[0]?.exists, true);
});
