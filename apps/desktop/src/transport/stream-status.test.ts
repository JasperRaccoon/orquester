import assert from "node:assert/strict";
import { test } from "node:test";

import { endBridgeStream } from "./stream-status";

function end(status: unknown): string[] {
  const seen: string[] = [];
  endBridgeStream(status, {
    onError: (error) => seen.push(`error:${(error as { status?: number }).status}`),
    onEnd: () => seen.push("end")
  });
  return seen;
}

test("a status-reported end is an error carrying the status, then the end", () => {
  assert.deepEqual(end(401), ["error:401", "end"]);
  assert.deepEqual(end(503), ["error:503", "end"]);
});

test("a plain end (a clean one, or a stream the daemon cut) is only the end", () => {
  assert.deepEqual(end(undefined), ["end"]);
  assert.deepEqual(end(200), ["end"]);
});

test("a malformed status from the bridge is a plain end", () => {
  assert.deepEqual(end("401"), ["end"]);
  assert.deepEqual(end(401.5), ["end"]);
  assert.deepEqual(end(null), ["end"]);
});

test("a consumer without onError still gets its end", () => {
  const seen: string[] = [];
  endBridgeStream(404, { onEnd: () => seen.push("end") });
  assert.deepEqual(seen, ["end"]);
});
