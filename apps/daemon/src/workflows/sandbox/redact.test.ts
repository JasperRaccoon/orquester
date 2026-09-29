import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createRedactor } from "./redact.ts";

describe("createRedactor", () => {
  const redactor = createRedactor({ API_TOKEN: "tok-12345", SHORT: "abc", LONG: "tok-12345-extended", PIN: "9876" });

  test("text: every value ≥ 4 chars, longest first", () => {
    assert.equal(
      redactor.text("a tok-12345 b tok-12345-extended c abc 9876"),
      "a «secret:API_TOKEN» b «secret:LONG» c abc «secret:PIN»",
      "a value containing another is replaced whole; a 3-char value is left alone"
    );
  });

  test("value: deep through arrays and objects, values only", () => {
    const input = {
      "tok-12345": "key stays",
      nested: [{ v: "x tok-12345 y" }, 42, null, true, "9876"],
      deeper: { list: ["tok-12345-extended"] }
    };
    const out = redactor.value(input);
    assert.deepEqual(
      out,
      {
        "tok-12345": "key stays",
        nested: [{ v: "x «secret:API_TOKEN» y" }, 42, null, true, "«secret:PIN»"],
        deeper: { list: ["«secret:LONG»"] }
      },
      "strings are redacted wherever they sit; keys and non-strings are untouched"
    );
    assert.deepEqual(input.nested[0], { v: "x tok-12345 y" }, "the original keeps its value");
  });

  test("special regex characters in a value are literal", () => {
    const special = createRedactor({ P: "a.b*c(d)" });
    assert.equal(special.text("a.b*c(d) axbbc(d)"), "«secret:P» axbbc(d)", "the value is matched literally");
  });
});
