/**
 * The chat image resolver (design 2026-11-10 §6.1, §9.3): where an image may be read from, what counts as an image,
 * and which image `recent:N` names. `show_image` itself is tested through the executor in `tools/visuals.test.ts`.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { agentChatRoutes, boundSessionToolData, MAX_TURN_IMAGE_BYTES, sessionToolMarkedData } from "@orquester/api/agent-chat";

import type { ThreadCaller } from "./catalog/contract.ts";
import { resolveChatImages, sniffImage, type ChatImageInput } from "./chat-images.ts";
import type { ToolError } from "./errors.ts";
import { FakeDaemonApi } from "./testing.ts";

const THREAD = "t1";

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function jpeg(width: number, height: number): Buffer {
  // SOI, an APP0 segment to step over, then SOF0 (length 17: precision, height, width, …).
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function webp(chunk: "VP8 " | "VP8L" | "VP8X", width: number, height: number): Buffer {
  const bytes = Buffer.alloc(40);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(32, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write(chunk, 12, "ascii");
  if (chunk === "VP8 ") {
    bytes.set([0x9d, 0x01, 0x2a], 23);
    bytes.writeUInt16LE(width, 26);
    bytes.writeUInt16LE(height, 28);
  } else if (chunk === "VP8L") {
    bytes[20] = 0x2f;
    bytes.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 21);
  } else {
    bytes.writeUIntLE(width - 1, 24, 3);
    bytes.writeUIntLE(height - 1, 27, 3);
  }
  return bytes;
}

function gif(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(13);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

test("sniffImage tells the four types and their pixel sizes by content alone", () => {
  assert.deepEqual(sniffImage(png(640, 480)), { mimeType: "image/png", width: 640, height: 480 });
  assert.deepEqual(sniffImage(jpeg(1920, 1080)), { mimeType: "image/jpeg", width: 1920, height: 1080 });
  assert.deepEqual(sniffImage(webp("VP8 ", 300, 200)), { mimeType: "image/webp", width: 300, height: 200 });
  assert.deepEqual(sniffImage(webp("VP8L", 1024, 768)), { mimeType: "image/webp", width: 1024, height: 768 });
  assert.deepEqual(sniffImage(webp("VP8X", 5000, 4000)), { mimeType: "image/webp", width: 5000, height: 4000 });
  assert.deepEqual(sniffImage(gif(16, 32)), { mimeType: "image/gif", width: 16, height: 32 });
  assert.equal(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
  assert.equal(sniffImage(Buffer.from("%PDF-1.7")), null);
});

function chatCaller(over: Partial<ThreadCaller> = {}): ThreadCaller {
  return {
    kind: "thread", threadId: THREAD, title: "Chat", projectPath: "", workspace: "", cwd: "/", agentId: "claude", callId: "call-1",
    runtimeMode: "approval-required", planning: false, workflowOwned: false, exchange: null, ...over
  };
}

/** An appdir-like layout: workspaces, the agent threads' attachments, a temp folder, and somewhere else. */
async function layout() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "chat-images-")));
  const ws = join(root, "workspaces");
  const threads = join(root, "daemon", "agent", "threads");
  const own = join(threads, THREAD, "attachments");
  const other = join(threads, "t2", "attachments");
  const temp = join(root, "tmp");
  const elsewhere = join(root, "elsewhere");
  for (const dir of [join(ws, "acme", "app"), own, other, temp, elsewhere]) await mkdir(dir, { recursive: true });
  const api = new FakeDaemonApi();
  api.fsRoot = ws;
  api.workspacesDir = ws;
  const attachments = new Map<string, string>();
  Object.assign(api, {
    chatImageRoots: (threadId: string) => ({ attachmentsDir: join(threads, threadId, "attachments"), tempDirs: [temp], appDir: root }),
    // As the host resolves: an id names its thread's file, or nothing.
    chatAttachmentPath: async (threadId: string, id: string) => (id.startsWith(`${threadId}-`) ? attachments.get(id) ?? null : null)
  });
  return { root, ws, own, other, temp, elsewhere, api, attachments };
}

const refusal = (code: string, message: RegExp) => (error: ToolError) => {
  assert.equal(error.code, code);
  assert.match(error.message, message);
  return true;
};

