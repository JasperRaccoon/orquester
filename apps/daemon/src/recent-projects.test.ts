import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_RECENT_PROJECTS } from "@orquester/config";
import { RecentProjectsService, describeProjectPath } from "./recent-projects.ts";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "orquester-recent-projects-"));
}

test("describeProjectPath accepts only <workspacesDir>/<workspace>/<project>", () => {
  const root = "/ws";
  assert.deepEqual(describeProjectPath(root, "/ws/acme/site"), { name: "site", workspace: "acme" });
  assert.deepEqual(describeProjectPath(root, "/ws/acme/site/"), { name: "site", workspace: "acme" });
  assert.deepEqual(describeProjectPath(root, "/ws/acme/x/../site"), { name: "site", workspace: "acme" });
  assert.equal(describeProjectPath(root, "/ws/acme"), null, "a workspace dir is not a project");
  assert.equal(describeProjectPath(root, "/ws"), null);
  assert.equal(describeProjectPath(root, "/ws/acme/site/src"), null, "too deep");
  assert.equal(describeProjectPath(root, "/etc/passwd"), null, "outside the tree");
  // isValidName parity with the project routes: no dot-directories.
  assert.equal(describeProjectPath(root, "/ws/.hidden/site"), null, "dot workspace");
  assert.equal(describeProjectPath(root, "/ws/acme/.git"), null, "dot project");
});

test("markInteracted records only existing directories, one event each", async () => {
  const root = await scratch();
  const service = new RecentProjectsService(join(root, "recent-projects.json"), root);
  await service.load();
  const changes: unknown[] = [];
  service.lifecycle.on("changed", (list) => changes.push(list));

  const real = join(root, "acme", "site");
  await mkdir(real, { recursive: true });
  const file = join(root, "acme", "notes.md");
  await writeFile(file, "x", "utf8");

  assert.equal(await service.markInteracted(join(root, "acme", "ghost")), null, "never existed");
  assert.equal(await service.markInteracted(file), null, "a file is not a project");
  assert.deepEqual(changes, [], "a rejected mark is not a mutation");

  assert.notEqual(await service.markInteracted(real), null);
  assert.equal(changes.length, 1, "one event per accepted mark");
  // snapshot() is what POST returns — no liveness sweep, so no second event.
  assert.deepEqual((await service.snapshot()).map((e) => e.path), [real]);
  assert.equal(changes.length, 1);

  await rm(root, { recursive: true, force: true });
});

test("markInteracted upserts newest-first, counts, caps, and persists", async () => {
  const root = await scratch();
  const indexPath = join(root, "daemon", "recent-projects.json");
  const service = new RecentProjectsService(indexPath, root);
  await service.load();

  const projects: string[] = [];
  for (let i = 0; i < MAX_RECENT_PROJECTS + 5; i++) {
    const path = join(root, "acme", `p${String(i).padStart(2, "0")}`);
    await mkdir(path, { recursive: true });
    projects.push(path);
    await service.markInteracted(path);
  }

  let list = await service.list();
  assert.equal(list.length, MAX_RECENT_PROJECTS);
  assert.equal(list[0].path, projects[projects.length - 1]);
  assert.deepEqual(
    { name: list[0].name, workspace: list[0].workspace, interactionCount: list[0].interactionCount },
    { name: "p34", workspace: "acme", interactionCount: 1 }
  );
  // The oldest marks fell off the cap.
  assert.equal(list.some((e) => e.path === projects[0]), false);

  // Re-marking bumps the entry to the front and increments its count; a
  // trailing slash is the same project, not a second entry.
  const revisited = projects[projects.length - MAX_RECENT_PROJECTS];
  await service.markInteracted(`${revisited}/`);
  list = await service.list();
  assert.equal(list.length, MAX_RECENT_PROJECTS);
  assert.equal(list[0].path, revisited);
  assert.equal(list[0].interactionCount, 2);

  // Everything survives a reload from disk. Ordering after a reload comes from
  // the (millisecond-resolution) timestamps, so compare the set, not the order.
  const reloaded = new RecentProjectsService(indexPath, root);
  await reloaded.load();
  const after = await reloaded.list();
  assert.deepEqual(new Set(after.map((e) => e.path)), new Set(list.map((e) => e.path)));
  assert.equal(after.find((e) => e.path === revisited)?.interactionCount, 2);

  await rm(root, { recursive: true, force: true });
});

test("list drops entries whose directory is gone, and persists the prune", async () => {
  const root = await scratch();
  const indexPath = join(root, "recent-projects.json");
  const service = new RecentProjectsService(indexPath, root);
  await service.load();

  const kept = join(root, "acme", "kept");
  const gone = join(root, "acme", "gone");
  await mkdir(kept, { recursive: true });
  await mkdir(gone, { recursive: true });
  await service.markInteracted(kept);
  await service.markInteracted(gone);
  assert.equal((await service.list()).length, 2);

  const changes: unknown[][] = [];
  service.lifecycle.on("changed", (list) => changes.push(list as unknown[]));
  await rm(gone, { recursive: true, force: true });

  const list = await service.list();
  assert.deepEqual(list.map((e) => e.path), [kept]);
  assert.equal(changes.length, 1, "prune notifies once");

  // A second read has nothing left to prune, so it must not re-notify.
  await service.list();
  assert.equal(changes.length, 1);

  const onDisk = JSON.parse(await readFile(indexPath, "utf8"));
  assert.deepEqual(onDisk.projects.map((e: { path: string }) => e.path), [kept]);

  await rm(root, { recursive: true, force: true });
});

