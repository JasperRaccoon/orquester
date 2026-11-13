import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SelfUpdateService, githubRepoFromRemoteUrl, type SelfUpdateDeps } from "./service.ts";

const RUNNING = "a".repeat(40);
const HEAD = "b".repeat(40);
const FROM = "c".repeat(40);

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orq-self-update-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function gitConfig(url: string): string {
  return `[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:someone/else.git\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
}

/** A checkout whose `.git/config` names `origin`. */
async function checkout(t: TestContext, url = "git@github.com:JasperRaccoon/orquester.git"): Promise<string> {
  const root = await tempDir(t);
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git", "config"), gitConfig(url));
  return root;
}

type Answer = { status?: number; body: unknown } | Error;

/** A fetch answering `answers` in turn; records each request. */
function fakeFetch(answers: Answer[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: init?.headers as Record<string, string> });
    const answer = answers.shift();
    if (answer === undefined) throw new Error("unexpected fetch");
    if (answer instanceof Error) throw answer;
    return new Response(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

async function service(t: TestContext, deps: Partial<SelfUpdateDeps> = {}): Promise<SelfUpdateService> {
  const dir = await tempDir(t);
  const s = new SelfUpdateService({
    repoRoot: await checkout(t),
    commit: RUNNING,
    requestPath: join(dir, "daemon", "update-request"),
    statusPath: null,
    logger: { warn: () => undefined },
    now: () => Date.parse("2026-11-13T10:30:00Z"),
    ...deps
  });
  t.after(() => s.stop());
  return s;
}

test("reports behind with the count and the branch head", async (t) => {
  const { fetch, calls } = fakeFetch([{ body: { status: "behind", behind_by: 3, ahead_by: 0, base_commit: { sha: HEAD } } }]);
  const s = await service(t, { fetch });
  await s.check();
  const status = await s.status();
  assert.equal(status.behindBy, 3);
  assert.equal(status.latest, HEAD);
  assert.equal(status.error, null);
  assert.equal(status.repo, "JasperRaccoon/orquester");
  assert.equal(status.current, RUNNING);
  assert.equal(status.branch, "main");
  assert.equal(typeof status.checkedAt, "string");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `https://api.github.com/repos/JasperRaccoon/orquester/compare/main...${RUNNING}`);
  assert.equal(calls[0]!.headers.Accept, "application/vnd.github+json");
  assert.equal(calls[0]!.headers["User-Agent"], "orquester-daemon");
});

test("ahead, diverged or identical is not out of date", async (t) => {
  const { fetch } = fakeFetch([
    { body: { status: "ahead", behind_by: 0, ahead_by: 2, base_commit: { sha: HEAD } } },
    { body: { status: "diverged", behind_by: 4, ahead_by: 1, base_commit: { sha: HEAD } } },
    { body: { status: "identical", behind_by: 0, base_commit: { sha: HEAD } } }
  ]);
  const s = await service(t, { fetch });
  for (let i = 0; i < 3; i++) {
    await s.check();
    const status = await s.status();
    assert.equal(status.behindBy, 0);
    assert.equal(status.latest, HEAD);
    assert.equal(status.error, null);
  }
});

test("a failed check keeps the last result and records the error", async (t) => {
  const { fetch } = fakeFetch([
    { body: { status: "behind", behind_by: 3, base_commit: { sha: HEAD } } },
    new TypeError("fetch failed"),
    { status: 403, body: { message: "API rate limit exceeded" } },
    { body: "not json" },
    { body: { status: "behind", behind_by: 5, base_commit: { sha: HEAD } } }
  ]);
  const warnings: string[] = [];
  const s = await service(t, { fetch, logger: { warn: (m) => warnings.push(m) } });
  await s.check();
  const { checkedAt } = await s.status();

  for (const expected of [/reached/, /rate limit/, /unexpected/]) {
    await s.check();
    const status = await s.status();
    assert.equal(status.behindBy, 3);
    assert.equal(status.latest, HEAD);
    assert.equal(status.checkedAt, checkedAt);
    assert.match(status.error ?? "", expected);
  }
  assert.equal(warnings.length, 3);

  await s.check();
  const recovered = await s.status();
  assert.equal(recovered.behindBy, 5);
  assert.equal(recovered.error, null);
});

test("overlapping checks share one request", async (t) => {
  const { fetch, calls } = fakeFetch([{ body: { status: "behind", behind_by: 1, base_commit: { sha: HEAD } } }]);
  const s = await service(t, { fetch });
  await Promise.all([s.check(), s.check()]);
  assert.equal(calls.length, 1);
  assert.equal((await s.status()).behindBy, 1);
});

test("no GitHub origin or an unknown commit reports why and never fetches", async (t) => {
  const { fetch, calls } = fakeFetch([]);
  const cases: Partial<SelfUpdateDeps>[] = [
    { repoRoot: await checkout(t, "https://gitlab.com/o/r.git") },
    { repoRoot: await tempDir(t) },
    { repoRoot: null },
    { commit: null }
  ];
  for (const deps of cases) {
    const s = await service(t, { fetch, ...deps });
    s.start();
    await s.check();
    const status = await s.status();
    assert.equal(status.behindBy, 0);
    assert.equal(status.latest, null);
    assert.equal(typeof status.error, "string");
  }
  assert.equal(calls.length, 0);
});

