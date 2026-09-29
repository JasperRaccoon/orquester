import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { blockAgent, filterPalette } from "./catalog-ui.ts";
import { node } from "./testing.ts";

describe("the palette", () => {
  it("from an output it offers no triggers and no notes", () => {
    const types = filterPalette("", { allowTriggers: false, allowNotes: false }).flatMap((g) => g.types);
    assert.ok(types.includes("code"));
    assert.ok(!types.some((type) => type.startsWith("trigger.")));
    assert.ok(!types.includes("note"));
  });
});

describe("blockAgent", () => {
  it("is the agent an agent block runs first", () => {
    const chain = [
      { agent: "grok", model: "grok-4", accounts: { strategy: "least-used" } },
      { agent: "claude", model: "opus", accounts: { strategy: "least-used" } }
    ];
    assert.equal(blockAgent(node("a", "agent", { chain })), "grok");
  });

  it("is undefined for an agent block with nothing chosen", () => {
    assert.equal(blockAgent(node("a", "agent", { chain: [] })), undefined);
  });

  it("is undefined for any other block", () => {
    assert.equal(blockAgent(node("c", "code")), undefined);
    assert.equal(blockAgent(node("t", "trigger.manual")), undefined);
  });
});
