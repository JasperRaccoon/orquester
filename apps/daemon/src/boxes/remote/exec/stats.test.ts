import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { boxRoutes } from "@orquester/api";

import { localBoxConnection } from "../../testing.ts";
import { registerBoxStatsRoute } from "./stats.ts";
import { boxRecord, fakeBoxes } from "./testing.ts";

test("GET boxRoutes.stats answers the box's sys.stats, 409 while away, 404 for an unknown box", async () => {
  const connection = localBoxConnection({ boxId: "box-1" });
  const boxes = fakeBoxes();
  boxes.add(boxRecord("box-1"), connection);
  const app = Fastify();
  registerBoxStatsRoute(app, { registry: boxes.registry, hub: boxes.hub });
  try {
    const ok = await app.inject({ method: "GET", url: boxRoutes.stats("box-1") });
    assert.equal(ok.statusCode, 200);
    const stats = ok.json() as { memTotalBytes: number; cpuPercent: number };
    assert.ok(stats.memTotalBytes > 0);
    assert.equal(typeof stats.cpuPercent, "number");

    connection.setConnected(false);
    const away = await app.inject({ method: "GET", url: boxRoutes.stats("box-1") });
    assert.equal(away.statusCode, 409);
    assert.equal((away.json() as { code: string }).code, "BOX_NOT_READY");

    const missing = await app.inject({ method: "GET", url: boxRoutes.stats("nope") });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
  }
});
