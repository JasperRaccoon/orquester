/**
 * `generate_image` (GPT Image design 2026-11-10 §6) through the catalog executor and the real chat-images
 * module: references resolved in the calling chat and sent as bytes, the made image stored in that chat and
 * answered as the image itself plus its image row's reference; a refused reference sends nothing upstream.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { GptImageToolInput, GptImageToolResult } from "../../gpt-image/tool-port.ts";
import type { ThreadCaller } from "../catalog/contract.ts";
import type { DaemonOutcome } from "../daemon-api.ts";
import { executeToolCall } from "../executor.ts";
import { FakeDaemonApi } from "../testing.ts";

const THREAD = "thread-1";

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const caller: ThreadCaller = {
  kind: "thread", threadId: THREAD, title: "Icons", projectPath: "", workspace: "", cwd: "/w/ws/p", agentId: "claude", callId: "call-1",
  runtimeMode: "approval-required", planning: false, workflowOwned: false, exchange: null
};

const call = (api: FakeDaemonApi, args: unknown): Promise<CallToolResult> =>
  executeToolCall({ approvals: null }, { name: "generate_image", arguments: args }, { caller, api, signal: new AbortController().signal });

async function setup(t: { after(fn: () => Promise<void>): void }, made: GptImageToolResult) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "generate-image-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ws = join(root, "workspaces");
  const attachments = join(root, "threads", THREAD, "attachments");
  await mkdir(join(ws, "acme", "app"), { recursive: true });
  await mkdir(attachments, { recursive: true });
  const pasted = join(attachments, "thread-1-icon.png");
  await writeFile(pasted, png(64, 64));
  const api = new FakeDaemonApi();
  api.fsRoot = ws;
  api.workspacesDir = ws;
  const sent: GptImageToolInput[] = [];
  Object.assign(api, {
    chatImageRoots: () => ({ attachmentsDir: attachments, tempDirs: [] }),
    chatAttachmentPath: async (_threadId: string, id: string) => (id === "thread-1-icon-png" ? pasted : null),
    generateImage: async (input: GptImageToolInput): Promise<DaemonOutcome<GptImageToolResult>> => {
      sent.push(input);
      return { ok: true, value: made };
    }
  });
  return { api, ws, sent };
}

describe("generate_image", () => {
  const made: GptImageToolResult = {
    bytes: png(1024, 1024),
    mimeType: "image/png",
    name: "liquid-glass-icon.png",
    width: 1024,
    height: 1024,
    transparent: true,
    account: "Work Plus"
  };

  it("edits the chat's image: sends its bytes, stores the result in the calling chat, answers the image then its row", async (t) => {
    const s = await setup(t, made);
    const result = await call(s.api, { prompt: "Turn this icon into a liquid glass style", images: ["attachment:thread-1-icon-png"], transparent: true });
    assert.equal(result.isError, undefined, JSON.stringify(result));

    assert.equal(s.sent.length, 1);
    assert.deepEqual(s.sent[0]!.images, [{ bytes: png(64, 64), mimeType: "image/png" }]);
    assert.equal(s.sent[0]!.transparent, true);
    assert.deepEqual(s.api.uploads.map((upload) => [upload.sessionId, upload.meta.name]), [[THREAD, "liquid-glass-icon.png"]]);

    assert.equal(result.content[0]!.type, "image", "the model sees the image first");
    const body = result.structuredContent as Record<string, unknown>;
    const attachmentId = `${THREAD}-att-1`;
    assert.deepEqual(body.imageRef, {
      images: [{ attachmentId, mimeType: "image/png", width: 1024, height: 1024, caption: "Turn this icon into a liquid glass style" }]
    });
    assert.equal(body.markdown, `![Turn this icon into a liquid glass style](attachment:${attachmentId})`);
    assert.equal(body.account, "Work Plus");
  });

  it("sends nothing upstream when a reference is refused", async (t) => {
    const s = await setup(t, made);
    await writeFile(join(s.ws, "acme", "app", "notes.png"), "not an image");
    const result = await call(s.api, { prompt: "restyle", images: [join(s.ws, "acme", "app", "notes.png")] });
    assert.equal(result.isError, true);
    assert.match((result.structuredContent as { message: string }).message, /^images\[0\]: not a PNG, JPEG, WebP or GIF image/);
    assert.equal(s.sent.length, 0);
    assert.equal(s.api.uploads.length, 0);
  });
});
