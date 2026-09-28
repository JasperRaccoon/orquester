import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,rm,symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProject } from "./addressing.ts";

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "mcp-addr-"));
  const workspacesDir = join(root, "workspaces");
  await mkdir(join(workspacesDir, "acme", "api"), { recursive: true });
  await mkdir(join(root, "outside"), { recursive: true });
  await symlink(join(root, "outside"), join(workspacesDir, "acme", "escape"));
  return { root, api: { fsRoot: workspacesDir, workspacesDir } };
}

test("workspace/name resolves to the joined path", async (t) => {
  const s = await sandbox(); t.after(() => rm(s.root, { recursive: true, force: true }));
  assert.deepEqual(await resolveProject(s.api, "acme/api"), { workspace: "acme", name: "api", path: join(s.api.workspacesDir, "acme", "api") });
});

test("an absolute path inside the sandbox resolves and is normalised; names are derived", async (t) => {
  const s = await sandbox(); t.after(() => rm(s.root, { recursive: true, force: true }));
  const r = await resolveProject(s.api, join(s.api.workspacesDir, "acme", "api") + "/");
  assert.deepEqual(r, { workspace: "acme", name: "api", path: join(s.api.workspacesDir, "acme", "api") });
});

test("missing project, bad names and escapes are refused with codes", async (t) => {
  const s = await sandbox(); t.after(() => rm(s.root, { recursive: true, force: true }));
  await assert.rejects(resolveProject(s.api, "acme/nope"), (e: { code: string }) => e.code === "PROJECT_NOT_FOUND");
  await assert.rejects(resolveProject(s.api, "../x/y"), (e: { code: string }) => e.code === "PROJECT_NOT_FOUND");
  await assert.rejects(resolveProject(s.api, "acme/escape"), (e: { code: string }) => e.code === "PATH_NOT_ALLOWED");
  await assert.rejects(resolveProject(s.api, "/etc"), (e: { code: string }) => e.code === "PATH_NOT_ALLOWED");
  await assert.rejects(resolveProject(s.api, "acme"), (e: { code: string }) => e.code === "PROJECT_NOT_FOUND");
});

test("a directory inside a project is refused and names the project", async (t) => {
  const s = await sandbox(); t.after(() => rm(s.root, { recursive: true, force: true }));
  await mkdir(join(s.api.workspacesDir, "acme", "api", "src"));
  await assert.rejects(resolveProject(s.api, join(s.api.workspacesDir, "acme", "api", "src")),
    (e: { code: string; message: string }) => e.code === "PROJECT_NOT_FOUND" && /inside project acme\/api/.test(e.message));
});

test("directories above or outside a project are refused with PROJECT_NOT_FOUND", async (t) => {
  const s = await sandbox(); t.after(() => rm(s.root, { recursive: true, force: true }));
  for (const input of [s.api.workspacesDir, s.api.workspacesDir + "/", join(s.api.workspacesDir, "acme")]) {
    await assert.rejects(resolveProject(s.api, input), (e: { code: string }) => e.code === "PROJECT_NOT_FOUND");
  }
  await assert.rejects(resolveProject({ fsRoot: s.root, workspacesDir: s.api.workspacesDir }, join(s.root, "outside")),
    (e: { code: string }) => e.code === "PROJECT_NOT_FOUND");
});
