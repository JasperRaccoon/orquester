import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { WorkflowError } from "./errors.ts";
import { WorkflowSecretsService } from "./secrets.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orq-wf-secrets-"));
  roots.push(dir);
  return dir;
}

function makeSecrets(file: string) {
  const lines: string[] = [];
  const logger = { warn: (...a: unknown[]) => void lines.push(a.join(" ")), error: (...a: unknown[]) => void lines.push(a.join(" ")) };
  const secrets = new WorkflowSecretsService({ file, logger });
  return { secrets, lines };
}

async function rejectsWith(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof WorkflowError && error.status === status && error.code === code);
}

test("values are stored 0600 (also after an existing file was looser) and never listed", async () => {
  const dir = await scratch();
  const file = join(dir, "daemon", "workflow-secrets.json");
  const { secrets, lines } = makeSecrets(file);
  await secrets.load();
  await secrets.set("API_TOKEN", "hunter2-value");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await chmod(file, 0o644);
  await secrets.set("OTHER", "abc");
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  const list = secrets.list();
  assert.deepEqual(
    list.map((s) => ({ name: s.name, scope: s.scope, short: s.short })).sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: "API_TOKEN", scope: "global", short: false },
      { name: "OTHER", scope: "global", short: true }
    ]
  );
  assert.ok(!JSON.stringify(list).includes("hunter2"), "names only");
  assert.ok(!lines.join("\n").includes("hunter2"), "values never logged");
});

test("a workflow's own secret shadows a global one; list shows both scopes; deleteForWorkflow removes its own", async () => {
  const dir = await scratch();
  const file = join(dir, "workflow-secrets.json");
  const { secrets } = makeSecrets(file);
  await secrets.load();
  const events: unknown[] = [];
  secrets.lifecycle.on("changed", (payload) => events.push(payload));
  await secrets.set("TOKEN", "global-value");
  await secrets.set("BASE", "https://example.test");
  await secrets.set("TOKEN", "own-value", "wf-1");

  assert.deepEqual(secrets.resolve("wf-1"), { TOKEN: "own-value", BASE: "https://example.test" });
  assert.deepEqual(secrets.resolve("wf-2"), { TOKEN: "global-value", BASE: "https://example.test" });
  assert.deepEqual(
    secrets.list("wf-1").map((s) => `${s.name}:${s.scope}`).sort(),
    ["BASE:global", "TOKEN:global", "TOKEN:workflow"]
  );
  assert.deepEqual(secrets.names("wf-1").sort(), ["BASE", "TOKEN"]);

  assert.equal(await secrets.delete("TOKEN", "wf-2"), false);
  await secrets.deleteForWorkflow("wf-1");
  assert.deepEqual(secrets.resolve("wf-1"), { TOKEN: "global-value", BASE: "https://example.test" });
  assert.equal(await secrets.delete("BASE"), true);
  assert.deepEqual(events, [{ workflowId: null }, { workflowId: null }, { workflowId: "wf-1" }, { workflowId: "wf-1" }, { workflowId: null }]);

  const { secrets: reloaded } = makeSecrets(file);
  await reloaded.load();
  assert.deepEqual(reloaded.resolve("wf-1"), { TOKEN: "global-value" });
});

test("names and values are validated: 400 SECRET_INVALID", async () => {
  const dir = await scratch();
  const { secrets } = makeSecrets(join(dir, "workflow-secrets.json"));
  await secrets.load();
  for (const name of ["lower", "1ABC", "A-B", "", `A${"B".repeat(64)}`]) {
    await rejectsWith(secrets.set(name, "value"), 400, "SECRET_INVALID");
  }
  await rejectsWith(secrets.set("BIG", "x".repeat(64 * 1024 + 1)), 400, "SECRET_INVALID");
  await rejectsWith(secrets.set("NOT_TEXT", 42 as never), 400, "SECRET_INVALID");
  await secrets.set("EXACT", "x".repeat(64 * 1024));
  assert.deepEqual(secrets.names(), ["EXACT"]);
});

test("a foreign-version file is moved aside, without quoting a value", async () => {
  const dir = await scratch();
  const file = join(dir, "workflow-secrets.json");
  const content = JSON.stringify({ version: 2, global: { TOKEN: { value: "leak-me-not", updatedAt: "2026-09-28T10:00:00Z" } } });
  await writeFile(file, content);
  const { secrets, lines } = makeSecrets(file);
  await secrets.load();
  assert.deepEqual(secrets.list(), []);
  const aside = (await readdir(dir)).find((name) => name.startsWith("workflow-secrets.json.corrupt-"));
  assert.ok(aside);
  assert.equal(await readFile(join(dir, aside), "utf8"), content);
  assert.ok(!lines.join("\n").includes("leak-me-not"));
});

test("an unreadable path makes the store read-only (503) and preserves existing content", async () => {
  const file = join(await scratch(), "workflow-secrets.json");
  await mkdir(file);
  const sentinel = join(file, "keep");
  await writeFile(sentinel, "original");
  const { secrets } = makeSecrets(file);
  await secrets.load();
  await rejectsWith(secrets.set("A_B", "value"), 503, "WORKFLOWS_UNAVAILABLE");
  await secrets.deleteForWorkflow("wf-1");
  assert.equal(await readFile(sentinel, "utf8"), "original");
});
