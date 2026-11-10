import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FsUploadResponse } from "@orquester/api";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import { createServer } from "./index.js";

// `POST /api/fs/upload` (the file browser's uploads and the chat's "Save to project…"): what an upload that
// does not land answers, and that "error" never replaces what is already there.

type CreateServerArgs = Parameters<typeof createServer>;

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "orquester-fs-upload-"));
  const workspacesDir = join(root, "workspaces");
  const project = join(workspacesDir, "ws", "proj");
  await mkdir(project, { recursive: true });
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
  const upload = (relativePath: string, body: string, onConflict = "error") =>
    app.inject({
      method: "POST",
      url: `/api/fs/upload?destDir=${encodeURIComponent(project)}&relativePath=${encodeURIComponent(relativePath)}&onConflict=${onConflict}`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(body)
    });
  return {
    project,
    upload,
    close: async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

test("onConflict error never replaces what is there: of racing uploads to one name exactly one lands, and a link is never written through", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const answers = await Promise.all(Array.from({ length: 8 }, (_, index) => h.upload("art/cat.png", `upload ${index}`)));
  const bodies = answers.map((answer) => answer.json() as FsUploadResponse);
  const landed = bodies.filter((body) => body.conflict !== true);
  assert.equal(landed.length, 1, JSON.stringify(bodies));
  assert.ok(bodies.filter((body) => body.conflict === true).every((body) => body.conflictKind === "file"));
  // What is on disk is the one upload that said it landed.
  const winner = answers.findIndex((answer) => (answer.json() as FsUploadResponse).conflict !== true);
  assert.equal(await readFile(join(h.project, "art", "cat.png"), "utf8"), `upload ${winner}`);

  // A dangling link at the name is an entry too: kept, not replaced.
  await symlink(join(h.project, "nowhere.png"), join(h.project, "art", "link.png"));
  assert.equal((await h.upload("art/link.png", "x")).json().conflictKind, "file");
  await assert.rejects(readFile(join(h.project, "nowhere.png")));
  assert.deepEqual((await readdir(join(h.project, "art"))).sort(), ["cat.png", "link.png"], "no temp file left behind");
});

test("a file where the path needs a folder is conflictKind parent; one at the name itself is file", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  await writeFile(join(h.project, "art"), "a file named like the folder");
  const parent = await h.upload("art/cat.png", "x");
  assert.equal(parent.statusCode, 200);
  assert.deepEqual(parent.json(), { path: "", name: "cat.png", size: 0, conflict: true, conflictKind: "parent" });
  // Told before the body is read: the connection is closed rather than drained.
  assert.equal(parent.headers.connection, "close");
  assert.equal((await h.upload("art/deeper/cat.png", "x", "rename")).json().conflictKind, "parent");
  assert.equal((await h.upload("art", "x")).json().conflictKind, "file");
});
