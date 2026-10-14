/**
 * MCP Apps — the capture both exposing adapters share (spec 2026-10-14 §3).
 *
 * When a provider reports a completed MCP tool call whose tool names a `ui://`
 * resource, the adapter reads the resource through the provider's own MCP
 * client, stores the prepared document as a thread attachment and writes the
 * {@link McpAppReference} on the call's completed row (`data.mcpApp`).
 *
 * The read is a round trip to the user's MCP server, so the completion waits
 * for it — and so does every frame after it ({@link McpAppFrameHold}): the
 * row keeps its place in the log, ahead of the reply that follows it and of
 * the turn's end, as it would have without an app. The wait is bounded
 * ({@link MCP_APP_CAPTURE_TIMEOUT_MS}); a capture that fails or times out
 * leaves an ordinary tool row, and a session's teardown lets go at once.
 *
 * Ported in spirit from T3 Code (MIT): `CodexAdapterV2.ts` `captureMcpApp` /
 * `terminalizeMcpAppCaptures`, which hold the ITEM open instead; Orquester's
 * log is append-only, so it is the frames that wait.
 */

import {
  MCP_APP_CAPTURE_TIMEOUT_MS,
  mcpAppFileName,
  readMcpAppDocument,
  readMcpAppReference,
  type McpAppReference
} from "@orquester/api/agent-chat";

import type { AdapterContext } from "../adapter.ts";
import { withDeadline } from "../support/deadline.ts";

/**
 * Holds a session's inbound frames while one capture runs, then replays them
 * in arrival order. Every handler that turns a frame into rows offers it here
 * first; one that waits is replayed through the same handler later.
 */
export class McpAppFrameHold {
  private holding = false;
  private closed = false;
  private held: Array<() => void> = [];
  private abandon: (() => void) | null = null;

  constructor(private readonly onError: (error: unknown) => void = () => {}) {}

  /** True when the frame must wait — `replay` then runs it, in order, after the capture. */
  offer(replay: () => void): boolean {
    if (!this.holding) {
      return false;
    }
    this.held.push(replay);
    return true;
  }

  /** {@link offer} for a frame whose handler answers (a server request): resolves with its answer. */
  offerAsync<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const go = (): void => {
        run().then(resolve, reject);
      };
      if (!this.offer(go)) {
        go();
      }
    });
  }

  /** False once the session tore down: nothing may wait any more. */
  get canCapture(): boolean {
    return !this.closed && !this.holding;
  }

  /**
   * Hold every later frame while `work` runs, then hand its value to
   * `finish` — which writes the held completion — and replay what waited.
   * `work` rejecting, or the hold being {@link close}d first, finishes with
   * `undefined`: the call then completes as it would have without an app.
   * `work` gets a signal that aborts on {@link close}.
   */
  hold<T>(work: (signal: AbortSignal) => Promise<T | undefined>, finish: (value: T | undefined) => void): void {
    const controller = new AbortController();
    this.holding = true;
    let done = false;
    const settle = (value: T | undefined): void => {
      if (done) {
        return;
      }
      done = true;
      this.abandon = null;
      try {
        finish(value);
      } catch (error) {
        this.onError(error);
      }
      this.release();
    };
    this.abandon = () => {
      controller.abort(new Error("the session is closing"));
      settle(undefined);
    };
    let pending: Promise<T | undefined>;
    try {
      pending = work(controller.signal);
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (value) => settle(value),
      () => settle(undefined)
    );
  }

  /**
   * The session is tearing down: a capture in flight finishes without its
   * app, every held frame replays NOW (synchronously, before the teardown's
   * own rows) and nothing waits again.
   */
  close(): void {
    this.closed = true;
    if (this.abandon !== null) {
      this.abandon();
      return;
    }
    this.release();
  }

  private release(): void {
    this.holding = false;
    const queue = this.held;
    this.held = [];
    for (let index = 0; index < queue.length; index += 1) {
      if (this.holding) {
        // A replayed frame started a capture of its own: the rest wait for it,
        // still ahead of anything that arrives later.
        this.held = [...queue.slice(index), ...this.held];
        return;
      }
      try {
        queue[index]!();
      } catch (error) {
        this.onError(error);
      }
    }
  }
}

export interface McpAppCaptureInput {
  context: Pick<AdapterContext, "storeAttachment" | "logger">;
  threadId: string;
  server: string;
  tool: string;
  resourceUri: string;
  /** `resources/read` through the provider's MCP client: the result's `contents`. */
  read: () => Promise<unknown>;
  signal: AbortSignal;
  timeoutMs?: number;
}

/**
 * Read, prepare and store one app's document; the reference, or undefined
 * when there is no app to show (not an MCP App document, over 5 MiB, a read
 * that failed or timed out, no attachment store). Never throws.
 */
export async function captureMcpApp(input: McpAppCaptureInput): Promise<McpAppReference | undefined> {
  const store = input.context.storeAttachment;
  if (store === undefined) {
    return undefined;
  }
  const where = { threadId: input.threadId, server: input.server, resourceUri: input.resourceUri };
  let contents: unknown;
  try {
    contents = await withDeadline(input.read, {
      label: "mcp app resource read",
      timeoutMs: input.timeoutMs ?? MCP_APP_CAPTURE_TIMEOUT_MS,
      signal: input.signal
    });
  } catch (error) {
    input.context.logger.warn("agent-host: an MCP app's resource could not be read; showing a plain tool row", {
      ...where,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
  const document = readMcpAppDocument(contents, input.resourceUri);
  if (document.kind !== "document") {
    input.context.logger.warn(
      document.kind === "too-large"
        ? "agent-host: an MCP app's document is over 5 MiB; showing a plain tool row"
        : "agent-host: an MCP app's resource holds no app document; showing a plain tool row",
      where
    );
    return undefined;
  }
  if (input.signal.aborted) {
    return undefined;
  }
  let attachmentId: string;
  try {
    attachmentId = await store(input.threadId, {
      name: mcpAppFileName(input.tool),
      mimeType: "text/html",
      bytes: document.html
    });
  } catch (error) {
    input.context.logger.warn("agent-host: an MCP app's document could not be stored; showing a plain tool row", {
      ...where,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
  // Validated like any reader does: an id the store answered in another shape
  // would never be framed, so the row is better left plain. A document
  // stored for a session that closed meanwhile is unreferenced and goes with
  // the attachment sweep's grace.
  return readMcpAppReference({
    attachmentId,
    server: input.server,
    tool: input.tool,
    resourceUri: input.resourceUri,
    ...(document.csp === undefined ? {} : { csp: document.csp }),
    ...(document.permissions === undefined ? {} : { permissions: document.permissions }),
    ...(document.prefersBorder === undefined ? {} : { prefersBorder: document.prefersBorder })
  });
}
