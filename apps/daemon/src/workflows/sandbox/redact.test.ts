import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createChunkRedactor, createRedactor, redactChunk } from "./redact.ts";

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
    assert.equal(input.nested[0] !== out.nested[0], true, "the input is not mutated (a copy is returned)");
    assert.deepEqual(input.nested[0], { v: "x tok-12345 y" }, "the original keeps its value");
  });

  test("no secrets: identity", () => {
    const none = createRedactor({ X: "ab" });
    const value = { a: "ab" };
    assert.equal(none.value(value), value, "nothing to redact returns the same value");
    assert.equal(none.text("ab"), "ab", "text unchanged");
    assert.equal(none.maxSecretLength, 0, "no redacted secret");
  });

  test("special regex characters in a value are literal", () => {
    const special = createRedactor({ P: "a.b*c(d)" });
    assert.equal(special.text("a.b*c(d) axbbc(d)"), "«secret:P» axbbc(d)", "the value is matched literally");
  });

  test("byteMatches agrees with text matching on UTF-8", () => {
    const utf = createRedactor({ U: "pässwörd✓" });
    const text = "héllo pässwörd✓ end";
    const bytes = Buffer.from(text, "utf8");
    const [match] = utf.byteMatches(bytes);
    assert.ok(match !== undefined, "the secret is found in bytes");
    assert.equal(bytes.subarray(match.start, match.end).toString("utf8"), "pässwörd✓", "byte positions cover the value");
    assert.equal(utf.maxSecretBytes, Buffer.byteLength("pässwörd✓"), "maxSecretBytes is the UTF-8 length");
  });
});

describe("streaming redaction", () => {
  const redactor = createRedactor({ TOKEN: "s3cr3t-value", OTHER: "s3cr3t-value-longer", SHORTER: "zzzz" });
  const text = "start s3cr3t-value mid s3cr3t-value-longer zzzz and zzz s3cr3t-valu end s3cr3t-value";
  const expected = redactor.text(text);

  test("every two-chunk split gives exactly text()'s answer", () => {
    for (let cut = 0; cut <= text.length; cut += 1) {
      const stream = createChunkRedactor(redactor);
      const out = stream.push(text.slice(0, cut)) + stream.push(text.slice(cut)) + stream.flush();
      assert.equal(out, expected, `split at ${cut}`);
    }
  });

  test("one character at a time never emits part of a secret", () => {
    const stream = redactor.stream();
    let out = "";
    for (const char of text) {
      const piece = stream.push(char);
      out += piece;
      assert.equal(out.includes("s3cr3t-value-"), false, "never a prefix of the longer secret");
    }
    out += stream.flush();
    assert.equal(out, expected, "the whole stream equals text()");
    assert.equal(out.includes("s3cr3t-value "), false, "no secret leaked");
  });

  test("redactChunk returns what to hold back", () => {
    const step = redactChunk(redactor, "", "abc s3cr3t");
    assert.equal(step.text + step.carry, "abc s3cr3t", "nothing is lost");
    assert.ok(step.carry.endsWith("s3cr3t"), "a possible secret prefix is held back");
    const next = redactChunk(redactor, step.carry, "-value!", true);
    assert.equal(step.text + next.text, "abc «secret:TOKEN»!", "the next chunk completes and redacts it");
  });
});