test("paths: the workspaces, this chat's own attachments and the temp folders are readable; nothing else is", async (t) => {
  const s = await layout();
  t.after(() => rm(s.root, { recursive: true, force: true }));
  await writeFile(join(s.ws, "acme", "app", "logo.png"), png(64, 64));
  await writeFile(join(s.own, "pasted.webp"), webp("VP8L", 10, 10));
  await writeFile(join(s.temp, "screenshot.jpeg"), jpeg(800, 600));
  await writeFile(join(s.elsewhere, "secret.png"), png(1, 1));
  await writeFile(join(s.other, "t2-x.png"), png(1, 1));
  await symlink(join(s.elsewhere, "secret.png"), join(s.ws, "acme", "app", "escape.png"));
  // A relative path is taken from the chat's working directory, as read_file takes it.
  const resolve = (inputs: ChatImageInput[]) => resolveChatImages(s.api, chatCaller({ cwd: join(s.ws, "acme", "app") }), inputs);

  const images = await resolve([{ path: "logo.png" }, { path: join(s.own, "pasted.webp") }, { path: join(s.temp, "screenshot.jpeg") }]);
  assert.deepEqual(
    images.map(({ name, mimeType, width, height, path }) => ({ name, mimeType, width, height, path })),
    [
      { name: "logo.png", mimeType: "image/png", width: 64, height: 64, path: join(s.ws, "acme", "app", "logo.png") },
      { name: "pasted.webp", mimeType: "image/webp", width: 10, height: 10, path: undefined },
      { name: "screenshot.jpg", mimeType: "image/jpeg", width: 800, height: 600, path: undefined }
    ]
  );
  assert.deepEqual(images[0]!.bytes, png(64, 64));

  await assert.rejects(resolve([{ path: join(s.ws, "acme", "app", "logo.png") }, { path: join(s.elsewhere, "secret.png") }]), refusal("PATH_NOT_ALLOWED", /^images\[1\]: path is not allowed/));
  await assert.rejects(resolve([{ path: join(s.ws, "acme", "app", "escape.png") }]), refusal("PATH_NOT_ALLOWED", /^images\[0\]: /), "a symlink out, after realpath");
  await assert.rejects(resolve([{ path: join(s.other, "t2-x.png") }]), refusal("PATH_NOT_ALLOWED", /^images\[0\]: /), "another chat's attachments");
  await assert.rejects(resolve([{ path: join(s.temp, "gone.png") }]), refusal("INVALID_ARGUMENT", /^images\[0\]: file not found/));
  await assert.rejects(resolve([{ path: join(s.elsewhere, "gone.png") }]), refusal("PATH_NOT_ALLOWED", /^images\[0\]: /), "no probing outside");
});

test("a chat's temp folder set above the appdir still never reaches another chat's attachments", async (t) => {
  const s = await layout();
  t.after(() => rm(s.root, { recursive: true, force: true }));
  Object.assign(s.api, { chatImageRoots: (threadId: string) => ({ attachmentsDir: join(s.root, "daemon", "agent", "threads", threadId, "attachments"), tempDirs: [s.root], appDir: s.root }) });
  await writeFile(join(s.other, "t2-x.png"), png(1, 1));
  await writeFile(join(s.own, "t1-y.png"), png(2, 2));
  await assert.rejects(resolveChatImages(s.api, chatCaller(), [{ path: join(s.other, "t2-x.png") }]), refusal("PATH_NOT_ALLOWED", /^images\[0\]: /));
  assert.equal((await resolveChatImages(s.api, chatCaller(), [{ path: join(s.own, "t1-y.png") }]))[0]!.width, 2);
});

