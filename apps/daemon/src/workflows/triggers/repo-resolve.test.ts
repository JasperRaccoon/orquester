import assert from "node:assert/strict";
import test, { after, mock } from "node:test";

mock.method(Math, "random", () => 0.5);
after(() => mock.restoreAll());
import type { LsRemoteResult } from "../git-remote/index.ts";
import { ManualClock } from "../testing/manual-trigger-clock.ts";
import { createGitPoller } from "./git-poller.ts";
import { createRepoResolver, workspaceOfProject } from "./repo-resolve.ts";
import { advance, fakeHost, memoryState, node, recordingLogger, workflow } from "./test-support.ts";

const WS = "/app/workspaces";

function resolver(remotes: Record<string, string | null>, accounts: Record<string, string | null>) {
  const calls: string[] = [];
  const resolve = createRepoResolver({
    workspacesDir: WS,
    git: {
      async remoteUrl(cwd) {
        calls.push(cwd);
        return remotes[cwd] ?? null;
      }
    },
    async readWorkspaceMeta(name) {
      return name in accounts ? { gitAccountId: accounts[name] } : null;
    }
  });
  return { resolve, calls };
}

test("workspaceOfProject takes exactly <workspacesDir>/<ws>/<project>", () => {
  assert.equal(workspaceOfProject(WS, `${WS}/team/app`), "team");
  assert.equal(workspaceOfProject(WS, `${WS}/team`), null);
  assert.equal(workspaceOfProject(WS, `${WS}/team/app/sub`), null);
  assert.equal(workspaceOfProject(WS, "/elsewhere/team/app"), null);
  assert.equal(workspaceOfProject(WS, `${WS}/../x/y`), null);
});

test("repo kind url: as given, with its account or none", async () => {
  const { resolve, calls } = resolver({}, {});
  const wf = workflow("wf", []);
  assert.deepEqual(await resolve(wf, { kind: "url", url: " https://github.com/o/r " }), { url: "https://github.com/o/r", accountId: null });
  assert.deepEqual(await resolve(wf, { kind: "url", url: "git@github.com:o/r.git", accountId: "acc1" }), {
    url: "git@github.com:o/r.git",
    accountId: "acc1"
  });
  assert.deepEqual(calls, []);
});

test("repo kind project: an existing project's origin + its workspace's account", async () => {
  const { resolve } = resolver({ [`${WS}/team/app`]: "https://github.com/o/app.git", [`${WS}/solo/lib`]: "git@github.com:o/lib.git" }, { team: "acc-team", solo: null });
  assert.deepEqual(await resolve(workflow("a", [], { project: { kind: "existing", projectPath: `${WS}/team/app` } }), { kind: "project" }), {
    url: "https://github.com/o/app.git",
    accountId: "acc-team"
  });
  assert.deepEqual(await resolve(workflow("b", [], { project: { kind: "existing", projectPath: `${WS}/solo/lib` } }), { kind: "project" }), {
    url: "git@github.com:o/lib.git",
    accountId: null
  });
  // No origin, or a path outside the workspaces layout: nothing to watch.
  assert.equal(await resolve(workflow("c", [], { project: { kind: "existing", projectPath: `${WS}/team/norigin` } }), { kind: "project" }), null);
  assert.equal(await resolve(workflow("d", [], { project: { kind: "existing", projectPath: "/tmp/x/y" } }), { kind: "project" }), null);
});

test("repo kind project on a temp workflow: its clone URL + that workspace's account; an empty temp project has none", async () => {
  const { resolve, calls } = resolver({}, { team: "acc-team" });
  const clone = workflow("t", [], { project: { kind: "temp", workspace: "team", source: { kind: "clone", url: "https://bitbucket.org/o/r.git", ref: "main" } } });
  assert.deepEqual(await resolve(clone, { kind: "project" }), { url: "https://bitbucket.org/o/r.git", accountId: "acc-team" });
  const empty = workflow("e", [], { project: { kind: "temp", workspace: "team", source: { kind: "empty" } } });
  assert.equal(await resolve(empty, { kind: "project" }), null);
  assert.deepEqual(calls, []);
});

test("a project whose origin appears later is picked up by the periodic re-resolve", async () => {
  const remotes: Record<string, string | null> = {};
  const { resolve } = resolver(remotes, { team: "acc-team" });
  const clock = new ManualClock("2026-09-28T10:00:00.000Z");
  const lsCalls: (string | null)[] = [];
  const poller = createGitPoller({
    host: fakeHost([
      workflow("wf", [node("g", "trigger.git", { repo: { kind: "project" }, event: { kind: "push", branches: ["main"] } })], {
        project: { kind: "existing", projectPath: `${WS}/team/app` }
      })
    ]),
    state: memoryState(),
    remote: {
      async lsRemote(accountId): Promise<LsRemoteResult> {
        lsCalls.push(accountId);
        return { heads: { main: "a".repeat(40) }, tags: {} };
      },
      async listPullRequests() {
        return { items: [] };
      },
      async listReleases() {
        return { items: [] };
      }
    },
    resolveRepo: resolve,
    clock,
    logger: recordingLogger()
  });
  await poller.start();
  assert.ok(poller.triggerState("wf", "g")!.lastError);
  remotes[`${WS}/team/app`] = "https://github.com/o/app.git";
  await advance(clock, () => poller.idle(), 5 * 60_000 + 5_000);
  assert.deepEqual(lsCalls, ["acc-team"]);
  assert.equal(poller.triggerState("wf", "g")!.baselined, true);
  assert.equal(poller.triggerState("wf", "g")!.lastError, null);
  poller.stop();
});