test("githubRepoFromRemoteUrl reads the GitHub URL forms and rejects others", () => {
  for (const url of [
    "git@github.com:o/r.git",
    "git@github.com:o/r",
    "https://github.com/o/r.git",
    "https://github.com/o/r",
    "https://user:token@github.com/o/r.git",
    "ssh://git@github.com/o/r.git",
    "ssh://git@github.com/o/r"
  ]) {
    assert.equal(githubRepoFromRemoteUrl(url), "o/r", url);
  }
  for (const url of ["https://gitlab.com/o/r", "git@gitlab.com:o/r.git", "https://github.com/o/r/tree/main", "https://github.com/o", "not a url", "", "https://github.com.evil.com/o/r"]) {
    assert.equal(githubRepoFromRemoteUrl(url), null, url);
  }
});

test("reads origin from the main repository of a linked worktree", async (t) => {
  const main = await checkout(t, "https://github.com/owner/fork.git");
  const gitDir = join(main, ".git", "worktrees", "wt");
  await mkdir(gitDir, { recursive: true });
  await writeFile(join(gitDir, "commondir"), "../..\n");
  const worktree = await tempDir(t);
  await writeFile(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
  const { fetch, calls } = fakeFetch([{ body: { status: "identical", behind_by: 0, base_commit: { sha: HEAD } } }]);
  const s = await service(t, { fetch, repoRoot: worktree });
  await s.check();
  assert.equal((await s.status()).repo, "owner/fork");
  assert.match(calls[0]!.url, /\/repos\/owner\/fork\/compare\//);
});

test("requestUpdate: unavailable without a status file, busy while running or pending", async (t) => {
  const dir = await tempDir(t);
  const requestPath = join(dir, "daemon", "update-request");
  const statusPath = join(dir, "status.json");

  const unavailable = await service(t, { requestPath, statusPath: null });
  assert.equal(await unavailable.requestUpdate(), "unavailable");
  await assert.rejects(access(requestPath));

  const s = await service(t, { requestPath, statusPath });
  await writeFile(statusPath, JSON.stringify({ state: "running", from: FROM, startedAt: "2026-11-13T10:00:00Z" }));
  assert.deepEqual(await s.requestUpdate(), { busy: true, requestedAt: "2026-11-13T10:00:00Z" }, "follow the running run");
  await assert.rejects(access(requestPath));

  await writeFile(statusPath, JSON.stringify({ state: "failed", from: FROM, startedAt: "2026-11-13T10:00:00Z", finishedAt: "2026-11-13T10:05:00Z", exitCode: 1 }));
  assert.deepEqual(await s.requestUpdate(), { started: true, requestedAt: "2026-11-13T10:30:00.000Z" });
  await utimes(requestPath, new Date("2026-11-13T10:30:00Z"), new Date("2026-11-13T10:30:00Z"));
  assert.deepEqual(await s.requestUpdate(), { busy: true, requestedAt: "2026-11-13T10:30:00.000Z" }, "follow the pending request");
  assert.equal((await s.status()).requestStalled, false);
});

test("a request the host updater never took is reported, and a new request replaces it", async (t) => {
  const dir = await tempDir(t);
  const requestPath = join(dir, "daemon", "update-request");
  let now = Date.parse("2026-11-13T10:30:00Z");
  const s = await service(t, { requestPath, statusPath: join(dir, "status.json"), now: () => now });
  assert.equal(typeof (await s.requestUpdate()), "object");
  const made = new Date(now);
  await utimes(requestPath, made, made);

  now += 60_000;
  assert.equal((await s.status()).requestStalled, false, "still within the updater's pickup time");
  assert.deepEqual(await s.requestUpdate(), { busy: true, requestedAt: made.toISOString() });

  now += 5 * 60_000;
  assert.equal((await s.status()).requestStalled, true);
  assert.deepEqual(await s.requestUpdate(), { started: true, requestedAt: new Date(now).toISOString() });
  await utimes(requestPath, new Date(now), new Date(now));
  assert.equal((await s.status()).requestStalled, false, "the new request is fresh");
});

test("status().run is the status file's run, null when missing or garbage", async (t) => {
  const dir = await tempDir(t);
  const statusPath = join(dir, "status.json");
  const s = await service(t, { statusPath });
  assert.equal((await s.status()).run, null);
  assert.equal((await s.status()).canUpdate, true);

  await writeFile(statusPath, JSON.stringify({ state: "reverted", from: FROM, startedAt: "2026-11-13T10:00:00Z", finishedAt: "2026-11-13T10:05:00Z", exitCode: 3, extra: 1 }));
  assert.deepEqual((await s.status()).run, { state: "reverted", from: FROM, startedAt: "2026-11-13T10:00:00Z", finishedAt: "2026-11-13T10:05:00Z", exitCode: 3 });

  for (const garbage of ["{not json", JSON.stringify({ state: "exploded", startedAt: "x" }), "[]"]) {
    await writeFile(statusPath, garbage);
    assert.equal((await s.status()).run, null);
  }

  // Cut off without an outcome (a reboot mid-run): failed, and no longer blocking a new request.
  await writeFile(statusPath, JSON.stringify({ state: "running", from: FROM, startedAt: "2026-11-13T07:00:00Z" }));
  assert.equal((await s.status()).run?.state, "failed");
  assert.equal(typeof (await s.requestUpdate()), "object", "started");

  const without = await service(t, { statusPath: null });
  assert.equal((await without.status()).canUpdate, false);
  assert.equal((await without.status()).run, null);
});
