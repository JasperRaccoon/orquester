import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { MAX_TURN_ATTACHMENTS, MAX_TURN_FILE_BYTES, MAX_TURN_IMAGE_BYTES, SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES, type AttachmentRef } from "@orquester/api/agent-chat";
import { assertInsideFsRoot, FsSandboxError } from "@orquester/config/fs";
import type { DaemonApi } from "./daemon-api.ts";
import { ToolError, daemonError } from "./errors.ts";

export const MAX_ATTACHMENTS = MAX_TURN_ATTACHMENTS;

export const attachmentInputSchema = z.union([
  z.object({ path: z.string().min(1).describe("Path of a file inside the workspaces sandbox (absolute, or relative to the sandbox root).") }).strict(),
  z.object({
    name: z.string().min(1).describe("File name; the extension decides the type unless mimeType is given."),
    base64: z.string().min(1).describe("The file bytes, base64-encoded."),
    mimeType: z.string().optional().describe("MIME type override.")
  }).strict()
]);
export type AttachmentInput = z.infer<typeof attachmentInputSchema>;

const MIME_BY_EXT: Record<string, string> = { gif: "image/gif", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html", xml: "application/xml", js: "text/javascript", ts: "text/typescript", py: "text/x-python", log: "text/plain" };
const IMAGE_EXTS = new Set(["gif", "jpg", "jpeg", "png", "webp"]);

export function guessMime(name: string): string | undefined {
  const ext = extname(name).slice(1).toLowerCase();
  return Object.hasOwn(MIME_BY_EXT, ext) ? MIME_BY_EXT[ext] : undefined; // own keys only: "x.constructor" is no MIME type
}

/** A validated attachment: its upload meta, and its bytes as a stream made only when it is sent. */
interface Prepared { name: string; type: string | undefined; body: () => Readable; handle?: FileHandle }

async function preparePath(api: DaemonApi, path: string, index: number): Promise<Prepared> {
  let real: string;
  // A relative path is taken under the sandbox root, as read_file's is — never under the daemon's cwd. The check realpaths
  // the deepest EXISTING ancestor, so it never signals a missing file: open() below does.
  try { real = await assertInsideFsRoot(api.fsRoot, resolve(api.fsRoot, path)); } catch (error) {
    throw error instanceof FsSandboxError ? new ToolError("PATH_NOT_ALLOWED", `attachments[${index}]: path is not allowed (outside the sandbox).`) : error;
  }
  // Opened while validating: that proves it readable, and fstat sizes the very file that will be sent. O_NONBLOCK keeps
  // a FIFO from parking a libuv thread until a writer appears (fstat refuses it below); a regular file ignores the flag.
  const handle = await open(real, constants.O_RDONLY | constants.O_NONBLOCK).catch((error: { code?: unknown }) => {
    throw new ToolError("INVALID_ARGUMENT", `attachments[${index}]: ${error.code === "ENOENT" || error.code === "ENOTDIR" ? "file not found." : "file could not be read."}`);
  });
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new ToolError("INVALID_ARGUMENT", `attachments[${index}]: not a regular file.`);
    const name = basename(path);
    checkSize(name, undefined, st.size, index);
    const size = st.size;
    // Exactly the validated bytes, even if the file grew since (`end` is inclusive, so an empty file needs its own
    // stream). autoClose off: the handle is uploadInlineAttachments' to close, once the upload is over.
    return { name, type: guessMime(name), handle, body: () => (size === 0 ? Readable.from([]) : handle.createReadStream({ start: 0, end: size - 1, autoClose: false })) };
  } catch (error) {
    await handle.close().catch(() => undefined); // a failed close must not replace the refusal
    throw error;
  }
}

function prepareInline(input: { name: string; base64: string; mimeType?: string }, index: number): Prepared {
  const clean = input.base64.replace(/\s+/g, "");
  const data = clean.replace(/={1,2}$/, "");
  // Some data, only the base64 alphabet, never 4n+1 data characters, and padding only ever up to a multiple of 4.
  if (!/^[A-Za-z0-9+/]+$/.test(data) || data.length % 4 === 1 || (data.length !== clean.length && clean.length % 4 !== 0)) {
    throw new ToolError("INVALID_ARGUMENT", `attachments[${index}]: base64 is empty or malformed.`);
  }
  const bytes = Buffer.from(clean, "base64");
  const type = input.mimeType?.trim().toLowerCase() || guessMime(input.name); // the host trims and lower-cases; blank = absent
  checkSize(input.name, type, bytes.length, index);
  return { name: input.name, type, body: () => Readable.from([bytes]) };
}

function checkSize(name: string, type: string | undefined, size: number, index: number): void {
  const isImage = (type !== undefined && (SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES as readonly string[]).includes(type)) || IMAGE_EXTS.has(extname(name).slice(1).toLowerCase());
  const cap = isImage ? MAX_TURN_IMAGE_BYTES : MAX_TURN_FILE_BYTES;
  if (size > cap) throw new ToolError("INVALID_ARGUMENT", `attachments[${index}] "${name}" is ${size} bytes; ${isImage ? "images" : "files"} are capped at ${cap / (1024 * 1024)} MiB.`);
}

/** A send-phase refusal, re-worded to name the attachment it refused (code and detail unchanged), as validation does. */
function atIndex(index: number, error: ToolError): ToolError {
  return new ToolError(error.code, `attachments[${index}]: ${error.message}`, error.detail);
}

/**
 * Validate every attachment, then upload them in order; nothing is uploaded unless all validate (spec §8). A path
 * attachment is opened while validating and streamed from that handle when sent (§8.3); every handle is closed on
 * the way out, whether the call succeeds, fails validation or is refused by the host. Every refusal starts with
 * `attachments[<i>]` — a send-phase one too — so a caller batching several lists (answer_question) can point back.
 */
export async function uploadInlineAttachments(api: DaemonApi, sessionId: string, inputs: readonly AttachmentInput[], opts?: { max?: number }): Promise<AttachmentRef[]> {
  const max = opts?.max ?? MAX_ATTACHMENTS;
  if (inputs.length > max) throw new ToolError("INVALID_ARGUMENT", `At most ${max} attachments per message.`);
  const prepared: Prepared[] = [];
  try {
    for (const [index, input] of inputs.entries()) prepared.push("path" in input ? await preparePath(api, input.path, index) : prepareInline(input, index));
    const refs: AttachmentRef[] = [];
    for (const [index, p] of prepared.entries()) {
      const res = await api.uploadAttachment(sessionId, { name: p.name, type: p.type }, p.body());
      if (res.status >= 400) throw atIndex(index, daemonError({ status: res.status, body: res.value }, { code: "HOST_UNAVAILABLE", message: "Attachment upload failed." }));
      const ref = res.value as AttachmentRef | null;
      if (!ref || typeof ref !== "object" || typeof (ref as { id?: unknown }).id !== "string") throw atIndex(index, new ToolError("INTERNAL", "the host did not return an attachment reference."));
      refs.push(ref);
    }
    return refs;
  } finally {
    await Promise.allSettled(prepared.map((p) => p.handle?.close()));
  }
}
