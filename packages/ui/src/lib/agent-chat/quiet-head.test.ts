import assert from "node:assert/strict";
import test from "node:test";

import { quietHead } from "./hooks";
import { head } from "./test-helpers";

test("a head that moved only its event stamps is the head the chrome already has", () => {
  const previous = head({ id: "t" });
  const stamped = { ...previous, seq: previous.seq + 1, updatedAt: "2026-10-23T12:00:00.000Z" };
  assert.equal(quietHead(previous, stamped), previous);
  const renamed = { ...stamped, title: "Renamed" };
  assert.equal(quietHead(previous, renamed), renamed);
  const switched = { ...stamped, session: { ...previous.session, status: "running" as const } };
  assert.equal(quietHead(previous, switched), switched);
  assert.equal(quietHead(previous, null), null);
  assert.equal(quietHead(null, stamped), stamped);
});
