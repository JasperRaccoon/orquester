import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AnyOrquesterTool, CallContext, ThreadCaller } from "../catalog/contract.ts";
import { FakeDaemonApi } from "../testing.ts";
import { gitFamily, MAX_COMMIT_BODY_CHARS, MAX_GIT_BRANCHES, MAX_GIT_FILES, MAX_GIT_UNTRACKED } from "./git.ts";

const getGitState: AnyOrquesterTool = gitFamily.find((t) => t.name === "get_git_state")!;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

async function rig(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mcp-git-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "acme", "api"), { recursive: true });
  const api = new FakeDaemonApi(); api.fsRoot = root; api.workspacesDir = root;
  const project = join(root, "acme", "api");
  const chat: ThreadCaller = { kind: "thread", threadId: "me", title: "Me", projectPath: project, workspace: "acme", cwd: project, agentId: "claude", callId: "c", runtimeMode: "auto", planning: false, workflowOwned: false, exchange: null };
  const ctx = (caller: CallContext["caller"] = { kind: "external" }): CallContext => ({ api, signal: new AbortController().signal, now: () => 0, caller, turn: { interactionMode: "default", provenance: (_o, text) => text } });
  const parse = (args: Record<string, unknown>) => z.object(getGitState.input).strict().parse(args);
  const run = async (args: Record<string, unknown>, caller?: CallContext["caller"]) => (await getGitState.run(parse(args), ctx(caller))) as Record<string, any>;
  const scope = (args: Record<string, unknown>, caller?: CallContext["caller"]) => getGitState.scope(parse(args), ctx(caller));
  return { root, api, project, chat, run, scope };
}

test("get_git_state status: the project's status with its file list capped (filesTruncated, omittedFiles)", async (t) => {
  const { api, project, run } = await rig(t);
  const files = Array.from({ length: MAX_GIT_FILES + 25 }, (_, i) => ({ path: `src/f${i}.ts`, status: "modified", staged: false, unstaged: true }));
  api.on("GET", "/api/git/status", ({ query }) => ({ status: 200, body: { isRepo: true, branch: "main", detached: false, upstream: "origin/main", ahead: 1, behind: 0, lastFetched: null, files: query?.path === project ? files : [] } }));
  const r = await run({ project: "acme/api", view: "status" });
  assert.equal(r.project, "acme/api"); assert.equal(r.branch, "main"); assert.equal(r.ahead, 1);
  assert.equal(r.files.length, MAX_GIT_FILES); assert.equal(r.filesTruncated, true); assert.equal(r.omittedFiles, 25);
  api.on("GET", "/api/git/status", { status: 200, body: { isRepo: false, branch: null, detached: false, upstream: null, ahead: 0, behind: 0, lastFetched: null, files: [] } });
  assert.deepEqual(await run({ project: "acme/api", view: "status" }), { project: "acme/api", isRepo: false, branch: null, detached: false, upstream: null, ahead: 0, behind: 0, lastFetched: null, files: [] });
});

test("get_git_state branches and log: lists capped; the log asks for `limit` commits, clips bodies and fits one result", async (t) => {
  const { api, run } = await rig(t);
  api.on("GET", "/api/git/branches", { status: 200, body: { current: "main", local: Array.from({ length: MAX_GIT_BRANCHES + 1 }, (_, i) => ({ name: `b${i}`, current: i === 0, ahead: 0, behind: 0 })), remote: ["origin/main"] } });
  const branches = await run({ project: "acme/api", view: "branches" });
  assert.equal(branches.local.length, MAX_GIT_BRANCHES); assert.equal(branches.localTruncated, true); assert.equal(branches.omittedLocal, 1);
  assert.deepEqual(branches.remote, ["origin/main"]); assert.equal(branches.remoteTruncated, undefined);

  const commit = (i: number) => ({ sha: `${i}`.padStart(40, "a"), shortSha: `${i}`, parents: [], subject: `Commit ${i}`, body: "語".repeat(5_000), authorName: "J", authorEmail: "j@x.io", date: "2026-10-15T00:00:00Z", refs: [] });
  api.on("GET", "/api/git/log", ({ query }) => ({ status: 200, body: Array.from({ length: Number(query?.limit) }, (_, i) => commit(i)) }));
  const log = await run({ project: "acme/api", view: "log", limit: 100 });
  assert.equal(api.calls.at(-1)!.query!.limit, "100");
  assert.ok(log.commits.length > 0 && log.commits.length < 100, `${log.commits.length} commits`);
  assert.equal(log.truncated, true);
  assert.ok(bytes(log) <= 60_000);
  assert.equal([...log.commits[0].body].length, MAX_COMMIT_BODY_CHARS);
  api.on("GET", "/api/git/log", ({ query }) => ({ status: 200, body: Array.from({ length: Number(query?.limit) }, (_, i) => ({ ...commit(i), body: "" })) }));
  const short = await run({ project: "acme/api", view: "log" });
  assert.equal(short.commits.length, 20); assert.equal(short.truncated, undefined);
});

