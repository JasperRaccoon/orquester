import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldHideSystemUsage } from "./usage-sources.ts";

const NOW = Date.parse("2026-08-05T12:00:00Z");
const PAST_MS = NOW - 60_000;
const FUTURE_MS = NOW + 60 * 60_000;

function fakeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

async function writeClaudeCreds(home: string, oauth: Record<string, unknown>): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: oauth }));
}

async function writeCodexAuth(
  home: string,
  opts: { accountId?: string; email?: string; expMs?: number }
): Promise<void> {
  await mkdir(home, { recursive: true });
  const tokens: Record<string, unknown> = {
    access_token: fakeJwt({ exp: Math.floor((opts.expMs ?? FUTURE_MS) / 1000) })
  };
  if (opts.accountId) tokens.account_id = opts.accountId;
  if (opts.email) tokens.id_token = fakeJwt({ email: opts.email });
  await writeFile(join(home, "auth.json"), JSON.stringify({ tokens }));
}

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "orq-usage-vis-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("claude: expired system credentials hide the System row", async () => {
  await withTmp(async (dir) => {
    const home = join(dir, ".claude");
    await writeClaudeCreds(home, { accessToken: "tok", expiresAt: PAST_MS });
    assert.equal(
      await shouldHideSystemUsage("claude", { userhome: dir, now: NOW, claudeHome: home }),
      true
    );
  });
});

test("claude: unexpired system credentials keep the System row", async () => {
  await withTmp(async (dir) => {
    const home = join(dir, ".claude");
    await writeClaudeCreds(home, { accessToken: "tok", expiresAt: FUTURE_MS });
    assert.equal(
      await shouldHideSystemUsage("claude", { userhome: dir, now: NOW, claudeHome: home }),
      false
    );
  });
});

test("claude: missing credentials file does not hide (source already reports null)", async () => {
  await withTmp(async (dir) => {
    assert.equal(
      await shouldHideSystemUsage("claude", { userhome: dir, now: NOW, claudeHome: join(dir, ".claude") }),
      false
    );
  });
});

test("codex: system account matching a managed account_id hides the System row", async () => {
  await withTmp(async (dir) => {
    const sys = join(dir, ".codex");
    const managed = join(dir, "managed-home");
    await writeCodexAuth(sys, { accountId: "acc-1" });
    await writeCodexAuth(managed, { accountId: "acc-1" });
    assert.equal(
      await shouldHideSystemUsage("codex", { userhome: dir, now: NOW, codexHome: sys, managedHomes: [managed] }),
      true
    );
  });
});

test("codex: system account matching a managed email (no account_id) hides the System row", async () => {
  await withTmp(async (dir) => {
    const sys = join(dir, ".codex");
    const managed = join(dir, "managed-home");
    await writeCodexAuth(sys, { email: "dev@example.com" });
    await writeCodexAuth(managed, { email: "dev@example.com" });
    assert.equal(
      await shouldHideSystemUsage("codex", { userhome: dir, now: NOW, codexHome: sys, managedHomes: [managed] }),
      true
    );
  });
});

test("codex: a distinct, unexpired system account keeps the System row", async () => {
  await withTmp(async (dir) => {
    const sys = join(dir, ".codex");
    const managed = join(dir, "managed-home");
    await writeCodexAuth(sys, { accountId: "acc-sys", email: "sys@example.com" });
    await writeCodexAuth(managed, { accountId: "acc-other", email: "other@example.com" });
    assert.equal(
      await shouldHideSystemUsage("codex", { userhome: dir, now: NOW, codexHome: sys, managedHomes: [managed] }),
      false
    );
  });
});

test("codex: an expired system token hides the System row even with a distinct identity", async () => {
  await withTmp(async (dir) => {
    const sys = join(dir, ".codex");
    const managed = join(dir, "managed-home");
    await writeCodexAuth(sys, { accountId: "acc-sys", expMs: PAST_MS });
    await writeCodexAuth(managed, { accountId: "acc-other" });
    assert.equal(
      await shouldHideSystemUsage("codex", { userhome: dir, now: NOW, codexHome: sys, managedHomes: [managed] }),
      true
    );
  });
});

test("codex: missing auth.json does not hide (source already reports null/scrape)", async () => {
  await withTmp(async (dir) => {
    assert.equal(
      await shouldHideSystemUsage("codex", { userhome: dir, now: NOW, codexHome: join(dir, ".codex"), managedHomes: [] }),
      false
    );
  });
});
