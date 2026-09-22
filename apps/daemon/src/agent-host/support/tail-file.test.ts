/**
 * `FileTail` against a real temp dir: the incremental read, the UTF-8 boundary,
 * the per-shell cap and the unreadable file. Nothing here waits on a sleep —
 * every read is driven explicitly.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { after, before, describe, it } from "node:test";

import { FileTail, resolveTildePath } from "./tail-file.ts";

describe("FileTail", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(nodePath.join(tmpdir(), "orq-tail-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads only the bytes appended since the previous read", async () => {
    const path = nodePath.join(dir, "append.log");
    await writeFile(path, "first\n", "utf8");
    const tail = new FileTail({ path });

    const one = await tail.read();
    assert.equal(one.text, "first\n");
    assert.equal(one.done, false);

    // Nothing new: an empty read is not an end.
    const two = await tail.read();
    assert.equal(two.text, "");
    assert.equal(two.done, false);

    await appendFile(path, "second\n", "utf8");
    const three = await tail.read();
    assert.equal(three.text, "second\n", "only the appended bytes, never the whole file again");
  });

  it("a multibyte character split across two reads decodes once, whole", async () => {
    const path = nodePath.join(dir, "utf8.log");
    // "é" is two bytes; a 3-byte read window puts its first byte at the end of
    // read one and its second at the start of read two.
    await writeFile(path, "aaébb", "utf8");
    const tail = new FileTail({ path, maxReadBytes: 3 });

    const one = await tail.read();
    assert.equal(one.text, "aa", "the dangling lead byte is held back, never rendered as U+FFFD");
    const two = await tail.read();
    assert.equal(two.text, "ébb");
    assert.equal(`${one.text}${two.text}`, "aaébb");
  });

  it("stops at the per-shell cap with one truncation notice naming the file", async () => {
    const path = nodePath.join(dir, "big.log");
    await writeFile(path, "x".repeat(40), "utf8");
    const tail = new FileTail({ path, maxReadBytes: 10, maxTotalBytes: 20 });

    const one = await tail.read();
    assert.equal(one.text, "x".repeat(10));
    assert.equal(one.done, false);

    const two = await tail.read();
    assert.equal(two.done, true, "the cap ends the tail");
    assert.ok(two.text.startsWith("x".repeat(10)));
    assert.ok(two.text.includes(path), "the notice names the file so the user can read the rest");

    const three = await tail.read();
    assert.deepEqual(three, { text: "", done: true }, "and then nothing, ever again");
  });

  it("an unreadable file yields ONE notice carrying the code and the path, then nothing", async () => {
    const path = nodePath.join(dir, "does-not-exist.log");
    const tail = new FileTail({ path });

    const one = await tail.read();
    assert.equal(one.done, true);
    assert.ok(one.text.includes("ENOENT"), one.text);
    assert.ok(one.text.includes(path), one.text);
    assert.ok(one.text.startsWith("[orquester]"), one.text);

    assert.deepEqual(await tail.read(), { text: "", done: true });
  });

  it("restarts from the beginning when the file is truncated under it", async () => {
    const path = nodePath.join(dir, "rotated.log");
    await writeFile(path, "0123456789", "utf8");
    const tail = new FileTail({ path });
    assert.equal((await tail.read()).text, "0123456789");

    await writeFile(path, "new", "utf8");
    assert.equal((await tail.read()).text, "new", "a shorter file is a new file, not a negative read");
  });
});

describe("resolveTildePath", () => {
  it("resolves a leading ~/ against the CLI's own HOME and leaves everything else alone", () => {
    assert.equal(resolveTildePath("~/tmp/a.output", "/homes/acc-1"), "/homes/acc-1/tmp/a.output");
    assert.equal(resolveTildePath("~", "/homes/acc-1"), "/homes/acc-1");
    assert.equal(resolveTildePath("/var/tmp/a.output", "/homes/acc-1"), "/var/tmp/a.output");
    // Another user's home is NOT ours to guess.
    assert.equal(resolveTildePath("~root/x", "/homes/acc-1"), "~root/x");
    assert.equal(resolveTildePath("~/tmp/a", ""), "~/tmp/a", "no home, no rewrite");
  });
});
