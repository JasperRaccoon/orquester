import assert from "node:assert/strict";
import test from "node:test";
import type { GitTriggerPayload } from "@orquester/api";
import type { LsRemoteResult } from "../git-remote/index.ts";
import { GitRemoteError, type ConditionalListOptions, type PullRequestInfo, type ReleaseInfo } from "../../providers/types.ts";
import { ManualClock } from "./clock.ts";
import { createGitPoller, MAX_BACKOFF_MS, type GitRemoteReader } from "./git-poller.ts";
import type { ResolveRepo } from "./repo-resolve.ts";
import { advance, fakeHost, memoryState, node, recordingLogger, workflow } from "./test-support.ts";

const S = 1_000;
const sha = (c: string) => c.repeat(40);
const URL = "https://github.com/acme/app.git";

class FakeRemote implements GitRemoteReader {
  heads: Record<string, string> = { main: sha("a") };
  tags: Record<string, { sha: string; commit: string }> = {};
  defaultBranch: string | undefined = "main";
  prs: PullRequestInfo[] = [];
  releases: ReleaseInfo[] = [];
  lsCalls: { accountId: string | null; url: string; defaultBranch: boolean | undefined }[] = [];
  prCalls: { accountId: string | null; url: string; etag?: string }[] = [];
  releaseCalls: { etag?: string }[] = [];
  lsError: Error | null = null;
  prError: Error | null = null;
  /** When set, a request carrying this ETag answers 304. */
  prEtag: string | null = null;
  releasesUnsupported = false;

  async lsRemote(accountId: string | null, url: string, opts?: { defaultBranch?: boolean }): Promise<LsRemoteResult> {
    this.lsCalls.push({ accountId, url, defaultBranch: opts?.defaultBranch });
    if (this.lsError) throw this.lsError;
    return {
      heads: { ...this.heads },
      tags: structuredClone(this.tags),
      ...(opts?.defaultBranch === true && this.defaultBranch ? { defaultBranch: this.defaultBranch } : {})
    };
  }

  async listPullRequests(accountId: string | null, url: string, opts?: ConditionalListOptions) {
    this.prCalls.push({ accountId, url, ...(opts?.etag ? { etag: opts.etag } : {}) });
    if (this.prError) throw this.prError;
    if (this.prEtag !== null && opts?.etag === this.prEtag) return { notModified: true as const };
    return { items: structuredClone(this.prs), ...(this.prEtag ? { etag: this.prEtag } : {}) };
  }

  async listReleases(_accountId: string | null, _url: string, opts?: ConditionalListOptions) {
    this.releaseCalls.push({ ...(opts?.etag ? { etag: opts.etag } : {}) });
    if (this.releasesUnsupported) return { items: [], unsupported: true as const };
    return { items: structuredClone(this.releases) };
  }
}

function gitTrigger(id: string, event: Record<string, unknown>, repo: Record<string, unknown> = { kind: "url", url: URL }) {
  return node(id, "trigger.git", { repo, event });
}

const byUrl: ResolveRepo = async (_workflow, repo) => (repo.kind === "url" ? { url: repo.url, accountId: repo.accountId ?? null } : null);

function setup(workflows: ReturnType<typeof workflow>[], opts: { remote?: FakeRemote; state?: ReturnType<typeof memoryState>; clock?: ManualClock } = {}) {
  const clock = opts.clock ?? new ManualClock("2026-09-28T10:00:00.000Z");
  const host = fakeHost(workflows);
  const state = opts.state ?? memoryState();
  const remote = opts.remote ?? new FakeRemote();
  const logger = recordingLogger();
  const poller = createGitPoller({ host, state, remote, resolveRepo: byUrl, clock, logger, random: () => 0.5, resolveIntervalMs: 0 });
  const run = (ms: number) => advance(clock, () => poller.idle(), ms);
  return { clock, host, state, remote, logger, poller, run };
}

const payloads = (host: ReturnType<typeof fakeHost>) => host.fired.map((r) => r.payload as GitTriggerPayload);

