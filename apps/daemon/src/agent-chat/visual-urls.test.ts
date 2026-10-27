/**
 * Signed agent-page URLs (spec 2026-10-14 §2.2): minting, expiry, tampering.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createVisualUrlSigner } from "./visual-urls.ts";

const SESSION = "s-1";
const PAGE = "s-1-0f8fad5b-d9cb-469f-a165-70867728950e-html";
const NOW = 1_800_000_000_000;

function query(path: string): { exp: string; sig: string } {
  const params = new URL(path, "http://x").searchParams;
  return { exp: params.get("exp") ?? "", sig: params.get("sig") ?? "" };
}

test("a minted URL names the page and expires at its advertised deadline, within 15 minutes", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const signer = createVisualUrlSigner();
  const minted = signer.mint(SESSION, PAGE);
  assert.ok(minted.path.startsWith(`/api/agent-visuals/${SESSION}/${PAGE}?`));
  assert.ok(minted.expiresAt > NOW && minted.expiresAt <= NOW + 15 * 60_000);
  const { exp, sig } = query(minted.path);
  assert.equal(Number(exp), minted.expiresAt);
  assert.ok(signer.verify(SESSION, PAGE, exp, sig));
  t.mock.timers.setTime(minted.expiresAt);
  assert.ok(signer.verify(SESSION, PAGE, exp, sig), "valid through its last millisecond");
  t.mock.timers.setTime(minted.expiresAt + 1);
  assert.ok(!signer.verify(SESSION, PAGE, exp, sig), "expired URLs are refused");
});

test("a tampered URL is refused: session, page, expiry and signature are all bound", () => {
  const signer = createVisualUrlSigner();
  const { exp, sig } = query(signer.mint(SESSION, PAGE).path);
  assert.ok(!signer.verify("s-2", PAGE, exp, sig), "another session");
  assert.ok(!signer.verify(SESSION, PAGE.replace("0f8f", "1f8f"), exp, sig), "another page");
  assert.ok(!signer.verify(SESSION, PAGE, String(Number(exp) - 1), sig), "another expiry");
  assert.ok(!signer.verify(SESSION, PAGE, exp, `${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`), "another signature");
  assert.ok(!signer.verify(SESSION, PAGE, exp, ""));
  assert.ok(!signer.verify(SESSION, PAGE, exp, undefined));
  assert.ok(!signer.verify(SESSION, PAGE, ["1", "2"], sig), "a repeated query parameter");
  assert.ok(!signer.verify(SESSION, PAGE, "1e20", sig));
  assert.ok(!createVisualUrlSigner().verify(SESSION, PAGE, exp, sig), "another daemon's key");
});

test("a signature claiming more life than a minted URL has is refused", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW + 60 * 60_000 });
  const signer = createVisualUrlSigner();
  // Minted "in the future" — an expiry beyond now + lifetime never came from mint().
  const { exp, sig } = query(signer.mint(SESSION, PAGE).path);
  t.mock.timers.setTime(NOW);
  assert.ok(!signer.verify(SESSION, PAGE, exp, sig));
});
