import test from "node:test";
import assert from "node:assert/strict";

import { VOXL_MAX_FAILURES, VOXL_STABLE_MS, chooseDesktopBackend, voxlFailuresAfterClose, type VoxlViewerSupport } from "./backend-choice.logic.ts";

const capable: VoxlViewerSupport = { secureContext: true, webCodecs: true, h264: true };
const voxlDesktop = { video: "voxl" as const, voxl: { state: "ready" as const } };

test("a ready voxl desktop on a capable viewer streams with voxl; while voxl starts it waits for it", () => {
  assert.deepEqual(chooseDesktopBackend({ desktop: voxlDesktop, support: capable, voxlFailures: 0 }), { backend: "voxl" });
  assert.deepEqual(
    chooseDesktopBackend({ desktop: { video: "voxl", voxl: { state: "starting" } }, support: capable, voxlFailures: 0 }),
    { backend: "voxl" }
  );
});

test("RFB desktops and older daemons use RFB without a notice", () => {
  assert.deepEqual(chooseDesktopBackend({ desktop: { video: "rfb" }, support: capable, voxlFailures: 0 }), { backend: "rfb", reason: null });
  assert.deepEqual(chooseDesktopBackend({ desktop: {}, support: capable, voxlFailures: 0 }), { backend: "rfb", reason: null });
});

test("a voxl desktop falls back to RFB with a reason when voxl or the viewer cannot stream", () => {
  const cases: [Parameters<typeof chooseDesktopBackend>[0], RegExp][] = [
    [{ desktop: { video: "voxl", voxl: { state: "unavailable", reason: "voxl exited" } }, support: capable, voxlFailures: 0 }, /voxl exited/],
    [{ desktop: { video: "voxl" }, support: capable, voxlFailures: 0 }, /unavailable/],
    [{ desktop: voxlDesktop, support: { ...capable, secureContext: false }, voxlFailures: 0 }, /secure/],
    [{ desktop: voxlDesktop, support: { ...capable, webCodecs: false, h264: false }, voxlFailures: 0 }, /WebCodecs/],
    [{ desktop: voxlDesktop, support: { ...capable, h264: false }, voxlFailures: 0 }, /H\.264/]
  ];
  for (const [input, reason] of cases) {
    const choice = chooseDesktopBackend(input);
    assert.equal(choice.backend, "rfb");
    assert.match(choice.backend === "rfb" ? choice.reason ?? "" : "", reason);
  }
});

test("three consecutive voxl connection failures fall back to RFB", () => {
  assert.equal(chooseDesktopBackend({ desktop: voxlDesktop, support: capable, voxlFailures: VOXL_MAX_FAILURES - 1 }).backend, "voxl");
  const choice = chooseDesktopBackend({ desktop: voxlDesktop, support: capable, voxlFailures: VOXL_MAX_FAILURES });
  assert.equal(choice.backend, "rfb");
  assert.match(choice.backend === "rfb" ? choice.reason ?? "" : "", /3 times/);
});

test("a voxl connection dropped right after its hello counts as a failure; one that streamed a while resets the count", () => {
  let failures = 0;
  for (let i = 0; i < VOXL_MAX_FAILURES; i++) failures = voxlFailuresAfterClose(failures, { helloAt: 1_000, closedAt: 1_000 + VOXL_STABLE_MS - 1 });
  assert.equal(chooseDesktopBackend({ desktop: voxlDesktop, support: capable, voxlFailures: failures }).backend, "rfb");
  assert.equal(voxlFailuresAfterClose(2, { helloAt: null, closedAt: 5_000 }), 3, "never had hello");
  assert.equal(voxlFailuresAfterClose(2, { helloAt: 1_000, closedAt: 1_000 + VOXL_STABLE_MS }), 0);
});
