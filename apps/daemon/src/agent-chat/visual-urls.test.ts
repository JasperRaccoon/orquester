/**
 * Signed agent-page URLs (spec 2026-10-14 §2.2): minting, expiry, tampering.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { agentChatRoutes } from "@orquester/api/agent-chat";

import { VISUAL_URL_LIFETIME_MS, createVisualUrlSigner } from "./visual-urls.ts";

const KEY = Buffer.alloc(32, 7);
const SESSION = "s-1";
const PAGE = "s-1-0f8fad5b-d9cb-469f-a165-70867728950e-html";
const NOW = 1_800_000_000_000;

function query(path: string): { exp: string; sig: string } {
  const params = new URL(path, "http://x").searchParams;
  return { exp: params.get("exp") ?? "", sig: params.get("sig") ?? "" };
}

test("a minted URL is the visual route with exp and sig, valid for 15 minutes", () => {
  const signer = createVisualUrlSigner(KEY);
  const minted = signer.mint(SESSION, PAGE, NOW);
  assert.ok(minted.path.startsWith(`${agentChatRoutes.visual(SESSION, PAGE)}?`));
  assert.equal(minted.expiresAt, NOW + VISUAL_URL_LIFETIME_MS);
  assert.ok(VISUAL_URL_LIFETIME_MS <= 15 * 60_000);
  const { exp, sig } = query(minted.path);
  assert.equal(Number(exp), minted.expiresAt);
  assert.ok(signer.verify(SESSION, PAGE, exp, sig, NOW));
  assert.ok(signer.verify(SESSION, PAGE, exp, sig, minted.expiresAt), "valid through its last millisecond");
});

test("an expired URL is refused", () => {
  const signer = createVisualUrlSigner(KEY);
  const { exp, sig } = query(signer.mint(SESSION, PAGE, NOW).path);
  assert.ok(!signer.verify(SESSION, PAGE, exp, sig, NOW + VISUAL_URL_LIFETIME_MS + 1));
});

test("a tampered URL is refused: session, page, expiry and signature are all bound", () => {
  const signer = createVisualUrlSigner(KEY);
  const { exp, sig } = query(signer.mint(SESSION, PAGE, NOW).path);
  assert.ok(!signer.verify("s-2", PAGE, exp, sig, NOW), "another session");
  assert.ok(!signer.verify(SESSION, PAGE.replace("0f8f", "1f8f"), exp, sig, NOW), "another page");
  assert.ok(!signer.verify(SESSION, PAGE, String(Number(exp) - 1), sig, NOW), "another expiry");
  assert.ok(!signer.verify(SESSION, PAGE, exp, `${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`, NOW), "another signature");
  assert.ok(!signer.verify(SESSION, PAGE, exp, "", NOW));
  assert.ok(!signer.verify(SESSION, PAGE, exp, undefined, NOW));
  assert.ok(!signer.verify(SESSION, PAGE, ["1", "2"], sig, NOW), "a repeated query parameter");
  assert.ok(!signer.verify(SESSION, PAGE, "1e20", sig, NOW));
  assert.ok(!createVisualUrlSigner(Buffer.alloc(32, 8)).verify(SESSION, PAGE, exp, sig, NOW), "another daemon's key");
});

test("a signature claiming more life than a minted URL has is refused", () => {
  const signer = createVisualUrlSigner(KEY);
  // Minted "in the future" — an expiry beyond now + lifetime never came from mint().
  const { exp, sig } = query(signer.mint(SESSION, PAGE, NOW + 60 * 60_000).path);
  assert.ok(!signer.verify(SESSION, PAGE, exp, sig, NOW));
});
