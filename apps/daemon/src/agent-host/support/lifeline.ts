/**
 * Agent host — the lifeline that stops a provider CLI when the host dies.
 *
 * After an unexpected host death (OOM kill, crash) the next host resumes every
 * turn that still reads running (README "Boot order" step 2). A CLI the dead
 * host started must not keep working beside the resumed one: a detached
 * `opencode serve`, Codex or Grok has no reason to notice its parent went, and
 * Claude finishes its turn after its pipes close.
 *
 * So every local provider CLI is started through a tiny `/bin/sh` wrapper, in
 * a process group of its own (`detached: true`), with one extra pipe — fd 3 —
 * whose other end only the host holds. A watcher in the group blocks reading
 * it:
 * - the host dies → the kernel closes its end → `read` meets a bare EOF and
 *   fails → `kill -TERM 0` (the CLI's group, never the host's), then
 *   `kill -KILL 0` after {@link LIFELINE_KILL_GRACE_S};
 * - the CLI ends while the host lives ({@link releaseLifeline}) → the host
 *   writes one newline and closes → `read` succeeds → the watcher exits and
 *   signals nothing, so a graceful end is never killed twice.
 *
 * The CLI itself never holds fd 3 (`3<&-`), so nothing it starts can keep the
 * lifeline open. A deploy's handover never trips it: the old host stops every
 * session (`stopAll`) before it exits, and a daemon restart leaves the host
 * process — and every lifeline it holds — running.
 *
 * The command and its args reach the CLI through `exec "$@"`, never through
 * the script text, so an arg with spaces, quotes or `$` is passed verbatim.
 * Credentials stay in the env, as before. POSIX only: on Windows the CLI is
 * spawned as it always was.
 */

import type { Writable } from "node:stream";

/** The grace between the watcher's SIGTERM and its SIGKILL of the CLI's group. */
export const LIFELINE_KILL_GRACE_S = 5;

/** The `argv[0]` the wrapper shows in `ps` (`$0` of the script). */
const LIFELINE_ARGV0 = "orq-lifeline";

// Adapted from T3 Code (MIT): apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts
export const LIFELINE_SCRIPT = [
  `{ trap '' TERM; if read -r _ <&3; then exit 0; fi; kill -TERM 0; sleep ${LIFELINE_KILL_GRACE_S}; kill -KILL 0; } </dev/null >/dev/null 2>&1 &`,
  // The names before `--` are what the shell itself exported and the caller's env lacks.
  'while [ "$1" != "--" ]; do unset "$1"; shift; done; shift',
  'exec "$@" 3<&-'
].join("\n");

/**
 * What `sh` exports by itself (dash: `PWD`). A child's env is exactly what the host passed
 * (`env.ts`), so the wrapper unsets each of these the caller did not set.
 */
const SHELL_EXPORTED_VARS = ["PWD", "OLDPWD", "SHLVL"] as const;

/** True where the lifeline applies: a POSIX host with `/bin/sh`. */
export const LIFELINE_SUPPORTED = process.platform !== "win32";

/**
 * `command args…` wrapped in the lifeline, or `null` where it does not apply.
 * Spawn the result with a fourth stdio pipe (`["pipe", "pipe", "pipe", "pipe"]`)
 * and `detached: true`, and call {@link releaseLifeline} on that pipe when the
 * child exits.
 */
export function lifelineLaunch(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>
): { command: string; args: string[] } | null {
  if (!LIFELINE_SUPPORTED) return null;
  const unset = SHELL_EXPORTED_VARS.filter((name) => env[name] === undefined);
  return { command: "/bin/sh", args: ["-c", LIFELINE_SCRIPT, LIFELINE_ARGV0, ...unset, "--", command, ...args] };
}

/**
 * The CLI ended while the host lives: tell its watcher to go without stopping
 * anything. Idempotent; a watcher already gone (its group killed) is fine.
 */
export function releaseLifeline(pipe: unknown): void {
  const stream = pipe as Writable | null | undefined;
  if (stream === null || stream === undefined || typeof stream.end !== "function" || stream.writableEnded) return;
  stream.on("error", () => {
    // EPIPE: the watcher already went with its group.
  });
  stream.end("\n");
}
