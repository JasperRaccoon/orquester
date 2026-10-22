import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  collectWrappedTerminalLine,
  extractTerminalLinks,
  isTerminalLinkActivation,
  isTerminalUrl,
  resolveTerminalPathLink,
  splitFilePathPosition,
  terminalLinksForRow,
  type TerminalBufferLineLike
} from "./terminal-links";

/** A buffer row of `cols` cells. Characters in `wide` take two cells. */
function row(text: string, opts: { wrapped?: boolean; cols?: number; wide?: string } = {}): TerminalBufferLineLike {
  const cells: Array<{ chars: string; width: number }> = [];
  for (const char of text) {
    const wide = opts.wide?.includes(char) ?? false;
    cells.push({ chars: char, width: wide ? 2 : 1 });
    if (wide) cells.push({ chars: "", width: 0 });
  }
  const cols = opts.cols ?? Math.max(cells.length, 40);
  while (cells.length < cols) cells.push({ chars: "", width: 1 });
  return {
    isWrapped: opts.wrapped ?? false,
    length: cells.length,
    getCell: (x) => {
      const cell = cells[x];
      return cell ? { getChars: () => cell.chars, getWidth: () => cell.width } : undefined;
    }
  };
}

// Adapted from T3 Code (MIT): apps/web/src/terminal-links.test.ts
describe("extractTerminalLinks", () => {
  for (const text of [
    String.raw`src\index.ts:12`,
    String.raw`.\src\index.ts:12:7`,
    String.raw`..\src\index.ts:12`,
    String.raw`C:\Users\Jane\project\index.ts:12`,
    String.raw`\\server\share\index.ts:12`
  ]) {
    test(`finds Windows path ${text}`, () => {
      assert.deepEqual(extractTerminalLinks(`error at ${text}: failed`), [
        { kind: "path", text, start: 9, end: 9 + text.length }
      ]);
    });
  }

  for (const quote of ['"', "'", "`"]) {
    test(`finds paths containing spaces enclosed in ${quote}`, () => {
      const text = String.raw`C:\Users\Jane Doe\project\index.ts:12:7`;
      assert.deepEqual(extractTerminalLinks(`see ${quote}${text}${quote}.`), [
        { kind: "path", text, start: 5, end: 5 + text.length }
      ]);
    });
  }

  for (const path of ["./my folder/index.ts", "/home/Jane Doe/index.ts", "/home/Jane Doe/file)"]) {
    test(`keeps positions outside quotes on ${path}`, () => {
      assert.deepEqual(extractTerminalLinks(`"${path}":12:7: error`), [
        { kind: "path", text: `${path}:12:7`, start: 1, end: path.length + 7 }
      ]);
    });
  }

  test("does not treat quoted prose as a path", () => {
    assert.deepEqual(extractTerminalLinks('error: "something went wrong"'), []);
    assert.deepEqual(extractTerminalLinks('error: "something went wrong."'), []);
  });

  test("keeps quoted paths and URLs separate without duplicate partial paths", () => {
    const path = String.raw`C:\Jane Doe\index.ts:12`;
    const url = "https://example.com/docs";
    const line = `"${path}" ${url} src/index.ts`;
    assert.deepEqual(extractTerminalLinks(line), [
      { kind: "path", text: path, start: 1, end: 1 + path.length },
      { kind: "url", text: url, start: path.length + 3, end: path.length + 3 + url.length },
      { kind: "path", text: "src/index.ts", start: line.length - 12, end: line.length }
    ]);
  });

  test("classifies uppercase schemes as URLs", () => {
    assert.equal(isTerminalUrl("HTTPS://example.com/docs"), true);
    assert.equal(isTerminalUrl("Http://example.com"), true);
    assert.equal(isTerminalUrl("src/components/main.ts"), false);
    assert.equal(isTerminalUrl("httpsdocs/readme.md"), false);
  });

  test("trims trailing punctuation from links", () => {
    assert.deepEqual(extractTerminalLinks("(https://example.com/docs), ./src/main.ts:12."), [
      { kind: "url", text: "https://example.com/docs", start: 1, end: 25 },
      { kind: "path", text: "./src/main.ts:12", start: 28, end: 44 }
    ]);
  });

  for (const text of ["src/żółć.ts:12:7", "żółć/main.ts:12", "src/cafe\u0301.ts:12", "src/𐐀.ts:12"]) {
    test(`keeps the complete Unicode relative path ${text}`, () => {
      assert.deepEqual(extractTerminalLinks(`see ${text} for details`), [
        { kind: "path", text, start: 4, end: 4 + text.length }
      ]);
    });
  }

  test("keeps a trailing colon on URLs", () => {
    assert.deepEqual(extractTerminalLinks("GET https://example.test/items/foo:"), [
      { kind: "url", text: "https://example.test/items/foo:", start: 4, end: 35 }
    ]);
  });

  for (const [line, text] of [
    ["./main.go:10:5: undefined: x", "./main.go:10:5"],
    ["/home/dev/app/src/main.c:10:5: error: expected ';'", "/home/dev/app/src/main.c:10:5"],
    ["wrote ./out/report.txt:", "./out/report.txt"]
  ] as const) {
    test(`drops the colon that ends a compiler diagnostic location in ${line}`, () => {
      const start = line.indexOf(text);
      assert.deepEqual(extractTerminalLinks(line), [{ kind: "path", text, start, end: start + text.length }]);
    });
  }

  for (const line of [
    " GET /api/trpc/post.list,user.me?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%7D%7D 200 in 35ms",
    "GET /api?+debug 200",
    'Started GET "/posts?page=2" for ::1',
    "proxying api/trpc/post.list?batch=1 to the backend"
  ]) {
    test(`does not turn a logged request route into a file link: ${line}`, () => {
      assert.deepEqual(extractTerminalLinks(line), []);
    });
  }

  test("keeps a question mark inside a filesystem path", () => {
    const path = "/tmp/report?draft";
    assert.deepEqual(extractTerminalLinks(`wrote ${path}`), [{ kind: "path", text: path, start: 6, end: 6 + path.length }]);
  });
});

