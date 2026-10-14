/**
 * The agent-page frame's pure rules (spec 2026-10-14 §2.2, §2.4).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { readHtmlRenderKeyDown } from "@orquester/api/agent-chat";

import {
  VISUAL_FRAME_SHORTCUTS,
  VISUAL_VIEWER_SHORTCUTS,
  VisualUrlCache,
  isAllowedVisualKey,
  stepVisualZoom,
  visualFrameSrc,
  visualRequestAllowed
} from "./visual-frame";

const PATH = "/api/agent-visuals/s1/s1-0f8fad5b-d9cb-469f-a165-70867728950e-html?exp=1&sig=x";

test("the web frames a page from its own endpoint", () => {
  assert.equal(visualFrameSrc(PATH, { kind: "http", endpoint: "https://orq.example.com/" }), `https://orq.example.com${PATH}`);
});

test("the desktop frames a page through its page scheme, local or remote", () => {
  assert.equal(
    visualFrameSrc(PATH, { kind: "unix", endpoint: "unix:///x/daemon.sock", desktopScheme: "orq-visual" }),
    `orq-visual://local${PATH}`
  );
  const remote = visualFrameSrc(PATH, { kind: "http", endpoint: "https://vps.example.com:8443/base", desktopScheme: "orq-visual" });
  assert.ok(remote?.startsWith("orq-visual://remote/"));
  const encoded = remote!.slice("orq-visual://remote/".length, remote!.indexOf("/api/"));
  assert.equal(Buffer.from(encoded, "base64url").toString("utf8"), "https://vps.example.com:8443");
  assert.ok(remote!.endsWith(PATH));
});

test("no frame where the connection cannot carry one, or for a path that is no page", () => {
  assert.equal(visualFrameSrc(PATH, { kind: "unix", endpoint: "unix:///x" }), null, "an older desktop on the socket");
  assert.equal(visualFrameSrc("/api/sessions/s1/thread", { kind: "http", endpoint: "https://x" }), null);
});

test("a cached URL is reused only with more than five minutes left", () => {
  const cache = new VisualUrlCache();
  const now = 1_000_000;
  cache.remember("k", { src: "a", expiresAt: now + 10 * 60_000 });
  assert.equal(cache.usable("k", now)?.src, "a");
  assert.equal(cache.usable("k", now + 5 * 60_000 + 1), null, "under five minutes left: mint afresh");
  assert.equal(cache.usable("k", now), null, "and the stale one is forgotten");
});

const keydown = (params: Record<string, unknown>) =>
  readHtmlRenderKeyDown({ jsonrpc: "2.0", method: "orq/notifications/keydown", params })!;

test("only the allowed app chords are replayed from a page", () => {
  assert.ok(isAllowedVisualKey(keydown({ key: "k", code: "KeyK", ctrlKey: true }), VISUAL_FRAME_SHORTCUTS));
  assert.ok(isAllowedVisualKey(keydown({ key: "K", code: "KeyK", metaKey: true }), VISUAL_FRAME_SHORTCUTS));
  assert.ok(isAllowedVisualKey(keydown({ key: "A", code: "KeyA", ctrlKey: true, shiftKey: true }), VISUAL_FRAME_SHORTCUTS));
  assert.ok(isAllowedVisualKey(keydown({ key: "j", code: "KeyJ", ctrlKey: true }), VISUAL_FRAME_SHORTCUTS));
  // Inline, a bare Escape is the chat's interrupt: never a page's to send.
  assert.ok(!isAllowedVisualKey(keydown({ key: "Escape", code: "Escape" }), VISUAL_FRAME_SHORTCUTS));
  assert.ok(isAllowedVisualKey(keydown({ key: "Escape", code: "Escape" }), VISUAL_VIEWER_SHORTCUTS));
  // A thread-changing chord, a held key, a printable key: refused.
  assert.ok(!isAllowedVisualKey(keydown({ key: "Enter", code: "Enter", ctrlKey: true, shiftKey: true }), VISUAL_FRAME_SHORTCUTS));
  assert.ok(!isAllowedVisualKey(keydown({ key: "k", code: "KeyK", ctrlKey: true, repeat: true }), VISUAL_FRAME_SHORTCUTS));
  assert.ok(!isAllowedVisualKey(keydown({ key: "k", code: "KeyK" }), VISUAL_FRAME_SHORTCUTS));
});

test("a page's request acts only from its focused frame, after the reader used the app", () => {
  assert.ok(visualRequestAllowed({ fromFrame: true, frameFocused: true, userActive: true }));
  assert.ok(visualRequestAllowed({ fromFrame: true, frameFocused: true, userActive: undefined }), "no activation API: focus decides");
  assert.ok(!visualRequestAllowed({ fromFrame: false, frameFocused: true, userActive: true }));
  assert.ok(!visualRequestAllowed({ fromFrame: true, frameFocused: false, userActive: true }));
  assert.ok(!visualRequestAllowed({ fromFrame: true, frameFocused: true, userActive: false }), "an open on load");
  assert.ok(visualRequestAllowed({ fromFrame: true, frameFocused: true, userActive: false, escape: true }), "Escape is no activation");
});

test("the viewer zooms 50–200 % in 25 % steps", () => {
  assert.equal(stepVisualZoom(1, 1), 1.25);
  assert.equal(stepVisualZoom(1, -1), 0.75);
  assert.equal(stepVisualZoom(2, 1), 2);
  assert.equal(stepVisualZoom(0.5, -1), 0.5);
  let zoom = 1;
  for (let i = 0; i < 10; i += 1) zoom = stepVisualZoom(zoom, -1);
  assert.equal(zoom, 0.5);
});
