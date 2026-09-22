import { readFile, stat } from "node:fs/promises";
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

interface Prepared { name: string; type: string | undefined; bytes: Buffer }

async function prepare(api: DaemonApi, input: AttachmentInput, index: number): Promise<Prepared> {
  if ("path" in input) {
    let real: string;
    // A relative path is taken under the sandbox root, as read_file's is — never under the daemon's cwd.
    try { real = await assertInsideFsRoot(api.fsRoot, resolve(api.fsRoot, input.path)); } catch (error) {
      if (error instanceof FsSandboxError) throw new ToolError("PATH_NOT_ALLOWED", `attachments[${index}]: path is not allowed (outside the sandbox).`);
      throw new ToolError("INVALID_ARGUMENT", `attachments[${index}]: file not found.`);
    }
    let size: number;
    try { const st = await stat(real); if (!st.isFile()) throw new Error("not a file"); size = st.size; } catch { throw new ToolError("INVALID_ARGUMENT", `attachments[${index}]: file not found or not a regular file.`); }
    const name = basename(input.path);
    checkSize(name, undefined, size, index);
    const bytes = await readFile(real).catch(() => { throw new ToolError("INVALID_ARGUMENT", `attachments[${index}]: file could not be read.`); });
    return { name, type: guessMime(name), bytes };
  }
  const clean = input.base64.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) throw new ToolError("INVALID_ARGUMENT", `attachments[${index}]: base64 is malformed.`);
  const bytes = Buffer.from(clean, "base64");
  const type = input.mimeType?.trim().toLowerCase() || guessMime(input.name); // the host trims and lower-cases; blank = absent
  checkSize(input.name, type, bytes.length, index);
  return { name: input.name, type, bytes };
}

function checkSize(name: string, type: string | undefined, size: number, index: number): void {
  const isImage = (type !== undefined && (SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES as readonly string[]).includes(type)) || IMAGE_EXTS.has(extname(name).slice(1).toLowerCase());
  const cap = isImage ? MAX_TURN_IMAGE_BYTES : MAX_TURN_FILE_BYTES;
  if (size > cap) throw new ToolError("INVALID_ARGUMENT", `attachments[${index}] "${name}" is ${size} bytes; ${isImage ? "images" : "files"} are capped at ${cap / (1024 * 1024)} MiB.`);
}

/** Validate every attachment, then upload them in order; nothing is uploaded unless all validate (spec §8). */
export async function uploadInlineAttachments(api: DaemonApi, sessionId: string, inputs: readonly AttachmentInput[], opts?: { max?: number }): Promise<AttachmentRef[]> {
  const max = opts?.max ?? MAX_ATTACHMENTS;
  if (inputs.length > max) throw new ToolError("INVALID_ARGUMENT", `At most ${max} attachments per message.`);
  const prepared: Prepared[] = [];
  for (const [index, input] of inputs.entries()) prepared.push(await prepare(api, input, index));
  const refs: AttachmentRef[] = [];
  for (const p of prepared) {
    const res = await api.uploadAttachment(sessionId, { name: p.name, type: p.type }, Readable.from([p.bytes]));
    if (res.status >= 400) throw daemonError({ status: res.status, body: res.value }, { code: "HOST_UNAVAILABLE", message: "Attachment upload failed." });
    const ref = res.value as AttachmentRef | null;
    if (!ref || typeof ref !== "object" || typeof (ref as { id?: unknown }).id !== "string") throw new ToolError("INTERNAL", "The host did not return an attachment reference.");
    refs.push(ref);
  }
  return refs;
}
