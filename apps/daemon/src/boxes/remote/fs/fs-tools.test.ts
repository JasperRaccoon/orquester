import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FsSandboxError } from "@orquester/config/fs";

import { ToolError } from "../../../mcp/errors.ts";
import { FsDirectoryError, FsTools } from "../../../mcp/fs-tools.ts";
import { boxDiskConnection, fakeBoxRegistry } from "./test-box.ts";

// The MCP `read_file` reads (FsTools) for a path in a box project: same results and errors, read in the box.

async function setup(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orq-box-fstools-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fsRoot = join(root, "workspaces");
  const project = join(fsRoot, "acme", "engine");
  await mkdir(project, { recursive: true }); // the host stub, left empty
  const disk = join(root, "disk");
  const connection = boxDiskConnection({ disk });
  const local = (rel: string): string => connection.local(join(project, rel));
  await mkdir(local("src"), { recursive: true });
  await writeFile(local("src/a.txt"), "héllo wörld\n");
  await writeFile(local("src/b.bin"), Buffer.from([1, 0, 2]));
  await mkdir(connection.local("/etc"), { recursive: true });
  await writeFile(connection.local("/etc/shadow"), "secret");
  await symlink(connection.local("/etc"), local("etc"));
  const registry = fakeBoxRegistry({ projectPath: project, connection });
  return { tools: new FsTools({ fsRoot, boxes: () => registry }), project, connection, fsRoot };
}

test("listFiles and readFileWindow read a box project", async (t) => {
  const { tools, project } = await setup(t);
  const listing = await tools.listFiles(join(project, "src"));
  assert.equal(listing.path, join(project, "src"));
  assert.deepEqual(listing.entries, [
    { name: "a.txt", kind: "file", size: 14 },
    { name: "b.bin", kind: "file", size: 3 }
  ]);
  const relative = await tools.listFiles("acme/engine/src");
  assert.deepEqual(relative, listing, "a relative path is taken from fsRoot");

  const whole = await tools.readFileWindow(join(project, "src/a.txt"));
  assert.deepEqual(whole, { path: join(project, "src/a.txt"), text: "héllo wörld\n", size: 14, offset: 0, truncated: false, consumed: 14 });
  // A window that would split "é" ends before it; the next starts right there.
  const first = await tools.readFileWindow(join(project, "src/a.txt"), { maxBytes: 2 });
  assert.deepEqual([first.text, first.consumed, first.truncated], ["h", 1, true]);
  const second = await tools.readFileWindow(join(project, "src/a.txt"), { offset: 1, maxBytes: 1 });
  assert.deepEqual([second.text, second.consumed], ["é", 2]);
});

test("box reads refuse binaries, directories, escapes and an unreachable box with agent-facing errors", async (t) => {
  const { tools, project, connection } = await setup(t);
  await assert.rejects(tools.readFileWindow(join(project, "src/b.bin")), (error: unknown) => error instanceof ToolError && /binary/.test(error.message));
  await assert.rejects(tools.readFileWindow(join(project, "src")), FsDirectoryError);
  await assert.rejects(tools.readFileWindow(join(project, "nope.txt")), (error: unknown) => error instanceof ToolError && error.message === "File not found.");
  await assert.rejects(tools.listFiles(join(project, "nope")), (error: unknown) => error instanceof ToolError && error.message === "Directory not found.");
  await assert.rejects(tools.readFileWindow(join(project, "etc/shadow")), FsSandboxError);
  connection.setConnected(false);
  await assert.rejects(tools.readFileWindow(join(project, "src/a.txt")), (error: unknown) => error instanceof ToolError && error.code === "BOX_NOT_READY");
});