test("before this chat has an attachments folder, another chat's attachments and the pending uploads stay out of reach", async (t) => {
  const s = await layout();
  t.after(() => rm(s.root, { recursive: true, force: true }));
  // A chat whose attachments folder was never made, its temp folder set above the appdir.
  Object.assign(s.api, { chatImageRoots: () => ({ attachmentsDir: join(s.root, "daemon", "agent", "threads", "t9", "attachments"), tempDirs: [s.root], appDir: s.root }) });
  const pending = join(s.root, "daemon", "agent", "pending-attachments");
  await mkdir(pending, { recursive: true });
  await writeFile(join(s.other, "t2-x.png"), png(1, 1));
  await writeFile(join(pending, "pending-y.png"), png(1, 1));
  const caller = chatCaller({ threadId: "t9" });
  await assert.rejects(resolveChatImages(s.api, caller, [{ path: join(s.other, "t2-x.png") }]), refusal("PATH_NOT_ALLOWED", /^images\[0\]: /));
  await assert.rejects(resolveChatImages(s.api, caller, [{ path: join(pending, "pending-y.png") }]), refusal("PATH_NOT_ALLOWED", /^images\[0\]: /));
});

test("an image is one by its bytes and its size: a renamed text file and an oversized image are refused", async (t) => {
  const s = await layout();
  t.after(() => rm(s.root, { recursive: true, force: true }));
  await writeFile(join(s.temp, "notes.png"), "just text");
  const big = join(s.temp, "huge.png");
  await writeFile(big, png(10, 10));
  await truncate(big, MAX_TURN_IMAGE_BYTES + 1);
  await assert.rejects(resolveChatImages(s.api, chatCaller(), [{ path: join(s.temp, "notes.png") }], "refs"), refusal("INVALID_ARGUMENT", /^refs\[0\]: not a PNG, JPEG, WebP or GIF image/));
  await assert.rejects(resolveChatImages(s.api, chatCaller(), [{ path: big }]), refusal("INVALID_ARGUMENT", /10 MiB/));
});

test("attachment:<id> reads only this chat's own stored attachments", async (t) => {
  const s = await layout();
  t.after(() => rm(s.root, { recursive: true, force: true }));
  await writeFile(join(s.own, "t1-a.gif"), gif(3, 4));
  await writeFile(join(s.other, "t2-b.png"), png(1, 1));
  await writeFile(join(s.root, "pending.png"), png(1, 1));
  s.attachments.set("t1-a-gif", join(s.own, "t1-a.gif"));
  s.attachments.set("t2-b-png", join(s.other, "t2-b.png"));
  // A host that resolves an id outside the thread's own directory (its shared pending uploads) is not followed there.
  s.attachments.set("t1-pending-png", join(s.root, "pending.png"));

  const [image] = await resolveChatImages(s.api, chatCaller(), [{ ref: "attachment:t1-a-gif" }]);
  assert.deepEqual({ attachmentId: image!.attachmentId, mimeType: image!.mimeType, width: image!.width }, { attachmentId: "t1-a-gif", mimeType: "image/gif", width: 3 });
  await assert.rejects(resolveChatImages(s.api, chatCaller(), [{ ref: "attachment:t2-b-png" }]), refusal("INVALID_ARGUMENT", /no attachment/));
  await assert.rejects(resolveChatImages(s.api, chatCaller(), [{ ref: "attachment:t1-pending-png" }]), refusal("INVALID_ARGUMENT", /no attachment/));
});

const message = (id: string, attachments: Array<{ id: string; type: "image" | "file" }>, over: Record<string, unknown> = {}) => ({
  kind: "message", id, role: "user", text: "", turnId: null, streaming: false, createdAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z",
  attachments: attachments.map((a) => ({ ...a, name: `${a.id}.bin`, mimeType: a.type === "image" ? "image/png" : "text/plain", sizeBytes: 33 })),
  ...over
});

/** A completed show_image row as the host ingests it (marked, then slimmed). */
const imageRow = (id: string, attachmentIds: string[], over: Record<string, unknown> = {}) => ({
  kind: "activity", id, tone: "tool", activityKind: "tool.completed", summary: "show_image", turnId: null, status: "completed",
  createdAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z",
  payload: {
    itemType: "mcp_tool_call",
    status: "completed",
    data: boundSessionToolData(sessionToolMarkedData({
      toolName: "mcp__orquester__show_image",
      result: { type: "tool_result", content: [{ type: "text", text: JSON.stringify({ imageRef: { images: attachmentIds.map((attachmentId) => ({ attachmentId })) } }) }] }
    }, new Set(["show_image"])))
  },
  ...over
});

