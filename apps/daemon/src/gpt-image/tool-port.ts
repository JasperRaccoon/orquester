/**
 * What the `generate_image` tool reaches through `DaemonApi` (design
 * `docs/superpowers/specs/2026-11-10-gpt-image-plugin-design.md` §6): the GPT Image service's one
 * agent operation. Types and one adapter: the tool module (`mcp/tools/images.ts`) imports this
 * file's types alone.
 */

import type { CallerPrincipal, ChatImageMimeType } from "@orquester/api/agent-chat";

import { isGptImageError } from "./errors.ts";

/** One call's options: who acts (`withPrincipal` forces the caller's) and its abort. */
export interface GptImageCallOptions {
  principal?: CallerPrincipal;
  signal?: AbortSignal;
}

export interface GptImageToolInput {
  prompt: string;
  /** 0–5 resolved reference images (already checked by the shared chat-images module). */
  images: readonly { bytes: Buffer; mimeType: ChatImageMimeType }[];
  transparent: boolean;
  /** A project-relative file, or a folder ending in `/`. */
  saveAs?: string;
  /** The caller's project root ("" with none) — from the daemon-derived caller, never an argument. */
  projectPath: string;
  /** The caller's CLI runs in a box: no project file. */
  inBox: boolean;
}

export interface GptImageToolResult {
  bytes: Buffer;
  mimeType: ChatImageMimeType;
  /** A file name for the attachment: the prompt slug and the image's extension (`dog-in-snow.png`). */
  name: string;
  width?: number;
  height?: number;
  /** The image has a transparent background. */
  transparent: boolean;
  revisedPrompt?: string;
  /** The label of the account that made it (never its id). */
  account: string;
  /** The project file it was written to (as the project spells it), and the project-relative path. */
  path?: string;
  relativePath?: string;
  /** Why it was not written into the project although asked (no project, a box chat, a refused path). */
  note?: string;
}

export interface GptImageToolPort {
  /** Throws `GptImageError`s. */
  generate(input: GptImageToolInput, signal: AbortSignal): Promise<GptImageToolResult>;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

const UNWIRED: Outcome<never> = { ok: false, code: "GPT_IMAGE_DISABLED", message: "GPT Image is not available here." };

/**
 * Run the operation for the calling agent's chat: refuses callers that are not an agent chat, and
 * turns a thrown `GptImageError` into an outcome. Anything else is logged and answered `INTERNAL`.
 */
export async function runGptImageTool(port: GptImageToolPort | null, input: GptImageToolInput, opts: GptImageCallOptions | undefined): Promise<Outcome<GptImageToolResult>> {
  if (!port) return UNWIRED;
  if (opts?.principal?.kind !== "agent") return { ok: false, code: "PERMISSION_DENIED", message: "generate_image is for agent chats only." };
  try {
    return { ok: true, value: await port.generate(input, opts.signal ?? new AbortController().signal) };
  } catch (error) {
    if (isGptImageError(error)) return { ok: false, code: error.code, message: error.message };
    console.error("[gpt-image] generate_image failed", error);
    return { ok: false, code: "INTERNAL", message: "The image could not be generated." };
  }
}
