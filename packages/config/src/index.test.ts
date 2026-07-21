import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isValidName, parseSessionsConfig } from "./index.ts";
import { assertInsideFsRoot, FsSandboxError } from "./fs.ts";

test("isValidName rejects traversal and empties", () => {
  assert.equal(isValidName("project"), true);
  assert.equal(isValidName(".hidden"), false);
  assert.equal(isValidName("a/b"), false);
  assert.equal(isValidName("a\\b"), false);
  assert.equal(isValidName(""), false);
  assert.equal(isValidName(undefined), false);
});

test("sessionRecordSchema round-trips accountId so reattach keeps the account pin", () => {
  // Zod strips unknown keys, so without accountId on the schema a persisted pin
  // would be silently dropped on read — leaving a reattached account-pinned
  // session invisible to liveAccountIds() and its refresher gate.
  const base = {
    id: "s1",
    title: "Claude",
    order: 0,
    projectPath: "/p",
    refId: "claude",
    kind: "agent" as const,
    cwd: "/p",
    createdAt: "2026-07-21T00:00:00.000Z"
  };
  const parsed = parseSessionsConfig({ version: 1, sessions: [{ ...base, accountId: "acct-A" }] });
  assert.equal(parsed.sessions[0].accountId, "acct-A");
  // Absent accountId (System/host-identity sessions and legacy records) stays undefined.
  const noAccount = parseSessionsConfig({ version: 1, sessions: [base] });
  assert.equal(noAccount.sessions[0].accountId, undefined);
});

test("assertInsideFsRoot allows in-root paths and rejects escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "fsroot-"));
  await mkdir(join(root, "ws"), { recursive: true });
  assert.equal(await assertInsideFsRoot(root, join(root, "ws")), join(root, "ws"));
  // not-yet-existing child still passes (deepest existing ancestor is realpath'd)
  assert.equal(await assertInsideFsRoot(root, join(root, "ws", "new")), join(root, "ws", "new"));
  await assert.rejects(() => assertInsideFsRoot(root, join(root, "..", "escape")), FsSandboxError);
  await assert.rejects(() => assertInsideFsRoot(root, "/etc"), FsSandboxError);
});
