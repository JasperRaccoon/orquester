/**
 * The Usage view's routes through the daemon's own router: `GET /api/usage/history` merges the chat
 * logs before answering from the ledger, and `PUT /api/usage/prices` validates, persists and
 * reprices that answer.
 */

import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { UsageHistoryResponse, UsagePricesResponse } from "@orquester/api";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";

import { createServer } from "./index.ts";
import { UsageHistory } from "./usage-history.ts";
import { setUsagePricingConfig } from "./usage-pricing.ts";
import { UsagePricingStore } from "./usage-pricing-store.ts";
import { HOUR_MS, type UsageRecord } from "./usage-records.ts";

type CreateServerArgs = Parameters<typeof createServer>;

afterEach(() => setUsagePricingConfig({ overrides: {}, aliases: {} }));

const NOW = Date.now();

const chatRecord: UsageRecord = {
  source: "orquester-chats", agent: "opencode", model: "house-model", hour: Math.floor(NOW / HOUR_MS), cwd: null, session: "t1", speed: "standard",
  input: 1_000_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0, requests: 1, reportedCostUsd: 0, reportedRequests: 0
};

test("history answers from the ledger after merging the chat logs; a price edit is validated, then reprices it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orq-usage-history-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let chatRefreshes = 0;
  let scanRequests = 0;
  const chatThreadUsage = { refresh: async () => void chatRefreshes++, historyRecords: () => [chatRecord] };
  const usageTokens = { requestRecompute: () => void scanRequests++, recompute: async () => undefined, historyRecords: () => null };
  const usageHistory = new UsageHistory({ path: join(root, "usage-history.json"), workspacesDir: () => root });
  const usagePricing = new UsagePricingStore({ path: join(root, "usage-pricing.json") });
  await usagePricing.load();
  const resolved = { daemonDir: root, baseDir: root, workspacesDir: root, workspacesMetaFile: `${root}/workspaces.json`, fsRoot: root, appConfigFile: `${root}/app.json` } as unknown as CreateServerArgs[1];
  const app = createServer(
    createDefaultDaemonConfig({ env: {} }),
    resolved,
    createDefaultClientConfig(`${root}/daemon.sock`),
    createWriteStream("/dev/null"),
    { usageTokens, chatThreadUsage, usageHistory, usagePricing } as unknown as CreateServerArgs[4],
    { authRequired: false, mode: "local" }
  );
  t.after(() => app.close());
  const history = () => app.inject({ method: "GET", url: "/api/usage/history?range=7d&tz=Europe/Berlin" });
  const putPrices = (payload: object) => app.inject({ method: "PUT", url: "/api/usage/prices", payload });

  const bad = await app.inject({ method: "GET", url: "/api/usage/history?range=91d" });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().code, "INVALID_REQUEST");

  const before = (await history()).json() as UsageHistoryResponse;
  assert.equal(chatRefreshes, 1);
  assert.equal(scanRequests, 1); // no transcript scan yet: one is asked for, and the answer says so
  assert.equal(before.scanning, true);
  assert.deepEqual(before.buckets.map((b) => [b.agent, b.model, b.costSource, b.costUsd]), [["opencode", "house-model", "unpriced", null]]);

  const refused = await putPrices({ overrides: { "house-model": { input: -1, output: 1 } } });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.json().code, "INVALID_REQUEST");
  assert.match(refused.json().message, /input price of house-model/);

  const saved = await putPrices({ overrides: { "house-model": { input: 2, output: 8 } } });
  assert.equal(saved.statusCode, 200);
  const prices = saved.json() as UsagePricesResponse;
  assert.deepEqual(prices.overrides, { "house-model": { input: 2, output: 8 } });
  assert.deepEqual(prices.seenModels.map((m) => [m.model, m.status]), [["house-model", "override"]]);

  const after = (await history()).json() as UsageHistoryResponse;
  assert.deepEqual(after.buckets.map((b) => [b.costSource, b.costUsd]), [["estimated", 2]]);
});
