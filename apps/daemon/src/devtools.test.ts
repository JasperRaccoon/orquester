import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseDebugPort } from "./devtools.js";

test("parseDebugPort extracts the loopback port from a puppeteer wsEndpoint", () => {
  assert.equal(parseDebugPort("ws://127.0.0.1:41573/devtools/browser/abc-def"), 41573);
});

test("parseDebugPort rejects garbage, missing ports and out-of-range values", () => {
  assert.equal(parseDebugPort("not a url"), null);
  assert.equal(parseDebugPort(""), null);
  assert.equal(parseDebugPort("ws://127.0.0.1/devtools/browser/x"), null);
  assert.equal(parseDebugPort("ws://127.0.0.1:0/devtools/browser/x"), null);
});
