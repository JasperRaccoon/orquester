import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeSource, createCodexSource, createGrokSource } from "./usage-sources";

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
  await writeFile(join(codex, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "tok" } }));

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

  // REGRESSION: with the wham endpoint unavailable (5xx), the log-scrape fallback must
  // still fall back from the empty newest file to the older one with data, not null.
  const a = await createCodexSource({ userhome: home, now, fetchImpl: async () => jsonRes(500, {}) })();
  assert.ok(a, "must fall back to the older file with data, not null");
  assert.equal(a.available, true);
  assert.equal(a.session?.percent, 3);
  assert.equal(a.weekly?.percent, 37);
  assert.equal(a.plan, "Pro");
  assert.ok(a.asOf, "codex reading stamps asOf");

  // API-key mode → null (no subscription quota to read).
  await writeFile(join(codex, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-x" }));
  assert.equal(await createCodexSource({ userhome: home, now })(), null, "api-key mode → null");

  // REGRESSION (F8): auth.json missing (or no access_token) must NOT return null —
  // usage rendered purely from rollout token_count events must still fall back to the
  // log-scrape reading, mirroring the old scan-rollouts-when-unauthenticated behavior.
  const noAuth = await mkdtemp(join(tmpdir(), "usage-codex-noauth-"));
  const noAuthCodex = join(noAuth, ".codex");
  const noAuthDay = join(noAuthCodex, "sessions", "2026", "07", "07");
  await mkdir(noAuthDay, { recursive: true });
  const noAuthRollout = join(noAuthDay, "rollout-2026-07-07T06-00-00-cccc.jsonl");
  await writeFile(noAuthRollout, JSON.stringify(tc) + "\n");
  await utimes(noAuthRollout, new Date(NOW - 3_600_000), new Date(NOW - 3_600_000));
  // No auth.json at all → still scrape the rollout log for the reading.
  const scraped = await createCodexSource({ userhome: noAuth, now, fetchImpl: async () => jsonRes(500, {}) })();
  assert.ok(scraped, "missing auth.json must fall back to rollout log scrape, not null");
  assert.equal(scraped.available, true);
  assert.equal(scraped.session?.percent, 3);
  assert.equal(scraped.weekly?.percent, 37);
  // auth.json present but without tokens.access_token → same log-scrape fallback.
  await writeFile(join(noAuthCodex, "auth.json"), JSON.stringify({ tokens: {} }));
  const scraped2 = await createCodexSource({ userhome: noAuth, now, fetchImpl: async () => jsonRes(500, {}) })();
  assert.ok(scraped2, "auth.json without access_token must fall back to rollout log scrape, not null");
  assert.equal(scraped2.session?.percent, 3);
}

async function grokTests() {
  const base = await mkdtemp(join(tmpdir(), "usage-grok-"));
  const authDir = join(base, "auth");
  const grokHome = join(base, ".grok");
  const billing = (pct: number) =>
    jsonRes(200, {
      config: { creditUsagePercent: pct, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-07-12T00:00:00Z" } }
    });

  // No credential anywhere → null (renders "not linked").
  assert.equal(await createGrokSource({ authDir, grokHome, now, fetchImpl: async () => billing(1) })(), null);

  // cliproxy xai auth file → weekly window; token/sub must never leak into the payload.
  await mkdir(authDir, { recursive: true });
  await writeFile(
    join(authDir, "xai-user@example.com.json"),
    JSON.stringify({ type: "xai", auth_kind: "oauth", access_token: "SECRET-TOK", sub: "uid-1", email: "user@example.com", expired: "2026-07-07T09:00:00Z" })
  );
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const src = createGrokSource({
    authDir,
    grokHome,
    now,
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return billing(22.4);
    }
  });
  const g1 = await src();
  assert.ok(g1);
  assert.equal(g1.id, "grok");
  assert.equal(g1.weekly?.percent, 22.4);
  assert.equal(g1.session, null);
  assert.ok(seen[0].url.includes("/billing"), "goes straight to billing when the file carries a user id");
  assert.equal(seen[0].headers["x-userid"], "uid-1");
  assert.equal(seen[0].headers["x-grok-client-identifier"], "grok-shell");
  assert.ok(!JSON.stringify(g1).includes("SECRET-TOK"), "token must never reach the usage payload");

  // Expired stamp → signed-in/stale, NO fetch (the proxy refreshes, never us).
  await writeFile(
    join(authDir, "xai-user@example.com.json"),
    JSON.stringify({ type: "xai", access_token: "SECRET-TOK", sub: "uid-1", expired: "2026-07-07T07:00:00Z" })
  );
  let fetches = 0;
  const expired = await createGrokSource({
    authDir,
    grokHome,
    now,
    fetchImpl: async () => {
      fetches++;
      return billing(1);
    }
  })();
  assert.ok(expired, "expired credential is still linked, not null");
  assert.equal(expired.stale, true);
  assert.equal(fetches, 0, "expired token must not be sent upstream");

  // 429 → backoff with last-good served stale; no second fetch.
  await writeFile(
    join(authDir, "xai-user@example.com.json"),
    JSON.stringify({ type: "xai", access_token: "SECRET-TOK", sub: "uid-1", expired: "2026-07-07T09:00:00Z" })
  );
  let calls = 0;
  const src429 = createGrokSource({
    authDir,
    grokHome,
    now,
    fetchImpl: async () => {
      calls++;
      return calls === 1 ? billing(50) : jsonRes(429, {}, { "retry-after": "600" });
    }
  });
  const ok1 = await src429();
  assert.equal(ok1?.weekly?.percent, 50);
  const stale1 = await src429();
  assert.equal(stale1?.stale, true);
  assert.equal(stale1?.weekly?.percent, 50, "last-good carried through the 429");
  const stale2 = await src429();
  assert.equal(calls, 2, "backed off after the 429");
  assert.ok(stale2?.stale);

  // grok CLI auth.json fallback (no cliproxy file): userId resolved via /user once.
  const cliOnly = await mkdtemp(join(tmpdir(), "usage-grok-cli-"));
  const cliHome = join(cliOnly, ".grok");
  await mkdir(cliHome, { recursive: true });
  await writeFile(
    join(cliHome, "auth.json"),
    JSON.stringify({ "https://auth.x.ai::client-1": { key: "CLI-TOK", auth_mode: "oidc", expires_at: "2026-07-07T09:00:00Z" } })
  );
  const cliSeen: string[] = [];
  const cliSrc = createGrokSource({
    authDir: join(cliOnly, "auth"),
    grokHome: cliHome,
    now,
    fetchImpl: async (url) => {
      cliSeen.push(String(url));
      return String(url).includes("/user") ? jsonRes(200, { userId: "uid-9" }) : billing(3);
    }
  });
  const cli1 = await cliSrc();
  assert.equal(cli1?.weekly?.percent, 3);
  assert.ok(cliSeen[0].includes("/user"), "missing user id is resolved via /user first");
  await cliSrc();
  assert.equal(cliSeen.filter((u) => u.includes("/user")).length, 1, "resolved user id is cached");
}

await claudeTests();
await codexTests();
await grokTests();
console.log("usage-sources.check OK");
