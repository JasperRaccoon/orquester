/**
 * The wait registry (unified MCP design 2026-10-15 §8.6): a wait that would close a cycle is
 * refused at once, whatever project the chats are in; waits are counted and released.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ToolError } from "../mcp/errors.ts";
import { asWaiter as reExported } from "../session-tools/threads/shared.ts";
import { asWaiter, registerWait, waitsOn } from "./waits.ts";

const isCycle = (error: unknown) => error instanceof ToolError && error.code === "WAIT_CYCLE";

describe("wait registry", () => {
  it("refuses a direct and an indirect cycle at once, and forgets a wait once it ends", async () => {
    let releaseAB!: () => void;
    const ab = asWaiter("a", "b", () => new Promise<void>((resolve) => (releaseAB = resolve)));
    assert.equal(waitsOn("a", "b"), true);
    await assert.rejects(asWaiter("b", "a", async () => "never"), isCycle);
    const release = registerWait("b", "c");
    assert.throws(() => registerWait("c", "a"), isCycle, "c → a would close a → b → c → a");
    release();
    release();
    assert.equal(waitsOn("b", "c"), false, "a release is idempotent");
    releaseAB();
    await ab;
    assert.equal(waitsOn("a", "b"), false);
    assert.equal(await asWaiter("b", "a", async () => "now fine"), "now fine");
  });

  it("counts two waits on one target: the first ending keeps the second registered", () => {
    const one = registerWait("x", "y");
    const two = registerWait("x", "y");
    one();
    assert.equal(waitsOn("x", "y"), true);
    assert.throws(() => registerWait("y", "x"), isCycle);
    two();
    assert.equal(waitsOn("x", "y"), false);
  });

  it("is the registry the session-tool toolkit uses (re-exported, one per daemon)", () => {
    assert.equal(reExported, asWaiter);
  });
});
