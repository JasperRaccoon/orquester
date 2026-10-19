import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProjectSummary } from "@orquester/api";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import { createServer } from "./index.js";

// GET /api/workspaces/:workspace/projects fills repoKey/repoName/cloneUrl off each checkout's
// origin, and no credential in that origin reaches the response. Same inject-only harness as
// project-create-routes.test.ts: nothing listens.

type CreateServerArgs = Parameters<typeof createServer>;

async function harness(t: test.TestContext): Promise<{
  workspacesDir: string;
  inject: ReturnType<typeof createServer>["inject"];
}> {
  const root = await mkdtemp(join(tmpdir(), "orquester-project-list-"));
  const workspacesDir = join(root, "workspaces");
  await mkdir(workspacesDir, { recursive: true });
  const resolved = {
    daemonDir: join(root, "daemon"),
    workspacesDir,
    workspacesMetaFile: join(root, "daemon", "workspaces.json"),
    fsRoot: workspacesDir
  } as unknown as CreateServerArgs[1];
  const app = createServer(
    createDefaultDaemonConfig({ env: {} }),
    resolved,
    createDefaultClientConfig(join(root, "daemon.sock")),
    createWriteStream("/dev/null"),
    {} as unknown as CreateServerArgs[4],
    { authRequired: false, mode: "local" }
  );
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return { workspacesDir, inject: app.inject.bind(app) };
}

async function checkout(dir: string, config: string): Promise<void> {
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(join(dir, ".git", "config"), config, "utf8");
}

test("project listings carry repoKey, repoName and a credential-free cloneUrl", async (t) => {
  const h = await harness(t);
  const ws = join(h.workspacesDir, "acme");
  await checkout(
    join(ws, "token-clone"),
    '[remote "origin"]\n\turl = https://ghp_SECRETTOKEN@github.com/Acme/Engine.git\n'
  );
  await checkout(
    join(ws, "userpass-clone"),
    '[remote "origin"]\n\turl = "https://bob:hunter2@gitlab.example.com/Acme/Engine.git"\n'
  );
  await checkout(join(ws, "ssh-clone"), '[remote "origin"]\n\turl = git@github.com:Acme/Engine.git\n');
  await checkout(join(ws, "local-only"), "[core]\n\tbare = false\n");
  await mkdir(join(ws, "plain-dir"), { recursive: true });

  const res = await h.inject({ method: "GET", url: "/api/workspaces/acme/projects" });
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(res.body, /SECRETTOKEN|ghp_|hunter2|bob:/);
  const byName = new Map((res.json() as ProjectSummary[]).map((p) => [p.name, p]));

  const token = byName.get("token-clone");
  assert.equal(token?.repoId, "github.com/Acme/Engine");
  assert.equal(token?.repoKey, "github.com/acme/engine");
  assert.equal(token?.repoName, "Acme/Engine");
  assert.equal(token?.cloneUrl, "https://github.com/Acme/Engine.git");

  const userpass = byName.get("userpass-clone");
  assert.equal(userpass?.repoKey, "gitlab.example.com/acme/engine");
  assert.equal(userpass?.cloneUrl, "https://gitlab.example.com/Acme/Engine.git");

  // Sibling clones over https and scp-like ssh share one key; the scp form is kept as is.
  const ssh = byName.get("ssh-clone");
  assert.equal(ssh?.repoKey, token?.repoKey);
  assert.equal(ssh?.repoName, "Acme/Engine");
  assert.equal(ssh?.cloneUrl, "git@github.com:Acme/Engine.git");

  const local = byName.get("local-only");
  assert.equal(local?.repoId, await realpath(join(ws, "local-only")));
  for (const field of ["repoKey", "repoName", "cloneUrl"] as const) {
    assert.equal(field in (local ?? {}), false, `local-only has no ${field}`);
  }

  const plain = byName.get("plain-dir");
  assert.ok(plain);
  for (const field of ["repoId", "repoKey", "repoName", "cloneUrl"] as const) {
    assert.equal(field in plain, false, `plain-dir has no ${field}`);
  }
});
