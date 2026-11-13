/**
 * The embed's public types: the loaders a host sets on `el.loaders` and the
 * `detail` of every event the element fires (design
 * `docs/superpowers/specs/2026-11-13-embeddable-agent-chat-design.md` §5.4,
 * §5.5). Type-only: nothing here runs.
 */

import type {
  AnswerCommandBody,
  ApprovalCommandBody,
  DismissCommandBody,
  ThreadHistoryPage,
  ThreadItemOutputResponse,
  ThreadItemOutputWindowResponse,
  ThreadItemResponse
} from "@orquester/api/agent-chat";

/**
 * Everything beyond the frames, read through the host. Each answers what the
 * daemon's own route answers; every one is optional, and a missing one hides
 * its affordance (§5.5).
 */
export interface EmbedLoaders {
  /** An image the thread shows: `GET /api/sessions/:id/attachments/:attachmentId`. */
  attachment?: (
    request: { sessionId: string; attachmentId: string; mimeType?: string },
    signal?: AbortSignal
  ) => Promise<Blob>;
  /** A URL the sandboxed frame loads an `html_render` page from. */
  visualUrl?: (request: { sessionId: string; attachmentId: string }) => Promise<string>;
  /** "Load older turns": `GET /api/sessions/:id/history?before=&turns=&windowCut=`. */
  history?: (
    request: { sessionId: string; before?: string; turns?: number; windowCut?: string },
    signal?: AbortSignal
  ) => Promise<ThreadHistoryPage>;
  /**
   * "Load full output", with `itemOutput` (offered only with both): one item,
   * unslimmed — `GET /api/sessions/:id/items/:itemId`.
   */
  item?: (request: { sessionId: string; itemId: string }, signal?: AbortSignal) => Promise<ThreadItemResponse>;
  /**
   * "Load full output", with `item`: a tool call's streamed output —
   * `GET /api/sessions/:id/items/:itemId/output?offset=&maxBytes=`; `null`
   * where that route answers 404 (the call streamed none), and the item is
   * read instead.
   */
  itemOutput?: (
    request: { sessionId: string; itemId: string; offset?: number; maxBytes?: number },
    signal?: AbortSignal
  ) => Promise<ThreadItemOutputResponse | ThreadItemOutputWindowResponse | null>;
}

/** `orquester-command`: POST `body` unchanged to `/api/sessions/:sessionId/<command>`. */
export type EmbedCommandDetail =
  | { sessionId: string; command: "answer"; body: AnswerCommandBody }
  | { sessionId: string; command: "dismiss"; body: DismissCommandBody }
  | { sessionId: string; command: "approval"; body: ApprovalCommandBody };

export interface EmbedPendingRequest {
  requestId: string;
  kind: "question" | "approval";
}

/** `orquester-pending`: the open questions and approvals, on every change. */
export interface EmbedPendingDetail {
  sessionId: string | null;
  pending: EmbedPendingRequest[];
}

/** `orquester-resync`: reopen the stream WITHOUT `after`. */
export interface EmbedResyncDetail {
  sessionId: string | null;
}

/** `orquester-stale`: a lazy chunk of this bundle failed to load. */
export interface EmbedStaleDetail {
  build: string;
}
