import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { assertOwnedAccountHome, AgentAccountError, ACCOUNT_MARKER } from "./agent-account-paths.ts";

async function makeAccountsDir() {
  return mkdtemp(join(tmpdir(), "orq-acct-"));
}

test("passes for a well-formed owned home", async () => {
  const root = await makeAccountsDir();
  const home = join(root, "claude", "id1", "home");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, ACCOUNT_MARKER), "id1");
  await assertOwnedAccountHome(root, "claude", "id1", home);
});

test("rejects a missing marker", async () => {
  const root = await makeAccountsDir();
  const home = join(root, "claude", "id2", "home");
  await mkdir(home, { recursive: true });
  await assert.rejects(() => assertOwnedAccountHome(root, "claude", "id2", home), AgentAccountError);
});

test("rejects a marker with the wrong id", async () => {
  const root = await makeAccountsDir();
  const home = join(root, "claude", "id3", "home");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, ACCOUNT_MARKER), "somethingelse");
  await assert.rejects(() => assertOwnedAccountHome(root, "claude", "id3", home), AgentAccountError);
});

test("rejects a symlinked home that escapes the accounts dir", async () => {
  const root = await makeAccountsDir();
  const outside = await mkdtemp(join(tmpdir(), "orq-out-"));
  await writeFile(join(outside, ACCOUNT_MARKER), "id4");
  const link = join(root, "claude", "id4", "home");
  await mkdir(join(root, "claude", "id4"), { recursive: true });
  await symlink(outside, link);
  await assert.rejects(() => assertOwnedAccountHome(root, "claude", "id4", link), AgentAccountError);
});
