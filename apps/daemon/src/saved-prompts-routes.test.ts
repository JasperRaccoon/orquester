import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SavedPrompt } from "@orquester/api";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import type { InjectOptions } from "fastify";
import { GitService } from "./git.ts";
import { createServer } from "./index.js";
import { SavedPromptsService } from "./saved-prompts.ts";

// Route-level coverage for /api/saved-prompts, /api/git/working-diff and the
// saved-prompt cascades of the project/workspace delete routes: status codes,
// the `{ code, message }` envelope, the 204 with no body. Built with the same
// inject-only harness as project-create-routes.test.ts — nothing listens.

type CreateServerArgs = Parameters<typeof createServer>;
const quiet = { warn: () => {}, error: () => {} };

async function harness(options: { unreadableLibrary?: boolean } = {}): Promise<{
  root: string;
  workspacesDir: string;
  /** The live paths the routes AND the service read — reassign them as a config change does. */
  resolved: { workspacesDir: string; fsRoot: string };
  savedPrompts: SavedPromptsService;
  /** Every to-do cascade the delete routes ran, as `<method> <path>`. */
  todoCascades: string[];
  inject: ReturnType<typeof createServer>["inject"];
  close: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "orquester-saved-prompt-routes-"));
  const workspacesDir = join(root, "workspaces");
  const daemonDir = join(root, "daemon");
  await mkdir(workspacesDir, { recursive: true });
  await mkdir(daemonDir, { recursive: true });
  const file = join(daemonDir, "saved-prompts.json");
  if (options.unreadableLibrary) {
    // A directory where the file should be: every read fails, so the library is read-only.
    await mkdir(file);
  } else {
    // Past its first run, so the library starts empty rather than seeded.
    await writeFile(file, JSON.stringify({ version: 1, prompts: [] }), "utf8");
  }
  const resolved = {
    daemonDir,
    workspacesDir,
    workspacesMetaFile: join(daemonDir, "workspaces.json"),
    fsRoot: workspacesDir
  };
  // Wired as startDaemon wires it: the service reads the live paths at every use.
  const savedPrompts = new SavedPromptsService({
    file,
    workspacesDir: () => resolved.workspacesDir,
    fsRoot: () => resolved.fsRoot,
    logger: quiet
  });
  await savedPrompts.load();
  const todoCascades: string[] = [];

  // The delete routes' other cascades are stubbed: only the saved-prompt one is under test.
  const services = {
    savedPrompts,
    git: new GitService(),
    sessions: { closeByProjectPrefix: () => {} },
    browsers: { closeForProject: async () => {} },
    desktops: { closeForProject: async () => {} },
    todos: {
      deleteByProjectPath: async (path: string) => void todoCascades.push(`deleteByProjectPath ${path}`),
      deleteByWorkspace: async (_name: string, path: string) => void todoCascades.push(`deleteByWorkspace ${path}`)
    },
    accounts: { unbindWorkspace: async () => {} }
  } as unknown as CreateServerArgs[4];

  const app = createServer(
    createDefaultDaemonConfig({ env: {} }),
    resolved as unknown as CreateServerArgs[1],
    createDefaultClientConfig(join(root, "daemon.sock")),
    createWriteStream("/dev/null"),
    services,
    { authRequired: false, mode: "local" }
  );
  return {
    root,
    workspacesDir,
    resolved,
    savedPrompts,
    todoCascades,
    inject: app.inject.bind(app),
    close: async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

test("saved prompts: create, list, update, use and delete over HTTP", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  assert.deepEqual((await h.inject({ method: "GET", url: "/api/saved-prompts" })).json(), { prompts: [] });

  const created = await h.inject({
    method: "POST",
    url: "/api/saved-prompts",
    payload: { title: "Explain", body: "Explain {project}", projectPath: null }
  });
  assert.equal(created.statusCode, 201);
  const prompt = created.json() as SavedPrompt;
  assert.equal(prompt.title, "Explain");

  const listed = await h.inject({ method: "GET", url: "/api/saved-prompts" });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json(), { prompts: [prompt] });

  const updated = await h.inject({
    method: "PUT",
    url: `/api/saved-prompts/${prompt.id}`,
    payload: { pinned: true }
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().pinned, true);

  // No body at all, as the client sends it.
  const used = await h.inject({ method: "POST", url: `/api/saved-prompts/${prompt.id}/used` });
  assert.equal(used.statusCode, 200);
  assert.equal(used.json().useCount, 1);
  assert.equal(typeof used.json().lastUsedAt, "string");

  const deleted = await h.inject({ method: "DELETE", url: `/api/saved-prompts/${prompt.id}` });
  assert.equal(deleted.statusCode, 204);
  assert.equal(deleted.body, "", "a 204 carries no body");
  assert.deepEqual((await h.inject({ method: "GET", url: "/api/saved-prompts" })).json(), { prompts: [] });
});

