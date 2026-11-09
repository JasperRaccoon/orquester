// STUB — replaced by wt/images-daemon at merge
/**
 * Chat images for session tools (design `docs/superpowers/specs/2026-11-10-gpt-image-plugin-design.md`
 * §6.1, §9.3): resolving the images an agent names, and storing an image as a thread attachment.
 * This file only carries the signatures `generate_image` builds against; the real module is written
 * on wt/images-daemon.
 */

import type { ChatImageMimeType } from "@orquester/api/agent-chat";

import type { ToolCaller } from "./catalog/contract.ts";
import type { DaemonApi } from "./daemon-api.ts";

export interface ChatImageInput {
  path?: string;
  ref?: string;
}

export interface ResolvedChatImage {
  bytes: Buffer;
  mimeType: ChatImageMimeType;
  name: string;
  width?: number;
  height?: number;
}

const NOT_HERE = "chat-images: implemented on wt/images-daemon";

/** Throws ToolError `${label}[i]: …` for an entry that cannot be used. */
export function resolveChatImages(_api: DaemonApi, _caller: ToolCaller, _inputs: readonly ChatImageInput[], _label?: string): Promise<ResolvedChatImage[]> {
  return Promise.reject(new Error(NOT_HERE));
}

/** The image kind and size by magic bytes, or null when the bytes are no PNG, JPEG, WebP or GIF. */
export function sniffImage(bytes: Uint8Array): { mimeType: ChatImageMimeType; width?: number; height?: number } | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
    return { mimeType: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 10 && b.toString("latin1", 0, 6).match(/^GIF8[79]a$/)) {
    return { mimeType: "image/gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  if (b.length >= 16 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return { mimeType: "image/webp" };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mimeType: "image/jpeg" };
  return null;
}

export function storeChatImage(_api: DaemonApi, _caller: ToolCaller, _image: { bytes: Buffer; mimeType: ChatImageMimeType; name: string }): Promise<{ attachmentId: string }> {
  return Promise.reject(new Error(NOT_HERE));
}
