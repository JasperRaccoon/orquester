import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { waitConfigForKind, type WaitConfig } from "./flow-settings.ts";

describe("waitConfigForKind", () => {
  it("drops the other kind's fields and keeps unknown ones", () => {
    const duration = { kind: "duration", minutes: 30, note: "kept" } as WaitConfig;
    assert.deepEqual(waitConfigForKind(duration, "until"), { kind: "until", time: "09:00", note: "kept" });
    const until = { kind: "until", time: "18:30", timezone: "Europe/Madrid", note: "kept" } as WaitConfig;
    assert.deepEqual(waitConfigForKind(until, "duration"), { kind: "duration", minutes: 5, note: "kept" });
    assert.deepEqual(waitConfigForKind(until, "until"), until, "the same kind is left as is");
  });
});