test("push: the first poll only baselines; a later push fires once with previousSha..sha", async () => {
  const { host, remote, poller, state, run } = setup([workflow("wf", [gitTrigger("g", { kind: "push", branches: ["main"] })])]);
  await poller.start();
  await run(5 * S);
  assert.equal(remote.lsCalls.length, 1);
  assert.equal(host.fired.length, 0);
  assert.equal(state.get().git["wf:g"]!.baselined, true);
  assert.deepEqual(state.get().git["wf:g"]!.seen, { "refs/heads/main": sha("a") });

  remote.heads.main = sha("b");
  await run(60 * S);
  assert.equal(remote.lsCalls.length, 2);
  assert.deepEqual(host.fired, [
    {
      workflowId: "wf",
      triggerNodeId: "g",
      kind: "git",
      payload: {
        kind: "git",
        event: "push",
        repo: { url: URL, name: "acme/app" },
        ref: "refs/heads/main",
        sha: sha("b"),
        previousSha: sha("a"),
        branch: "main"
      },
      text: "Push to main (bbbbbbb)"
    }
  ]);
  assert.deepEqual(state.get().git["wf:g"]!.fired, [`push:refs/heads/main:${sha("b")}`]);

  await run(60 * S);
  assert.equal(host.fired.length, 1, "an unchanged head fires nothing");
  assert.deepEqual(poller.triggerState("wf", "g"), {
    repo: { url: URL, name: "acme/app" },
    baselined: true,
    lastPollAt: "2026-09-28T10:02:05.000Z",
    lastError: null,
    failures: 0
  });
  poller.stop();
});

test("push: several pushes between polls coalesce into ONE event", async () => {
  const { host, remote, poller, run } = setup([workflow("wf", [gitTrigger("g", { kind: "push", branches: ["main"] })])]);
  await poller.start();
  await run(5 * S);
  remote.heads.main = sha("b");
  remote.heads.main = sha("c");
  await run(60 * S);
  assert.equal(host.fired.length, 1);
  assert.equal(payloads(host)[0]!.previousSha, sha("a"));
  assert.equal(payloads(host)[0]!.sha, sha("c"));
  poller.stop();
});

test("push: branch globs; a new matching branch fires with no previousSha; deleted branches are ignored", async () => {
  const remote = new FakeRemote();
  remote.heads = { main: sha("a"), "release/1.0": sha("1"), "feature/x": sha("f"), "release/1.0/hotfix": sha("h") };
  const { host, poller, run, state } = setup([workflow("wf", [gitTrigger("g", { kind: "push", branches: ["release/*"] })])], { remote });
  await poller.start();
  await run(5 * S);
  assert.deepEqual(Object.keys(state.get().git["wf:g"]!.seen), ["refs/heads/release/1.0"]);

  remote.heads = { main: sha("b"), "release/1.0": sha("2"), "release/2.0": sha("3"), "feature/x": sha("g"), "release/1.0/hotfix": sha("i") };
  await run(60 * S);
  assert.deepEqual(
    payloads(host).map((p) => [p.branch, p.sha, p.previousSha]),
    [
      ["release/1.0", sha("2"), sha("1")],
      ["release/2.0", sha("3"), undefined]
    ]
  );
  delete remote.heads["release/2.0"];
  await run(60 * S);
  assert.equal(host.fired.length, 2, "a deletion fires nothing");
  assert.deepEqual(Object.keys(state.get().git["wf:g"]!.seen), ["refs/heads/release/1.0"]);
  poller.stop();
});

test("push: branches [] watches the default branch, read only when unknown and every 10th poll", async () => {
  const remote = new FakeRemote();
  remote.heads = { main: sha("a"), dev: sha("d") };
  const { host, poller, run } = setup([workflow("wf", [gitTrigger("g", { kind: "push", branches: [] })])], { remote });
  await poller.start();
  await run(5 * S);
  remote.heads = { main: sha("b"), dev: sha("e") };
  await run(60 * S);
  assert.deepEqual(payloads(host).map((p) => p.branch), ["main"]);
  await run(9 * 60 * S);
  assert.deepEqual(
    remote.lsCalls.map((c) => c.defaultBranch),
    [true, false, false, false, false, false, false, false, false, false, true]
  );

  // The default branch moves to dev: noticed on the 20th poll and recorded silently; then pushes to dev fire.
  remote.defaultBranch = "dev";
  await run(10 * 60 * S);
  assert.equal(remote.lsCalls.at(-1)!.defaultBranch, true);
  assert.equal(host.fired.length, 1);
  remote.heads.dev = sha("f");
  await run(60 * S);
  assert.deepEqual(payloads(host).map((p) => p.branch), ["main", "dev"]);
  poller.stop();
});

