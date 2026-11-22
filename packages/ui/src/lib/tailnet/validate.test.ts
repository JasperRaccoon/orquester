import assert from "node:assert/strict";
import test from "node:test";

import { parseTailnetChanged, parseTailnetHttpsStatus } from "./validate";

test("tailnet answers: a broken envelope is refused, a bad preview is left out, an unknown problem code keeps its fix", () => {
  assert.equal(parseTailnetHttpsStatus({ serveState: "funnel" }), null);
  assert.equal(parseTailnetHttpsStatus(null), null);
  const status = parseTailnetHttpsStatus({
    available: true,
    url: "javascript:alert(1)",
    operatorOk: true,
    serveState: "failed",
    port: 10000,
    checkedAt: "2026-11-22T10:00:00.000Z",
    problem: { code: "tailscale-something-new", message: "Tailscale said no.", fix: "Do the thing." }
  });
  assert.equal(status?.url, null);
  assert.deepEqual(status?.problem, { code: "tailscale-serve-failed", message: "Tailscale said no.", fix: "Do the thing." });

  const changed = parseTailnetChanged({
    https: { serveState: "serving", url: "https://pc.tail1.ts.net:10000", port: 10000 },
    previews: [{ port: 5173, url: "https://pc.tail1.ts.net:5173", threadId: "t1", createdAt: "x" }, { port: "5174" }, { port: 6000, url: "http://pc:6000" }]
  });
  assert.deepEqual(changed?.previews.map((preview) => preview.port), [5173]);
  assert.equal(parseTailnetChanged({ https: { serveState: "serving" } }), null);
});
