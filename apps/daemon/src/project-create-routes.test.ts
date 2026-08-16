import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import { createServer } from "./index.js";

// Route-level coverage for the two guards that keep a scaffold flow from
// landing on top of someone's work: the non-empty-dir 409 on project create,
// and the bounds on the typed `initialCommand`. Built with the same
// inject-only harness as devtools-routes.test.ts — nothing listens.

type CreateServerArgs = Parameters<typeof createServer>;

async function harness(): Promise<{
  root: string;
  workspacesDir: string;
  inject: ReturnType<typeof createServer>["inject"];
  close: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "orquester-project-create-"));
  const workspacesDir = join(root, "workspaces");
  await mkdir(workspacesDir, { recursive: true });

  const resolved = {
    daemonDir: join(root, "daemon"),
    workspacesDir,
    workspacesMetaFile: join(root, "daemon", "workspaces.json"),
    fsRoot: workspacesDir
  } as unknown as CreateServerArgs[1];

  // The routes under test never touch a service; the rest of the surface is
  // registered but never called (see devtools-routes.test.ts for the pattern).
  const services = {} as unknown as CreateServerArgs[4];

  const app = createServer(
    createDefaultDaemonConfig({ env: {} }),
    resolved,
    createDefaultClientConfig(join(root, "daemon.sock")),
    createWriteStream("/dev/null"),
    services,
    { authRequired: false, mode: "local" }
  );
  return {
    root,
    workspacesDir,
    inject: app.inject.bind(app),
    close: async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

test("creating a project refuses an existing NON-EMPTY directory", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const taken = join(h.workspacesDir, "acme", "taken");
  await mkdir(taken, { recursive: true });
  await writeFile(join(taken, "README.md"), "someone's work\n", "utf8");

  const res = await h.inject({
    method: "POST",
    url: "/api/workspaces/acme/projects",
    payload: { source: "empty", name: "taken" }
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, "DIRECTORY_NOT_EMPTY");
  // The guard must not have touched the directory it refused.
  assert.deepEqual(await readdir(taken), ["README.md"]);
});

test("the refusal names an ARCHIVED project instead of a mystery collision", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const hidden = join(h.workspacesDir, "acme", "hidden");
  await mkdir(hidden, { recursive: true });
  await writeFile(join(hidden, "README.md"), "archived work\n", "utf8");
  await mkdir(join(h.root, "daemon"), { recursive: true });
  await writeFile(
    join(h.root, "daemon", "workspaces.json"),
    JSON.stringify({
      version: 1,
      workspaces: [
        {
          name: "acme",
          createdAt: "2026-01-01T00:00:00.000Z",
          isArchived: false,
          archivedProjects: ["hidden"]
        }
      ]
    }),
    "utf8"
  );

  const res = await h.inject({
    method: "POST",
    url: "/api/workspaces/acme/projects",
    payload: { source: "empty", name: "hidden" }
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, "DIRECTORY_NOT_EMPTY");
  assert.match(res.json().message, /archived project/);
  assert.match(res.json().message, /Archived panel/);
});

test("creating a project still succeeds on a fresh or existing EMPTY directory", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const fresh = await h.inject({
    method: "POST",
    url: "/api/workspaces/acme/projects",
    payload: { name: "fresh" }
  });
  assert.equal(fresh.statusCode, 200);
  assert.equal(fresh.json().path, join(h.workspacesDir, "acme", "fresh"));

  // Re-creating over the empty shell it just made is the legit case (an
  // abandoned project dir), and must not regress into a 409.
  const again = await h.inject({
    method: "POST",
    url: "/api/workspaces/acme/projects",
    payload: { source: "empty", name: "fresh" }
  });
  assert.equal(again.statusCode, 200);
});

test("a project name that is an existing FILE is refused, not a 500", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  await mkdir(join(h.workspacesDir, "acme"), { recursive: true });
  await writeFile(join(h.workspacesDir, "acme", "notes"), "x", "utf8");

  const res = await h.inject({
    method: "POST",
    url: "/api/workspaces/acme/projects",
    payload: { source: "empty", name: "notes" }
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, "DIRECTORY_NOT_EMPTY");
});

test("initialCommand is rejected when it is over-long or carries control bytes", async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const create = async (initialCommand: string) =>
    h.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { kind: "shell", refId: "sh", initialCommand }
    });

  const bad = [
    "a".repeat(4097),
    "echo hi\nrm -rf /",
    // An OSC title sequence: legitimate in a raw keystroke stream, never in a
    // launch command a client asks the daemon to type on its behalf.
    "echo \u001b]0;pwned\u0007",
    "echo hi\r"
  ];
  for (const command of bad) {
    const res = await create(command);
    assert.equal(res.statusCode, 400, JSON.stringify(command.slice(0, 20)));
    assert.equal(res.json().code, "INVALID_INITIAL_COMMAND");
  }

  // A well-formed one gets past the bound (and only then fails on this
  // harness's absent registry) — the guard is a bound, not a blanket refusal.
  const ok = await create("npm create vite@latest . -- --template react-ts");
  assert.notEqual(ok.json().code, "INVALID_INITIAL_COMMAND");
});
