import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProject, projectNamesFor } from "./addressing.ts";

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

test("projectNamesFor splits a sandbox path and nulls the rest", () => {
  assert.deepEqual(projectNamesFor("/w/acme/api", "/w"), { workspace: "acme", name: "api", path: "/w/acme/api" });
  assert.deepEqual(projectNamesFor("/w/acme/api/sub", "/w"), { workspace: "acme", name: "api", path: "/w/acme/api/sub" });
  assert.deepEqual(projectNamesFor("/elsewhere", "/w"), { workspace: null, name: null, path: "/elsewhere" });
});

test("a directory that is not a project is refused for what it is: the workspaces root, a workspace, or outside every workspace", async (t) => {
  const s = await sandbox(); t.after(() => rm(s.root, { recursive: true, force: true }));
  const refused = (input: string, message: string) => assert.rejects(resolveProject(s.api, input), (e: { code: string; message: string }) => e.code === "PROJECT_NOT_FOUND" && e.message === message, input);
  const hint = "Pass \"<workspace>/<project>\" (list_projects names them).";
  await refused(s.api.workspacesDir, `"${s.api.workspacesDir}" is the workspaces root, not a project. ${hint}`);
  await refused(`${s.api.workspacesDir}/`, `"${s.api.workspacesDir}/" is the workspaces root, not a project. ${hint}`);
  await refused(join(s.api.workspacesDir, "acme"), `"${join(s.api.workspacesDir, "acme")}" is a workspace, not a project. ${hint}`);
  // A sandbox wider than the workspaces dir reaches directories that sit in no workspace at all.
  const wide = { fsRoot: s.root, workspacesDir: s.api.workspacesDir };
  await assert.rejects(resolveProject(wide, join(s.root, "outside")),
    (e: { code: string; message: string }) => e.code === "PROJECT_NOT_FOUND" && e.message === `"${join(s.root, "outside")}" is not inside a workspace. ${hint}`);
});