test("list joins the workspaces side-table for the archive curtain", async () => {
  const root = await scratch();
  const plain = join(root, "acme", "plain");
  const hidden = join(root, "acme", "hidden");
  const inArchivedWorkspace = join(root, "old", "site");
  for (const path of [plain, hidden, inArchivedWorkspace]) {
    await mkdir(path, { recursive: true });
  }

  let meta = {
    version: 1 as const,
    workspaces: [
      { name: "acme", createdAt: "2026-01-01T00:00:00.000Z", isArchived: false, archivedProjects: ["hidden"] },
      { name: "old", createdAt: "2026-01-01T00:00:00.000Z", isArchived: true, archivedProjects: [] }
    ]
  };
  const service = new RecentProjectsService(join(root, "recent-projects.json"), root, console, async () => meta);
  await service.load();
  for (const path of [plain, hidden, inArchivedWorkspace]) {
    await service.markInteracted(path);
  }

  const list = await service.list();
  const byPath = new Map(list.map((e) => [e.path, e.isArchived]));
  assert.equal(byPath.get(plain), undefined, "a visible project carries no flag");
  assert.equal(byPath.get(hidden), true, "listed in the workspace's archivedProjects");
  assert.equal(byPath.get(inArchivedWorkspace), true, "the whole workspace is archived");
  // snapshot() (what POST returns) re-reads the side-table itself.
  assert.equal((await service.snapshot()).find((e) => e.path === hidden)?.isArchived, true);

  // Un-archiving is picked up on the next list().
  meta = { version: 1, workspaces: [] };
  const after = await service.list();
  assert.equal(after.every((e) => e.isArchived === undefined), true);

  await rm(root, { recursive: true, force: true });
});

test("markInteracted and snapshot re-read the curtain, not the set list() left behind", async () => {
  const root = await scratch();
  const hidden = join(root, "acme", "hidden");
  const other = join(root, "acme", "other");
  for (const path of [hidden, other]) {
    await mkdir(path, { recursive: true });
  }

  let meta = { version: 1 as const, workspaces: [] as Array<Record<string, unknown>> };
  const service = new RecentProjectsService(
    join(root, "recent-projects.json"),
    root,
    console,
    async () => meta as never
  );
  await service.load();
  await service.markInteracted(hidden);
  const changes: Array<Array<{ path: string; isArchived?: boolean }>> = [];
  service.lifecycle.on("changed", (list) => changes.push(list));

  // Archived AFTER the only list()/mark that read the side-table.
  meta = {
    version: 1,
    workspaces: [
      {
        name: "acme",
        createdAt: "2026-01-01T00:00:00.000Z",
        isArchived: false,
        archivedProjects: ["hidden"]
      }
    ]
  };

  await service.markInteracted(other);
  assert.equal(
    changes[0]?.find((e) => e.path === hidden)?.isArchived,
    true,
    "the broadcast list carries the fresh curtain"
  );
  assert.equal(
    (await service.snapshot()).find((e) => e.path === hidden)?.isArchived,
    true,
    "so does the POST response"
  );

  await rm(root, { recursive: true, force: true });
});

test("an unreadable side-table keeps the previous curtain rather than un-hiding", async () => {
  const root = await scratch();
  const hidden = join(root, "acme", "hidden");
  await mkdir(hidden, { recursive: true });
  let fail = false;
  const service = new RecentProjectsService(join(root, "recent-projects.json"), root, console, async () => {
    if (fail) {
      throw new Error("workspaces.json is unreadable");
    }
    return {
      version: 1 as const,
      workspaces: [
        { name: "acme", createdAt: "2026-01-01T00:00:00.000Z", isArchived: false, archivedProjects: ["hidden"] }
      ]
    };
  });
  await service.load();
  await service.markInteracted(hidden);
  assert.equal((await service.list())[0]?.isArchived, true);

  fail = true;
  assert.equal((await service.list())[0]?.isArchived, true);

  await rm(root, { recursive: true, force: true });
});

test("without a side-table reader nothing is ever reported archived", async () => {
  const root = await scratch();
  const path = join(root, "acme", "site");
  await mkdir(path, { recursive: true });
  const service = new RecentProjectsService(join(root, "recent-projects.json"), root);
  await service.load();
  await service.markInteracted(path);
  assert.equal((await service.list())[0]?.isArchived, undefined);

  await rm(root, { recursive: true, force: true });
});

test("load survives a corrupt file and drops only the bad entries", async () => {
  const root = await scratch();
  const indexPath = join(root, "recent-projects.json");
  const good = join(root, "acme", "good");
  await mkdir(good, { recursive: true });

  await writeFile(indexPath, "{ not json", "utf8");
  const broken = new RecentProjectsService(indexPath, root, { warn: () => {} });
  await broken.load();
  assert.deepEqual(await broken.list(), []);
  // A corrupt file must not be clobbered on read.
  assert.equal(await readFile(indexPath, "utf8"), "{ not json");

  await writeFile(
    indexPath,
    JSON.stringify({
      version: 1,
      projects: [
        { name: "good", workspace: "acme", path: good, lastInteractedAt: "2026-01-01T00:00:00.000Z" },
        { name: "", workspace: "acme", path: "/nope", lastInteractedAt: "2026-01-02T00:00:00.000Z" },
        "garbage"
      ]
    }),
    "utf8"
  );
  const partial = new RecentProjectsService(indexPath, root, { warn: () => {} });
  await partial.load();
  const list = await partial.list();
  assert.deepEqual(list.map((e) => e.path), [good]);
  // interactionCount defaults for a record written before the field existed.
  assert.equal(list[0].interactionCount, 1);

  await rm(root, { recursive: true, force: true });
});
