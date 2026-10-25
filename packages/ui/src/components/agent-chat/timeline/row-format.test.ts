/**
 * Which messages from other chats fold to one line, and the line a folded one shows.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { foldedMessageSummary } from "./row-format";

test("a folded message shows its first line with text, whitespace collapsed", () => {
  assert.equal(foldedMessageSummary("\n\n  Audit   the\tauth module.  \nSecond line."), "Audit the auth module.");
  assert.equal(foldedMessageSummary("\r\n   \r\nCRLF first\r\nnext"), "CRLF first");
  assert.equal(foldedMessageSummary("one line"), "one line");
});

test("a message with no text has no line", () => {
  assert.equal(foldedMessageSummary(""), "");
  assert.equal(foldedMessageSummary(" \n\t\n "), "");
});
