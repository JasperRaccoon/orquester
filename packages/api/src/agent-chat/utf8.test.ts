/**
 * The one UTF-8 lead-byte rule the byte windows of `GET …/items/:itemId/output` are cut with — by the agent host
 * (`utf8Window`) and by the MCP's `read_tool_output` (`windowEnd`) alike.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { utf8SequenceLength } from "./index.ts";

test("utf8SequenceLength reads a character's length off its lead byte, and 1 for a byte no character starts with", () => {
  const encoded = (text: string): number[] => [...new TextEncoder().encode(text)];
  for (const [char, length] of [["a", 1], ["é", 2], ["語", 3], ["😀", 4]] as const) {
    assert.equal(utf8SequenceLength(encoded(char)[0]!), length, char);
  }
  // ASCII and the continuation bytes (10xxxxxx) count one: a reader never jumps past the bytes it has.
  for (const byte of [0x00, 0x0a, 0x7f, 0x80, 0xbf]) assert.equal(utf8SequenceLength(byte), 1, byte.toString(16));
  assert.deepEqual([0xc0, 0xdf, 0xe0, 0xef, 0xf0, 0xff].map(utf8SequenceLength), [2, 2, 3, 3, 4, 4]);
});