test("tag: one run per new matching tag (version order), at most 10 per poll, the rest skipped; moved tags ignored", async () => {
  const remote = new FakeRemote();
  remote.tags = { "v1.0": { sha: sha("0"), commit: sha("0") }, nightly: { sha: sha("n"), commit: sha("n") } };
  const { host, poller, run } = setup([workflow("wf", [gitTrigger("g", { kind: "tag", pattern: "v*" })])], { remote });
  await poller.start();
  await run(5 * S);
  for (let i = 1; i <= 12; i += 1) remote.tags[`v1.${i}`] = { sha: `${String(i).padStart(2, "0")}${"e".repeat(38)}`, commit: `${String(i).padStart(2, "0")}${"c".repeat(38)}` };
  remote.tags["v1.0"] = { sha: sha("9"), commit: sha("9") }; // moved
  remote.tags["nightly-2"] = { sha: sha("m"), commit: sha("m") }; // not matching
  await run(60 * S);
  assert.deepEqual(payloads(host).map((p) => p.tag), ["v1.1", "v1.2", "v1.3", "v1.4", "v1.5", "v1.6", "v1.7", "v1.8", "v1.9", "v1.10"]);
  assert.deepEqual(host.skipped.map((s) => [s.reason, (s.request.payload as GitTriggerPayload).tag]), [
    ["missed", "v1.11"],
    ["missed", "v1.12"]
  ]);
  const first = host.fired[0]!;
  assert.equal(first.text, "Tag v1.1");
  assert.deepEqual(first.payload, {
    kind: "git",
    event: "tag",
    repo: { url: URL, name: "acme/app" },
    ref: "refs/tags/v1.1",
    sha: `01${"c".repeat(38)}`,
    tag: "v1.1"
  });
  await run(60 * S);
  assert.equal(host.fired.length + host.skipped.length, 12, "nothing more on the next poll");
  poller.stop();
});

test("release: drafts never, pre-releases only when asked for", async () => {
  const remote = new FakeRemote();
  const release = (id: string, extra: Partial<ReleaseInfo> = {}): ReleaseInfo => ({
    id,
    name: `Release ${id}`,
    tag: `v${id}`,
    body: "notes",
    url: `https://github.com/acme/app/releases/${id}`,
    prerelease: false,
    draft: false,
    publishedAt: "2026-09-28T10:00:00.000Z",
    ...extra
  });
  remote.releases = [release("1")];
  const { host, poller, run } = setup(
    [
      workflow("stable", [gitTrigger("g", { kind: "release", includePrereleases: false })]),
      workflow("all", [gitTrigger("g", { kind: "release", includePrereleases: true })])
    ],
    { remote }
  );
  await poller.start();
  await run(5 * S);
  assert.equal(remote.releaseCalls.length, 1, "one listing shared by both triggers");
  remote.releases = [release("4", { draft: true, publishedAt: null }), release("3", { prerelease: true }), release("2"), release("1")];
  await run(120 * S);
  const fired = host.fired.map((r) => [r.workflowId, (r.payload as GitTriggerPayload).release!.id]);
  assert.deepEqual(fired.filter(([w]) => w === "stable"), [["stable", "2"]]);
  assert.deepEqual(fired.filter(([w]) => w === "all"), [["all", "2"], ["all", "3"]]);
  assert.deepEqual((host.fired[0]!.payload as GitTriggerPayload).release, {
    id: "2",
    name: "Release 2",
    tag: "v2",
    body: "notes",
    url: "https://github.com/acme/app/releases/2",
    prerelease: false
  });
  // The pre-release is promoted: the stable trigger now sees it for the first time.
  remote.releases = [release("3"), release("2"), release("1")];
  await run(120 * S);
  assert.deepEqual(host.fired.filter((r) => r.workflowId === "stable").map((r) => (r.payload as GitTriggerPayload).release!.id), ["2", "3"]);
  assert.equal(host.fired.filter((r) => r.workflowId === "all").length, 2, "already fired for the pre-release");
  poller.stop();
});

test("release on a provider without releases shows an error and fires nothing", async () => {
  const remote = new FakeRemote();
  remote.releasesUnsupported = true;
  const { host, poller, run } = setup([workflow("wf", [gitTrigger("g", { kind: "release", includePrereleases: false })])], { remote });
  await poller.start();
  await run(5 * S);
  assert.equal(poller.triggerState("wf", "g")!.lastError, "Releases are only available on GitHub");
  assert.equal(host.fired.length, 0);
  poller.stop();
});

