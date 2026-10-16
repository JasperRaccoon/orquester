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
 *
 * Beside a LIVE parent (its own app-server running a turn): safe, because the
 * fork only READS the source's append-only rollout and writes a new one — the
 * parent's process and file are never written to — and `lastTurnId` names a
 * settled turn (the host refuses an unsettled one), so every line the fork
 * needs is complete; a torn trailing line the parent is still writing lies
 * past it and is skipped (verified: a source rollout ending in half a line
 * forks the same). `deferGoalContinuation` keeps a goal the parent is
 * continuing from starting a turn inside this throwaway process. Should the
 * fork fail anyway, the host falls back to the transcript handoff.
 *
 * No MCP server runs in it (§12.1): no turn ever does, so every server the thread's effective
 * config defines (`config/read` with the cwd) is switched off in the fork's own `config`. Probed on
 * 0.159.0 (one minimal turn in a scratch home): `thread/fork` takes `config`, the server is
 * `disabled` in that process, and the override is NOT persisted — the child's own session, resumed
 * later, loads its servers (and its denials) as any resume does. A config that cannot be read
 * leaves the fork as it was (logged).
 */

import type { AdapterLogger } from "../../adapter.ts";
import { AGENT_HOST_DEADLINES, withDeadline } from "../../support/deadline.ts";
import { describeExit, spawnProviderChild } from "../../support/spawn.ts";
import { isUsableConversationId } from "../../orchestration/resume.ts";
import { CodexPeer } from "./protocol.ts";
import { codexDenyConfig } from "./session-tools.ts";

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
    let config: ReturnType<typeof codexDenyConfig> = {};
    try {
      const read = await withDeadline(() => peer.request("config/read", { cwd: input.cwd }), {
        label: "codex fork config/read",
        timeoutMs: AGENT_HOST_DEADLINES.sessionOpenMs
      });
      const servers = (read.config as { mcp_servers?: unknown } | null | undefined)?.mcp_servers;
      const defined = servers !== null && typeof servers === "object" ? Object.keys(servers) : [];
      config = codexDenyConfig(defined, "", new Set(defined));
    } catch (error) {
      input.logger.warn("codex: could not read the MCP servers for a fork; they may start in its short-lived process", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    const forked = await withDeadline(
      () =>
        peer.request("thread/fork", {
          threadId: input.sourceCodexThreadId,
          lastTurnId: input.lastTurnId,
          cwd: input.cwd,
          // Metadata only: the child replays its history through
          // `thread/turns/list` like any resumed thread (observation 17).
          excludeTurns: true,
          // A goal is carried into the fork without its automatic
          // continuation: no turn may start in this short-lived process; the
          // child's own next turn owns the goal.
          deferGoalContinuation: true,
          ...(Object.keys(config).length > 0 ? { config } : {})
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
