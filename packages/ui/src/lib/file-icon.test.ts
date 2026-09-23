import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { FILE_ICON_IDS, fileIconIdFor } from "./file-icon.ts";
import { FILE_ICONS, FileTypeIcon } from "../icons/files/index.tsx";

const ICON_DIR = join(dirname(fileURLToPath(import.meta.url)), "../icons/files");

describe("file-type icons", () => {
  it("resolves office, data and code files by extension, case-insensitively", () => {
    assert.equal(fileIconIdFor({ name: "Q3 Report.XLSX" }), "table");
    assert.equal(fileIconIdFor({ name: "data.csv" }), "table");
    assert.equal(fileIconIdFor({ name: "memo.docx" }), "word");
    assert.equal(fileIconIdFor({ name: "deck.pptx" }), "powerpoint");
    assert.equal(fileIconIdFor({ name: "paper.pdf" }), "pdf");
    assert.equal(fileIconIdFor({ name: "archive.tar.gz" }), "zip");
    assert.equal(fileIconIdFor({ name: "App.tsx" }), "react_ts");
    assert.equal(fileIconIdFor({ name: "notes.md" }), "markdown");
    assert.equal(fileIconIdFor({ name: "shot.PNG" }), "image");
  });

  it("falls back to the mime when the name has no usable extension", () => {
    assert.equal(fileIconIdFor({ name: "pasted", mimeType: "text/csv" }), "table");
    assert.equal(fileIconIdFor({ mimeType: "application/pdf" }), "pdf");
    assert.equal(fileIconIdFor({ mimeType: "image/png" }), "image");
    assert.equal(fileIconIdFor({ mimeType: "text/plain; charset=utf-8" }), "document");
    assert.equal(fileIconIdFor({ mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "table");
  });

  it("ranks the extension above the mime, and strips mime parameters before the exact match", () => {
    // Browsers report `.ts` as MPEG-TS and much text as `text/plain`, and an
    // Office file is a ZIP container a sniffer may call `application/zip`: the
    // user's own spelling of the file outranks both mime tiers.
    assert.equal(fileIconIdFor({ name: "index.ts", mimeType: "video/mp2t" }), "typescript");
    assert.equal(fileIconIdFor({ name: "notes.md", mimeType: "text/plain" }), "markdown");
    assert.equal(fileIconIdFor({ name: "report.xlsx", mimeType: "application/zip" }), "table");
    assert.equal(fileIconIdFor({ mimeType: "text/csv; charset=utf-8" }), "table");
  });

  it("is the generic file for the unknown: no extension, no mime, octet-stream", () => {
    assert.equal(fileIconIdFor({ name: "README" }), "file");
    assert.equal(fileIconIdFor({ name: "blob.xyz123", mimeType: "application/octet-stream" }), "file");
    assert.equal(fileIconIdFor({ name: "", mimeType: "" }), "file");
    assert.equal(fileIconIdFor({}), "file");
  });

  it("reads only its own table keys: a name or mime spelled like an Object.prototype member is unknown", () => {
    assert.equal(fileIconIdFor({ name: "notes.constructor" }), "file");
    assert.equal(fileIconIdFor({ name: "x.__proto__" }), "file");
    assert.equal(fileIconIdFor({ name: "README", mimeType: "constructor" }), "file");
  });

  it("backs every id with an icon component", () => {
    for (const id of FILE_ICON_IDS) {
      assert.equal(typeof FILE_ICONS[id], "function", id);
    }
  });

  it("renders the resolved icon as a sized, decorative glyph carrying the light-mode hook", () => {
    // A plain function component (no hooks), so calling it returns its element.
    const element = FileTypeIcon({ name: "a.xlsx", size: 14 });
    assert.equal(element.type, FILE_ICONS.table);
    assert.equal(element.props.width, 14);
    assert.equal(element.props.height, 14);
    assert.ok(element.props["aria-hidden"]);
    assert.ok("data-file-icon" in element.props);
  });

  // tsc types every `.svg?react` through the wildcard module in `icons/svg.d.ts`
  // and the test loader stubs it unread, so neither notices a missing or a wrong
  // file — only `vite build` would. So read the barrel: each id's entry must
  // import that id's own `<id>.svg`, and that file must exist.
  it("maps every id to its own <id>.svg, which exists on disk", () => {
    const barrel = readFileSync(join(ICON_DIR, "index.tsx"), "utf8");
    const fileOf = new Map(
      [...barrel.matchAll(/^import (\w+) from "\.\/([\w-]+\.svg)\?react";$/gm)].map((m): [string, string] => [m[1], m[2]])
    );
    const record = /export const FILE_ICONS\b[^=]*=\s*\{([^}]*)\}/.exec(barrel)?.[1] ?? "";
    const bindingOf = new Map([...record.matchAll(/(\w+):\s*(\w+)/g)].map((m): [string, string] => [m[1], m[2]]));
    for (const id of FILE_ICON_IDS) {
      assert.ok(existsSync(join(ICON_DIR, `${id}.svg`)), `${id}.svg is missing`);
      assert.equal(fileOf.get(bindingOf.get(id) ?? ""), `${id}.svg`, `${id} imports the wrong file`);
    }
  });
});
