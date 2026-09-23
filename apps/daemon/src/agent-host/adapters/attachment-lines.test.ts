import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  appendAttachmentPathLines,
  isAttachmentPathBlock,
  stripAttachmentPathLines
} from "./attachment-lines.ts";

describe("attachment path lines (§4.1, §4.5)", () => {
  it("appends an `Attached files:` block as a suffix, one `- name: path` line per attachment", () => {
    assert.equal(
      appendAttachmentPathLines("look at these", [
        { name: "q3.xlsx", path: "/a/t1-1-xlsx.xlsx" },
        { name: "notes.txt", path: "/a/t1-2-txt.txt" }
      ]),
      "look at these\n\nAttached files:\n- q3.xlsx: /a/t1-1-xlsx.xlsx\n- notes.txt: /a/t1-2-txt.txt"
    );
  });

  it("is the block alone when the text is empty, so an attachment-only turn still says something", () => {
    assert.equal(
      appendAttachmentPathLines("", [{ name: "q3.xlsx", path: "/a/x.xlsx" }]),
      "Attached files:\n- q3.xlsx: /a/x.xlsx"
    );
  });

  it("skips a path the text already names — the composer put it there (§7.4) — and returns the text by identity when nothing is left", () => {
    const text = "see /a/x.xlsx please";
    assert.equal(appendAttachmentPathLines(text, [{ name: "x.xlsx", path: "/a/x.xlsx" }]), text);
    assert.equal(
      appendAttachmentPathLines(text, [
        { name: "x.xlsx", path: "/a/x.xlsx" },
        { name: "y.csv", path: "/a/y.csv" }
      ]),
      "see /a/x.xlsx please\n\nAttached files:\n- y.csv: /a/y.csv"
    );
    assert.equal(appendAttachmentPathLines(text, []), text);
  });

  it("never prefixes or wraps: a leading slash command stays first (§4.6.9)", () => {
    const out = appendAttachmentPathLines("/review", [{ name: "a.pdf", path: "/a/a.pdf" }]);
    assert.ok(out.startsWith("/review\n\n"));
  });

  it("collapses a run of control characters in a name to one space, so a name cannot forge a line of the turn", () => {
    assert.equal(
      appendAttachmentPathLines("", [{ name: "bad\nname.txt", path: "/a/b.txt" }]),
      "Attached files:\n- bad name.txt: /a/b.txt"
    );
    assert.equal(
      appendAttachmentPathLines("", [{ name: "a\r\n\u007fb.txt", path: "/a/c.txt" }]),
      "Attached files:\n- a b.txt: /a/c.txt"
    );
  });

  it("reads `namedIn` for a path already named, and still appends to `text` (§4.6.8)", () => {
    // A skill dispatch: the block rides the leading prose, the path the user
    // typed sits in the command block.
    const lines = [{ name: "x.xlsx", path: "/a/x.xlsx" }];
    assert.equal(appendAttachmentPathLines("please", lines, "please $review /a/x.xlsx"), "please");
    assert.equal(
      appendAttachmentPathLines("please", lines, "please $review"),
      "please\n\nAttached files:\n- x.xlsx: /a/x.xlsx"
    );
  });
});

