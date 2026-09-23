import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { FsSandboxError } from "@orquester/config/fs";
import { DEFAULT_READ_BYTES, FsTools, MAX_READ_BYTES } from "../fs-tools.ts";
import { MAX_RESULT_BYTES, ok } from "../result.ts";
import { FakeDaemonApi } from "../testing.ts";
import { READ_ONLY, type ToolContext, type ToolDef } from "../tool.ts";
import { fileTools } from "./files.ts";

const tool = (name: string) => fileTools.find((t) => t.name === name)!;
/** The arguments as `run()` receives them: parsed by the tool's own schema, defaults applied (server.ts's tools/call handler). */
const parse = (t: ToolDef, args: Record<string, unknown>) => z.object(t.input).parse(args) as never;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

async function harness(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "mcp-file-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sandbox = join(root, "workspaces");
  await mkdir(join(sandbox, "acme", "api"), { recursive: true });
  const ctx: ToolContext = { api: new FakeDaemonApi(), todos: {} as never, files: new FsTools({ fsRoot: sandbox }), signal: new AbortController().signal, now: () => 0 };
  return { root, sandbox, ctx };
}

/** Page through a file the way a caller is told to: from `nextOffset` until truncated is false. */
async function readAll(ctx: ToolContext, path: string): Promise<{ text: string; pages: number }> {
  let text = "";
  let offset = 0;
  for (let pages = 1; ; pages += 1) {
    const r = await tool("read_file").run(parse(tool("read_file"), { path, offset }), ctx);
    assert.ok(bytes(r) <= MAX_RESULT_BYTES, `page ${pages} is ${bytes(r)} bytes`);
    text += r.text as string;
    if (!r.truncated) { assert.equal("nextOffset" in r, false); return { text, pages }; }
    assert.ok((r.nextOffset as number) > offset, "every page advances");
    offset = r.nextOffset as number;
  }
}

test("list_files and read_file are read-only tools with short descriptions", () => {
  assert.deepEqual(fileTools.map((t) => t.name), ["list_files", "read_file"]);
  for (const t of fileTools) {
    assert.deepEqual(t.annotations, READ_ONLY);
    assert.equal(t.annotations.openWorldHint, false, `${t.name} reads only the sandbox`);
    assert.ok(t.title && t.description.length <= 400, `${t.name}: ${t.description.length} chars`);
  }
});

test("list_files lists a sandbox directory given relative to the sandbox root or absolute", async (t) => {
  const { sandbox, ctx } = await harness(t);
  await writeFile(join(sandbox, "acme", "api", "b.txt"), "12345");
  await mkdir(join(sandbox, "acme", "api", "a-dir"));
  const expected = { path: join(sandbox, "acme", "api"), entries: [{ name: "a-dir", kind: "dir", size: 0 }, { name: "b.txt", kind: "file", size: 5 }], truncated: false };
  assert.deepEqual(await tool("list_files").run(parse(tool("list_files"), { path: "acme/api" }), ctx), expected);
  assert.deepEqual(await tool("list_files").run(parse(tool("list_files"), { path: join(sandbox, "acme", "api") }), ctx), expected);
});

test("list_files keeps a listing inside one result: the first entries by name, truncated:true", async (t) => {
  const { sandbox, ctx } = await harness(t);
  const dir = join(sandbox, "acme", "api");
  // 400 names of ~200 bytes: about 95 KB of entries, well under the 500-entry cap but over one result.
  const names = Array.from({ length: 400 }, (_, i) => `${String(i).padStart(3, "0")}-${"n".repeat(196)}`);
  await Promise.all(names.map((n) => writeFile(join(dir, n), "")));
  const r = await tool("list_files").run(parse(tool("list_files"), { path: dir }), ctx);
  const entries = r.entries as { name: string }[];
  assert.equal(r.truncated, true);
  assert.ok(entries.length > 0 && entries.length < names.length, `${entries.length} entries kept`);
  assert.deepEqual(entries.map((e) => e.name), names.slice(0, entries.length));
  assert.ok(bytes(r) <= MAX_RESULT_BYTES, `${bytes(r)} bytes`);
  assert.equal(ok(r).structuredContent, r, "ok() passes the bounded result through untouched");
  assert.ok(bytes({ ...r, entries: names.slice(0, entries.length + 1).map((name) => ({ name, kind: "file", size: 0 })) }) > MAX_RESULT_BYTES, "one more entry would not have fitted");
});

test("read_file returns a small file whole, with no nextOffset", async (t) => {
  const { sandbox, ctx } = await harness(t);
  await writeFile(join(sandbox, "acme", "api", "a.txt"), "hello\n");
  assert.deepEqual(await tool("read_file").run(parse(tool("read_file"), { path: "acme/api/a.txt" }), ctx), { path: join(sandbox, "acme", "api", "a.txt"), text: "hello\n", size: 6, offset: 0, truncated: false });
});

test("read_file honours an explicit window and names where the next one starts", async (t) => {
  const { sandbox, ctx } = await harness(t);
  await writeFile(join(sandbox, "a.txt"), "0123456789abcdefghij");
  const r = await tool("read_file").run(parse(tool("read_file"), { path: "a.txt", offset: 5, maxBytes: 10 }), ctx);
  assert.deepEqual(r, { path: join(sandbox, "a.txt"), text: "56789abcde", size: 20, offset: 5, truncated: true, nextOffset: 15 });
});

