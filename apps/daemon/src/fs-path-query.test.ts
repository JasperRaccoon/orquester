import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import { fsPathFromQuery } from "./fs-path-query.js";
import { createServer } from "./index.js";

// The `/api/fs/*` GET routes accept the target path either as plain `?path=`
// or as base64url `?p=`. The encoded spelling exists because browser ad
// blockers filter on the raw URL string — a file under `banners/` or named
// `*_300x250.jpg` matches EasyList and the request dies client-side with
// ERR_BLOCKED_BY_CLIENT before it ever reaches the daemon.

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

test("fsPathFromQuery: `p` decodes base64url UTF-8, `path` is the plain fallback", () => {
  const spanish = "/ws/diseños/muestras/en-300x250-Diseño_ÉN.jpg";
  assert.equal(fsPathFromQuery({ p: b64url(spanish) }), spanish);
  assert.equal(fsPathFromQuery({ path: spanish }), spanish);
  // `p` wins when both are present — a client that sends the encoded form
  // meant it, and a plaintext `path` beside it is the thing filters key on.
  assert.equal(fsPathFromQuery({ p: b64url("/a"), path: "/b" }), "/a");
  assert.equal(fsPathFromQuery({}), undefined);
});

test("fsPathFromQuery: a malformed `p` is unusable (never partially decoded)", () => {
  for (const bad of ["", "not base64url!", "abc=", "/ws/x", "a b", "%2F"]) {
    assert.equal(fsPathFromQuery({ p: bad }), undefined, JSON.stringify(bad));
  }
  // A malformed `p` does not fall through to `path`: the client chose one
  // spelling, and silently reading the other would hide a broken encoder.
  assert.equal(fsPathFromQuery({ p: "abc=", path: "/plain" }), undefined);
  // Decoded bytes that are not valid UTF-8 are rejected too.
  assert.equal(fsPathFromQuery({ p: Buffer.from([0xff, 0xfe, 0x2f]).toString("base64url") }), undefined);
});

type CreateServerArgs = Parameters<typeof createServer>;

async function harness(): Promise<{
  workspacesDir: string;
  inject: ReturnType<typeof createServer>["inject"];
  close: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "orquester-fs-path-query-"));
  const workspacesDir = join(root, "workspaces");
  await mkdir(workspacesDir, { recursive: true });
  const resolved = {
    daemonDir: join(root, "daemon"),
    workspacesDir,
    workspacesMetaFile: join(root, "daemon", "workspaces.json"),
    fsRoot: workspacesDir
  } as unknown as CreateServerArgs[1];
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
    workspacesDir,
    inject: app.inject.bind(app),
    close: async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

test("/api/fs/raw and /api/fs/download serve a file addressed by base64url `p`", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const dir = join(h.workspacesDir, "ws", "proj", "superfunbox-banners");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "en-300x250-Diseño_EN_1_300x250.jpg");
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  await writeFile(file, bytes);

  const raw = await h.inject({ method: "GET", url: `/api/fs/raw?p=${b64url(file)}` });
  assert.equal(raw.statusCode, 200);
  assert.deepEqual(raw.rawPayload, bytes);

  const dl = await h.inject({ method: "GET", url: `/api/fs/download?p=${b64url(file)}` });
  assert.equal(dl.statusCode, 200);
  assert.deepEqual(dl.rawPayload, bytes);
  assert.match(dl.headers["content-disposition"] as string, /attachment/);

  // The plain spelling still works (older bundles, curl, scripts).
  const plain = await h.inject({ method: "GET", url: `/api/fs/raw?path=${encodeURIComponent(file)}` });
  assert.equal(plain.statusCode, 200);
  assert.deepEqual(plain.rawPayload, bytes);
});

test("/api/fs GET routes: a malformed `p` is a 400, and `p` cannot escape the sandbox", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const dir = join(h.workspacesDir, "ws", "proj");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "a.txt"), "hello");

  for (const route of ["/api/fs", "/api/fs/files", "/api/fs/read", "/api/fs/raw", "/api/fs/archive", "/api/fs/download"]) {
    const res = await h.inject({ method: "GET", url: `${route}?p=abc=` });
    assert.equal(res.statusCode, 400, route);
    assert.equal(res.json().code, "INVALID_REQUEST", route);
  }
  const parquet = await h.inject({ method: "GET", url: `/api/fs/parquet?p=abc=` });
  assert.equal(parquet.statusCode, 400);
  const search = await h.inject({ method: "GET", url: `/api/fs/search?p=abc=&q=x` });
  assert.equal(search.statusCode, 400);

  // Encoding is not a bypass: the decoded path goes through the same sandbox.
  const outside = await h.inject({ method: "GET", url: `/api/fs/read?p=${b64url("/etc/passwd")}` });
  assert.equal(outside.statusCode, 403);
  assert.equal(outside.json().code, "FS_FORBIDDEN");

  const list = await h.inject({ method: "GET", url: `/api/fs?p=${b64url(dir)}` });
  assert.equal(list.statusCode, 200);
  const read = await h.inject({ method: "GET", url: `/api/fs/read?p=${b64url(join(dir, "a.txt"))}` });
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().content, "hello");
});
