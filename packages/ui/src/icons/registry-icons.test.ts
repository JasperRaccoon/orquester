import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { getRegistryIcon } from "./registry-icons.tsx";

describe("getRegistryIcon", () => {

  it("an id naming an Object.prototype member falls back to the generic icon instead of crashing", () => {
    for (const refId of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      const output = renderToStaticMarkup(getRegistryIcon("agent", refId));
      assert.notEqual(output, "", refId);
    }
  });
});
