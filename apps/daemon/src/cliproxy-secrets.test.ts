import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cliproxySecretsFile } from "@orquester/config";
import { loadOrInitSecrets, setOpenRouterKey } from "./cliproxy-secrets.ts";

async function makeDir() {
  return mkdtemp(join(tmpdir(), "orq-cliproxy-secrets-"));
}

test("secrets: creates 0600 with generated values; second load returns identical", async () => {
  const dir = await makeDir();
  const first = await loadOrInitSecrets(dir);
  // assert.equal narrows the discriminated union to the "created" branch below.
  assert.equal(first.state, "created");
  assert.match(first.secrets.apiKey, /^[0-9a-f]{48}$/);
  assert.match(first.secrets.managementSecret, /^[0-9a-f]{48}$/);
  assert.equal(first.secrets.openRouterKey, null);
  // apiKey and managementSecret must differ (two independent draws).
  assert.notEqual(first.secrets.apiKey, first.secrets.managementSecret);

  const file = cliproxySecretsFile(dir);
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  const second = await loadOrInitSecrets(dir);
  assert.equal(second.state, "loaded");
  assert.deepEqual(second.secrets, first.secrets);
});

test("secrets: corrupt file → {state:'corrupt'}, file untouched (mtime + content unchanged)", async () => {
  const dir = await makeDir();
  const file = cliproxySecretsFile(dir);
  await mkdir(dirname(file), { recursive: true });
  const garbage = "{ this is not valid json";
  await writeFile(file, garbage, { mode: 0o600 });
  const before = await stat(file);

  const result = await loadOrInitSecrets(dir);
  assert.equal(result.state, "corrupt");

  const after = await stat(file);
  assert.equal(await readFile(file, "utf8"), garbage);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("secrets: setOpenRouterKey rewrites the key, preserving the rest, at 0600", async () => {
  const dir = await makeDir();
  const created = await loadOrInitSecrets(dir);
  if (created.state === "corrupt") throw new Error("unexpected corrupt");

  const updated = await setOpenRouterKey(dir, "sk-or-test");
  assert.equal(updated.openRouterKey, "sk-or-test");
  assert.equal(updated.apiKey, created.secrets.apiKey);
  assert.equal(updated.managementSecret, created.secrets.managementSecret);

  const file = cliproxySecretsFile(dir);
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  const reloaded = await loadOrInitSecrets(dir);
  assert.equal(reloaded.state, "loaded");
  assert.equal(reloaded.secrets.openRouterKey, "sk-or-test");
});
