/**
 * Catalog family `images` (GPT Image design `docs/superpowers/specs/2026-11-10-gpt-image-plugin-design.md`
 * §6): `generate_image`, chat-only, advertised while the GPT Image plugin is on and a Codex account
 * can make images (`session-tools/manifest.ts`). Act tier, no card: it cannot cost money (the
 * ChatGPT plan's own limits apply).
 *
 * One call: the reference images are resolved by the shared chat-images module (paths, `recent:N`,
 * `attachment:<id>`; nothing is sent upstream when one fails), the daemon's GPT Image service
 * generates the image (and writes the project copy when asked), and the image is stored as an
 * attachment of the calling chat. The result is the image itself, then JSON with an `imageRef`
 * (kept through slimming) the chat row shows inline.
 *
 * Everything goes through `DaemonApi`: this module imports types, pure contracts and the
 * DaemonApi-only chat-images helpers.
 */

import { z } from "zod";
import {
  chatImageMarkdown,
  GENERATE_IMAGE_TOOL_NAME,
  IMAGE_CAPTION_MAX_LENGTH,
  parseChatImageSource,
  type ImageToolReference
} from "@orquester/api/agent-chat";

import { defineTool, type AnyOrquesterTool, type ScopeClaim, type ThreadCaller, type ToolCaller } from "../catalog/contract.ts";
import { resolveChatImages, storeChatImage, type ChatImageInput } from "../chat-images.ts";
import type { DaemonApi, DaemonOutcome } from "../daemon-api.ts";
import { ToolError } from "../errors.ts";
import { imageResult } from "../../session-tools/results.ts";

const DISABLED = "GPT Image is off. Ask the owner to turn it on in Settings → Plugins.";

/** Past this many bytes the image is not inlined (base64 stays under the providers' ~5 MB image cap). */
const INLINE_IMAGE_MAX_BYTES = 3_700_000;

function threadCaller(caller: ToolCaller): ThreadCaller {
  if (caller.kind !== "thread") throw new ToolError("TOOL_NOT_FOUND", `${GENERATE_IMAGE_TOOL_NAME} is a chat tool.`);
  return caller;
}

function unwrap<T>(outcome: DaemonOutcome<T>): T {
  if (!outcome.ok) throw new ToolError(outcome.code, outcome.message);
  return outcome.value;
}

/** One `images` entry as the chat-images module takes it: a chat source (`recent:N`, `attachment:<id>`) or a path. */
function imageInput(entry: string): ChatImageInput {
  const text = entry.trim();
  return parseChatImageSource(text) !== null ? { ref: text } : { path: text };
}

function caption(prompt: string): string {
  // eslint-disable-next-line no-control-regex
  const line = prompt.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  return line.length > IMAGE_CAPTION_MAX_LENGTH ? `${line.slice(0, IMAGE_CAPTION_MAX_LENGTH - 1)}…` : line;
}

const generateImage = defineTool({
  name: GENERATE_IMAGE_TOOL_NAME,
  title: "Generate an image",
  description:
    "Make a picture, icon, logo, illustration or mockup, or edit/restyle images, with GPT Image on the user's ChatGPT plan (no API key, no cost). Use this for every image request: never write a script against an image API. images (≤ 5) switch it to editing: recent:1 is the latest image in this chat (pasted or generated; recent:2 the one before), attachment:<id> one from an earlier result, or a file path. transparent: a transparent background. save_as also writes it into the project (a path, or a folder ending in /); a taken name gets -v2. The user sees the image in the chat and you get it back.",
  chatNote: "It takes seconds to a couple of minutes. The result's markdown shows the image again in a reply.",
  input: {
    prompt: z.string().min(1).max(32_000).describe("What to make, or what to change in the images."),
    images: z
      .array(z.string().min(1).max(4096))
      .max(5)
      .optional()
      .describe("Reference images to edit or restyle: recent:N, attachment:<id>, or a path."),
    transparent: z.boolean().optional().describe("A transparent background (PNG with alpha). Default false."),
    save_as: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe("Also write it into this chat's project: a project-relative file (assets/logo.png) or a folder ending in /. Never overwrites.")
  },
  audiences: ["chat"],
  toolset: "images",
  tier: "act",
  // It shows an image in the caller's own chat and may add a file to its own project.
  scope: async (_args, ctx): Promise<ScopeClaim> => ({
    projects: [],
    sessions: ctx.caller.kind === "thread" ? [ctx.caller.threadId] : [],
    self: "allow",
    reads: "content",
    writes: true,
    causesTurnIn: []
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  resultKind: "image",
  async run(args, ctx) {
    const caller = threadCaller(ctx.caller);
    const api: DaemonApi = ctx.api;
    if (typeof api.generateImage !== "function") throw new ToolError("GPT_IMAGE_DISABLED", DISABLED);
    const references = args.images ?? [];
    const resolved = references.length > 0 ? await resolveChatImages(api, caller, references.map(imageInput), "images") : [];
    const made = unwrap(
      await api.generateImage(
        {
          prompt: args.prompt,
          images: resolved.map((image) => ({ bytes: image.bytes, mimeType: image.mimeType })),
          transparent: args.transparent === true,
          ...(args.save_as !== undefined ? { saveAs: args.save_as } : {}),
          projectPath: caller.projectPath,
          inBox: caller.projectBoxId !== undefined
        },
        { signal: ctx.signal }
      )
    );
    const { attachmentId } = await storeChatImage(api, caller, { bytes: made.bytes, mimeType: made.mimeType, name: made.name });
    const text = caption(args.prompt);
    const imageRef: ImageToolReference = {
      images: [
        {
          attachmentId,
          mimeType: made.mimeType,
          ...(made.width !== undefined && made.height !== undefined ? { width: made.width, height: made.height } : {}),
          ...(text ? { caption: text } : {}),
          ...(made.path ? { path: made.path } : {})
        }
      ],
      ...(made.revisedPrompt ? { revisedPrompt: made.revisedPrompt } : {})
    };
    const inline = made.bytes.length <= INLINE_IMAGE_MAX_BYTES;
    const notes = [made.note, inline ? undefined : "The image is too large to return inline; the user sees it in the chat."].filter(Boolean);
    const value: Record<string, unknown> = {
      imageRef,
      attachmentId,
      ...(made.path ? { path: made.path, relativePath: made.relativePath } : {}),
      markdown: chatImageMarkdown(attachmentId, text || "generated image"),
      ...(made.revisedPrompt ? { revisedPrompt: made.revisedPrompt } : {}),
      ...(made.width !== undefined && made.height !== undefined ? { width: made.width, height: made.height } : {}),
      transparent: made.transparent,
      account: made.account,
      ...(notes.length > 0 ? { note: notes.join(" ") } : {})
    };
    if (!inline) return value;
    return imageResult({ data: made.bytes.toString("base64"), mimeType: made.mimeType }, value);
  }
});

export const imagesFamily: readonly AnyOrquesterTool[] = [generateImage];
