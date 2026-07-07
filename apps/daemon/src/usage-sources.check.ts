import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeSource, createCodexSource } from "./usage-sources";

const NOW = Date.parse("2026-07-07T08:00:00Z");
const now = () => NOW;
const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

async function claudeTests() {
  const home = await mkdtemp(join(tmpdir(), "usage-claude-"));
  const dir = join(home, ".claude");
  await mkdir(dir, { recursive: true });
  const creds = {
    claudeAiOauth: { accessToken: "tok", expiresAt: NOW + 3_600_000, subscriptionType: "max", rateLimitTier: "default_claude_max_20x" }
  };
  await writeFile(join(dir, ".credentials.json"), JSON.stringify(creds));

  // REGRESSION: a 429 with no prior good reading must NOT read as "not logged in".
  let calls = 0;
  const src429 = createClaudeSource({
    userhome: home,
    now,
    fetchImpl: async () => {
      calls++;
      return jsonRes(429, { error: "rate_limited" }, { "retry-after": "600" });
    }
  });
  const a1 = await src429();
  assert.ok(a1, "429 must return an agent, not null");
  assert.equal(a1.id, "claude");
  assert.equal(a1.available, true, "still signed in despite 429");
  assert.equal(a1.stale, true);
  assert.equal(a1.plan, "Max 20x", "plan derived from creds without a fetch");
  assert.equal(a1.session, null, "no number yet");
  // Backoff: a second immediate call must NOT hit the endpoint again.
  const a2 = await src429();
  assert.ok(a2 && a2.available);
  assert.equal(calls, 1, "must back off after 429 (no repeated fetch)");

  // 200 then 429 → stale last-known carrying the real numbers.
  let mode: "ok" | "429" = "ok";
  const src = createClaudeSource({
    userhome: home,
    now,
    fetchImpl: async () =>
      mode === "ok"
        ? jsonRes(200, { five_hour: { utilization: 45, resets_at: "2026-07-07T10:00:00Z" }, seven_day: { utilization: 69 } })
        : jsonRes(429, { error: "x" })
  });
  const good = await src();
  assert.ok(good);
  assert.equal(good.stale, false);
  assert.equal(good.session?.percent, 45);
  assert.ok(good.asOf, "fresh reading stamps asOf");
  mode = "429";
  const stale = await src();
  assert.ok(stale);
  assert.equal(stale.stale, true);
  assert.equal(stale.session?.percent, 45, "stale shows last-known 45%");
  assert.equal(stale.asOf, good.asOf, "stale reuses the last good reading's asOf");

  // No creds file → genuinely not logged in (null → widget shows "not logged in").
  const empty = await mkdtemp(join(tmpdir(), "usage-empty-"));
  const srcNone = createClaudeSource({ userhome: empty, now, fetchImpl: async () => jsonRes(200, {}) });
  assert.equal(await srcNone(), null, "no creds → null");
}

async function codexTests() {
  const home = await mkdtemp(join(tmpdir(), "usage-codex-"));
  const codex = join(home, ".codex");
  const day = join(codex, "sessions", "2026", "07", "07");
  await mkdir(day, { recursive: true });
  await writeFile(join(codex, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: {} }));

  // Older file WITH a real token_count.
  const older = join(day, "rollout-2026-07-07T06-00-00-aaaa.jsonl");
  const tc = {
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        limit_id: "codex",
        plan_type: "pro",
        primary: { used_percent: 3, window_minutes: 300, resets_at: Math.floor((NOW + 3_600_000) / 1000) },
        secondary: { used_percent: 37, window_minutes: 10080, resets_at: Math.floor((NOW + 7 * 86_400_000) / 1000) }
      }
    }
  };
  await writeFile(older, JSON.stringify(tc) + "\n");
  // Newer file (higher mtime) with NO token_count — a brand-new session.
  const newer = join(day, "rollout-2026-07-07T07-30-00-bbbb.jsonl");
  await writeFile(newer, JSON.stringify({ type: "session_meta", payload: {} }) + "\n");
  await utimes(older, new Date(NOW - 3_600_000), new Date(NOW - 3_600_000));
  await utimes(newer, new Date(NOW - 60_000), new Date(NOW - 60_000));

  // REGRESSION: the empty newest file must fall back to the older one, not null.
  const a = await createCodexSource({ userhome: home, now })();
  assert.ok(a, "must fall back to the older file with data, not null");
  assert.equal(a.available, true);
  assert.equal(a.session?.percent, 3);
  assert.equal(a.weekly?.percent, 37);
  assert.equal(a.plan, "Pro");
  assert.ok(a.asOf, "codex reading stamps asOf");

  // API-key mode → null (no subscription quota to read).
  await writeFile(join(codex, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-x" }));
  assert.equal(await createCodexSource({ userhome: home, now })(), null, "api-key mode → null");
}

await claudeTests();
await codexTests();
console.log("usage-sources.check OK");