test("recent:N counts this chat's images newest first: pasted ones, shown ones, then older history", async (t) => {
  const s = await layout();
  t.after(() => rm(s.root, { recursive: true, force: true }));
  for (const [id, width] of [["t1-old-png", 1], ["t1-p1-png", 2], ["t1-p2-png", 3], ["t1-shown-png", 4], ["t1-sub-png", 9]] as const) {
    await writeFile(join(s.own, `${id}.png`), png(width, width));
    s.attachments.set(id, join(s.own, `${id}.png`));
  }
  s.api.on("GET", agentChatRoutes.thread(THREAD), {
    status: 200,
    body: {
      kind: "snapshot",
      thread: {
        items: [
          message("m1", [{ id: "t1-p1-png", type: "image" }, { id: "t1-p2-png", type: "image" }]),
          imageRow("a1", ["t1-shown-png"]),
          message("m2", [{ id: "t1-notes-txt", type: "file" }]),
          imageRow("a2", ["t1-sub-png"], { agentId: "sub-1" })
        ],
        history: { indexed: true, hasOlder: true, beforeCursor: "cursor-1", oldestRetainedOrdinal: 2, totalTurns: 2 }
      }
    }
  });
  s.api.on("GET", agentChatRoutes.history(THREAD), ({ query }) =>
    query?.before === "cursor-1"
      ? { status: 200, body: { threadId: THREAD, turns: [], checkpoints: [], seq: 1, items: [message("m0", [{ id: "t1-old-png", type: "image" }]), message("m1", [{ id: "t1-p1-png", type: "image" }])], page: { beforeCursor: null } } }
      : { status: 404, body: { code: "NOT_FOUND", message: "no such page" } }
  );
  const widths = async (refs: string[]) =>
    (await resolveChatImages(s.api, chatCaller(), refs.map((ref) => ({ ref })))).map((image) => [image.attachmentId, image.width]);

  assert.deepEqual(await widths(["recent:1", "recent:2", "recent:3"]), [["t1-shown-png", 4], ["t1-p2-png", 3], ["t1-p1-png", 2]]);
  assert.deepEqual(await widths(["recent:4"]), [["t1-old-png", 1]]);
  await assert.rejects(widths(["recent:5"]), refusal("INVALID_ARGUMENT", /^images\[0\]: this chat has only 4 images/));
});

test("in a box chat a path is the box's, read there under the same image checks", async () => {
  const api = new FakeDaemonApi();
  const asked: Array<[string, number]> = [];
  const files: Record<string, Buffer> = { "/tmp/shot.png": png(5, 6), "/tmp/notes.png": Buffer.from("text") };
  Object.assign(api, {
    boxReadChatFile: async (path: string, maxBytes: number) => {
      asked.push([path, maxBytes]);
      return files[path] ? { ok: true, value: { bytes: files[path] } } : { ok: false, code: "NOT_FOUND", message: "file not found." };
    }
  });
  const caller = chatCaller({ projectBoxId: "box-1" });
  const [image] = await resolveChatImages(api, caller, [{ path: "/tmp/shot.png" }]);
  assert.deepEqual({ name: image!.name, width: image!.width, path: image!.path }, { name: "shot.png", width: 5, path: undefined });
  await assert.rejects(resolveChatImages(api, caller, [{ path: "/tmp/notes.png" }]), refusal("INVALID_ARGUMENT", /not a PNG/));
  await assert.rejects(resolveChatImages(api, caller, [{ path: "/tmp/gone.png" }]), refusal("INVALID_ARGUMENT", /file not found/));
  assert.deepEqual(asked.map(([, max]) => max), [MAX_TURN_IMAGE_BYTES, MAX_TURN_IMAGE_BYTES, MAX_TURN_IMAGE_BYTES]);
});

test("an input names exactly one image source, and a ref is recent:N or attachment:<id>", async (t) => {
  const s = await layout();
  t.after(() => rm(s.root, { recursive: true, force: true }));
  for (const input of [{}, { path: "a.png", ref: "recent:1" }, { ref: "/tmp/a.png" }] as ChatImageInput[]) {
    await assert.rejects(resolveChatImages(s.api, chatCaller(), [input]), refusal("INVALID_ARGUMENT", /^images\[0\]: /), JSON.stringify(input));
  }
});