test("read_file shortens a default window that would not fit one result, and paging from nextOffset reads the file exactly", async (t) => {
  const { sandbox, ctx } = await harness(t);
  // ~200 KB of source-like text: a 64 KiB window of it is well over one result once JSON-escaped.
  const line = (i: number) => `export const value${i} = "quoted \\"text\\" with a backslash \\\\ and a tab\t";\n`;
  const content = Array.from({ length: 3000 }, (_, i) => line(i)).join("");
  assert.ok(content.length > 3 * DEFAULT_READ_BYTES);
  await writeFile(join(sandbox, "big.ts"), content);
  const first = await tool("read_file").run(parse(tool("read_file"), { path: "big.ts" }), ctx);
  assert.equal(first.truncated, true);
  assert.ok((first.nextOffset as number) < DEFAULT_READ_BYTES, "the window was shortened");
  assert.equal(first.text, content.slice(0, first.nextOffset as number));
  assert.ok(bytes(first) <= MAX_RESULT_BYTES);
  const all = await readAll(ctx, "big.ts");
  assert.equal(all.text, content);
});

test("read_file stays inside one result even for escape-heavy text and the largest window", async (t) => {
  const { sandbox, ctx } = await harness(t);
  // Control characters cost six bytes each once JSON-escaped (no NUL, so the file is still text).
  const content = Array.from({ length: 40_000 }, (_, i) => String.fromCharCode(1 + (i % 31)) + "\"\\").join("");
  await writeFile(join(sandbox, "ctl.txt"), content);
  const r = await tool("read_file").run(parse(tool("read_file"), { path: "ctl.txt", maxBytes: MAX_READ_BYTES }), ctx);
  assert.equal(r.truncated, true);
  assert.ok(bytes(r) <= MAX_RESULT_BYTES, `${bytes(r)} bytes`);
  assert.equal(r.text, content.slice(0, r.nextOffset as number));
  assert.equal((await readAll(ctx, "ctl.txt")).text, content);
});

test("read_file refuses a path outside the sandbox with the safe sandbox error", async (t) => {
  const { root, ctx } = await harness(t);
  await writeFile(join(root, "secret.txt"), "no");
  await assert.rejects(tool("read_file").run(parse(tool("read_file"), { path: join(root, "secret.txt") }), ctx), (err: unknown) => err instanceof FsSandboxError && !err.message.includes(root));
  await assert.rejects(tool("list_files").run(parse(tool("list_files"), { path: "../" }), ctx), FsSandboxError);
});

test("read_file never splits a character: nextOffset is where the page's text ends, and the pages concatenate byte-exactly", async (t) => {
  const { sandbox, ctx } = await harness(t);
  // 65 536 is not a multiple of 3, so the default window ends inside a character; the result cap shortens it too.
  const content = "語".repeat(50_000);
  await writeFile(join(sandbox, "cjk.txt"), content);
  const first = await tool("read_file").run(parse(tool("read_file"), { path: "cjk.txt" }), ctx);
  assert.equal(first.truncated, true);
  assert.equal((first.nextOffset as number) % 3, 0, "the window ended on a character boundary");
  assert.equal(Buffer.byteLength(first.text as string), first.nextOffset, "nextOffset is offset + the bytes consumed");
  assert.ok(!(first.text as string).includes(String.fromCharCode(0xfffd)));
  assert.equal("consumed" in first, false, "nextOffset says it; the result has no second field for it");
  const all = await readAll(ctx, "cjk.txt");
  assert.ok(Buffer.from(all.text, "utf8").equals(Buffer.from(content, "utf8")), "byte-exact");
  const small = await tool("read_file").run(parse(tool("read_file"), { path: "cjk.txt", offset: 3, maxBytes: 10 }), ctx);
  assert.deepEqual([small.text, small.nextOffset], ["語語語", 12]);
});

test("read_file: a maxBytes narrower than the character at offset takes that character whole, and the description says so", async (t) => {
  const { sandbox, ctx } = await harness(t);
  await writeFile(join(sandbox, "e.txt"), "😀語é!"); // 4 + 3 + 2 + 1 bytes
  const read = async (offset: number, maxBytes: number) => {
    const r = await tool("read_file").run(parse(tool("read_file"), { path: "e.txt", offset, maxBytes }), ctx);
    return [r.text, r.nextOffset];
  };
  assert.deepEqual(await read(0, 1), ["😀", 4], "4 bytes at maxBytes 1");
  assert.deepEqual(await read(4, 2), ["語", 7], "3 bytes at maxBytes 2");
  assert.deepEqual(await read(7, 1), ["é", 9], "2 bytes at maxBytes 1");
  assert.deepEqual(await read(9, 1), ["!", undefined], "the last byte, and no more to read");
  const description = tool("read_file").description;
  assert.ok(description.includes(`at most \`maxBytes\` (default ${DEFAULT_READ_BYTES}), or one whole character when maxBytes is smaller than it.`), description);
  assert.match(tool("read_file").input.maxBytes.description ?? "", /or one whole character when maxBytes is smaller than it/);
});
