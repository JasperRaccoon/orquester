/**
 * "Load full output" in the embed: the app's own read (`readFullOutput`,
 * `lib/agent-chat/full-output.ts`), with the two reads `AgentChatView`'s
 * viewer makes served by the host's loaders — the item through `item`
 * (`GET …/items/:itemId`, the transport's `readItem`), and the call's
 * streamed output through `itemOutput`, window by window, as the transport
 * reads `GET …/items/:itemId/output` (`readItemOutput`). `null` from
 * `itemOutput` is that route's 404: as in the app, the item answers instead.
 *
 * The viewer is offered only with both loaders (`EmbedChat`): which of the two
 * reads a row ends up needing is known only once the first has answered.
 */

import {
  isThreadItemOutputWindow,
  THREAD_ITEM_OUTPUT_MAX_BYTES,
  THREAD_ITEM_OUTPUT_WINDOW_MAX_BYTES,
  type ThreadItemOutputResponse,
  type ThreadItemOutputWindowResponse,
  type ThreadItemResponse
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

/** The two loaders the viewer reads through. */
export type FullOutputLoaders = Required<Pick<EmbedLoaders, "item" | "itemOutput">>;

/** What the viewer shows once a read settled. */
export type FullOutputResult =
  | { kind: "output"; title: string; text: string; notes: readonly string[] }
  | { kind: "error"; title: string; error: string };

/** `GET …/items/:itemId`'s answer: an item of a kind the viewer can show. */
const isItemResponse = (body: unknown): body is ThreadItemResponse => {
  const item = typeof body === "object" && body !== null ? (body as Record<string, unknown>).item : undefined;
  if (typeof item !== "object" || item === null) return false;
  const kind = (item as Record<string, unknown>).kind;
  return kind === "message" || kind === "activity";
};

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

/**
 * The call's whole streamed output, joined from the loader's windows, or
 * `null` where the loader says the route has none (its 404).
 */
async function readStreamedOutput(
  loader: ItemOutputLoader,
  sessionId: string,
  itemId: string,
  signal: AbortSignal
): Promise<ThreadItemOutputResponse | null> {
  const texts: string[] = [];
  let offset = 0;
  let call: string | null = null;
  for (;;) {
    const body: unknown = await loader({ sessionId, itemId, offset, maxBytes: THREAD_ITEM_OUTPUT_WINDOW_MAX_BYTES }, signal);
    if (body === null && offset === 0) return null;
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

/** Read one row's whole output for the viewer, as the app's viewer does; never rejects. */
export async function loadFullOutput(
  loaders: FullOutputLoaders,
  sessionId: string,
  itemId: string,
  source: FullOutputSource | undefined,
  signal: AbortSignal
): Promise<FullOutputResult> {
  const copy = fullOutputViewerCopy(source);
  try {
    const output = await readFullOutput(
      {
        item: async (id) => {
          const body: unknown = await loaders.item({ sessionId, itemId: id }, signal);
          if (!isItemResponse(body)) throw new Error("Expected a thread item.");
          return body;
        },
        streamedOutput: (id) => readStreamedOutput(loaders.itemOutput, sessionId, id, signal)
      },
      itemId,
      source
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
