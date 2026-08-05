import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type XaiAuthFile,
  deriveXaiAccount,
  removeXaiAuthFiles,
  scanXaiAuthFiles,
  scanXaiQuotaError
} from "./cliproxy-xai.ts";

const NOW = Date.parse("2026-08-05T12:00:00.000Z");
const FUTURE = "2026-08-05T13:00:00.000Z";
const PAST = "2026-08-05T11:00:00.000Z";

async function authDir(files: Record<string, string>): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "orq-xai-")), "auth");
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8");
  }
  return dir;
}

const authFile = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "xai",
    auth_kind: "oauth",
    access_token: "at",
    refresh_token: "rt",
    email: "pilot@example.com",
    expired: FUTURE,
    ...patch
  });

test("scanXaiAuthFiles: reads xai-*.json only, tolerating corrupt and foreign files", async () => {
  const dir = await authDir({
    "xai-pilot@example.com.json": authFile(),
    "xai-broken.json": "{not json",
    "xai-foreign.json": JSON.stringify({ type: "gemini", email: "x@y.z" }),
    "codex-acc1.json": authFile({ type: "codex" }),
    "notes.txt": "ignored"
  });

  const files = await scanXaiAuthFiles(dir);
  assert.deepEqual(
    files.map((f) => f.file),
    ["xai-pilot@example.com.json"]
  );
  assert.equal(files[0].email, "pilot@example.com");
  assert.equal(files[0].expired, FUTURE);
});

test("scanXaiAuthFiles: a missing auth dir is 'nothing linked', never a throw", async () => {
  assert.deepEqual(await scanXaiAuthFiles(join(tmpdir(), "orq-xai-does-not-exist-12345", "auth")), []);
});

test("deriveXaiAccount: none / linked / expired, latest expiry wins the displayed identity", () => {
  assert.deepEqual(deriveXaiAccount([], NOW), { state: "none", email: null, expiredAt: null });

  const fresh: XaiAuthFile = { file: "xai-a.json", email: "a@x.com", expired: FUTURE };
  const stale: XaiAuthFile = { file: "xai-b.json", email: "b@x.com", expired: PAST };

  assert.deepEqual(deriveXaiAccount([stale], NOW), {
    state: "expired",
    email: "b@x.com",
    expiredAt: PAST
  });
  // One live file is enough: `expired` means EVERY file is past due.
  assert.deepEqual(deriveXaiAccount([stale, fresh], NOW), {
    state: "linked",
    email: "a@x.com",
    expiredAt: FUTURE
  });
  // An unreadable stamp must never demote the account.
  assert.equal(deriveXaiAccount([{ file: "xai-c.json", email: null, expired: null }], NOW).state, "linked");
});

test("removeXaiAuthFiles: deletes every xai-*.json and nothing else", async () => {
  const dir = await authDir({
    "xai-a.json": authFile(),
    "xai-b.json": authFile({ email: "b@x.com" }),
    "claude-acc1.json": authFile({ type: "claude" })
  });

  assert.equal(await removeXaiAuthFiles(dir), 2);
  assert.ok(!existsSync(join(dir, "xai-a.json")));
  assert.ok(!existsSync(join(dir, "xai-b.json")));
  assert.ok(existsSync(join(dir, "claude-acc1.json")), "other providers' credentials survive");
  assert.equal(await removeXaiAuthFiles(dir), 0, "idempotent");
});

test("scanXaiQuotaError: picks the most recent usage-exhausted line from the newest log", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "orq-xai-logs-")), "logs");
  await mkdir(dir, { recursive: true });
  assert.equal(await scanXaiQuotaError(dir), null, "no logs → no signal");

  await writeFile(
    join(dir, "request.log"),
    [
      "2026-08-05 11:00:00 200 /v1/messages",
      '2026-08-05 11:30:00 429 upstream {"error":"subscription:heavy-usage-exhausted"}',
      "2026-08-05 11:31:00 200 /v1/messages"
    ].join("\n"),
    "utf8"
  );
  const found = await scanXaiQuotaError(dir);
  assert.ok(found?.includes("usage-exhausted"), `unexpected: ${found}`);
  assert.ok((found ?? "").length <= 300, "clipped for the status payload");
});
