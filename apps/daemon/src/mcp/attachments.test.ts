import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, constants, existsSync } from "node:fs";
import { mkdtemp, mkdir, open, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDaemonApi } from "./testing.ts";
import { attachmentInputSchema, guessMime, uploadInlineAttachments } from "./attachments.ts";

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "mcp-att-"));
  const ws = join(root, "workspaces"); await mkdir(join(ws, "acme", "api"), { recursive: true });
  await writeFile(join(ws, "acme", "api", "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(root, "secret.txt"), "nope"); await symlink(join(root, "secret.txt"), join(ws, "acme", "api", "link.txt"));
  const api = new FakeDaemonApi(); api.fsRoot = ws; api.workspacesDir = ws;
  return { root, ws, api };
}

test("schema accepts the two shapes and rejects mixed or empty ones", () => {
  assert.ok(attachmentInputSchema.safeParse({ path: "/x/y.png" }).success);
  assert.ok(attachmentInputSchema.safeParse({ name: "a.txt", base64: "YQ==" }).success);
  assert.ok(!attachmentInputSchema.safeParse({ name: "a.txt" }).success);
  assert.ok(!attachmentInputSchema.safeParse({ path: "/x", base64: "YQ==" }).success);
});

test("guessMime by extension", () => {
  assert.equal(guessMime("a.PNG"), "image/png"); assert.equal(guessMime("b.jpg"), "image/jpeg"); assert.equal(guessMime("c.pdf"), "application/pdf"); assert.equal(guessMime("d"), undefined);
});

test("uploads a sandbox file and an inline base64 file with the right meta, returning the host's refs in order", async (t) => {
  const s = await sandbox(); t.after(() => rm(s.root, { recursive: true, force: true }));
  const refs = await uploadInlineAttachments(s.api, "c1", [{ path: join(s.ws, "acme", "api", "shot.png") }, { name: "notes.txt", base64: Buffer.from("hello").toString("base64") }]);
  assert.equal(refs.length, 2);
  assert.deepEqual(s.api.uploads.map((u) => [u.sessionId, u.meta, u.bytes.toString("latin1").length]), [["c1", { name: "shot.png", type: "image/png" }, 4], ["c1", { name: "notes.txt", type: "text/plain" }, 5]]);
  assert.equal(refs[0].type, "image"); assert.equal(refs[1].type, "file"); assert.equal(refs[1].name, "notes.txt");
});

test("refuses more than 8, a path outside the sandbox (incl. a symlink escape), a missing file, bad base64, and oversize", async (t) => {
  const s = await sandbox(); t.after(() => rm(s.root, { recursive: true, force: true }));
  const nine = Array.from({ length: 9 }, () => ({ name: "a.txt", base64: "YQ==" }));
  await assert.rejects(uploadInlineAttachments(s.api, "c1", nine), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  await assert.rejects(uploadInlineAttachments(s.api, "c1", [{ path: join(s.root, "secret.txt") }]), (e: { code: string }) => e.code === "PATH_NOT_ALLOWED");
  await assert.rejects(uploadInlineAttachments(s.api, "c1", [{ path: join(s.ws, "acme", "api", "link.txt") }]), (e: { code: string }) => e.code === "PATH_NOT_ALLOWED");
  await assert.rejects(uploadInlineAttachments(s.api, "c1", [{ path: join(s.ws, "acme", "api", "missing.txt") }]), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  await assert.rejects(uploadInlineAttachments(s.api, "c1", [{ name: "x.txt", base64: "not base64!!" }]), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  const bigImage = { name: "big.png", base64: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64") };
  await assert.rejects(uploadInlineAttachments(s.api, "c1", [bigImage]), (e: { message: string }) => /10 MiB/.test(e.message));
  assert.equal(s.api.uploads.length, 0, "nothing is uploaded when validation fails");
});

test("a host refusal becomes the daemon's error", async (t) => {
  const s = await sandbox(); t.after(() => rm(s.root, { recursive: true, force: true }));
  s.api.onUpload(() => ({ status: 400, value: { error: { code: "INVALID_COMMAND", message: "Attachment exceeds the 50 MiB limit." } } }));
  await assert.rejects(uploadInlineAttachments(s.api, "c1", [{ name: "a.txt", base64: "YQ==" }]), (e: { code: string }) => e.code === "INVALID_COMMAND");
});

test("guessMime answers from its own table only, never an inherited object key", () => {
  assert.equal(guessMime("x.constructor"), undefined); assert.equal(guessMime("x.__proto__"), undefined);
});

test("a relative path resolves against the sandbox root, as read_file's does", async (t) => {
  const s = await sandbox(); t.after(() => rm(s.root, { recursive: true, force: true }));
  await assert.rejects(uploadInlineAttachments(s.api, "c1", [{ path: join("..", "secret.txt") }]), (e: { code: string }) => e.code === "PATH_NOT_ALLOWED");
  const refs = await uploadInlineAttachments(s.api, "c1", [{ path: join("acme", "api", "shot.png") }]);
  assert.equal(refs[0].type, "image");
  assert.deepEqual(s.api.uploads.map((u) => [u.meta, u.bytes.length]), [[{ name: "shot.png", type: "image/png" }, 4]]);
});

test("a mimeType override is read as the host reads it: trimmed, lower-cased, blank meaning absent", async (t) => {
  const s = await sandbox(); t.after(() => rm(s.root, { recursive: true, force: true }));
  await uploadInlineAttachments(s.api, "c1", [{ name: "shot.png", base64: "YQ==", mimeType: "" }, { name: "blob", base64: "YQ==", mimeType: " Image/PNG " }]);
  assert.deepEqual(s.api.uploads.map((u) => u.meta.type), ["image/png", "image/png"]);
  const bigImage = { name: "blob", base64: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64"), mimeType: " image/png " };
  await assert.rejects(uploadInlineAttachments(s.api, "c1", [bigImage]), (e: { message: string }) => /10 MiB/.test(e.message));
});

test("an unreadable sandbox file is the caller's error, not an internal one", { skip: process.getuid?.() === 0 && "root reads any file" }, async (t) => {
  const s = await sandbox(); t.after(() => rm(s.root, { recursive: true, force: true }));
  const locked = join(s.ws, "acme", "api", "locked.txt"); await writeFile(locked, "x", { mode: 0o000 });
  await assert.rejects(uploadInlineAttachments(s.api, "c1", [{ path: locked }]), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  assert.equal(s.api.uploads.length, 0);
});

test("nothing is uploaded when a later attachment fails validation", async (t) => {
  const s = await sandbox(); t.after(() => rm(s.root, { recursive: true, force: true }));
  const valid = [{ name: "ok.txt", base64: "YQ==" }, { path: join(s.ws, "acme", "api", "shot.png") }];
  await assert.rejects(uploadInlineAttachments(s.api, "c1", [...valid, { path: join(s.root, "secret.txt") }]), (e: { code: string }) => e.code === "PATH_NOT_ALLOWED");
  await assert.rejects(uploadInlineAttachments(s.api, "c1", [...valid, { path: join(s.ws, "acme", "api", "missing.txt") }]), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  assert.equal(s.api.uploads.length, 0);
});

test("a path attachment sends the bytes it was validated at, even if the file grows before its upload", async (t) => {
  const s = await sandbox(); t.after(() => rm(s.root, { recursive: true, force: true }));
  const log = join(s.ws, "acme", "api", "app.log"); await writeFile(log, "12345");
  s.api.onUpload((sessionId, meta, bytes) => {
    if (meta.name === "shot.png") appendFileSync(log, "678");
    return { status: 200, value: { type: "file", id: `${sessionId}-${meta.name}`, name: meta.name, sizeBytes: bytes.length } };
  });
  await uploadInlineAttachments(s.api, "c1", [{ path: join(s.ws, "acme", "api", "shot.png") }, { path: log }]);
  assert.deepEqual(s.api.uploads.map((u) => u.bytes.toString("latin1")), ["\x89PNG", "12345"]);
});

test("an empty sandbox file uploads as an empty attachment", async (t) => {
  const s = await sandbox(); t.after(() => rm(s.root, { recursive: true, force: true }));
  const empty = join(s.ws, "acme", "api", "empty.txt"); await writeFile(empty, "");
  await uploadInlineAttachments(s.api, "c1", [{ path: empty }]);
  assert.deepEqual(s.api.uploads.map((u) => [u.meta, u.bytes.length]), [[{ name: "empty.txt", type: "text/plain" }, 0]]);
});

const openFds = async () => (await readdir("/proc/self/fd")).length;

test("every file opened to validate an attachment is closed again, whatever the outcome", { skip: !existsSync("/proc/self/fd") && "needs /proc/self/fd" }, async (t) => {
  const s = await sandbox(); t.after(() => rm(s.root, { recursive: true, force: true }));
  const shot = { path: join(s.ws, "acme", "api", "shot.png") };
  const bigPng = join(s.ws, "acme", "api", "big.png"); await writeFile(bigPng, ""); await truncate(bigPng, 10 * 1024 * 1024 + 1);
  const baseline = await openFds();
  await uploadInlineAttachments(s.api, "c1", [shot, shot]);
  assert.equal(await openFds(), baseline, "after a success");
  for (const bad of [{ path: join(s.ws, "acme") }, { path: bigPng }, { path: join(s.root, "secret.txt") }]) {
    await assert.rejects(uploadInlineAttachments(s.api, "c1", [shot, bad]), (e: { code: string }) => e.code === "INVALID_ARGUMENT" || e.code === "PATH_NOT_ALLOWED");
    assert.equal(await openFds(), baseline, `after refusing ${bad.path}`);
  }
  s.api.onUpload(() => ({ status: 409, value: { error: { code: "COMMAND_REJECTED", message: "no" } } }));
  await assert.rejects(uploadInlineAttachments(s.api, "c1", [shot, shot]), (e: { code: string }) => e.code === "COMMAND_REJECTED");
  assert.equal(await openFds(), baseline, "after a host refusal");
  s.api.uploadAttachment = async () => ({ status: 503, value: { code: "HOST_UNAVAILABLE", message: "The agent host is restarting." } });
  await assert.rejects(uploadInlineAttachments(s.api, "c1", [shot, shot]), (e: { code: string }) => e.code === "HOST_UNAVAILABLE");
  assert.equal(await openFds(), baseline, "after a refusal that never read the body");
});

test("a FIFO in the sandbox is refused at once, never waited on", { skip: process.platform === "win32" && "no FIFOs", timeout: 10_000 }, async (t) => {
  const s = await sandbox();
  const fifo = join(s.ws, "acme", "api", "pipe.txt");
  // Were open() ever to block on it again, the test would time out; this then releases the stuck reader so the run still ends.
  t.after(async () => { await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK).then((w) => w.close(), () => undefined); await rm(s.root, { recursive: true, force: true }); });
  execFileSync("mkfifo", [fifo]);
  await assert.rejects(uploadInlineAttachments(s.api, "c1", [{ path: fifo }]), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
});

test("base64 must be canonical: some data, padding only to a multiple of 4, never 4n+1 data characters", async (t) => {
  const s = await sandbox(); t.after(() => rm(s.root, { recursive: true, force: true }));
  for (const base64 of ["   ", "\n", "==", "AAAAA=", "AAAAA", "YQ=", "YWJj=", "YQ==YQ=="]) {
    await assert.rejects(uploadInlineAttachments(s.api, "c1", [{ name: "x.txt", base64 }]), (e: { code: string }) => e.code === "INVALID_ARGUMENT", JSON.stringify(base64));
  }
  assert.equal(s.api.uploads.length, 0);
  await uploadInlineAttachments(s.api, "c1", [{ name: "a.txt", base64: "YWI=" }, { name: "b.txt", base64: "YWJj\nZA==" }, { name: "c.txt", base64: "YWJjZA" }]);
  assert.deepEqual(s.api.uploads.map((u) => u.bytes.toString("latin1")), ["ab", "abcd", "abcd"]);
});
