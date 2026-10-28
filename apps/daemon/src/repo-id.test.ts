import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  detectRepoInfo,
  normalizeGitUrl,
  parseOriginUrl,
  remoteRepoFields
} from "./repo-id";

async function tempDir(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orquester-repo-id-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function gitRepo(dir: string, config: string): Promise<void> {
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(join(dir, ".git", "config"), config, "utf8");
}

const ORIGIN = (url: string): string =>
  `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;

test("normalizeGitUrl collapses every URL form of one repo onto host/path", () => {
  const same = [
    "git@github.com:JasperRaccoon/JasperEngine.git",
    "ssh://git@github.com/JasperRaccoon/JasperEngine.git",
    "ssh://git@GitHub.com:22/JasperRaccoon/JasperEngine",
    "https://github.com/JasperRaccoon/JasperEngine.git",
    "https://github.com/JasperRaccoon/JasperEngine/",
    "https://ghp_secret@github.com/JasperRaccoon/JasperEngine.git",
    "https://user:pass@GITHUB.COM/JasperRaccoon/JasperEngine",
    "  git://github.com/JasperRaccoon/JasperEngine.git  "
  ].map(normalizeGitUrl);
  // The port survives (it is part of the host), so drop that one from the equality set.
  assert.equal(same[2], "github.com:22/JasperRaccoon/JasperEngine");
  for (const id of [...same.slice(0, 2), ...same.slice(3)]) {
    assert.equal(id, "github.com/JasperRaccoon/JasperEngine");
  }
  assert.equal(normalizeGitUrl("github.com:o/r"), "github.com/o/r");
});

test("normalizeGitUrl drops a userinfo whose password holds an unencoded @", () => {
  assert.equal(normalizeGitUrl("https://user:p@ss@github.com/o/r.git"), "github.com/o/r");
});

test("normalizeGitUrl refuses a scheme URL whose authority is ambiguous (an unencoded / in the password)", () => {
  assert.equal(normalizeGitUrl("https://u:p/ss@github.com/o/r.git"), null);
  assert.equal(normalizeGitUrl("ssh://git@host/o/r@x"), null, "an @ left anywhere after the userinfo");
  // Normal URLs keep their ids.
  assert.equal(normalizeGitUrl("https://u:p%2Fss@github.com/o/r.git"), "github.com/o/r");
  assert.equal(normalizeGitUrl("ssh://git@github.com/o/r.git"), "github.com/o/r");
  assert.equal(normalizeGitUrl("git@github.com:o/r.git"), "github.com/o/r");
});

test("detectRepoInfo: an ambiguous origin URL falls back to the realpathed root, and no remote fields", async (t) => {
  const dir = await tempDir(t);
  const url = "https://u:p/ss@github.com/o/r.git";
  await gitRepo(dir, ORIGIN(url));
  const info = await detectRepoInfo(dir);
  assert.equal(info?.repoId.includes("ss@"), false);
  assert.deepEqual(info, { repoId: await realpath(dir), originUrl: url });
  assert.equal(remoteRepoFields(url), null);
});

test("parseOriginUrl reads the first url of [remote \"origin\"] only", () => {
  const config = [
    "[core]",
    "\turl = https://not-a-remote.example/x/y",
    '[remote "upstream"]',
    "\turl = https://github.com/upstream/repo.git",
    '[remote "origin"]',
    "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    "\tpushurl = git@github.com:push/only.git",
    "\turl = git@github.com:me/repo.git",
    "\turl = https://github.com/second/url.git",
    '[branch "main"]',
    "\tremote = origin",
    "\turl = https://github.com/branch/section.git"
  ].join("\n");
  assert.equal(parseOriginUrl(config), "git@github.com:me/repo.git");
});

test("parseOriginUrl honors git value syntax: quotes, escapes, comments, case", () => {
  assert.equal(parseOriginUrl('[remote "origin"]\n  url = "https://github.com/o/r.git"\n'), "https://github.com/o/r.git");
  assert.equal(parseOriginUrl('[remote "origin"]\n  url = "https://h/o/r#x"  ; trailing comment\n'), "https://h/o/r#x");
  assert.equal(parseOriginUrl('[remote "origin"]\n  url = https://h/o/r # comment\n'), "https://h/o/r");
  assert.equal(parseOriginUrl('[remote "origin"]\n  url = "a\\"b"\n'), 'a"b');
  assert.equal(parseOriginUrl('[Remote "origin"]\n\tURL=https://h/o/r\r\n'), "https://h/o/r");
  // Subsection names are case-sensitive: "Origin" is a different remote.
  assert.equal(parseOriginUrl('[remote "Origin"]\n\turl = https://h/o/r\n'), null);
  assert.equal(parseOriginUrl('[remote "origin"]\n\turl =\n'), null);
  assert.equal(parseOriginUrl("[core]\n\tbare = false\n"), null);
  assert.equal(parseOriginUrl(null), null);
});

test("detectRepoInfo: a checkout with an origin yields the normalized id and the raw URL", async (t) => {
  const dir = await tempDir(t);
  await gitRepo(dir, ORIGIN("https://ghp_token@github.com/Me/Repo.git"));
  assert.deepEqual(await detectRepoInfo(dir), {
    repoId: "github.com/Me/Repo",
    originUrl: "https://ghp_token@github.com/Me/Repo.git"
  });
});

test("detectRepoInfo: a local-only repo is identified by its realpathed root", async (t) => {
  const base = await tempDir(t);
  const real = join(base, "real");
  await mkdir(real);
  await gitRepo(real, "[core]\n\tbare = false\n");
  const link = join(base, "link");
  await symlink(real, link);
  const expected = await realpath(real);
  assert.deepEqual(await detectRepoInfo(link), { repoId: expected, originUrl: null });
});

test("detectRepoInfo: a linked worktree resolves to its main repo's config and root", async (t) => {
  const base = await tempDir(t);
  const main = join(base, "main");
  await gitRepo(main, ORIGIN("git@github.com:me/repo.git"));
  await mkdir(join(main, ".git", "worktrees", "feature"), { recursive: true });
  const worktree = join(base, "feature");
  await mkdir(worktree);
  await writeFile(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "feature")}\n`, "utf8");
  assert.deepEqual(await detectRepoInfo(worktree), {
    repoId: "github.com/me/repo",
    originUrl: "git@github.com:me/repo.git"
  });

  // Without an origin the worktree shares the main checkout's realpath, like a sibling clone would share a URL.
  await writeFile(join(main, ".git", "config"), "[core]\n", "utf8");
  assert.deepEqual(await detectRepoInfo(worktree), { repoId: await realpath(main), originUrl: null });
});