test("get_git_state diff: the working diff cut to one result with untracked files capped; one file's diff by repo-relative path, staged or not", async (t) => {
  const { api, project, run } = await rig(t);
  const huge = "+".repeat(200_000);
  api.on("GET", "/api/git/working-diff", { status: 200, body: { isRepo: true, diff: huge, truncated: false, untracked: Array.from({ length: MAX_GIT_UNTRACKED + 3 }, (_, i) => `new${i}.txt`) } });
  const working = await run({ project: "acme/api", view: "diff" });
  assert.equal(working.truncated, true); assert.ok(bytes(working) <= 60_000); assert.ok(working.diff.length > 30_000);
  assert.equal(working.untracked.length, MAX_GIT_UNTRACKED); assert.equal(working.omittedUntracked, 3);
  // A diff the daemon already cut says so even when it fits.
  api.on("GET", "/api/git/working-diff", { status: 200, body: { isRepo: true, diff: "small", truncated: true, untracked: [] } });
  assert.deepEqual(await run({ project: "acme/api", view: "diff" }), { project: "acme/api", isRepo: true, untracked: [], diff: "small", truncated: true });

  api.on("GET", "/api/git/diff", ({ query }) => ({ status: 200, body: { diff: `diff of ${query?.file} staged=${query?.staged}`, binary: false } }));
  assert.deepEqual(await run({ project: "acme/api", view: "diff", path: "src/a.ts", staged: true }), { project: "acme/api", file: "src/a.ts", staged: true, binary: false, diff: "diff of src/a.ts staged=true", truncated: false });
  assert.equal((await run({ project: "acme/api", view: "diff", path: join(project, "src", "b.ts") })).file, "src/b.ts", "an absolute path inside the project");
  for (const path of ["../web/x.ts", "/etc/passwd", "."]) {
    await assert.rejects(run({ project: "acme/api", view: "diff", path }), (e: { code: string }) => e.code === "INVALID_ARGUMENT", path);
  }
  await assert.rejects(run({ project: "acme/api", view: "status", path: "src/a.ts" }), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
});

test("get_git_state scope: a content read of the project (the chat's own by default; an external caller names one), the file among its paths", async (t) => {
  const { project, chat, scope, run } = await rig(t);
  assert.deepEqual(await scope({ view: "status" }, chat), { projects: [project], sessions: [], reads: "content", writes: false, causesTurnIn: [] });
  assert.deepEqual(await scope({ view: "diff", path: "src/a.ts" }, chat), { projects: [project], sessions: [], reads: "content", writes: false, causesTurnIn: [], paths: [join(project, "src", "a.ts")] });
  await assert.rejects(scope({ view: "status" }), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  await assert.rejects(scope({ view: "status" }, { ...chat, projectPath: "", workspace: "" }), (e: { code: string }) => e.code === "PROJECT_NOT_FOUND");
  await assert.rejects(scope({ project: "acme/nope", view: "status" }, chat), (e: { code: string }) => e.code === "PROJECT_NOT_FOUND");
  await assert.rejects(run({ view: "log" }), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
});