function pull(number: number, state: PullRequestInfo["state"], headSha: string, extra: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    number,
    title: `Change ${number}`,
    body: "body",
    url: `https://github.com/acme/app/pull/${number}`,
    author: "dev",
    head: `feature/${number}`,
    base: "main",
    headSha,
    state,
    updatedAt: "2026-09-28T10:00:00.000Z",
    ...extra
  };
}

test("pull_request: opened, updated, merged and closed; the base filter; payload and text", async () => {
  const remote = new FakeRemote();
  remote.prs = [pull(40, "open", sha("a")), pull(41, "open", sha("b")), pull(39, "open", sha("c"), { base: "develop" })];
  const { host, poller, run, clock } = setup(
    [workflow("wf", [gitTrigger("g", { kind: "pull_request", actions: ["opened", "updated", "merged", "closed"], baseBranches: ["main"] })])],
    { remote }
  );
  await poller.start();
  await run(5 * S);
  assert.equal(host.fired.length, 0);
  assert.deepEqual(clock.pending(), [120 * S]);

  remote.prs = [
    pull(42, "open", sha("d"), { title: "Add the thing" }),
    pull(40, "open", sha("e")),
    pull(41, "merged", sha("b")),
    pull(39, "closed", sha("c"), { base: "develop" })
  ];
  await run(120 * S);
  assert.deepEqual(
    host.fired.map((r) => r.text),
    ["PR #41 merged · Change 41", "PR #40 updated · Change 40", "PR #42 opened · Add the thing"]
  );
  assert.deepEqual((host.fired[2]!.payload as GitTriggerPayload), {
    kind: "git",
    event: "pull_request",
    repo: { url: URL, name: "acme/app" },
    ref: "refs/heads/feature/42",
    sha: sha("d"),
    branch: "feature/42",
    pr: {
      number: 42,
      title: "Add the thing",
      body: "body",
      url: "https://github.com/acme/app/pull/42",
      author: "dev",
      head: "feature/42",
      base: "main",
      action: "opened",
      headSha: sha("d")
    }
  });
  remote.prs = [pull(42, "closed", sha("d")), pull(40, "open", sha("e"))];
  await run(120 * S);
  assert.equal(host.fired.at(-1)!.text, "PR #42 closed · Change 42");
  assert.equal(host.fired.length, 4);
  poller.stop();
});

test("pull_request: Bitbucket Cloud's 12-char head sha compares consistently and polls every 180 s", async () => {
  const remote = new FakeRemote();
  const bbUrl = "git@bitbucket.org:acme/app.git";
  remote.prs = [pull(7, "open", "0123456789ab")];
  const { host, poller, run, clock } = setup(
    [workflow("wf", [gitTrigger("g", { kind: "pull_request", actions: ["updated"] }, { kind: "url", url: bbUrl, accountId: "acc1" })])],
    { remote }
  );
  await poller.start();
  await run(5 * S);
  assert.deepEqual(remote.prCalls[0], { accountId: "acc1", url: bbUrl });
  assert.deepEqual(clock.pending(), [180 * S]);
  await run(180 * S);
  assert.equal(host.fired.length, 0, "the same abbreviated sha is no update");
  remote.prs = [pull(7, "open", "fedcba987654")];
  await run(180 * S);
  assert.deepEqual(host.fired.map((r) => (r.payload as GitTriggerPayload).pr!.headSha), ["fedcba987654"]);
  poller.stop();
});

test("ETags: a baselined listing sends its ETag; a 304 fires nothing and still counts as a poll", async () => {
  const remote = new FakeRemote();
  remote.prEtag = 'W/"1"';
  remote.prs = [pull(1, "open", sha("a"))];
  const { host, poller, run, state } = setup([workflow("wf", [gitTrigger("g", { kind: "pull_request", actions: ["opened"] })])], { remote });
  await poller.start();
  await run(5 * S);
  assert.deepEqual(remote.prCalls.map((c) => c.etag), [undefined], "a baseline asks for the page");
  assert.deepEqual(Object.values(state.get().etags), [{ etag: 'W/"1"', body: null }]);
  await run(120 * S);
  assert.deepEqual(remote.prCalls.map((c) => c.etag), [undefined, 'W/"1"']);
  assert.equal(host.fired.length, 0);
  assert.equal(poller.triggerState("wf", "g")!.lastPollAt, "2026-09-28T10:02:05.000Z");

  remote.prEtag = 'W/"2"';
  remote.prs = [pull(2, "open", sha("b")), pull(1, "open", sha("a"))];
  await run(120 * S);
  assert.deepEqual(host.fired.map((r) => r.text), ["PR #2 opened · Change 2"]);
  assert.deepEqual(Object.values(state.get().etags), [{ etag: 'W/"2"', body: null }]);
  poller.stop();
});

