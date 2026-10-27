import assert from "node:assert/strict";
import { it } from "node:test";

import { requestAndroidFold } from "./fold.ts";

it("GETs the posture and POSTs a change as {posture} to the proxy URL; a refusal reads as the hub's message", async () => {
  const saved = globalThis.fetch;
  const seen: { url: string; method: string; body: unknown; type: string | null; auth: string | null }[] = [];
  let answer: { status: number; body: unknown } = { status: 200, body: { ok: true, fold: { supported: true, posture: "closed", hingeAngle: 0 } } };
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    seen.push({ url, method: init.method ?? "GET", body: init.body ?? null, type: new Headers(init.headers).get("content-type"), auth: new Headers(init.headers).get("authorization") });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const url = "http://d.test/api/devices/hosts/local/hub/vendor/serve-emu/api/fold?device=emulator-5554";
    const target = { url, headers: { Authorization: "Bearer t" } };
    assert.deepEqual(await requestAndroidFold(target), { supported: true, posture: "closed", hingeAngle: 0 });
    assert.deepEqual(await requestAndroidFold(target, "closed"), { supported: true, posture: "closed", hingeAngle: 0 });
    // The bearer rides as a header on both: never as `?token=` in the URL.
    assert.deepEqual(seen, [
      { url, method: "GET", body: null, type: null, auth: "Bearer t" },
      { url, method: "POST", body: JSON.stringify({ posture: "closed" }), type: "application/json", auth: "Bearer t" }
    ]);
    answer = { status: 404, body: { code: "DEVICE_NOT_LEASED", message: "That device is not leased on this host." } };
    await assert.rejects(requestAndroidFold(target, "opened"), /not leased/);
    answer = { status: 200, body: { ok: true, fold: { supported: true, posture: "opened", hingeAngle: 180 } } };
    assert.deepEqual(await requestAndroidFold(target), { supported: true, posture: "opened", hingeAngle: 180 });
    answer = { status: 200, body: { ok: true, fold: { supported: false, posture: null, hingeAngle: null } } };
    assert.deepEqual(await requestAndroidFold(target), { supported: false, posture: null, hingeAngle: null });
    for (const body of [
      { ok: false }, { ok: true }, "x",
      { ok: true, fold: { supported: true, posture: "sideways", hingeAngle: null } },
      { ok: true, fold: { supported: true, posture: "closed", hingeAngle: "bad" } }
    ]) {
      answer = { status: 200, body };
      await assert.rejects(requestAndroidFold(target), /unexpected shape/);
    }
  } finally {
    globalThis.fetch = saved;
  }
});
