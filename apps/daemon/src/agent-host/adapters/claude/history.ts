/**
 * Claude adapter — reading and forking native history (spec §4.5).
 *
 * `getSessionMessages` / `forkSession` read `process.env` for
 * `CLAUDE_CONFIG_DIR`, so they are run **in a child process** whenever the
 * thread's account home differs from the host's own — otherwise one thread's
 * rollback would read another account's transcripts. When the two agree, the
 * in-process helpers are used directly.
 *
 * Every wait on that child has a deadline (§3.1); an expired one kills it.
 */

import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { forkSession, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";

import { AGENT_HOST_DEADLINES, withDeadline } from "../../support/deadline.ts";
import { spawnProviderChild } from "../../support/spawn.ts";
import type { ClaudeHistoryMessage } from "./rollback.ts";

export const HISTORY_WORKER_PATH = nodePath.resolve(
  nodePath.dirname(fileURLToPath(import.meta.url)),
  "history-worker.ts"
);

/** A bounded window for one history read or fork. */
export const HISTORY_DEADLINE_MS = 30_000;

export interface ClaudeHistoryReader {
  readMessages(input: {
    sessionId: string;
    cwd?: string;
  }): Promise<ClaudeHistoryMessage[]>;
  fork(input: {
    sessionId: string;
    upToMessageId: string;
    cwd?: string;
  }): Promise<{ sessionId: string }>;
}

export interface ClaudeHistoryReaderOptions {
  /** The complete child env; carries this thread's `CLAUDE_CONFIG_DIR`. */
  env: Record<string, string>;
  /** Where a spawned worker runs. */
  cwd: string;
  /** `process.env.CLAUDE_CONFIG_DIR` at host start, to decide in-process vs child. */
  hostConfigDir: string | undefined;
  /** Overridden in tests. */
  spawn?: typeof spawnProviderChild;
  nodePath?: string;
  /** Overridden in tests, so a real child can be driven through this path. */
  workerPath?: string;
}

function collect(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      text += chunk;
    });
    stream.on("end", () => resolve(text));
    stream.on("error", () => resolve(text));
  });
}

/**
 * A worker payload that does not parse is a **named** refusal, never a raw
 * `SyntaxError`: a truncated or empty stdout is exactly what a crashed or
 * killed worker produces, and "Unexpected end of JSON input" tells the user
 * nothing about their rewind.
 */
function parseWorkerPayload(raw: string, what: string): unknown {
  if (raw.trim().length === 0) {
    throw new Error(`Could not ${what}: the history worker produced no output.`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `Could not ${what}: the history worker's output was incomplete (${raw.length} bytes).`
    );
  }
}

export function createClaudeHistoryReader(
  options: ClaudeHistoryReaderOptions
): ClaudeHistoryReader {
  const spawn = options.spawn ?? spawnProviderChild;
  const inProcess = options.env.CLAUDE_CONFIG_DIR === options.hostConfigDir;

  const runWorker = async (method: string, sessionId: string, args: object): Promise<string> => {
    const child = spawn({
      command: options.nodePath ?? process.execPath,
      args: [
        "--import",
        "tsx",
        options.workerPath ?? HISTORY_WORKER_PATH,
        method,
        sessionId,
        JSON.stringify(args)
      ],
      env: { ...options.env, ELECTRON_RUN_AS_NODE: "1" },
      cwd: options.cwd
    });
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    const reason = await withDeadline(child.exited, {
      label: `claude/history/${method}`,
      timeoutMs: HISTORY_DEADLINE_MS,
      onTimeout: () => {
        void child.kill();
      }
    });
    const out = await stdout;
    const err = await stderr;
    if (reason.kind !== "exit" || reason.code !== 0) {
      throw new Error(err.trim().length > 0 ? err.trim() : `Claude history command failed.`);
    }
    return out;
  };

  return {
    async readMessages({ sessionId, cwd }) {
      const readOptions = {
        ...(cwd !== undefined ? { dir: cwd } : {}),
        includeSystemMessages: true
      };
      if (inProcess) {
        const messages = await withDeadline(getSessionMessages(sessionId, readOptions), {
          label: "claude/history/getSessionMessages",
          timeoutMs: HISTORY_DEADLINE_MS
        });
        return messages as unknown as ClaudeHistoryMessage[];
      }
      const raw = await runWorker("getSessionMessages", sessionId, readOptions);
      const parsed = parseWorkerPayload(raw, "read the Claude conversation history");
      return Array.isArray(parsed) ? (parsed as ClaudeHistoryMessage[]) : [];
    },

    async fork({ sessionId, upToMessageId, cwd }) {
      const forkOptions = {
        ...(cwd !== undefined ? { dir: cwd } : {}),
        upToMessageId
      };
      if (inProcess) {
        const result = await withDeadline(forkSession(sessionId, forkOptions), {
          label: "claude/history/forkSession",
          timeoutMs: HISTORY_DEADLINE_MS
        });
        return { sessionId: result.sessionId };
      }
      const raw = await runWorker("forkSession", sessionId, forkOptions);
      const parsed = parseWorkerPayload(raw, "fork the Claude conversation");
      const forked =
        parsed !== null && typeof parsed === "object"
          ? (parsed as { sessionId?: unknown }).sessionId
          : undefined;
      if (typeof forked !== "string" || forked.length === 0) {
        throw new Error("Claude fork did not return a session id.");
      }
      return { sessionId: forked };
    }
  };
}

export { AGENT_HOST_DEADLINES };
