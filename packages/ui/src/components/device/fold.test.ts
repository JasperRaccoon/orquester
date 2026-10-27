import assert from "node:assert/strict";
import { it } from "node:test";

import { parseAndroidFold } from "./fold.ts";

it("reads the hub's fold answer and refuses anything else", () => {
  assert.deepEqual(parseAndroidFold({ ok: true, fold: { supported: true, posture: "opened", hingeAngle: 180 } }), { supported: true, posture: "opened", hingeAngle: 180 });
  assert.deepEqual(parseAndroidFold({ ok: true, fold: { supported: false, posture: null, hingeAngle: null } }), { supported: false, posture: null, hingeAngle: null });
  assert.equal(parseAndroidFold({ ok: false }), null);
  assert.equal(parseAndroidFold({ ok: true, fold: { supported: true, posture: "sideways", hingeAngle: null } }), null);
  assert.equal(parseAndroidFold({ ok: true, fold: { supported: true, posture: "closed", hingeAngle: Number.NaN } }), null);
  assert.equal(parseAndroidFold("x"), null);
});
