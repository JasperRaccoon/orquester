/**
 * Claude adapter — the long-lived streaming input (spec §4.5).
 *
 * One unbounded queue per session becomes the SDK prompt. `sendTurn` only
 * offers onto it and `query()` is never re-made per turn, which is what makes
 * steering (§4.1) an injection into the running loop rather than a second
 * turn.
 *
 * Closing the queue ends the iterable, which is how a session's input is shut
 * without touching the query — **never** by breaking out of the message
 * `for await`, which would close the query and kill the CLI
 * (fixtures/claude README, "Breaking out of `for await (… of query)`").
 */

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { createDeferred, type Deferred } from "./async-queue.ts";

export class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiter: Deferred<void> | undefined;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) {
      return;
    }
    this.items.push(message);
    this.waiter?.resolve();
    this.waiter = undefined;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.waiter?.resolve();
    this.waiter = undefined;
  }

  get pending(): number {
    return this.items.length;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) {
        return;
      }
      const waiter = createDeferred<void>();
      this.waiter = waiter;
      await waiter.promise;
    }
  }
}
