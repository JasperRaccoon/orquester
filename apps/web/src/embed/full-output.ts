/**
 * "Load full output" in the embed: the app's own read (`readFullOutput`,
 * `lib/agent-chat/full-output.ts`), with the call's streamed output read
 * through the host's `itemOutput` loader window by window, as the app's
 * transport reads `GET …/items/:itemId/output` (`readItemOutput`).
 *
 * The embed has no loader for `GET …/items/:itemId` (design §5.5), so the
 * item read is unavailable: a row is read through its call's output first,
 * and where that holds nothing the viewer says the output is unavailable,
 * as it does when any read fails.
 */

import {
  isThreadItemOutputWindow,
  THREAD_ITEM_OUTPUT_MAX_BYTES,
  THREAD_ITEM_OUTPUT_WINDOW_MAX_BYTES,
  type ThreadItemOutputResponse,
  type ThreadItemOutputWindowResponse
} from "@orquester/api/agent-chat";

import {
  fullOutputNotes,
  fullOutputText,
  fullOutputViewerCopy,
  readFullOutput,
  type FullOutputSource
} from "../../../../packages/ui/src/lib/agent-chat/full-output";

import type { EmbedLoaders } from "./types";

type ItemOutputLoader = NonNullable<EmbedLoaders["itemOutput"]>;

/** What the viewer shows once a read settled. */
export type FullOutputResult =
  | { kind: "output"; title: string; text: string; notes: readonly string[] }
  | { kind: "error"; title: string; error: string };

const isWholeOutput = (body: unknown): body is ThreadItemOutputResponse =>
  typeof body === "object" &&
  body !== null &&
  typeof (body as Record<string, unknown>).toolUseId === "string" &&
  typeof (body as Record<string, unknown>).output === "string" &&
  typeof (body as Record<string, unknown>).complete === "boolean" &&
  typeof (body as Record<string, unknown>).truncated === "boolean";

const utf8 = new TextEncoder();

/**
 * Where the window after `window` starts, `undefined` at the join's end. A
 * window that does not meet the last one end to end throws: stitching it
 * would show text the call never printed (the transport's `nextWindowOffset`).
 */
function nextWindowOffset(window: ThreadItemOutputWindowResponse, offset: number, call: string | null): number | undefined {
  const bytes = utf8.encode(window.text).length;
  const end = window.offset + bytes;
  const sane =
    window.offset === offset &&
    (call === null || window.toolUseId === call) &&
    window.totalBytes <= THREAD_ITEM_OUTPUT_MAX_BYTES &&
    bytes <= THREAD_ITEM_OUTPUT_WINDOW_MAX_BYTES &&
    end <= window.totalBytes &&
    (window.nextOffset === undefined ? end === window.totalBytes : bytes > 0 && window.nextOffset === end);
  if (!sane) throw new Error("Expected the next window of a tool call's streamed output.");
  return window.nextOffset;
}

/** The call's whole streamed output, joined from the loader's windows. */
async function readStreamedOutput(
  loader: ItemOutputLoader,
  sessionId: string,
  itemId: string,
  signal: AbortSignal
): Promise<ThreadItemOutputResponse> {
  const texts: string[] = [];
  let offset = 0;
  let call: string | null = null;
  for (;;) {
    const body: unknown = await loader({ sessionId, itemId, offset, maxBytes: THREAD_ITEM_OUTPUT_WINDOW_MAX_BYTES }, signal);
    if (!isThreadItemOutputWindow(body)) {
      if (isWholeOutput(body)) return body;
      throw new Error("Expected a tool call's streamed output.");
    }
    const next = nextWindowOffset(body, offset, call);
    call = body.toolUseId;
    texts.push(body.text);
    if (next === undefined) {
      return { toolUseId: body.toolUseId, output: texts.join(""), complete: body.complete, truncated: body.truncated };
    }
    offset = next;
  }
}

const ITEM_UNAVAILABLE = (): Promise<never> => Promise.reject(new Error("unavailable"));

/** Read one row's whole output for the viewer; never rejects. */
export async function loadFullOutput(
  loader: ItemOutputLoader,
  sessionId: string,
  itemId: string,
  source: FullOutputSource | undefined,
  signal: AbortSignal
): Promise<FullOutputResult> {
  const copy = fullOutputViewerCopy(source);
  try {
    const output = await readFullOutput(
      {
        item: ITEM_UNAVAILABLE,
        streamedOutput: (id) => readStreamedOutput(loader, sessionId, id, signal)
      },
      itemId,
      // The call's output is the one read there is: asked first for every row
      // but an agent's launch prompt, which only its item holds.
      source === "prompt" ? "prompt" : "streamed"
    );
    return {
      kind: "output",
      title: copy.title,
      text: output.kind === "item" ? fullOutputText(output.item) : output.text,
      notes: fullOutputNotes(output)
    };
  } catch {
    return { kind: "error", title: copy.title, error: copy.missing };
  }
}