describe("stripping the block from a replayed native history", () => {
  it("removes one trailing block in the helper's own shape and nothing else", () => {
    const text = "look at these";
    const sent = appendAttachmentPathLines(text, [
      { name: "q3.xlsx", path: "/a/q3.xlsx" },
      { name: "b c.txt", path: "/a/b c.txt" }
    ]);
    assert.equal(stripAttachmentPathLines(sent), text);
  });

  it("keeps a block that is the whole message: a replay has no attachment chips to show instead", () => {
    const alone = "Attached files:\n- q3.xlsx: /a/q3.xlsx";
    assert.equal(stripAttachmentPathLines(alone), alone);
    // Nothing but whitespace before it is nothing of the user's either.
    const blank = " \n\nAttached files:\n- q3.xlsx: /a/q3.xlsx";
    assert.equal(stripAttachmentPathLines(blank), blank);
  });

  it("returns text without a trailing block by identity, including a mid-text mention", () => {
    const plain = "see /a/q3.xlsx please";
    assert.equal(stripAttachmentPathLines(plain), plain);
    const mid = "Attached files:\n- a: /x\n\nand then I wrote more";
    assert.equal(stripAttachmentPathLines(mid), mid);
    assert.equal(stripAttachmentPathLines(""), "");
  });

  it("answers in linear time when a block-shaped run fails at its last line", () => {
    // Each `- a: b: c` line splits into a name and a path two ways, and a
    // per-line `[^\n]*: [^\n]+` retries every combination of splits before a
    // run that fails at its end gives up: 2^14 of them here, on the event loop
    // every thread shares. The guard is RELATIVE, as in `glob.test.ts`: the
    // baseline is a run of the same length whose lines split one way only,
    // CPU contention on a loaded suite scales both measurements together, and
    // the exponential case overshoots a generous factor by orders of magnitude.
    const run = (line: string): string =>
      `hi\n\nAttached files:\n${Array.from({ length: 14 }, () => line).join("\n")}\nand then more`;
    const pathological = run("- a: b: c");
    const trivial = run("- abcd: e");
    const time = (text: string): number => {
      const start = performance.now();
      for (let i = 0; i < 2000; i++) {
        assert.equal(stripAttachmentPathLines(text), text);
      }
      return performance.now() - start;
    };
    // Warm the JIT, then take the best of three runs on each — the minimum is
    // the measurement least polluted by a scheduler preemption.
    const best = (text: string): number => {
      time(text);
      return Math.min(time(text), time(text), time(text));
    };
    const baseline = Math.max(best(trivial), 1);
    const elapsed = best(pathological);
    // Observed ratio is ~1x: both are linear in the length of the text.
    assert.ok(
      elapsed < baseline * 25,
      `expected <${(baseline * 25).toFixed(1)}ms (25x the ${baseline.toFixed(1)}ms linear baseline), took ${elapsed.toFixed(1)}ms`
    );
    // The same lines closing the text are still one block: a name may hold ": ".
    assert.equal(stripAttachmentPathLines(pathological.slice(0, -"\nand then more".length)), "hi");
  });
});

describe("recognising a block-only text (`isAttachmentPathBlock`)", () => {
  it("is true for exactly the block `appendAttachmentPathLines` writes onto empty prose", () => {
    assert.equal(isAttachmentPathBlock("Attached files:\n- q3.xlsx: /a/q3.xlsx"), true);
    assert.equal(
      isAttachmentPathBlock(
        appendAttachmentPathLines("", [
          { name: "q3.xlsx", path: "/a/q3.xlsx" },
          { name: "b c.txt", path: "/a/b c.txt" }
        ])
      ),
      true
    );
    // A name may hold ": " — the same lookahead line form as the strip.
    assert.equal(isAttachmentPathBlock("Attached files:\n- a: b: c"), true);
  });

  it("is false for anything around the block — leading blank lines, trailing prose — and for empty text", () => {
    assert.equal(isAttachmentPathBlock("\n\nAttached files:\n- q3.xlsx: /a/q3.xlsx"), false);
    assert.equal(isAttachmentPathBlock("Attached files:\n- q3.xlsx: /a/q3.xlsx\n\nand more"), false);
    assert.equal(isAttachmentPathBlock("hi\n\nAttached files:\n- q3.xlsx: /a/q3.xlsx"), false);
    assert.equal(isAttachmentPathBlock("Attached files:\n- q3.xlsx: /a/q3.xlsx\n"), false);
    assert.equal(isAttachmentPathBlock("Attached files:"), false);
    assert.equal(isAttachmentPathBlock(""), false);
  });
});
