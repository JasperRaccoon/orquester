import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureKnownHosts, KNOWN_HOSTS_SEED } from "./known-hosts";

test("seeds once, idempotently, preserving TOFU-appended entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-kh-"));
  const path = await ensureKnownHosts(dir);
  await ensureKnownHosts(dir);                       // second call must not duplicate
  const { appendFile } = await import("node:fs/promises");
  await appendFile(path, "[bb.corp.com]:7999 ssh-ed25519 AAAAtofu\n");
  await ensureKnownHosts(dir);                       // must keep the TOFU line
  const text = await readFile(path, "utf8");
  for (const line of KNOWN_HOSTS_SEED) assert.equal(text.split("\n").filter(l => l === line).length, 1);
  assert.ok(text.includes("[bb.corp.com]:7999 ssh-ed25519 AAAAtofu"));
});