test("dedup survives a restart: a new poller over the same state never re-fires, and still fires what is new", async () => {
  const state = memoryState();
  const remote = new FakeRemote();
  const workflows = [workflow("wf", [gitTrigger("g", { kind: "push", branches: ["main"] })])];
  const first = setup(workflows, { state, remote });
  await first.poller.start();
  await first.run(5 * S);
  remote.heads.main = sha("b");
  await first.run(60 * S);
  assert.equal(first.host.fired.length, 1);
  first.poller.stop();

  const second = setup(workflows, { state, remote, clock: first.clock });
  await second.poller.start();
  await second.run(5 * S);
  assert.equal(second.host.fired.length, 0);

  // Even with `seen` lost, the fired ring still dedups the same push.
  await state.update((draft) => {
    draft.git["wf:g"]!.seen = { "refs/heads/main": sha("a") };
  });
  await second.run(60 * S);
  assert.equal(second.host.fired.length, 0);
  remote.heads.main = sha("c");
  await second.run(60 * S);
  assert.deepEqual(payloads(second.host).map((p) => [p.previousSha, p.sha]), [[sha("b"), sha("c")]]);
  second.poller.stop();
});

test("a changed filter or repo re-baselines; a disabled or deleted trigger is pruned", async () => {
  const remote = new FakeRemote();
  remote.heads = { main: sha("a"), dev: sha("d") };
  const { host, poller, run, state } = setup([workflow("wf", [gitTrigger("g", { kind: "push", branches: ["main"] })])], { remote });
  await poller.start();
  await run(5 * S);
  host.put(workflow("wf", [gitTrigger("g", { kind: "push", branches: ["dev"] })]));
  await poller.idle();
  assert.equal(state.get().git["wf:g"]!.baselined, false);
  remote.heads.dev = sha("e");
  await run(5 * S);
  assert.equal(host.fired.length, 0, "the first poll after the change only baselines");
  remote.heads.dev = sha("f");
  await run(60 * S);
  assert.deepEqual(payloads(host).map((p) => p.branch), ["dev"]);

  host.put(workflow("wf", [gitTrigger("g", { kind: "push", branches: ["dev"] }, { kind: "url", url: "https://github.com/acme/other" })]));
  await poller.idle();
  assert.equal(state.get().git["wf:g"]!.repoKey, "github.com/acme/other|anonymous");
  assert.equal(state.get().git["wf:g"]!.baselined, false);

  host.put(workflow("wf", [gitTrigger("g", { kind: "push", branches: ["dev"] })], { enabled: false }));
  await poller.idle();
  assert.deepEqual(state.get().git, {});
  assert.equal(poller.triggerState("wf", "g"), null);
  await run(10 * 60 * S);
  const calls = remote.lsCalls.length;
  await run(10 * 60 * S);
  assert.equal(remote.lsCalls.length, calls, "no repo left to poll");
  poller.stop();
});

test("two triggers on one repo share one poller (one ls-remote per poll); another account is another poller", async () => {
  const remote = new FakeRemote();
  const { host, poller, run } = setup(
    [
      workflow("a", [gitTrigger("g", { kind: "push", branches: ["main"] })]),
      workflow("b", [gitTrigger("g", { kind: "push", branches: ["*"] }, { kind: "url", url: "git@github.com:Acme/App.git" })]),
      workflow("c", [gitTrigger("g", { kind: "push", branches: ["main"] }, { kind: "url", url: URL, accountId: "acc2" })])
    ],
    { remote }
  );
  await poller.start();
  await run(5 * S);
  assert.deepEqual(
    remote.lsCalls.map((c) => c.accountId).sort(),
    [null, "acc2"].sort()
  );
  remote.heads.main = sha("b");
  await run(60 * S);
  assert.equal(remote.lsCalls.length, 4);
  assert.deepEqual(host.fired.map((r) => r.workflowId).sort(), ["a", "b", "c"]);
  poller.stop();
});

