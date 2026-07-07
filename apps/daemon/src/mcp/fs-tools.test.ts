import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FsSandboxError } from "@orquester/config/fs";
import { ToolError } from "./terminal-control.ts";
import { DEFAULT_READ_BYTES, FsTools, MAX_FS_ENTRIES, MAX_READ_BYTES } from "./fs-tools.ts";

async function makeRoot(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "orq-fs-tools-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function write(root: string, path: string, data: string | Buffer) {
  const full = join(root, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, data);
  return full;
}

test("listFiles accepts relative and absolute paths and returns sorted file, dir, and symlink entries", async (t) => {
  const root = await makeRoot(t);
  const nested = join(root, "nested");
  await mkdir(join(nested, "subdir"), { recursive: true });
  await write(root, "nested/b.txt", "hello");
  await write(root, "nested/a.txt", "abc");
  await symlink(join(nested, "a.txt"), join(nested, "link-to-a"));

  const tools = new FsTools({ fsRoot: root });
  const relative = await tools.listFiles("nested");
  const absolute = await tools.listFiles(nested);

  assert.equal(relative.path, nested);
  assert.deepEqual(absolute, relative);
  assert.equal(relative.truncated, false);
  assert.deepEqual(relative.entries, [
    { name: "a.txt", kind: "file", size: 3 },
    { name: "b.txt", kind: "file", size: 5 },
    { name: "link-to-a", kind: "symlink", size: 0 },
    { name: "subdir", kind: "dir", size: 0 },
  ]);
});

test("listFiles rejects sandbox escapes and missing directories with safe errors", async (t) => {
  const root = await makeRoot(t);
  const outside = await mkdtemp(join(tmpdir(), "orq-fs-tools-outside-list-"));
  t.after(async () => {
    await rm(outside, { recursive: true, force: true });
  });
  await symlink(outside, join(root, "outside-link"));
  const tools = new FsTools({ fsRoot: root });

  await assert.rejects(
    () => tools.listFiles("/etc/shadow"),
    (error) => {
      assert.ok(error instanceof FsSandboxError);
      assert.doesNotMatch(error.message, /\/etc\/shadow/);
      return true;
    }
  );
  await assert.rejects(
    () => tools.listFiles("outside-link"),
    (error) => {
      assert.ok(error instanceof FsSandboxError);
      assert.doesNotMatch(error.message, new RegExp(outside));
      return true;
    }
  );
  await assert.rejects(
    () => tools.listFiles("missing"),
    (error) => {
      assert.ok(error instanceof ToolError);
      assert.doesNotMatch(error.message, new RegExp(root));
      assert.match(error.message, /not found/i);
      return true;
    }
  );
});

test("listFiles caps entries and marks truncated after MAX_FS_ENTRIES", async (t) => {
  const root = await makeRoot(t);
  const dir = join(root, "many");
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < MAX_FS_ENTRIES + 1; i += 1) {
    await writeFile(join(dir, `f${String(i).padStart(4, "0")}.txt`), "x");
  }

  const result = await new FsTools({ fsRoot: root }).listFiles("many");

  assert.equal(result.entries.length, MAX_FS_ENTRIES);
  assert.equal(result.truncated, true);
  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    [...result.entries].map((entry) => entry.name).sort((a, b) => a.localeCompare(b))
  );
});

test("readFileWindow reads the default window and supports byte-offset paging", async (t) => {
  const root = await makeRoot(t);
  await write(root, "large.txt", `${"a".repeat(DEFAULT_READ_BYTES)}tail`);
  const tools = new FsTools({ fsRoot: root });

  const first = await tools.readFileWindow("large.txt");
  const second = await tools.readFileWindow("large.txt", { offset: DEFAULT_READ_BYTES, maxBytes: 10 });

  assert.equal(first.text, "a".repeat(DEFAULT_READ_BYTES));
  assert.equal(first.size, DEFAULT_READ_BYTES + 4);
  assert.equal(first.offset, 0);
  assert.equal(first.truncated, true);
  assert.equal(second.text, "tail");
  assert.equal(second.offset, DEFAULT_READ_BYTES);
  assert.equal(second.truncated, false);
});

test("readFileWindow clamps offset and hard-caps maxBytes", async (t) => {
  const root = await makeRoot(t);
  await write(root, "huge.txt", "b".repeat(MAX_READ_BYTES + 5));

  const negativeOffset = await new FsTools({ fsRoot: root }).readFileWindow("huge.txt", {
    offset: -20,
    maxBytes: MAX_READ_BYTES + 99,
  });
  const tinyWindow = await new FsTools({ fsRoot: root }).readFileWindow("huge.txt", { maxBytes: 0 });

  assert.equal(negativeOffset.offset, 0);
  assert.equal(negativeOffset.text.length, MAX_READ_BYTES);
  assert.equal(negativeOffset.truncated, true);
  assert.equal(tinyWindow.text.length, 1);
});

test("readFileWindow refuses binary files, directories, and missing files with safe ToolErrors", async (t) => {
  const root = await makeRoot(t);
  await write(root, "binary.bin", Buffer.from([65, 0, 66]));
  await mkdir(join(root, "dir"), { recursive: true });
  const tools = new FsTools({ fsRoot: root });

  await assert.rejects(
    () => tools.readFileWindow("binary.bin"),
    (error) => {
      assert.ok(error instanceof ToolError);
      assert.match(error.message, /binary/i);
      return true;
    }
  );
  await assert.rejects(
    () => tools.readFileWindow("dir"),
    (error) => {
      assert.ok(error instanceof ToolError);
      assert.match(error.message, /list_files/);
      return true;
    }
  );
  await assert.rejects(
    () => tools.readFileWindow("missing.txt"),
    (error) => {
      assert.ok(error instanceof ToolError);
      assert.match(error.message, /not found/i);
      assert.doesNotMatch(error.message, new RegExp(root));
      return true;
    }
  );
});

test("readFileWindow blocks symlinks that resolve outside the sandbox", async (t) => {
  const root = await makeRoot(t);
  const outside = await mkdtemp(join(tmpdir(), "orq-fs-tools-outside-"));
  t.after(async () => {
    await rm(outside, { recursive: true, force: true });
  });
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(join(outside, "secret.txt"), join(root, "secret-link"));

  await assert.rejects(() => new FsTools({ fsRoot: root }).readFileWindow("secret-link"), FsSandboxError);
});
