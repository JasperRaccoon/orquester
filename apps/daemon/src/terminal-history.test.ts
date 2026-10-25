import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { TerminalOutputRing, sanitizeTerminalReplayChunk } from "./terminal-history.ts";

const ESC = "\u001b";

function sanitize(...chunks: string[]): { text: string; pending: string } {
  let pending = "";
  let text = "";
  for (const chunk of chunks) {
    const result = sanitizeTerminalReplayChunk(pending, chunk);
    text += result.visibleText;
    pending = result.pendingControlSequence;
  }
  return { text, pending };
}

describe("TerminalOutputRing", () => {
  test("keeps everything below the cap, in order", () => {
    const ring = new TerminalOutputRing(1024);
    for (let i = 0; i < 10; i += 1) ring.append(`line ${i}\r\n`);
    assert.equal(ring.value(), Array.from({ length: 10 }, (_, i) => `line ${i}\r\n`).join(""));
    assert.equal(ring.length, ring.value().length);
  });

  test("retains at most the cap and only ever drops from the front", () => {
    const ring = new TerminalOutputRing(4096);
    let all = "";
    for (let i = 0; i < 5000; i += 1) {
      const chunk = `row ${i} ${"x".repeat(i % 37)}\n`;
      all += chunk;
      ring.append(chunk);
      assert.ok(ring.length <= 4096);
    }
    const value = ring.value();
    assert.ok(all.endsWith(value), "the ring is a suffix of the output");
    // At most one scan window more than the cap went.
    assert.ok(value.length > 4096 - 1024);
    // The cut landed on a line start, not mid-line.
    assert.match(value, /^row \d+ /);
  });

  test("large single appends are trimmed to the cap", () => {
    const ring = new TerminalOutputRing(100);
    ring.append("a".repeat(10_000));
    assert.equal(ring.value(), "a".repeat(100));
    ring.append("b".repeat(30));
    assert.equal(ring.value(), "a".repeat(70) + "b".repeat(30));
  });

  test("never starts with a lone low surrogate", () => {
    const ring = new TerminalOutputRing(9);
    // Ten astral characters (20 code units), no line or sequence starts.
    ring.append("😀".repeat(10));
    const value = ring.value();
    assert.ok(value.length <= 9);
    const first = value.charCodeAt(0);
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff), "a pair was split");
    assert.equal(value, "😀".repeat(4));
  });

  test("trimming does not start the replay inside an escape sequence", () => {
    const ring = new TerminalOutputRing(64);
    const coloured = `${ESC}[38;5;196mred${ESC}[0m`;
    // Without a nearby boundary search the cut would land mid-sequence.
    ring.append("p".repeat(40) + coloured.repeat(4));
    const value = ring.value();
    assert.ok(value.startsWith(ESC), `starts with ${JSON.stringify(value.slice(0, 12))}`);
  });

  test("strips queries split across appends and keeps the rest", () => {
    const ring = new TerminalOutputRing();
    ring.append(`before${ESC}[`);
    ring.append(`6nafter`);
    assert.equal(ring.value(), "beforeafter");
  });

  test("an unterminated huge OSC is stored rather than held forever", () => {
    const ring = new TerminalOutputRing();
    const body = "A".repeat(20 * 1024);
    ring.append(`${ESC}]1337;File=:${body}`);
    assert.ok(ring.value().startsWith(`${ESC}]1337;File=:`));
    ring.append(`tail\u0007done`);
    assert.ok(ring.value().endsWith(`tail\u0007done`));
  });

  test("clear empties it", () => {
    const ring = new TerminalOutputRing();
    ring.append("abc");
    ring.clear();
    assert.equal(ring.value(), "");
    assert.equal(ring.length, 0);
    ring.append("d");
    assert.equal(ring.value(), "d");
  });
});

describe("sanitizeTerminalReplayChunk", () => {
  test("passes plain text through untouched", () => {
    assert.deepEqual(sanitizeTerminalReplayChunk("", "hello\r\n"), { visibleText: "hello\r\n", pendingControlSequence: "" });
  });

  for (const [name, sequence] of [
    ["primary DA query", `${ESC}[c`],
    ["primary DA query with 0", `${ESC}[0c`],
    ["primary DA reply", `${ESC}[?1;2c`],
    ["secondary DA query", `${ESC}[>c`],
    ["secondary DA reply", `${ESC}[>0;276;0c`],
    ["tertiary DA query", `${ESC}[=c`],
    ["tertiary DA reply", `${ESC}P!|00000000${ESC}\\`],
    ["DSR status query", `${ESC}[5n`],
    ["CPR query", `${ESC}[6n`],
    ["CPR reply", `${ESC}[12;40R`],
    ["DECRQM query", `${ESC}[?2026$p`],
    ["DECRPM reply", `${ESC}[?2026;2$y`],
    ["XTVERSION query", `${ESC}[>q`],
    ["kitty keyboard query", `${ESC}[?u`],
    ["DECRQSS query", `${ESC}P$qm${ESC}\\`],
    ["XTGETTCAP query", `${ESC}P+q544e${ESC}\\`],
    ["OSC 10 query (BEL)", `${ESC}]10;?\u0007`],
    ["OSC 11 query (ST)", `${ESC}]11;?${ESC}\\`],
    ["OSC 11 reply", `${ESC}]11;rgb:0a0a/0a0a/0a0a${ESC}\\`],
    ["OSC 12 query", `${ESC}]12;?\u0007`],
    ["OSC 4 palette query", `${ESC}]4;1;?\u0007`],
    ["OSC 4 multi query", `${ESC}]4;0;?;15;?\u0007`],
    ["OSC 52 clipboard read", `${ESC}]52;c;?\u0007`],
    ["8-bit CSI CPR query", `\u009b6n`],
    ["8-bit OSC query", `\u009d11;?\u009c`]
  ] as const) {
    test(`strips the ${name}`, () => {
      assert.equal(sanitize(`a${sequence}b`).text, "ab");
    });
  }

  for (const [name, sequence] of [
    ["SGR", `${ESC}[1;31m`],
    ["cursor move", `${ESC}[12;40H`],
    ["alt screen", `${ESC}[?1049h`],
    ["DECSTR", `${ESC}[!p`],
    ["DECSCUSR", `${ESC}[2 q`],
    ["restore cursor", `${ESC}[u`],
    ["title", `${ESC}]0;my title\u0007`],
    ["hyperlink", `${ESC}]8;;https://example.com${ESC}\\`],
    ["palette set", `${ESC}]4;1;rgb:ff/00/00\u0007`],
    ["charset", `${ESC}(B`],
    ["save cursor", `${ESC}7`]
  ] as const) {
    test(`keeps ${name}`, () => {
      assert.equal(sanitize(`a${sequence}b`).text, `a${sequence}b`);
    });
  }

  test("holds a sequence split across chunks until it completes", () => {
    const first = sanitizeTerminalReplayChunk("", `x${ESC}]11;`);
    assert.deepEqual(first, { visibleText: "x", pendingControlSequence: `${ESC}]11;` });
    const second = sanitizeTerminalReplayChunk(first.pendingControlSequence, `?\u0007y`);
    assert.deepEqual(second, { visibleText: "y", pendingControlSequence: "" });
  });

  test("a lone trailing ESC is pending, not dropped", () => {
    assert.deepEqual(sanitize("ab", ESC), { text: "ab", pending: ESC });
    assert.deepEqual(sanitize("ab", ESC, "[1mc"), { text: `ab${ESC}[1mc`, pending: "" });
  });
});