test("detectRepoInfo: not a git checkout (or a broken gitfile) is null", async (t) => {
  const dir = await tempDir(t);
  assert.equal(await detectRepoInfo(dir), null);
  assert.equal(await detectRepoInfo(join(dir, "missing")), null);
  await writeFile(join(dir, ".git"), "not a gitfile\n", "utf8");
  assert.equal(await detectRepoInfo(dir), null);
});

test("remoteRepoFields: https token userinfo never survives", () => {
  assert.deepEqual(remoteRepoFields("https://ghp_x@github.com/Owner/Repo.git"), {
    repoKey: "github.com/owner/repo",
    repoName: "Owner/Repo",
    cloneUrl: "https://github.com/Owner/Repo.git"
  });
  assert.deepEqual(remoteRepoFields("https://user:pass@gitlab.example.com/group/sub/repo.git"), {
    repoKey: "gitlab.example.com/group/sub/repo",
    repoName: "group/sub/repo",
    cloneUrl: "https://gitlab.example.com/group/sub/repo.git"
  });
  assert.equal(remoteRepoFields("http://x-access-token:tok@github.com/o/r")?.cloneUrl, "http://github.com/o/r");
});

test("remoteRepoFields: scp-like and ssh logins stay, an ssh password goes", () => {
  assert.deepEqual(remoteRepoFields("git@github.com:Owner/Repo.git"), {
    repoKey: "github.com/owner/repo",
    repoName: "Owner/Repo",
    cloneUrl: "git@github.com:Owner/Repo.git"
  });
  assert.equal(remoteRepoFields("ssh://git@github.com/o/r.git")?.cloneUrl, "ssh://git@github.com/o/r.git");
  assert.equal(remoteRepoFields("ssh://git:secret@host.example/o/r.git")?.cloneUrl, "ssh://git@host.example/o/r.git");
});

test("remoteRepoFields: malformed userinfo that stripping cannot remove yields nothing", () => {
  for (const url of [
    "https://user:p@ss@github.com/o/r.git",
    "https://user:pa/ss@github.com/o/r.git",
    "https://user:pa/a/b?s@github.com/o/r.git",
    "https://user:p?ss@github.com/o/r.git",
    "ssh://git:p@ss@host.example/o/r.git"
  ]) {
    const fields = remoteRepoFields(url);
    assert.equal(fields, null, url);
  }
});

test("remoteRepoFields: no parseable remote, no fields", () => {
  assert.equal(remoteRepoFields("/srv/git/repo.git"), null);
  assert.equal(remoteRepoFields("file:///srv/git/repo.git"), null);
  assert.equal(remoteRepoFields("https://github.com/only-owner"), null);
  assert.equal(remoteRepoFields("ext::sh -c evil"), null);
});
