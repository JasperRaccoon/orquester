import assert from "node:assert/strict";
import test from "node:test";

import { parseTailnetFile, serializeTailnetFile } from "./tailnet.ts";

test("tailnet.json: records it cannot read and unknown keys survive a rewrite", () => {
  const raw = {
    version: 1,
    note: "from a newer build",
    https: { enabled: true, port: 10000, target: "http://127.0.0.1:47831", updatedAt: "2026-11-22T10:00:00.000Z", mode: "funnel" },
    previews: {
      "5173": { port: 5173, target: "http://127.0.0.1:5173", threadId: "t1", createdAt: "2026-11-22T10:00:00.000Z" },
      "3000": { port: "3000", target: 42 },
      "4000": { port: 4001, target: "http://127.0.0.1:4001", createdAt: "2026-11-22T10:00:00.000Z" }
    }
  };
  const file = parseTailnetFile(raw);
  assert.equal(file.https?.port, 10000);
  assert.deepEqual(Object.keys(file.previews), ["5173"]);
  assert.equal(file.previews["5173"]?.threadId, "t1");

  delete file.previews["5173"];
  file.previews["8080"] = { port: 8080, target: "http://[::1]:8080", threadId: null, createdAt: "2026-11-22T11:00:00.000Z" };
  const written = serializeTailnetFile(file);
  assert.equal(written.note, "from a newer build");
  assert.deepEqual((written.https as Record<string, unknown>).mode, "funnel");
  assert.deepEqual(Object.keys(written.previews as object).sort(), ["3000", "4000", "8080"]);

  const unreadableHttps = parseTailnetFile({ https: { enabled: "yes" } });
  assert.equal(unreadableHttps.https, null);
  assert.deepEqual(serializeTailnetFile(unreadableHttps).https, { enabled: "yes" });
  assert.throws(() => parseTailnetFile({ version: 2 }));
});