describe("buffer rows", () => {
  test("reconstructs a wrapped line from any of its rows", () => {
    const lines = [row("prompt> "), row("see https://example.com/a", { cols: 25 }), row("/bc?x=1", { wrapped: true }), row("done")];
    const fromFirst = collectWrappedTerminalLine(2, (i) => lines[i]);
    const fromWrapped = collectWrappedTerminalLine(3, (i) => lines[i]);
    assert.equal(fromFirst?.text, "see https://example.com/a/bc?x=1");
    assert.deepEqual(fromWrapped, fromFirst);
  });

  test("a link wrapping across rows spans both, and is offered on each", () => {
    const lines = [row("see https://example.com/a", { cols: 25 }), row("/bc?x=1", { wrapped: true })];
    const expected = [
      {
        kind: "url",
        text: "https://example.com/a/bc?x=1",
        range: { start: { x: 5, y: 1 }, end: { x: 7, y: 2 } }
      }
    ];
    assert.deepEqual(terminalLinksForRow(1, (i) => lines[i]), expected);
    assert.deepEqual(terminalLinksForRow(2, (i) => lines[i]), expected);
  });

  test("maps columns past wide characters to cells, not UTF-16 offsets", () => {
    const lines = [row("漢字 src/main.ts:3", { wide: "漢字" })];
    // 漢 and 字 take two cells each, so the path starts at cell 6 (1-based).
    assert.deepEqual(terminalLinksForRow(1, (i) => lines[i]), [
      { kind: "path", text: "src/main.ts:3", range: { start: { x: 6, y: 1 }, end: { x: 18, y: 1 } } }
    ]);
  });

  test("a row with no links has none, and a missing row is empty", () => {
    assert.deepEqual(terminalLinksForRow(1, () => row("just words here")), []);
    assert.deepEqual(terminalLinksForRow(5, () => undefined), []);
  });
});

describe("resolveTerminalPathLink", () => {
  test("splits a :line:col suffix", () => {
    assert.deepEqual(splitFilePathPosition("src/a.ts:12:7"), { path: "src/a.ts", line: 12, column: 7 });
    assert.deepEqual(splitFilePathPosition("src/a.ts:12"), { path: "src/a.ts", line: 12 });
    assert.deepEqual(splitFilePathPosition("src/a.ts"), { path: "src/a.ts" });
  });

  test("resolves a relative path against the session's cwd", () => {
    assert.deepEqual(resolveTerminalPathLink("./src/main.ts:10:5", "/w/proj/app", "/w/proj"), {
      path: "/w/proj/app/src/main.ts",
      line: 10,
      column: 5
    });
    assert.deepEqual(resolveTerminalPathLink("../lib/x.ts", "/w/proj/app", "/w/proj"), { path: "/w/proj/lib/x.ts" });
  });

  test("falls back to the project root without a cwd", () => {
    assert.deepEqual(resolveTerminalPathLink("README.md:1", "", "/w/proj"), { path: "/w/proj/README.md", line: 1 });
  });

  test("keeps an absolute path inside the project", () => {
    assert.deepEqual(resolveTerminalPathLink("/w/proj/a/b.c:3", "/w/proj", "/w/proj"), { path: "/w/proj/a/b.c", line: 3 });
  });

  test("refuses anything outside the project", () => {
    assert.equal(resolveTerminalPathLink("/etc/passwd", "/w/proj", "/w/proj"), null);
    assert.equal(resolveTerminalPathLink("../../etc/passwd", "/w/proj", "/w/proj"), null);
    assert.equal(resolveTerminalPathLink("../proj-other/x", "/w/proj", "/w/proj"), null);
    assert.equal(resolveTerminalPathLink("/w/projX/x", "/w/proj", "/w/proj"), null);
    assert.equal(resolveTerminalPathLink("~/x", "/w/proj", "/w/proj"), null);
    assert.equal(resolveTerminalPathLink("a.ts", "/w/proj", ""), null);
  });

  test("handles Windows project paths, case-insensitively", () => {
    assert.deepEqual(resolveTerminalPathLink(String.raw`src\my folder\index.ts:12:7`, String.raw`C:\Users\Jane\proj`, String.raw`C:\Users\Jane\proj`), {
      path: String.raw`C:\Users\Jane\proj\src\my folder\index.ts`,
      line: 12,
      column: 7
    });
    assert.deepEqual(resolveTerminalPathLink("c:/users/jane/proj/a.ts", String.raw`C:\Users\Jane\proj`, String.raw`C:\Users\Jane\proj`), {
      path: String.raw`c:\users\jane\proj\a.ts`
    });
    assert.equal(resolveTerminalPathLink(String.raw`D:\x.ts`, String.raw`C:\proj`, String.raw`C:\proj`), null);
  });
});

describe("isTerminalLinkActivation", () => {
  test("Cmd on Apple platforms, Ctrl elsewhere", () => {
    assert.equal(isTerminalLinkActivation({ metaKey: true, ctrlKey: false }, true), true);
    assert.equal(isTerminalLinkActivation({ metaKey: false, ctrlKey: true }, true), false);
    assert.equal(isTerminalLinkActivation({ metaKey: false, ctrlKey: true }, false), true);
    assert.equal(isTerminalLinkActivation({ metaKey: true, ctrlKey: false }, false), false);
    assert.equal(isTerminalLinkActivation({ metaKey: false, ctrlKey: false }, false), false);
  });
});
