/**
 * The wait registry (unified MCP design 2026-10-15 §8.6; moved from
 * `session-tools/threads/shared.ts`, which re-exports it): who waits on whom right now, in this
 * daemon — every blocking wait of a chat on another chat (`thread_wait`, `task_wait`,
 * `thread_send` with `wait`, `send_message`/`wait_for_session`, the reply-subscription waiter).
 * A wait that would close a cycle — the target is itself waiting, directly or through others, on
 * the caller — is refused at once (`WAIT_CYCLE`) instead of both sides sitting out their
 * timeouts. Project-blind: a cycle across projects is a cycle.
 *
 * Pure (no daemon service): the agent host loads the session-tool tree that re-exports it.
 */

import { WAIT_CYCLE } from "@orquester/api/agent-chat";

import { ToolError } from "../mcp/errors.ts";

/** waiter → targets, counted (one chat may wait on one target more than once at a time). */
const activeWaits = new Map<string, Map<string, number>>();

/** Whether `from` waits on `to`, directly or through others. */
export function waitsOn(from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of activeWaits.get(current)?.keys() ?? []) stack.push(next);
  }
  return false;
}

/** The refusal of a wait that would close a cycle. */
export function waitCycleError(target: string): ToolError {
  return new ToolError(
    WAIT_CYCLE,
    `Thread "${target}" is itself waiting on this thread, so waiting on it would only run out the clock. Answer it (finish your turn), or read it with thread_read.`
  );
}

/**
 * Register `waiter` as waiting on `target` for the life of `run` — after refusing a wait that
 * would close a cycle. The check and the registration happen in one synchronous step.
 */
export async function asWaiter<T>(waiter: string, target: string, run: () => Promise<T>): Promise<T> {
  const release = registerWait(waiter, target);
  try {
    return await run();
  } finally {
    release();
  }
}

/**
 * The synchronous half of {@link asWaiter}: refuse a cycle (throws `WAIT_CYCLE`) or register the
 * wait, and return its release (idempotent).
 */
export function registerWait(waiter: string, target: string): () => void {
  if (waitsOn(target, waiter)) throw waitCycleError(target);
  const targets = activeWaits.get(waiter) ?? new Map<string, number>();
  activeWaits.set(waiter, targets);
  targets.set(target, (targets.get(target) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (targets.get(target) ?? 1) - 1;
    if (left > 0) targets.set(target, left);
    else targets.delete(target);
    if (targets.size === 0 && activeWaits.get(waiter) === targets) activeWaits.delete(waiter);
  };
}
