import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageAccount } from "@orquester/api";
import { parseClaudeUsage } from "./usage-parse.ts";
import { createClaudeSource } from "./usage-sources.ts";
import { aggregateWorstAccountUsage } from "./index.ts";

const NOW = Date.parse("2026-08-17T00:00:00Z");
const PAST = "2026-08-16T23:59:00Z";
const FUTURE = "2026-08-17T03:00:00Z";

// The live on-host response shape (2026-08): legacy five_hour/seven_day fields
// present AND a limits[] array; the model-scoped weekly cap exists ONLY as a
// limits[] entry, so it must be read even when the legacy fields win the
// session/weekly slots.
const liveBody = {
  five_hour: { utilization: 0, resets_at: null },
  seven_day: { utilization: 96, resets_at: FUTURE },
  limits: [
    { kind: "session", percent: 0, resets_at: null },
    { kind: "weekly_all", percent: 96, resets_at: FUTURE },
    {
      kind: "weekly_scoped",
      percent: 100,
      resets_at: FUTURE,
      scope: { model: { id: null, display_name: "Fable" }, surface: null }
    }
  ]
};

test("parseClaudeUsage surfaces a model-scoped weekly limit alongside the legacy windows", () => {
  const usage = parseClaudeUsage(liveBody, {}, NOW);
  assert.equal(usage.weekly?.percent, 96);
  assert.equal(usage.scopedWindows?.length, 1);
  assert.equal(usage.scopedWindows?.[0].label, "Fable");
  assert.equal(usage.scopedWindows?.[0].percent, 100);
  assert.equal(usage.scopedWindows?.[0].resetsAt, FUTURE);
});

test("parseClaudeUsage drops scoped windows that are unlabeled, expired, or garbage", () => {
  const usage = parseClaudeUsage(
    {
      seven_day: { utilization: 10, resets_at: FUTURE },
      limits: [
        // no model display name → nothing to label the bar with
        { kind: "weekly_scoped", percent: 40, resets_at: FUTURE, scope: { model: { display_name: "" } } },
        { kind: "weekly_scoped", percent: 40, resets_at: FUTURE, scope: {} },
        // already reset → not a current reading
        { kind: "weekly_scoped", percent: 90, resets_at: PAST, scope: { model: { display_name: "Fable" } } },
        // the >101 leak-bug value → dropped like the main windows
        { kind: "weekly_scoped", percent: 400, resets_at: FUTURE, scope: { model: { display_name: "Opus" } } }
      ]
    },
    {},
    NOW
  );
  assert.equal(usage.weekly?.percent, 10);
  assert.equal(usage.scopedWindows, undefined);
});

test("parseClaudeUsage keeps scoped windows in the limits[]-only shape too", () => {
  const usage = parseClaudeUsage(
    {
      limits: [
        { kind: "weekly_all", percent: 49, resets_at: FUTURE },
        { kind: "weekly_scoped", percent: 72, resets_at: FUTURE, scope: { model: { display_name: "Fable" } } }
      ]
    },
    {},
    NOW
  );
  assert.equal(usage.weekly?.percent, 49);
  assert.equal(usage.scopedWindows?.[0].label, "Fable");
  assert.equal(usage.scopedWindows?.[0].percent, 72);
});

test("aggregateWorstAccountUsage carries scoped windows on account rows and the system row", () => {
  const accounts: UsageAccount[] = [
    {
      id: "a1",
      label: "one",
      available: true,
      stale: false,
      session: null,
      weekly: { percent: 96, resetsAt: FUTURE },
      scopedWindows: [{ label: "Fable", percent: 100, resetsAt: FUTURE }]
    }
  ];
  const base = {
    id: "claude",
    available: true,
    stale: false,
    session: null,
    weekly: { percent: 10, resetsAt: FUTURE },
    scopedWindows: [
      { label: "Fable", percent: 55, resetsAt: FUTURE },
      // expired → must not survive onto the system row
      { label: "Opus", percent: 80, resetsAt: PAST }
    ]
  };
  const head = aggregateWorstAccountUsage("claude", base, accounts, NOW);
  assert.equal(head.accounts?.[0].scopedWindows?.[0].label, "Fable");
  assert.equal(head.accounts?.[0].scopedWindows?.[0].percent, 100);
  assert.deepEqual(head.system?.scopedWindows, [{ label: "Fable", percent: 55, resetsAt: FUTURE }]);
});

test("stale last-known reading drops scoped windows whose reset has passed", async (t) => {
  const savedEnv = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedEnv;
  });

  const claudeHome = await mkdtemp(join(tmpdir(), "orq-usage-scoped-"));
  const userhome = await mkdtemp(join(tmpdir(), "orq-usage-scoped-home-"));
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
        json: async () => ({
          seven_day: { utilization: 96, resets_at: new Date(NOW + 4 * 3_600_000).toISOString() },
          limits: [
            {
              kind: "weekly_scoped",
              percent: 100,
              // Fable window resets 1h after the fetch
              resets_at: new Date(NOW + 3_600_000).toISOString(),
              scope: { model: { display_name: "Fable" } }
            }
          ]
        })
      } as unknown as Response;
    }) as unknown as typeof fetch
  });

  const fresh = await source();
  assert.equal(fetches, 1);
  assert.equal(fresh?.scopedWindows?.[0].percent, 100);

  // 2h later: token expired (no refetch) and the Fable window has reset — the
  // served last-known reading must not keep claiming Fable is at 100%.
  clock = NOW + 2 * 3_600_000;
  const served = await source();
  assert.equal(fetches, 1, "expired token must not refetch");
  assert.equal(served?.stale, true);
  assert.equal(served?.weekly?.percent, 96); // still inside its window → kept
  assert.equal(served?.scopedWindows, undefined); // Fable window reset → dead reading
});
