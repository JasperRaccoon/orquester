import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import type {
  FsArchiveResponse,
  FsCapabilitiesResponse,
  FsFilesResponse,
  FsListResponse,
  FsParquetResponse,
  FsReadResponse,
  FsSearchResponse,
  FsUploadResponse
} from "@orquester/api";
import { hostToBoxPath } from "@orquester/api";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";

import { createServer } from "../../../index.ts";
import { onPath } from "../../../archive.ts";
import { boxDiskConnection, fakeBoxRegistry, type BoxDiskConnection } from "./test-box.ts";

// Every /api/fs route for a path inside a box project, through createServer (inject only,
// nothing listens). The project's host stub stays EMPTY: every file lives on the "box disk"
// (boxDiskConnection), so an answer can only have come through the box link.

type CreateServerArgs = Parameters<typeof createServer>;

const PARQUET_FIXTURE =
  "UEFSMRUAFdQBFdQBLBUyFQAVBhUGHAAAAAIAAAAyAQAAAAABAAAAAgAAAAMAAAAEAAAABQAAAAYAAAAHAAAACAAAAAkAAAAKAAAACwAAAAwAAAANAAAADgAAAA8AAAAQAAAAEQAAABIAAAATAAAAFAAAABUAAAAWAAAAFwAAABgAAAAVABWABBWABCwVMhUAFQYVBhwAAAACAAAAMgEGAAAAcm93LTAwBgAAAHJvdy0wMQYAAAByb3ctMDIGAAAAcm93LTAzBgAAAHJvdy0wNAYAAAByb3ctMDUGAAAAcm93LTA2BgAAAHJvdy0wNwYAAAByb3ctMDgGAAAAcm93LTA5BgAAAHJvdy0xMAYAAAByb3ctMTEGAAAAcm93LTEyBgAAAHJvdy0xMwYAAAByb3ctMTQGAAAAcm93LTE1BgAAAHJvdy0xNgYAAAByb3ctMTcGAAAAcm93LTE4BgAAAHJvdy0xOQYAAAByb3ctMjAGAAAAcm93LTIxBgAAAHJvdy0yMgYAAAByb3ctMjMGAAAAcm93LTI0FQAV1AEV1AEsFTIVABUGFQYcAAAAAgAAADIBGQAAABoAAAAbAAAAHAAAAB0AAAAeAAAAHwAAACAAAAAhAAAAIgAAACMAAAAkAAAAJQAAACYAAAAnAAAAKAAAACkAAAAqAAAAKwAAACwAAAAtAAAALgAAAC8AAAAwAAAAMQAAABUAFYAEFYAELBUyFQAVBhUGHAAAAAIAAAAyAQYAAAByb3ctMjUGAAAAcm93LTI2BgAAAHJvdy0yNwYAAAByb3ctMjgGAAAAcm93LTI5BgAAAHJvdy0zMAYAAAByb3ctMzEGAAAAcm93LTMyBgAAAHJvdy0zMwYAAAByb3ctMzQGAAAAcm93LTM1BgAAAHJvdy0zNgYAAAByb3ctMzcGAAAAcm93LTM4BgAAAHJvdy0zOQYAAAByb3ctNDAGAAAAcm93LTQxBgAAAHJvdy00MgYAAAByb3ctNDMGAAAAcm93LTQ0BgAAAHJvdy00NQYAAAByb3ctNDYGAAAAcm93LTQ3BgAAAHJvdy00OAYAAAByb3ctNDkVBBk8NQAYBnNjaGVtYRUEABUCJQIYAmlkABUMJQIYBG5hbWUlAEwcAAAAFmQZLBksJgAcFQIZJQYAGRgCaWQVABYyFv4BFv4BJghJHBUAFQAVAgA8KQYZJgAyAAAAJgAcFQwZJQYAGRgEbmFtZRUAFjIWqgQWqgQmhgJJHBUAFQAVAgA8FqwCGQYZJgAyAAAAFqgGFjImCBaoBgAZLCYAHBUCGSUGABkYAmlkFQAWMhb+ARb+ASawBkkcFQAVABUCADwpBhkmADIAAAAmABwVDBklBgAZGARuYW1lFQAWMhaqBBaqBCauCEkcFQAVABUCADwWrAIZBhkmADIAAAAWqAYWMiawBhaoBgAoIHBhcnF1ZXQtY3BwLWFycm93IHZlcnNpb24gMjUuMC4wGSwcAAAcAAAANgEAAFBBUjE=";