test("failures back off exponentially to 15 min, show on the trigger, honour Retry-After and never fire", async () => {
  const remote = new FakeRemote();
  const { host, poller, run, clock, state } = setup([workflow("wf", [gitTrigger("g", { kind: "push", branches: ["main"] })])], { remote });
  await poller.start();
  await run(5 * S);
  remote.lsError = new GitRemoteError(400, "git ls-remote: authentication was rejected. fatal: …", "auth");
  remote.heads.main = sha("b");
  await run(60 * S);
  assert.deepEqual(poller.triggerState("wf", "g"), {
    repo: { url: URL, name: "acme/app" },
    baselined: true,
    lastPollAt: "2026-09-28T10:00:05.000Z",
    lastError: "auth rejected",
    failures: 1
  });
  assert.deepEqual(clock.pending(), [120 * S]);
  await run(120 * S);
  assert.equal(state.get().git["wf:g"]!.failures, 2);
  assert.deepEqual(clock.pending(), [240 * S]);
  await run(240 * S);
  await run(480 * S);
  assert.deepEqual(clock.pending(), [MAX_BACKOFF_MS], "capped at 15 min");
  assert.equal(host.fired.length, 0);

  remote.lsError = new GitRemoteError(429, "rate limit exceeded", "rate_limited", 403, 40 * 60 * S);
  await run(MAX_BACKOFF_MS);
  assert.equal(poller.triggerState("wf", "g")!.lastError, "rate limited");
  assert.deepEqual(clock.pending(), [40 * 60 * S], "Retry-After wins over the backoff");

  remote.lsError = null;
  await run(40 * 60 * S);
  assert.equal(poller.triggerState("wf", "g")!.lastError, null);
  assert.equal(poller.triggerState("wf", "g")!.failures, 0);
  assert.deepEqual(payloads(host).map((p) => p.sha), [sha("b")], "the push missed while failing fires once it recovers");
  assert.deepEqual(clock.pending(), [60 * S]);
  poller.stop();
});

test("a PR listing without the scope says which scope is missing; push triggers on the same repo keep polling", async () => {
  const remote = new FakeRemote();
  remote.prError = new GitRemoteError(400, "Bitbucket Cloud: the token lacks read:pullrequest:bitbucket (…)", "missing_scope", 403);
  const { poller, run } = setup(
    [workflow("wf", [gitTrigger("pr", { kind: "pull_request", actions: ["opened"] }), gitTrigger("push", { kind: "push", branches: ["main"] })])],
    { remote }
  );
  await poller.start();
  await run(5 * S);
  assert.equal(poller.triggerState("wf", "pr")!.lastError, "missing scope read:pullrequest");
  assert.equal(poller.triggerState("wf", "push")!.lastError, null);
  assert.equal(poller.triggerState("wf", "push")!.baselined, true);
  poller.stop();
});

test("an unresolvable repository shows why and polls nothing; stop() leaves no timer", async () => {
  const { poller, run, remote, clock } = setup([
    workflow("wf", [gitTrigger("g", { kind: "push", branches: ["main"] }, { kind: "project" })]),
    workflow("bad", [gitTrigger("g", { kind: "push", branches: ["main"] }, { kind: "url", url: "file:///etc" })])
  ]);
  await poller.start();
  await run(60 * S);
  assert.equal(remote.lsCalls.length, 0);
  assert.equal(poller.triggerState("wf", "g")!.lastError, "The project has no git remote to watch");
  assert.equal(poller.triggerState("bad", "g")!.lastError, "Unsupported repository URL");
  poller.stop();
  assert.deepEqual(clock.pending(), []);
});

test("stop() mid-poll commits and fires nothing", async () => {
  const remote = new FakeRemote();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { host, poller, run, clock, state } = setup([workflow("wf", [gitTrigger("g", { kind: "push", branches: ["main"] })])], { remote });
  await poller.start();
  await run(5 * S);
  remote.heads.main = sha("b");
  const original = remote.lsRemote.bind(remote);
  remote.lsRemote = async (...args) => {
    await gate;
    return original(...args);
  };
  clock.advance(60 * S);
  poller.stop();
  release();
  await poller.idle();
  assert.equal(host.fired.length, 0);
  assert.equal(state.get().git["wf:g"]!.seen["refs/heads/main"], sha("a"));
  assert.deepEqual(clock.pending(), []);
});
