// `POST /api/workspaces/:ws/projects {source:"clone", ref}` — the optional clone ref (spec §5.10)
// is validated at the route (400 INVALID_REF) and handed to AccountsService.cloneFromInput.
// Inject-only harness (project-create-routes.test.ts's): nothing listens, nothing clones.

import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import { createServer } from "./index.js";

type CreateServerArgs = Parameters<typeof createServer>;

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "orquester-clone-ref-"));
  const workspacesDir = join(root, "workspaces");
  await mkdir(workspacesDir, { recursive: true });
  await mkdir(join(root, "daemon"), { recursive: true });
  await writeFile(
    join(root, "daemon", "workspaces.json"),
    JSON.stringify({
      version: 1,
      workspaces: [
        { name: "acme", createdAt: "2026-01-01T00:00:00.000Z", isArchived: false, archivedProjects: [], gitAccountId: "acc-1" }
      ]
    }),
    "utf8"
  );
  const resolved = {
    daemonDir: join(root, "daemon"),
    workspacesDir,
    workspacesMetaFile: join(root, "daemon", "workspaces.json"),
    fsRoot: workspacesDir
  } as unknown as CreateServerArgs[1];

  const clones: unknown[][] = [];
  const services = {
    accounts: {
      cloneFromInput: async (...args: unknown[]) => {
        clones.push(args);
        return { name: (args[2] as string | undefined) ?? "repo" };
      }
    }
  } as unknown as CreateServerArgs[4];

  const app = createServer(
    createDefaultDaemonConfig({ env: {} }),
    resolved,
    createDefaultClientConfig(join(root, "daemon.sock")),
    createWriteStream("/dev/null"),
    services,
    { authRequired: false, mode: "local" }
  );
  return {
    workspacesDir,
    clones,
    inject: app.inject.bind(app),
    close: async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

test("a bad ref is a 400 INVALID_REF and nothing is cloned", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  for (const ref of ["-b", "--upload-pack=x", "has space", "line\nbreak", "x".repeat(251), "", 7]) {
    const res = await h.inject({
      method: "POST",
      url: "/api/workspaces/acme/projects",
      payload: { source: "clone", url: "git@github.com:o/r.git", ref }
    });
    assert.equal(res.statusCode, 400, JSON.stringify(ref));
    assert.equal(res.json().code, "INVALID_REF");
  }
  assert.equal(h.clones.length, 0);
  const valid = await h.inject({
    method: "POST",
    url: "/api/workspaces/acme/projects",
    payload: { source: "clone", url: "git@github.com:o/r.git", ref: "main" }
  });
  assert.equal(valid.statusCode, 200, valid.body);
  assert.equal(h.clones.length, 1);
});
