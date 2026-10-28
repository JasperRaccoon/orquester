import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir,mkdtemp,realpath,rm,symlink,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { boxPathMapFor, hostToBoxPath } from "@orquester/api";
import { FsSandboxError } from "@orquester/config/fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AnyOrquesterTool, CallContext, ThreadCaller } from "../catalog/contract.ts";
import { executeToolCall } from "../executor.ts";
import { DEFAULT_READ_BYTES,FsTools,MAX_READ_BYTES } from "../fs-tools.ts";
import { FakeDaemonApi } from "../testing.ts";
import { filesFamily } from "./files.ts";

const readFile: AnyOrquesterTool = filesFamily.find((t) => t.name === "read_file")!;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** A FakeDaemonApi with the real file reads over `fsRoot` (InjectDaemonApi's, through FsTools). */
class FsApi extends FakeDaemonApi {
  listDirectory(path: string) { return new FsTools({ fsRoot: this.fsRoot }).listFiles(path); }
  readFileRange(path: string, opts: { offset?: number; maxBytes?: number }) { return new FsTools({ fsRoot: this.fsRoot }).readFileWindow(path, opts); }
}

interface Ctx { api: FsApi; caller: CallContext["caller"] }

/** `read_file` as the executor runs it: arguments parsed (defaults applied), then `run`. */
async function call(ctx: Ctx, args: Record<string, unknown>): Promise<Record<string, any>> {
  return (await readFile.run(z.object(readFile.input).strict().parse(args), { api: ctx.api, signal: new AbortController().signal, now: () => 0, caller: ctx.caller, turn: { interactionMode: "default", provenance: (_o, t) => t } })) as Record<string, any>;
}

async function harness(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mcp-file-tools-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sandbox = join(root, "workspaces");
  await mkdir(join(sandbox, "acme", "api"), { recursive: true });
  const api = new FsApi(); api.fsRoot = sandbox; api.workspacesDir = sandbox;
  const ctx: Ctx = { api, caller: { kind: "external" } };
  return { root, sandbox, ctx };
}

/** Page through a file the way a caller is told to: from `nextOffset` until truncated is false. */
async function readAll(ctx: Ctx, path: string): Promise<{ text: string; pages: number }> {
  let text = "";
  let offset = 0;
  for (let pages = 1; ; pages += 1) {
    const r = await call(ctx, { path, offset });
    assert.ok(bytes(r) <= 60_000, `page ${pages} is ${bytes(r)} bytes`);
    text += r.text as string;
    if (!r.truncated) { assert.equal("nextOffset" in r, false); return { text, pages }; }
    assert.ok((r.nextOffset as number) > offset, "every page advances");
    offset = r.nextOffset as number;
  }
}

test("read_file on a directory lists it (list_files' successor) inside one result: the first entries by name, truncated:true", async (t) => {
  const { sandbox, ctx } = await harness(t);
  const dir = join(sandbox, "acme", "api");
  // 400 names of ~200 bytes: about 95 KB of entries, well under the 500-entry cap but over one result.
  const names = Array.from({ length: 400 }, (_, i) => `${String(i).padStart(3, "0")}-${"n".repeat(196)}`);
  await Promise.all(names.map((n) => writeFile(join(dir, n), "")));
  const r = await call(ctx, { path: dir });
  assert.equal(r.kind, "directory");
  const entries = r.entries as { name: string }[];
  assert.equal(r.truncated, true);
  assert.ok(entries.length > 0 && entries.length < names.length, `${entries.length} entries kept`);
  assert.deepEqual(entries.map((e) => e.name), names.slice(0, entries.length));
  assert.ok(bytes(r) <= 60_000, `${bytes(r)} bytes`);
});

test("read_file shortens a default window that would not fit one result, and paging from nextOffset reads the file exactly", async (t) => {
  const { sandbox, ctx } = await harness(t);
  // ~200 KB of source-like text: a 64 KiB window of it is well over one result once JSON-escaped.
  const line = (i: number) => `export const value${i} = "quoted \\"text\\" with a backslash \\\\ and a tab\t";\n`;
  const content = Array.from({ length: 3000 }, (_, i) => line(i)).join("");
  assert.ok(content.length > 3 * DEFAULT_READ_BYTES);
  await writeFile(join(sandbox, "big.ts"), content);
  const first = await call(ctx, { path: "big.ts" });
  assert.equal(first.truncated, true);
  assert.ok((first.nextOffset as number) < DEFAULT_READ_BYTES, "the window was shortened");
  assert.equal(first.text, content.slice(0, first.nextOffset as number));
  assert.ok(bytes(first) <= 60_000);
  const all = await readAll(ctx, "big.ts");
  assert.equal(all.text, content);
});

test("read_file stays inside one result even for escape-heavy text and the largest window", async (t) => {
  const { sandbox, ctx } = await harness(t);
  // Control characters cost six bytes each once JSON-escaped (no NUL, so the file is still text).
  const content = Array.from({ length: 40_000 }, (_, i) => String.fromCharCode(1 + (i % 31)) + "\"\\").join("");
  await writeFile(join(sandbox, "ctl.txt"), content);
  const r = await call(ctx, { path: "ctl.txt", maxBytes: MAX_READ_BYTES });
  assert.equal(r.truncated, true);
  assert.ok(bytes(r) <= 60_000, `${bytes(r)} bytes`);
  assert.equal(r.text, content.slice(0, r.nextOffset as number));
  assert.equal((await readAll(ctx, "ctl.txt")).text, content);
});

test("read_file never splits a character: nextOffset is where the page's text ends, and the pages concatenate byte-exactly", async (t) => {
  const { sandbox, ctx } = await harness(t);
  // 65 536 is not a multiple of 3, so the default window ends inside a character; the result cap shortens it too.
  const content = "語".repeat(50_000);
  await writeFile(join(sandbox, "cjk.txt"), content);
  const first = await call(ctx, { path: "cjk.txt" });
  assert.equal(first.truncated, true);
  assert.equal((first.nextOffset as number) % 3, 0, "the window ended on a character boundary");
  assert.equal(Buffer.byteLength(first.text as string), first.nextOffset, "nextOffset is offset + the bytes consumed");
  assert.ok(!(first.text as string).includes(String.fromCharCode(0xfffd)));
  assert.equal("consumed" in first, false, "nextOffset says it; the result has no second field for it");
  const all = await readAll(ctx, "cjk.txt");
  assert.ok(Buffer.from(all.text, "utf8").equals(Buffer.from(content, "utf8")), "byte-exact");
  const small = await call(ctx, { path: "cjk.txt", offset: 3, maxBytes: 10 });
  assert.deepEqual([small.text, small.nextOffset], ["語語語", 12]);
});

// ---- Unified MCP Task 9: chat callers read inside project directories only (§5.1 ruling S6) ----

const chatCaller = (sandbox: string, over: Partial<ThreadCaller> = {}): ThreadCaller => ({
  kind: "thread", threadId: "me", title: "Me", projectPath: join(sandbox, "acme", "api"), workspace: "acme", cwd: join(sandbox, "acme", "api"), agentId: "claude", callId: "call-1",
  runtimeMode: "auto", planning: false, workflowOwned: false, exchange: null, ...over
});

/** One read_file call through the executor (the gate, then run), files-git on, no approval port. */
async function chatRead(api: FsApi, caller: ThreadCaller, args: Record<string, unknown>): Promise<CallToolResult> {
  return executeToolCall({ approvals: null }, { name: "read_file", arguments: args }, { caller, api, signal: new AbortController().signal });
}
const answer = (r: CallToolResult) => r.structuredContent as Record<string, any>;

test("read_file for a chat: a path inside its project reads (relative to its directory); a directory lists; outside every project is PERMISSION_DENIED", async (t) => {
  const { root, sandbox, ctx } = await harness(t);
  const api = ctx.api;
  await mkdir(join(sandbox, "acme", "api", "src"), { recursive: true });
  await writeFile(join(sandbox, "acme", "api", "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(sandbox, "acme", "notes.txt"), "beside the projects");
  await writeFile(join(sandbox, "root.txt"), "at the sandbox root");
  await writeFile(join(root, "outside.txt"), "outside the sandbox");
  await symlink(join(sandbox, "acme", "notes.txt"), join(sandbox, "acme", "api", "link.txt"));
  const caller = chatCaller(sandbox);

  const relative = await chatRead(api, caller, { path: "src/a.ts" });
  assert.equal(relative.isError, undefined, JSON.stringify(relative.content));
  assert.equal(answer(relative).text, "export const a = 1;\n");
  const fromSubdir = await chatRead(api, chatCaller(sandbox, { cwd: join(sandbox, "acme", "api", "src") }), { path: "a.ts" });
  assert.equal(answer(fromSubdir).text, "export const a = 1;\n", "relative to the chat's working directory");
  const listing = answer(await chatRead(api, caller, { path: "." }));
  assert.equal(listing.kind, "directory");
  assert.deepEqual((listing.entries as { name: string }[]).map((e) => e.name), ["link.txt", "src"]);

  for (const path of [join(sandbox, "acme", "notes.txt"), join(sandbox, "acme"), join(sandbox, "root.txt"), sandbox, join(root, "outside.txt"), "../notes.txt", "link.txt"]) {
    const r = await chatRead(api, caller, { path });
    assert.equal(r.isError, true, path);
    assert.equal(answer(r).code, "PERMISSION_DENIED", path);
  }
});

test("read_file for a chat in a Windows box: its C:\\orq\\… and backslash paths read the host file; another drive is refused; a host chat's backslash is a filename character", async (t) => {
  const { sandbox, ctx } = await harness(t);
  await mkdir(join(sandbox, "acme", "api", "src"), { recursive: true });
  await writeFile(join(sandbox, "acme", "api", "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(sandbox, "acme", "api", "src\\b.ts"), "a backslash in its name");
  const boxPaths = boxPathMapFor("win32");
  const windows = chatCaller(sandbox, { boxPaths });
  const boxed = hostToBoxPath(boxPaths, join(sandbox, "acme", "api", "src", "a.ts"));
  const slashed = boxed.slice(2).replace(/\\/g, "/");
  for (const path of ["src\\a.ts", boxed, `c:${slashed}`, `/c${slashed}`, `/cygdrive/C${slashed}`]) {
    const r = await chatRead(ctx.api, windows, { path });
    assert.equal(answer(r).text, "export const a = 1;\n", path);
  }
  for (const path of ["D:\\acme\\api\\src\\a.ts", "C:\\Users\\me\\a.ts", `${"..\\".repeat(20)}a.ts`, `/d${slashed}`, "/c/Users/me/a.ts"]) {
    const r = await chatRead(ctx.api, windows, { path });
    assert.equal(answer(r).code, "PERMISSION_DENIED", path);
  }
  assert.equal(answer(await chatRead(ctx.api, chatCaller(sandbox), { path: "src\\b.ts" })).text, "a backslash in its name");
});

test("read_file for a chat: another project's content follows the gate (same workspace under auto: allowed; another workspace: a card, refused without a port)", async (t) => {
  const { sandbox, ctx } = await harness(t);
  await mkdir(join(sandbox, "acme", "web"), { recursive: true });
  await mkdir(join(sandbox, "beta", "app"), { recursive: true });
  await writeFile(join(sandbox, "acme", "web", "x.txt"), "same workspace");
  await writeFile(join(sandbox, "beta", "app", "y.txt"), "other workspace");
  const same = await chatRead(ctx.api, chatCaller(sandbox), { path: join(sandbox, "acme", "web", "x.txt") });
  assert.equal(answer(same).text, "same workspace");
  const supervised = await chatRead(ctx.api, chatCaller(sandbox, { runtimeMode: "approval-required" }), { path: join(sandbox, "acme", "web", "x.txt") });
  assert.equal(answer(supervised).code, "PERMISSION_DENIED", "below auto a same-workspace content read needs a card");
  const other = await chatRead(ctx.api, chatCaller(sandbox), { path: join(sandbox, "beta", "app", "y.txt") });
  assert.equal(answer(other).code, "PERMISSION_DENIED");
  assert.match(answer(other).message, /approval/);
  const full = await chatRead(ctx.api, chatCaller(sandbox, { runtimeMode: "full-access" }), { path: join(sandbox, "beta", "app", "y.txt") });
  assert.equal(answer(full).text, "other workspace");
});

test("read_file for an external caller keeps the sandbox rule only: relative to the sandbox root, anywhere inside it", async (t) => {
  const { sandbox, ctx } = await harness(t);
  await writeFile(join(sandbox, "root.txt"), "at the sandbox root");
  assert.equal((await call(ctx, { path: "root.txt" })).text, "at the sandbox root");
  await assert.rejects(call(ctx, { path: "../escape.txt" }), FsSandboxError);
  // Without the DaemonApi file reads (a bare double) the tool says so instead of reaching for the disk itself.
  await assert.rejects(readFile.run({ path: "root.txt", offset: 0, maxBytes: 10 }, { api: new FakeDaemonApi(), signal: new AbortController().signal, now: () => 0, caller: { kind: "external" }, turn: { interactionMode: "default", provenance: (_o, t2) => t2 } }), (e: { code: string }) => e.code === "UNAVAILABLE");
});
