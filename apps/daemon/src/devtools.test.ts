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

import { sanitizeDevtoolsPath } from "./devtools.js";

test("sanitizeDevtoolsPath accepts normal frontend asset paths", () => {
  assert.equal(sanitizeDevtoolsPath("inspector.html"), "inspector.html");
  assert.equal(sanitizeDevtoolsPath("front_end/entrypoints/inspector/inspector.js"),
    "front_end/entrypoints/inspector/inspector.js");
});

test("sanitizeDevtoolsPath rejects traversal, empty segments and junk", () => {
  assert.equal(sanitizeDevtoolsPath("../json/list"), null);
  assert.equal(sanitizeDevtoolsPath("a/../../json"), null);
  assert.equal(sanitizeDevtoolsPath("a//b"), null);
  assert.equal(sanitizeDevtoolsPath(""), null);
  assert.equal(sanitizeDevtoolsPath("a\\b"), null);
  assert.equal(sanitizeDevtoolsPath("%2e%2e/json"), null);
  assert.equal(sanitizeDevtoolsPath("a".repeat(3000)), null);
});

import { redactUrlTokens } from "./devtools.js";

test("redactUrlTokens redacts the plain ?token= form", () => {
  assert.equal(
    redactUrlTokens("/ws-devtools/abc?token=SECRET"),
    "/ws-devtools/abc?token=[redacted]"
  );
  assert.equal(
    redactUrlTokens("/api/fs/download?path=x&token=SECRET"),
    "/api/fs/download?path=x&token=[redacted]"
  );
});

test("redactUrlTokens redacts the percent-encoded token inside the DevTools wss= value", () => {
  assert.equal(
    redactUrlTokens("/devtools-frontend/abc/inspector.html?wss=host%2Fws-devtools%2Fabc%3Ftoken%3DSECRET"),
    "/devtools-frontend/abc/inspector.html?wss=host%2Fws-devtools%2Fabc%3Ftoken%3D[redacted]"
  );
});

test("redactUrlTokens leaves token-free URLs untouched", () => {
  assert.equal(redactUrlTokens("/api/browsers?projectPath=/x"), "/api/browsers?projectPath=/x");
});