const rgAvailable = onPath("rg");
const gitAvailable = onPath("git");

interface Harness {
  root: string;
  workspacesDir: string;
  /** The box project's host path (an empty stub on the host). */
  projectPath: string;
  connection: BoxDiskConnection;
  registry: ReturnType<typeof fakeBoxRegistry>;
  closed: string[];
  inject: ReturnType<typeof createServer>["inject"];
  /** Write a file in the box project (relative path). */
  put(rel: string, content: string | Buffer): Promise<string>;
  /** Read a file from the box project (relative path). */
  get(rel: string): Promise<Buffer>;
  /** The local path of a box project file (relative path). */
  local(rel?: string): string;
}

async function harness(t: test.TestContext, options: { windows?: boolean; env?: Record<string, string> } = {}): Promise<Harness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orq-boxfs-")));
  const workspacesDir = join(root, "workspaces");
  const projectPath = join(workspacesDir, "acme", "engine");
  await mkdir(projectPath, { recursive: true });
  const disk = join(root, "box-disk");
  await mkdir(disk);
  const map = options.windows ? ({ kind: "windows-prefix", prefix: "C:\\orq" } as const) : ({ kind: "identity" } as const);
  const connection = boxDiskConnection({
    disk,
    windows: options.windows,
    ...(options.env ? { env: options.env } : {}),
    argRoots: [hostToBoxPath(map, projectPath)]
  });
  const boxProject = connection.local(hostToBoxPath(map, projectPath));
  await mkdir(boxProject, { recursive: true });
  const registry = fakeBoxRegistry({ projectPath, connection });
  const closed: string[] = [];
  const services = {
    boxRegistry: registry,
    sessions: { closeByProjectPrefix: (path: string) => closed.push(path) },
    browsers: { closeForProject: async () => undefined },
    desktops: { closeForProject: async () => undefined }
  } as unknown as CreateServerArgs[4];
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
    services,
    { authRequired: false, mode: "local" }
  );
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const local = (rel = ""): string => (rel ? join(boxProject, ...rel.split("/")) : boxProject);
  return {
    root,
    workspacesDir,
    projectPath,
    connection,
    registry,
    closed,
    inject: app.inject.bind(app),
    local,
    async put(rel, content) {
      await mkdir(join(local(rel), ".."), { recursive: true });
      await writeFile(local(rel), content);
      return join(projectPath, ...rel.split("/"));
    },
    get: (rel) => readFile(local(rel))
  };
}

const q = (path: string): string => encodeURIComponent(path);

async function hostStubIsEmpty(h: Harness): Promise<void> {
  assert.deepEqual(await readdir(h.projectPath), [], "the host stub of the box project stays empty");
}

/** A PATH directory holding links to the named tools only. */
async function pathWith(t: test.TestContext, tools: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orq-boxfs-path-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const tool of tools) {
    const binary = (process.env.PATH ?? "")
      .split(delimiter)
      .map((entry) => join(entry, tool))
      .find((candidate) => existsSync(candidate));
    if (binary) await symlink(binary, join(dir, tool));
  }
  return dir;
}

// --- list, read, raw ------------------------------------------------------------

test("GET /api/fs lists a box directory with host paths", async (t) => {
  const h = await harness(t);
  await h.put("src/main.ts", "export {};\n");
  await h.put("README.md", "# hi\n");
  const res = await h.inject({ method: "GET", url: `/api/fs?path=${q(h.projectPath)}` });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as FsListResponse;
  assert.equal(body.path, h.projectPath);
  assert.equal(body.parent, join(h.workspacesDir, "acme"));
  assert.deepEqual(
    body.entries.map((entry) => [entry.name, entry.kind, entry.path, entry.size]),
    [
      ["src", "dir", join(h.projectPath, "src"), 0],
      ["README.md", "file", join(h.projectPath, "README.md"), 5]
    ]
  );
  assert.ok(h.connection.calls.some((call) => call.method === "fs.readdir"), "listed through the box");
  await hostStubIsEmpty(h);
});