test("saved prompts: refusals are { code, message } with the service's status", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const expectRefusal = async (
    request: InjectOptions,
    status: number,
    code: string
  ) => {
    const res = await h.inject(request);
    assert.equal(res.statusCode, status, res.body);
    const body = res.json() as { code: string; message: string };
    assert.equal(body.code, code, res.body);
    assert.equal(typeof body.message, "string");
  };

  await expectRefusal(
    { method: "POST", url: "/api/saved-prompts", payload: { title: " ", body: "b", projectPath: null } },
    400,
    "INVALID_REQUEST"
  );
  await expectRefusal({ method: "POST", url: "/api/saved-prompts" }, 400, "INVALID_REQUEST");
  await expectRefusal(
    { method: "POST", url: "/api/saved-prompts", payload: { title: "t", body: "b", projectPath: "/etc" } },
    400,
    "INVALID_PROJECT_PATH"
  );
  await expectRefusal({ method: "GET", url: "/api/saved-prompts?projectPath=%2Fetc" }, 400, "INVALID_PROJECT_PATH");
  await expectRefusal(
    { method: "PUT", url: "/api/saved-prompts/nope", payload: { title: "x" } },
    404,
    "SAVED_PROMPT_NOT_FOUND"
  );
  await expectRefusal({ method: "DELETE", url: "/api/saved-prompts/nope" }, 404, "SAVED_PROMPT_NOT_FOUND");
  await expectRefusal({ method: "POST", url: "/api/saved-prompts/nope/used" }, 404, "SAVED_PROMPT_NOT_FOUND");
});

test("saved prompts: ?projectPath= adds that project's prompts to the global ones", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const site = join(h.workspacesDir, "acme", "site");
  await mkdir(site, { recursive: true });

  const global = (
    await h.inject({ method: "POST", url: "/api/saved-prompts", payload: { title: "G", body: "b", projectPath: null } })
  ).json() as SavedPrompt;
  const scoped = (
    await h.inject({ method: "POST", url: "/api/saved-prompts", payload: { title: "S", body: "b", projectPath: site } })
  ).json() as SavedPrompt;
  assert.equal(scoped.projectPath, site);

  const ids = async (url: string) =>
    ((await h.inject({ method: "GET", url })).json() as { prompts: SavedPrompt[] }).prompts.map((p) => p.id);
  assert.deepEqual(await ids(`/api/saved-prompts?projectPath=${encodeURIComponent(site)}`), [global.id, scoped.id]);
  assert.deepEqual(await ids("/api/saved-prompts"), [global.id]);
  assert.deepEqual(await ids("/api/saved-prompts?projectPath="), [global.id], "an empty value is no project");
});

test("deleting a project, then its workspace, deletes their saved prompts", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const site = join(h.workspacesDir, "acme", "site");
  const docs = join(h.workspacesDir, "acme", "docs");
  const other = join(h.workspacesDir, "other", "site");
  for (const dir of [site, docs, other]) {
    await mkdir(dir, { recursive: true });
  }
  const create = (projectPath: string | null) =>
    h.savedPrompts.create({ title: "T", body: "b", projectPath });
  const global = await create(null);
  const inSite = await create(site);
  const inDocs = await create(docs);
  const inOther = await create(other);

  assert.equal((await h.inject({ method: "DELETE", url: "/api/workspaces/acme/projects/site" })).statusCode, 204);
  assert.equal(h.savedPrompts.get(inSite.id), undefined, "the project's prompt went with it");
  assert.notEqual(h.savedPrompts.get(inDocs.id), undefined);

  assert.equal((await h.inject({ method: "DELETE", url: "/api/workspaces/acme" })).statusCode, 204);
  assert.equal(h.savedPrompts.get(inDocs.id), undefined, "every project of the workspace");
  assert.notEqual(h.savedPrompts.get(inOther.id), undefined, "another workspace's prompt stays");
  assert.notEqual(h.savedPrompts.get(global.id), undefined, "global prompts stay");
  assert.deepEqual(h.todoCascades, [
    `deleteByProjectPath ${site}`,
    `deleteByWorkspace ${join(h.workspacesDir, "acme")}`
  ]);
});

