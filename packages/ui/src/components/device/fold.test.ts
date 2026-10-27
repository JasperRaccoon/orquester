import assert from "node:assert/strict";
import { it } from "node:test";

import { parseAndroidFold, requestAndroidFold } from "./fold.ts";

it("reads the hub's fold answer and refuses anything else", () => {
  assert.deepEqual(parseAndroidFold({ ok: true, fold: { supported: true, posture: "opened", hingeAngle: 180 } }), { supported: true, posture: "opened", hingeAngle: 180 });
  assert.deepEqual(parseAndroidFold({ ok: true, fold: { supported: false, posture: null, hingeAngle: null } }), { supported: false, posture: null, hingeAngle: null });
  assert.equal(parseAndroidFold({ ok: false }), null);
  assert.equal(parseAndroidFold({ ok: true, fold: { supported: true, posture: "sideways", hingeAngle: null } }), null);
  assert.equal(parseAndroidFold({ ok: true, fold: { supported: true, posture: "closed", hingeAngle: Number.NaN } }), null);
  assert.equal(parseAndroidFold("x"), null);
});

it("GETs the posture and POSTs a change as {posture} to the proxy URL; a refusal reads as the hub's message", async () => {
  const saved = globalThis.fetch;
  const seen: { url: string; method: string; body: unknown; type: string | null }[] = [];
  let answer: { status: number; body: unknown } = { status: 200, body: { ok: true, fold: { supported: true, posture: "closed", hingeAngle: 0 } } };
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    seen.push({ url, method: init.method ?? "GET", body: init.body ?? null, type: new Headers(init.headers).get("content-type") });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const url = "http://d.test/api/devices/hosts/local/hub/vendor/serve-emu/api/fold?token=t&device=emulator-5554";
    assert.deepEqual(await requestAndroidFold(url), { supported: true, posture: "closed", hingeAngle: 0 });
    assert.deepEqual(await requestAndroidFold(url, "closed"), { supported: true, posture: "closed", hingeAngle: 0 });
    assert.deepEqual(seen, [
      { url, method: "GET", body: null, type: null },
      { url, method: "POST", body: JSON.stringify({ posture: "closed" }), type: "application/json" }
    ]);
    answer = { status: 404, body: { code: "DEVICE_NOT_LEASED", message: "That device is not leased on this host." } };
    await assert.rejects(requestAndroidFold(url, "opened"), /not leased/);
    answer = { status: 200, body: { ok: true } };
    await assert.rejects(requestAndroidFold(url), /unexpected shape/);
  } finally {
    globalThis.fetch = saved;
  }
});
