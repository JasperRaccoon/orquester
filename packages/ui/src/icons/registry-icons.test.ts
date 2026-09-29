import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";

import { getRegistryIcon } from "./registry-icons.tsx";

describe("getRegistryIcon", () => {
  it("draws a known agent's own icon", () => {
    const icon = getRegistryIcon("agent", "claude");
    assert.ok(React.isValidElement(icon));
  });

  it("an id naming an Object.prototype member falls back to the generic icon instead of crashing", () => {
    const generic = getRegistryIcon("agent");
    assert.ok(React.isValidElement(generic));
    for (const refId of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      const icon = getRegistryIcon("agent", refId);
      assert.ok(React.isValidElement(icon), refId);
      assert.equal((icon as React.ReactElement).type, (generic as React.ReactElement).type, refId);
    }
  });

  it("an unknown kind draws nothing", () => {
    assert.equal(getRegistryIcon("constructor" as never), null);
    assert.equal(getRegistryIcon("__proto__" as never, "__proto__"), null);
  });
});