test("GET /api/fs/read caps at 1 MB and reports the full size", async (t) => {
  const h = await harness(t);
  const big = Buffer.alloc(1024 * 1024 + 4096, "a");
  const path = await h.put("big.txt", big);
  const res = await h.inject({ method: "GET", url: `/api/fs/read?path=${q(path)}` });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as FsReadResponse;
  assert.equal(body.path, path);
  assert.equal(body.size, big.length);
  assert.equal(body.truncated, true);
  assert.equal(body.content.length, 1024 * 1024);

  const small = await h.put("small.txt", "héllo\n");
  const smallRes = (await h.inject({ method: "GET", url: `/api/fs/read?p=${Buffer.from(small).toString("base64url")}` })).json() as FsReadResponse;
  assert.deepEqual(smallRes, { path: small, content: "héllo\n", size: 7, truncated: false });
});

test("GET /api/fs/raw returns the bytes and refuses a file over the preview cap", async (t) => {
  const h = await harness(t);
  const bytes = randomBytes(64 * 1024);
  const path = await h.put("blob.bin", bytes);
  const res = await h.inject({ method: "GET", url: `/api/fs/raw?path=${q(path)}` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/octet-stream");
  assert.deepEqual(res.rawPayload, bytes);

  // A sparse 51 MB file: refused from its size alone.
  const huge = await h.put("huge.bin", "");
  await truncate(h.local("huge.bin"), 51 * 1024 * 1024);
  const tooLarge = await h.inject({ method: "GET", url: `/api/fs/raw?path=${q(huge)}` });
  assert.equal(tooLarge.statusCode, 413);
  assert.equal(tooLarge.json().code, "FS_TOO_LARGE");

  const dir = await h.inject({ method: "GET", url: `/api/fs/raw?path=${q(h.projectPath)}` });
  assert.equal(dir.statusCode, 400);
  assert.equal(dir.json().message, "Not a file.");
});

// --- quick-open and search --------------------------------------------------------

async function gitFixture(h: Harness): Promise<void> {
  await h.put(".gitignore", "build/\n");
  await h.put("src/app.ts", "const needle = 1;\nconst NEEDLE = 2;\n");
  await h.put("src/util/helpers.ts", "export const needleHelper = () => 'needle';\n");
  await h.put("docs/guide.md", "The needle is here.\n");
  await h.put("build/out.js", "needle in build output\n");
  await h.put("node_modules/dep/index.js", "needle in a dependency\n");
  execFileSync("git", ["init", "-q"], { cwd: h.local() });
  execFileSync("git", ["add", "."], { cwd: h.local() });
}

test("GET /api/fs/files lists in the box (rg, then git ls-files, then a walk) with the same result", { skip: !gitAvailable }, async (t) => {
  const expected = [".gitignore", "docs/guide.md", "src/app.ts", "src/util/helpers.ts"];
  const variants: Array<{ name: string; tools: string[] | null; skip?: boolean }> = [
    { name: "rg", tools: null, skip: !rgAvailable },
    { name: "git", tools: ["git"] }
  ];
  for (const variant of variants) {
    if (variant.skip) continue;
    const env = variant.tools ? { PATH: await pathWith(t, variant.tools) } : undefined;
    const h = await harness(t, env ? { env } : {});
    await gitFixture(h);
    const res = await h.inject({ method: "GET", url: `/api/fs/files?path=${q(h.projectPath)}` });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as FsFilesResponse;
    assert.equal(body.root, h.projectPath, variant.name);
    assert.deepEqual(
      body.files.map((file) => file.path),
      expected,
      variant.name
    );
    assert.equal(body.files.find((file) => file.path === "src/app.ts")?.size, 36, variant.name);
    const ran = h.connection.execs.map((exec) => exec.command);
    assert.ok(ran.includes(variant.name), `${variant.name} ran in the box (${ran.join(", ")})`);
    await hostStubIsEmpty(h);
  }

  // No rg, no git: a walk over fs.readdir. Ignored files are listed (nothing knows the rules), skip dirs are not.
  const walk = await harness(t, { env: { PATH: await pathWith(t, []) } });
  await gitFixture(walk);
  const res = await walk.inject({ method: "GET", url: `/api/fs/files?path=${q(walk.projectPath)}` });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(
    (res.json() as FsFilesResponse).files.map((file) => file.path),
    [".gitignore", "build/out.js", "docs/guide.md", "src/app.ts", "src/util/helpers.ts"]
  );
});

test("GET /api/fs/search searches in the box: literal, regex, globs, and without rg", { skip: !gitAvailable }, async (t) => {
  const h = await harness(t);
  await gitFixture(h);
  const search = async (h2: Harness, params: string): Promise<{ status: number; body: FsSearchResponse & { code?: string } }> => {
    const res = await h2.inject({ method: "GET", url: `/api/fs/search?path=${q(h2.projectPath)}&${params}` });
    return { status: res.statusCode, body: res.json() };
  };
  const summary = (body: FsSearchResponse): Array<[string, number[]]> =>
    body.files.map((file) => [file.path, file.matches.map((match) => match.line)]);

  if (rgAvailable) {
    const literal = await search(h, "q=needle");
    assert.equal(literal.status, 200);
    assert.equal(literal.body.tool, "rg");
    assert.deepEqual(summary(literal.body), [
      ["docs/guide.md", [1]],
      ["src/app.ts", [1, 2]],
      ["src/util/helpers.ts", [1, 1]]
    ]);
    assert.equal(literal.body.files.find((file) => file.path === "src/app.ts")?.size, 36);

    const regex = await search(h, `q=${q("NEEDLE\\s*=")}&regex=1&caseSensitive=1`);
    assert.equal(regex.status, 200);
    assert.deepEqual(summary(regex.body), [["src/app.ts", [2]]]);

    const globbed = await search(h, `q=needle&include=${q("src/**")}&exclude=${q("**/util/**")}`);
    assert.deepEqual(summary(globbed.body), [["src/app.ts", [1, 2]]]);

    const badRegex = await search(h, `q=${q("(unclosed")}&regex=1`);
    assert.equal(badRegex.status, 400);
  }

  // Without rg: git grep pre-filters, the node engine reads only those files over the link.
  const gitOnly = await harness(t, { env: { PATH: await pathWith(t, ["git"]) } });
  await gitFixture(gitOnly);
  const viaGit = await search(gitOnly, "q=needle");
  assert.equal(viaGit.status, 200);
  assert.equal(viaGit.body.tool, "node");
  assert.deepEqual(summary(viaGit.body), [
    ["docs/guide.md", [1]],
    ["src/app.ts", [1, 2]],
    ["src/util/helpers.ts", [1, 1]]
  ]);
  assert.ok(gitOnly.connection.execs.some((exec) => exec.command === "git" && exec.args[0] === "grep"), "git grep ran in the box");
  const regexWithoutRg = await search(gitOnly, "q=needle&regex=1");
  assert.equal(regexWithoutRg.status, 400);
  assert.equal(regexWithoutRg.body.code, "REGEX_UNSUPPORTED");

  // Neither: a walk, same matches (the ignored build output is searched only with includeIgnored on the host too).
  const bare = await harness(t, { env: { PATH: await pathWith(t, []) } });
  await gitFixture(bare);
  const viaWalk = await search(bare, "q=needle&caseSensitive=1");
  assert.equal(viaWalk.status, 200);
  assert.deepEqual(summary(viaWalk.body), [
    ["build/out.js", [1]],
    ["docs/guide.md", [1]],
    ["src/app.ts", [1]],
    ["src/util/helpers.ts", [1, 1]]
  ]);
});

// --- write, create, rename, delete --------------------------------------------------

test("write, create, rename and delete act in the box", async (t) => {
  const h = await harness(t);
  const script = await h.put("run.sh", "#!/bin/sh\necho old\n");
  execFileSync("chmod", ["755", h.local("run.sh")]);

  const write = await h.inject({ method: "PUT", url: "/api/fs/write", payload: { path: script, content: "#!/bin/sh\necho new\n" } });
  assert.equal(write.statusCode, 200, write.body);
  assert.equal((await h.get("run.sh")).toString(), "#!/bin/sh\necho new\n");
  assert.equal((await lstat(h.local("run.sh"))).mode & 0o777, 0o755, "the file keeps its mode");

  const dir = await h.inject({ method: "POST", url: "/api/fs/create", payload: { path: join(h.projectPath, "a/b"), kind: "dir" } });
  assert.equal(dir.statusCode, 200, dir.body);
  assert.ok((await lstat(h.local("a/b"))).isDirectory());
  const file = await h.inject({ method: "POST", url: "/api/fs/create", payload: { path: join(h.projectPath, "a/b/new.txt"), kind: "file" } });
  assert.equal(file.statusCode, 200, file.body);
  assert.equal((await h.get("a/b/new.txt")).length, 0);
  const again = await h.inject({ method: "POST", url: "/api/fs/create", payload: { path: join(h.projectPath, "a/b/new.txt"), kind: "file" } });
  assert.equal(again.statusCode, 400);
  assert.match(again.json().message, /EEXIST/);

  await h.put("taken.txt", "occupied");
  const conflict = await h.inject({ method: "POST", url: "/api/fs/rename", payload: { path: script, newName: "taken.txt" } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, "FS_EXISTS");
  const renamed = await h.inject({ method: "POST", url: "/api/fs/rename", payload: { path: script, newName: "start.sh" } });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.ok(existsSync(h.local("start.sh")) && !existsSync(h.local("run.sh")));
  const badName = await h.inject({ method: "POST", url: "/api/fs/rename", payload: { path: script, newName: "../x" } });
  assert.equal(badName.statusCode, 400);
  const rootRename = await h.inject({ method: "POST", url: "/api/fs/rename", payload: { path: h.projectPath, newName: "other" } });
  assert.equal(rootRename.statusCode, 400);

  const removed = await h.inject({ method: "DELETE", url: `/api/fs?path=${q(join(h.projectPath, "a"))}` });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.ok(!existsSync(h.local("a")));
  assert.deepEqual(h.closed, [join(h.projectPath, "a"), join(h.projectPath, "a")], "sessions under the deleted tree are closed");
  const rootDelete = await h.inject({ method: "DELETE", url: `/api/fs?path=${q(h.projectPath)}` });
  assert.equal(rootDelete.statusCode, 400);
  assert.ok(existsSync(h.local()), "the box project's folder is never deleted through the file browser");
  await hostStubIsEmpty(h);
});

// --- upload, download ----------------------------------------------------------------

test("POST /api/fs/upload streams a multi-MB body into the box, with conflicts", async (t) => {
  const h = await harness(t);
  const bytes = randomBytes(6 * 1024 * 1024 + 123);
  const upload = (relativePath: string, onConflict?: string, payload: Buffer = bytes) =>
    h.inject({
      method: "POST",
      url: `/api/fs/upload?destDir=${q(h.projectPath)}&relativePath=${q(relativePath)}${onConflict ? `&onConflict=${onConflict}` : ""}`,
      headers: { "content-type": "application/octet-stream" },
      payload
    });
  const first = await upload("assets/data.bin");
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json(), { path: join(h.projectPath, "assets", "data.bin"), name: "data.bin", size: bytes.length });
  assert.ok((await h.get("assets/data.bin")).equals(bytes));

  const conflict = (await upload("assets/data.bin")).json() as FsUploadResponse;
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.conflictKind, "file");
  const kept = (await upload("assets/data.bin", "rename", Buffer.from("second"))).json() as FsUploadResponse;
  assert.equal(kept.path, join(h.projectPath, "assets", "data (1).bin"));
  assert.equal((await h.get("assets/data (1).bin")).toString(), "second");
  const replaced = await upload("assets/data.bin", "overwrite", Buffer.from("third"));
  assert.equal(replaced.statusCode, 200);
  assert.equal((await h.get("assets/data.bin")).toString(), "third");
  const dirClash = (await upload("assets", "error", Buffer.from("x"))).json() as FsUploadResponse;
  assert.equal(dirClash.conflictKind, "dir");

  const invalid = await upload("../escape.bin");
  assert.equal(invalid.statusCode, 400);
  // No temp files left behind.
  assert.deepEqual((await readdir(h.local("assets"))).sort(), ["data (1).bin", "data.bin"]);
  assert.deepEqual((await readdir(h.local())).filter((name) => name.startsWith(".orq-upload-")), []);
  await hostStubIsEmpty(h);
});

test("GET /api/fs/download streams a file and zips a folder in the box", async (t) => {
  const h = await harness(t);
  const bytes = randomBytes(300 * 1024);
  const path = await h.put("pkg/lib.bin", bytes);
  await h.put("pkg/notes/readme.txt", "notes\n");
  const file = await h.inject({ method: "GET", url: `/api/fs/download?path=${q(path)}` });
  assert.equal(file.statusCode, 200);
  assert.equal(file.headers["content-length"], String(bytes.length));
  assert.match(String(file.headers["content-disposition"]), /filename="lib.bin"/);
  assert.deepEqual(file.rawPayload, bytes);

  const caps = (await h.inject({ method: "GET", url: `/api/fs/capabilities?path=${q(h.projectPath)}` })).json() as FsCapabilitiesResponse;
  if (!caps.folderZip) return;
  const folder = await h.inject({ method: "GET", url: `/api/fs/download?path=${q(join(h.projectPath, "pkg"))}` });
  assert.equal(folder.statusCode, 200);
  assert.equal(folder.headers["content-type"], "application/zip");
  const zipPath = join(h.root, "pkg.zip");
  await writeFile(zipPath, folder.rawPayload);
  const listing = execFileSync(caps.zipTool === "zip" || caps.zipTool === "bsdtar" ? "bsdtar" : "7z", caps.zipTool === "7z" ? ["l", zipPath] : ["-tf", zipPath], {
    encoding: "utf8"
  });
  assert.match(listing, /pkg\/lib\.bin/);
  assert.match(listing, /pkg\/notes\/readme\.txt/);

  const missing = await h.inject({ method: "GET", url: `/api/fs/download?path=${q(join(h.projectPath, "nope"))}` });
  assert.equal(missing.statusCode, 404);
});

// --- archive, parquet, capabilities -----------------------------------------------------

test("GET /api/fs/archive lists an archive with the box's tool", { skip: !onPath("zip") }, async (t) => {
  const h = await harness(t);
  await h.put("pack/one.txt", "1");
  await h.put("pack/two/three.txt", "3");
  execFileSync("zip", ["-r", "-q", "pack.zip", "pack"], { cwd: h.local() });
  const res = await h.inject({ method: "GET", url: `/api/fs/archive?path=${q(join(h.projectPath, "pack.zip"))}` });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as FsArchiveResponse;
  assert.equal(body.supported, true, body.reason);
  const names = body.entries.map((entry) => entry.name.replace(/\\/g, "/").replace(/\/$/, ""));
  for (const name of ["pack/one.txt", "pack/two/three.txt"]) assert.ok(names.includes(name), `${name} in ${names.join(", ")}`);
  assert.ok(h.connection.execs.some((exec) => exec.args.includes(join(h.projectPath, "pack.zip"))), "the box's tool read the archive");

  const none = await harness(t, { env: { PATH: await pathWith(t, []) } });
  await none.put("x.zip", "not really");
  const unsupported = (await none.inject({ method: "GET", url: `/api/fs/archive?path=${q(join(none.projectPath, "x.zip"))}` })).json() as FsArchiveResponse;
  assert.equal(unsupported.supported, false);
  assert.match(unsupported.reason ?? "", /box/);
});

test("GET /api/fs/parquet reads a window through ranged box reads", async (t) => {
  const h = await harness(t);
  const path = await h.put("data/table.parquet", Buffer.from(PARQUET_FIXTURE, "base64"));
  const res = await h.inject({ method: "GET", url: `/api/fs/parquet?path=${q(path)}&offset=20&limit=10` });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as FsParquetResponse;
  assert.equal(body.supported, true, body.reason);
  assert.equal(body.rowCount, 50);
  assert.deepEqual(body.columns.map((column) => column.name), ["id", "name"]);
  assert.equal(body.offset, 20);
  assert.deepEqual(body.rows[0], [20, "row-20"]);
  assert.deepEqual(body.rows[9], [29, "row-29"]);

  const sorted = (await h.inject({ method: "GET", url: `/api/fs/parquet?path=${q(path)}&offset=0&limit=2&orderBy=id&desc=1` })).json() as FsParquetResponse;
  assert.deepEqual(sorted.rows, [[49, "row-49"], [48, "row-48"]]);
  const unknownColumn = await h.inject({ method: "GET", url: `/api/fs/parquet?path=${q(path)}&orderBy=nope` });
  assert.equal(unknownColumn.statusCode, 400);
});

test("GET /api/fs/capabilities answers for the box with ?path and for the host without", async (t) => {
  const h = await harness(t, { env: { PATH: await pathWith(t, ["git"]) } });
  const box = (await h.inject({ method: "GET", url: `/api/fs/capabilities?path=${q(h.projectPath)}` })).json() as FsCapabilitiesResponse;
  assert.deepEqual(box, { folderZip: false, zipTool: null, archiveTool: null, regexSearch: false });
  const host = (await h.inject({ method: "GET", url: "/api/fs/capabilities" })).json() as FsCapabilitiesResponse;
  assert.equal("regexSearch" in host, false, "the host answer is unchanged");
});

// --- containment, readiness --------------------------------------------------------------

test("containment: `..` and symlinks out of the box project are refused", async (t) => {
  const h = await harness(t);
  // A file elsewhere in the box, and one outside the box entirely.
  await mkdir(h.connection.local("/etc"), { recursive: true });
  await writeFile(h.connection.local("/etc/secret"), "box secret");
  await symlink("/etc", h.local("box-etc"));
  await symlink(h.connection.local("/etc"), h.local("disk-etc"));
  await symlink(join(h.root, "outside"), h.local("host-out"));
  await mkdir(join(h.root, "outside"));
  await writeFile(join(h.root, "outside", "secret"), "host secret");

  for (const path of [
    join(h.projectPath, "box-etc", "secret"),
    join(h.projectPath, "disk-etc", "secret"),
    join(h.projectPath, "host-out", "secret")
  ]) {
    const res = await h.inject({ method: "GET", url: `/api/fs/read?path=${q(path)}` });
    assert.equal(res.statusCode, 403, `${path}: ${res.body}`);
    assert.equal(res.json().code, "FS_FORBIDDEN");
  }
  const write = await h.inject({ method: "PUT", url: "/api/fs/write", payload: { path: join(h.projectPath, "box-etc", "x"), content: "x" } });
  assert.equal(write.statusCode, 403);
  const upload = await h.inject({
    method: "POST",
    url: `/api/fs/upload?destDir=${q(join(h.projectPath, "box-etc"))}&relativePath=x.bin`,
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from("x")
  });
  assert.equal(upload.statusCode, 403);
  assert.ok(!existsSync(h.connection.local("/etc/x.bin")));

  // `..` resolves out of the project before routing: the host's own sandbox answers.
  const dotdot = await h.inject({ method: "GET", url: `/api/fs/read?path=${q(`${h.projectPath}/../../../../etc/passwd`)}` });
  assert.equal(dotdot.statusCode, 403);
});

test("a box that is not connected answers 409 BOX_NOT_READY; a destroyed one 410", async (t) => {
  const h = await harness(t);
  const path = await h.put("a.txt", "a");
  h.connection.setConnected(false);
  const requests = [
    { method: "GET" as const, url: `/api/fs?path=${q(h.projectPath)}` },
    { method: "GET" as const, url: `/api/fs/read?path=${q(path)}` },
    { method: "GET" as const, url: `/api/fs/search?path=${q(h.projectPath)}&q=a` },
    { method: "GET" as const, url: `/api/fs/download?path=${q(path)}` },
    { method: "PUT" as const, url: "/api/fs/write", payload: { path, content: "b" } },
    { method: "DELETE" as const, url: `/api/fs?path=${q(path)}` }
  ];
  for (const request of requests) {
    const res = await h.inject(request);
    assert.equal(res.statusCode, 409, `${request.method} ${request.url}: ${res.body}`);
    assert.equal(res.json().code, "BOX_NOT_READY");
  }
  const upload = await h.inject({
    method: "POST",
    url: `/api/fs/upload?destDir=${q(h.projectPath)}&relativePath=x.bin`,
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from("x")
  });
  assert.equal(upload.statusCode, 409);
  assert.equal(upload.headers.connection, "close");

  h.connection.setConnected(true);
  h.registry.record.state = "destroyed";
  const gone = await h.inject({ method: "GET", url: `/api/fs/read?path=${q(path)}` });
  assert.equal(gone.statusCode, 410);
  assert.equal(gone.json().code, "BOX_DESTROYED");
  // A host path next to it is untouched by the box's state.
  const hostRes = await h.inject({ method: "GET", url: `/api/fs?path=${q(join(h.workspacesDir, "acme"))}` });
  assert.equal(hostRes.statusCode, 200);
});

// --- Windows mapping, end to end ---------------------------------------------------------

test("a Windows box: every path in and out is a host path", async (t) => {
  const h = await harness(t, { windows: true });
  await h.put("Src/Main.cs", "class Main { /* needle */ }\n");
  const list = (await h.inject({ method: "GET", url: `/api/fs?path=${q(join(h.projectPath, "Src"))}` })).json() as FsListResponse;
  assert.deepEqual(list.entries.map((entry) => entry.path), [join(h.projectPath, "Src", "Main.cs")]);
  assert.equal(list.path, join(h.projectPath, "Src"));
  assert.ok(
    h.connection.calls.some((call) => (call.params as { path?: string }).path?.startsWith("C:\\orq\\")),
    "the box was asked for C:\\orq\\… paths"
  );

  const read = (await h.inject({ method: "GET", url: `/api/fs/read?path=${q(join(h.projectPath, "Src", "Main.cs"))}` })).json() as FsReadResponse;
  assert.equal(read.path, join(h.projectPath, "Src", "Main.cs"));

  // Case-only rename: the box reports no inode, the names match but for case.
  const renamed = await h.inject({ method: "POST", url: "/api/fs/rename", payload: { path: join(h.projectPath, "Src", "Main.cs"), newName: "main.cs" } });
  assert.equal(renamed.statusCode, 200, renamed.body);

  const uploaded = await h.inject({
    method: "POST",
    url: `/api/fs/upload?destDir=${q(join(h.projectPath, "Src"))}&relativePath=${q("deep/file.txt")}`,
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from("hello")
  });
  assert.equal((uploaded.json() as FsUploadResponse).path, join(h.projectPath, "Src", "deep", "file.txt"));

  if (rgAvailable) {
    const found = (await h.inject({ method: "GET", url: `/api/fs/search?path=${q(h.projectPath)}&q=needle` })).json() as FsSearchResponse;
    assert.deepEqual(found.files.map((file) => file.path), ["Src/main.cs"]);
    assert.ok(h.connection.execs.some((exec) => exec.command === "rg" && exec.args[0] === "--path-separator"));
  }

  const missing = await h.inject({ method: "GET", url: `/api/fs/read?path=${q(join(h.projectPath, "nope.txt"))}` });
  assert.equal(missing.statusCode, 400);
  assert.doesNotMatch(missing.json().message, /C:\\orq/i, "error messages name host paths");
  await hostStubIsEmpty(h);
});
