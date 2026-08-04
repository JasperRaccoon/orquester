import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeUsage } from "./usage-parse.ts";
import { createClaudeSource } from "./usage-sources.ts";

const NOW = Date.parse("2026-07-21T08:00:00Z");
const PAST = "2026-07-21T07:59:00Z";
const FUTURE = "2026-07-21T12:00:00Z";

test("parseClaudeUsage drops a window whose reset time has already passed", () => {
  const usage = parseClaudeUsage(
    {
      five_hour: { utilization: 50, resets_at: PAST },
      seven_day: { utilization: 100, resets_at: FUTURE }
    },
    {},
    NOW
  );
  assert.equal(usage.session, null); // already reset → not a current reading
  assert.equal(usage.weekly?.percent, 100);
});

test("expired-token lastGood serves only windows that have not reset yet", async (t) => {
  const savedEnv = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedEnv;
  });

  const claudeHome = await mkdtemp(join(tmpdir(), "orq-usage-expiry-"));
  const userhome = await mkdtemp(join(tmpdir(), "orq-usage-expiry-home-"));
  t.after(async () => {
    await rm(claudeHome, { recursive: true, force: true });
    await rm(userhome, { recursive: true, force: true });
  });

  // Token expires 90m after the first (successful) fetch.
  await writeFile(
    join(claudeHome, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: NOW + 90 * 60_000, subscriptionType: "max" } })
  );

  let clock = NOW;
  let fetches = 0;
  const source = createClaudeSource({
    userhome,
    claudeHome,
    now: () => clock,
    fetchImpl: (async () => {
      fetches++;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        // Weekly window resets 1h after the fetch; session window 4h after.
        json: async () => ({
          five_hour: { utilization: 50, resets_at: new Date(NOW + 4 * 3_600_000).toISOString() },
          seven_day: { utilization: 100, resets_at: new Date(NOW + 3_600_000).toISOString() }
        })
      } as unknown as Response;
    }) as unknown as typeof fetch
  });

  const fresh = await source();
  assert.equal(fetches, 1);
  assert.equal(fresh?.weekly?.percent, 100); // valid while the window is current

  // 2h later the token is expired (no refetch possible) and the weekly window has
  // reset: the served last-known reading must not keep claiming 100%.
  clock = NOW + 2 * 3_600_000;
  const served = await source();
  assert.equal(fetches, 1, "expired token must not refetch");
  assert.equal(served?.stale, true);
  assert.equal(served?.weekly, null); // window reset an hour ago → dead reading
  assert.equal(served?.session?.percent, 50); // still inside its window → kept
});
