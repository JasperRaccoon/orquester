import assert from "node:assert/strict";
import test from "node:test";

import { parseGduExport, type ParsedScan } from "./export-parser.ts";
import type { ScanNode } from "./tree.ts";

// gdu v5.39.0's export (`--output-attrs name,asize,dsize,ino`) of a small tree: a hard
// link pair, an unreadable dir, a fifo and a symlink without dsize, names that need
// every kind of escape (control char, quote, newline, a surrogate pair) and raw UTF-8.
// The root's dsize carries its own 4096-byte block on top of its children.
const EXPORT = `[1,2,{"progname":"gdu","progver":"v5.39.0","timestamp":1794589601},
[{"name":"/vol","asize":2100519,"dsize":2134016},
{"name":"\\u0001ctl","asize":2,"dsize":4096},
{"name":"fifo"},
{"name":"link","asize":4},
[{"name":"sp ace","asize":1,"dsize":8192},
{"name":"q\\"uo\\nte \\ud83d\\ude00 é\\/\\\\","asize":1,"dsize":4096}],
[{"name":"noread","asize":512,"dsize":4096,"read_error":true}
],
[{"name":"a","asize":100000,"dsize":110592},
{"name":"big","asize":100000,"dsize":102400,"ino":15759022,"hlnkc":true},
[{"name":"b","asize":0,"dsize":4096},
{"name":"hl","asize":100000,"dsize":102400,"ino":15759022,"hlnkc":true}]],
{"name":"huge","asize":2000000,"dsize":2002944}]]
`;

async function parse(text: string, minKeepBytes: number, chunkSize = text.length): Promise<ParsedScan> {
  const bytes = Buffer.from(text);
  async function* chunks() {
    for (let at = 0; at < bytes.length; at += chunkSize) yield bytes.subarray(at, at + chunkSize);
  }
  return parseGduExport(chunks(), { minKeepBytes });
}

function child(node: ScanNode, name: string): ScanNode {
  const found = node.children?.find((entry) => entry.name === name);
  assert.ok(found, `${name} kept under ${node.name}`);
  return found;
}

test("totals come from the children, hard links count once, and small entries fold into their directory's smaller", async () => {
  const scan = await parse(EXPORT, 100_000);
  assert.equal(scan.scannerVersion, "v5.39.0");
  assert.equal(scan.unreadableDirs, 1);
  const root = scan.root;
  assert.deepEqual([root.size, root.apparent, root.items], [2134016, 2100519, 12]);
  // Biggest first; the tiny unreadable dir is kept so the map can flag it.
  assert.deepEqual(
    root.children!.map((entry) => [entry.name, entry.size]),
    [
      ["huge", 2002944],
      ["a", 110592],
      ["noread", 4096]
    ]
  );
  assert.equal(child(root, "noread").unreadable, true);
  // ctl + fifo + link + "sp ace" (a dir of 2 items) — everything under 100 kB.
  assert.deepEqual(root.smaller, { size: 4096 + 8192, apparent: 2 + 4 + 1, items: 5 });
  const a = child(root, "a");
  assert.deepEqual([a.size, a.apparent, a.items], [110592, 100000, 4]);
  // The second link of the inode adds an entry but no bytes.
  assert.deepEqual(a.smaller, { size: 4096, apparent: 0, items: 2 });
  assert.deepEqual(child(a, "big"), { name: "big", size: 102400, apparent: 100000, items: 1, dir: false });
});

test("names decode every JSON escape and raw UTF-8, whatever the chunk boundaries", async () => {
  const whole = await parse(EXPORT, 1);
  const spaced = child(whole.root, "sp ace");
  assert.deepEqual(
    spaced.children!.map((entry) => entry.name),
    ['q"uo\nte \u{1F600} é/\\']
  );
  assert.ok(whole.root.children!.some((entry) => entry.name === "\u0001ctl"));
  for (const chunkSize of [1, 2, 3, 7]) {
    assert.deepEqual(await parse(EXPORT, 1, chunkSize), whole, `chunks of ${chunkSize} bytes`);
  }
});

test("a deeply nested export parses without recursion and keeps every ancestor of a kept entry", async () => {
  const depth = 20_000;
  const text =
    `[1,2,{"progname":"gdu","progver":"v5.39.0"},\n` +
    `[{"name":"/deep","asize":0,"dsize":4096},` +
    `[{"name":"d","asize":0,"dsize":4096},`.repeat(depth) +
    `{"name":"leaf","asize":5000000,"dsize":5000192}` +
    "]".repeat(depth) +
    "]]";
  const scan = await parse(text, 1024 * 1024);
  let node = scan.root;
  let levels = 0;
  while (node.children?.length) {
    node = node.children[0]!;
    levels++;
  }
  assert.equal(levels, depth + 1);
  assert.equal(node.name, "leaf");
  assert.equal(scan.root.size, 5000192);
  assert.equal(scan.root.items, depth + 2);
});

test("a truncated or malformed export is rejected", async () => {
  await assert.rejects(parse(EXPORT.slice(0, -8), 1), /truncated/);
  await assert.rejects(parse(EXPORT.replace('"asize":2,', '"asize" 2,'), 1), /Malformed/);
  await assert.rejects(parse(EXPORT.replace('[{"name":"a"', '[["name"'), 1), /Malformed|structure/);
  await assert.rejects(parse(`${EXPORT}]`, 1), /Malformed/);
});
