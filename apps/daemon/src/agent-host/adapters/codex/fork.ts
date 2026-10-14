/**
 * Codex adapter — forking a conversation into ANOTHER thread (thread lineage,
 * spec 2026-10-14 §6).
 *
 * Native: app-server `thread/fork {threadId, lastTurnId}` (`_generated`
 * `v2/ThreadForkParams`: "Optional last turn id to fork through, inclusive …
 * The referenced turn cannot be in progress"). It reads the source's rollout
 * from disk, so it needs no live session of the source and never touches one:
 * a short-lived `codex app-server` under the source's `CODEX_HOME` asks for
 * the fork and is killed, exactly as a probe is (`runProbe`).
 *
 * Verified against codex-cli 0.159.0 (task-4 report): the forked rollout is on
 * disk when that process exits, a NEW process resumes it by id, and the fork
 * keeps the source's turn ids through `lastTurnId`, inclusive.
 */

import type { AdapterLogger } from "../../adapter.ts";
import { AGENT_HOST_DEADLINES, withDeadline } from "../../support/deadline.ts";
import { describeExit, spawnProviderChild } from "../../support/spawn.ts";
import { isUsableConversationId } from "../../orchestration/resume.ts";
import { CodexPeer } from "./protocol.ts";

export const CODEX_FORK_NO_THREAD =
  "Codex has no saved conversation for this thread yet, so there is nothing to fork.";

/** The Codex thread a source cursor names, or null for a cursor that does not read (§4.1). */
export function codexThreadIdOf(cursor: unknown): string | null {
  if (cursor === null || typeof cursor !== "object") return null;
  const threadId = (cursor as { threadId?: unknown }).threadId;
  return isUsableConversationId(threadId) ? threadId : null;
}

export interface ForkCodexThreadInput {
  bin: string;
  /** The complete child env — the SOURCE's `CODEX_HOME` included. */
  env: Record<string, string>;
  cwd: string;
  /** The source's Codex thread id. */
  sourceCodexThreadId: string;
  /** The last turn the fork keeps, inclusive. */
  lastTurnId: string;
  logger: AdapterLogger;
  /** Overridden in tests. */
  spawn?: typeof spawnProviderChild;
}

/** Fork the source thread through `lastTurnId` and answer the new Codex thread id. */
export async function forkCodexThread(input: ForkCodexThreadInput): Promise<string> {
  const spawn = input.spawn ?? spawnProviderChild;
  const child = spawn({ command: input.bin, args: ["app-server"], env: input.env, cwd: input.cwd });
  const peer = new CodexPeer({
    stdin: child.stdin,
    stdout: child.stdout,
    handlers: {
      onRequest: () => Promise.reject(new Error("a fork answers no server requests")),
      onNotification: () => {},
      onUnknownFrame: () => {},
      onMalformedLine: () => {}
    }
  });
  // A fork's noise is not a session's problem, as for a probe.
  child.stderr.resume();
  void child.exited.then((reason) => {
    peer.close(`fork child ${describeExit(reason)}`);
  });
  try {
    await withDeadline(
      () =>
        peer.request("initialize", {
          clientInfo: { name: "orquester", title: "Orquester", version: "1" },
          capabilities: { experimentalApi: true, requestAttestation: false }
        }),
      { label: "codex fork initialize", timeoutMs: AGENT_HOST_DEADLINES.handshakeMs }
    );
    peer.notify("initialized");
    const forked = await withDeadline(
      () =>
        peer.request("thread/fork", {
          threadId: input.sourceCodexThreadId,
          lastTurnId: input.lastTurnId,
          cwd: input.cwd,
          // Metadata only: the child replays its history through
          // `thread/turns/list` like any resumed thread (observation 17).
          excludeTurns: true
        }),
      { label: "codex thread/fork", timeoutMs: AGENT_HOST_DEADLINES.sessionOpenMs }
    );
    const id = forked.thread.id;
    if (!isUsableConversationId(id)) {
      throw new Error("Codex answered the fork without a usable thread id.");
    }
    input.logger.info("codex: forked a conversation", {
      from: input.sourceCodexThreadId,
      to: id,
      lastTurnId: input.lastTurnId
    });
    return id;
  } finally {
    peer.close("fork finished");
    await child.kill();
  }
}
