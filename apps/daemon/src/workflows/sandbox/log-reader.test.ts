import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { followLog, readLogWindow } from "./log-reader.ts";
import { createRedactor } from "./redact.ts";

let root: string;
let counter = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "orq-log-reader-test-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function logFile(content: string | Buffer): Promise<string> {
  counter += 1;
  const path = join(root, `log-${counter}.log`);
  await writeFile(path, content);
  return path;
}

async function readAllWindows(path: string, size: number, redactor?: ReturnType<typeof createRedactor>): Promise<string[]> {
  const windows: string[] = [];
  let offset = 0;
  for (let guard = 0; guard < 10_000; guard += 1) {
    const window = await readLogWindow(path, offset, size, redactor);
    assert.ok(window.nextOffset > offset || window.eof, `the window at ${offset} advances`);
    windows.push(window.text);
    offset = window.nextOffset;
    if (window.eof) {
      return windows;
    }
  }
  throw new Error("too many windows");
}

describe("readLogWindow", () => {
  const text = "héllo wörld — ✓ 🎉 ascii tail\nsecond line ✓✓✓\n";

  test("windows of any size cut at character boundaries and join to the whole text", async () => {
    const path = await logFile(text);
    for (let size = 1; size <= 12; size += 1) {
      const windows = await readAllWindows(path, size);
      assert.equal(windows.join(""), text, `windows of ${size} bytes join to the text`);
      for (const window of windows) {
        assert.equal(window.includes("�"), false, `no window of ${size} bytes splits a character`);
      }
    }
  });

  test("a secret is never split across windows", async () => {
    const redactor = createRedactor({ KEY: "sk-live-ÄBC-123", SHORT: "pw12" });
    const content = `x sk-live-ÄBC-123 y pw12 z ${"sk-live-ÄBC-123"}${"pw12"} end sk-live-ÄBC-12`;
    const path = await logFile(content);
    const expected = "x «secret:KEY» y «secret:SHORT» z «secret:KEY»«secret:SHORT» end sk-live-ÄBC-12";
    for (let size = 1; size <= 40; size += 1) {
      const windows = await readAllWindows(path, size, redactor);
      assert.equal(windows.join(""), expected, `windows of ${size} bytes join to the redacted text`);
      for (const window of windows) {
        assert.equal(/sk-live-ÄBC-123|pw12/.test(window), false, `no window of ${size} bytes shows a secret`);
      }
    }
  });

  test("an offset inside a secret serves its placeholder, never its tail", async () => {
    const redactor = createRedactor({ KEY: "abcdefghij" });
    const path = await logFile("12345abcdefghij67890");
    const window = await readLogWindow(path, 9, 100, redactor);
    assert.equal(window.text, "«secret:KEY»67890", "the partial secret became its placeholder");
    assert.equal(window.eof, true, "and the window reached the end");
  });

  test("holdTail keeps back a partial character and a possible secret prefix", async () => {
    const redactor = createRedactor({ KEY: "topsecret" });
    const path = await logFile("line topsec");
    const first = await readLogWindow(path, 0, 1000, redactor, { holdTail: true });
    assert.equal(first.text.includes("topsec"), false, "the possible secret prefix is held");
    assert.equal(first.eof, false, "the held bytes are still to come");
    await appendFile(path, "ret done ");
    const second = await readLogWindow(path, first.nextOffset, 1000, redactor, { holdTail: false });
    assert.equal(first.text + second.text, "line «secret:KEY» done ", "completed, it is redacted");

    const partial = await logFile(Buffer.concat([Buffer.from("ab "), Buffer.from("✓", "utf8").subarray(0, 2)]));
    const held = await readLogWindow(partial, 0, 1000, undefined, { holdTail: true });
    assert.equal(held.text, "ab ", "an incomplete trailing character is held");
    assert.equal(held.nextOffset, 3, "the next read starts at the character");
  });

  test("a missing file reads as empty", async () => {
    const window = await readLogWindow(join(root, "nope.log"), 0, 100);
    assert.deepEqual(window, { text: "", nextOffset: 0, eof: true, size: 0 }, "empty, at its end");
  });
});

describe("followLog", () => {
  test("yields as the file grows and ends once it is not live and fully read", async () => {
    const redactor = createRedactor({ KEY: "hunter22" });
    const path = await logFile("");
    let live = true;
    const chunks: string[] = [];
    const follow = followLog(path, { isLive: () => live, redactor });
    const reading = (async () => {
      for await (const chunk of follow) {
        chunks.push(chunk);
        if (!live) continue;
        if (chunks.join("").includes("line")) {
          // The writer finishes once the reader has seen the first line (the tail of a live file —
          // a possible secret prefix — is held back until more arrives or the file stops growing).
          await appendFile(path, " hunt");
          await appendFile(path, "er22 last");
          live = false;
        }
      }
    })();
    await appendFile(path, "first hun");
    await appendFile(path, "ter22 line\nsecond");
    await reading;
    assert.equal(chunks.join(""), "first «secret:KEY» line\nsecond «secret:KEY» last", "everything, redacted, in order");
  });

  test("an abort ends a live follow", async () => {
    const path = await logFile("abc");
    const controller = new AbortController();
    const chunks: string[] = [];
    for await (const chunk of followLog(path, { isLive: () => true, signal: controller.signal })) {
      chunks.push(chunk);
      controller.abort();
    }
    assert.deepEqual(chunks, ["abc"], "the follow ended at the abort");
  });
});