test("a delete whose rm fails leaves the project's prompts and to-dos alone", { skip: process.getuid?.() === 0 }, async (t) => {
  const h = await harness();
  const site = join(h.workspacesDir, "acme", "site");
  const locked = join(site, "locked");
  t.after(async () => {
    await chmod(locked, 0o700).catch(() => undefined);
    await h.close();
  });
  await mkdir(locked, { recursive: true });
  await writeFile(join(locked, "file.txt"), "x", "utf8");
  // Its entries cannot be unlinked, so removing the tree fails.
  await chmod(locked, 0o500);
  const prompt = await h.savedPrompts.create({ title: "T", body: "b", projectPath: site });

  const project = await h.inject({ method: "DELETE", url: "/api/workspaces/acme/projects/site" });
  assert.equal(project.statusCode, 500, project.body);
  const workspace = await h.inject({ method: "DELETE", url: "/api/workspaces/acme" });
  assert.equal(workspace.statusCode, 500, workspace.body);

  assert.notEqual(h.savedPrompts.get(prompt.id), undefined, "the prompt outlives both failed deletes");
  assert.deepEqual(h.todoCascades, [], "and so do the to-dos");
});

test("a read-only library answers reads, refuses writes with a 503, and never fails a project delete", async (t) => {
  const h = await harness({ unreadableLibrary: true });
  t.after(() => h.close());

  const listed = await h.inject({ method: "GET", url: "/api/saved-prompts" });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json(), { prompts: [] });

  const writes: InjectOptions[] = [
    { method: "POST", url: "/api/saved-prompts", payload: { title: "T", body: "b", projectPath: null } },
    { method: "PUT", url: "/api/saved-prompts/any", payload: { title: "x" } },
    { method: "DELETE", url: "/api/saved-prompts/any" },
    { method: "POST", url: "/api/saved-prompts/any/used" }
  ];
  for (const request of writes) {
    const res = await h.inject(request);
    assert.equal(res.statusCode, 503, `${request.method} ${request.url}: ${res.body}`);
    assert.equal(res.json().code, "SAVED_PROMPTS_UNAVAILABLE");
  }

  await mkdir(join(h.workspacesDir, "acme", "site"), { recursive: true });
  const deleted = await h.inject({ method: "DELETE", url: "/api/workspaces/acme/projects/site" });
  assert.equal(deleted.statusCode, 204, "the cascade has nothing to do, and does not fail the delete");
});

test("a workspaces directory moved at runtime is followed by validation and cascades alike", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const old = join(h.workspacesDir, "acme", "site");
  const moved = join(h.root, "moved-workspaces");
  const site = join(moved, "acme", "site");
  await mkdir(old, { recursive: true });
  await mkdir(site, { recursive: true });
  // What PUT /api/config/daemon does: reassign the live paths in place, no restart.
  h.resolved.workspacesDir = moved;
  h.resolved.fsRoot = moved;

  const created = await h.inject({
    method: "POST",
    url: "/api/saved-prompts",
    payload: { title: "T", body: "b", projectPath: site }
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = (created.json() as SavedPrompt).id;
  const listed = await h.inject({ method: "GET", url: `/api/saved-prompts?projectPath=${encodeURIComponent(site)}` });
  assert.deepEqual((listed.json() as { prompts: SavedPrompt[] }).prompts.map((p) => p.id), [id]);

  const stale = await h.inject({
    method: "POST",
    url: "/api/saved-prompts",
    payload: { title: "T", body: "b", projectPath: old }
  });
  assert.equal(stale.statusCode, 400, "a project under the old directory is no longer one");
  assert.equal(stale.json().code, "INVALID_PROJECT_PATH");

  assert.equal((await h.inject({ method: "DELETE", url: "/api/workspaces/acme/projects/site" })).statusCode, 204);
  assert.equal(h.savedPrompts.get(id), undefined, "the cascade followed the move too");
});

test("working diff route rejects missing and outside paths", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const missing = await h.inject({ method: "GET", url: "/api/git/working-diff" });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().code, "INVALID_REQUEST");

  const outside = await h.inject({ method: "GET", url: `/api/git/working-diff?path=${encodeURIComponent(h.root)}` });
  assert.equal(outside.statusCode, 403);
  assert.equal(outside.json().code, "FS_FORBIDDEN");
});
