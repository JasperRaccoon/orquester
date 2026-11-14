/**
 * Claude adapter — the `stoppedByUser` mark a per-task Stop leaves on a subagent
 * (spec `2026-11-14-per-task-stop-and-live-account-switch-design.md` §2).
 *
 * The SDK's `stop_task` control (`ClaudeSession.stopTask`) always stops with source "user", and
 * the CLI then records `stoppedByUser: true` on the task — and on every subagent the stop cascades
 * to — both in its in-memory task registry and in
 * `<CLAUDE_CONFIG_DIR>/projects/<cwd slug>/<session id>/subagents/agent-<id>.meta.json`. While
 * either says so, the main agent's `SendMessage` to that agent is refused ("was stopped and won't
 * be resumed"), and no Orquester surface stops a subagent "for good". So before every CLI start
 * that resumes a session — the process is down then, so the CLI cannot race the edit — that one
 * key is removed from each meta file of the session; the in-memory copy dies with the process
 * (the host restarts the CLI at the next idle send after such a stop, `wantsSessionRestart`).
 *
 * Only the `stoppedByUser` key goes: every other field and the key order are kept, and the file
 * is rewritten atomically (a temp file renamed over it) with its mode. A file that cannot be read,
 * is not a regular file, or does not hold a JSON object is left untouched and reported. A session
 * with no transcript, or no `subagents` directory, has nothing to clear.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as nodePath from "node:path";

import { locateClaudeTranscript } from "./goal-transcript.ts";

const STOPPED_BY_USER_KEY = "stoppedByUser";
/** The key as it appears in the file: a file without these bytes is never parsed. */
const STOPPED_BY_USER_NEEDLE = `"${STOPPED_BY_USER_KEY}"`;
/** A subagent's meta file, directly in `subagents/` (a workflow's agents sit deeper). */
const META_FILE_RE = /^agent-[\w-]+\.meta\.json$/;
/** A meta file is a few hundred bytes; anything far larger is not one. */
const MAX_META_FILE_BYTES = 256 * 1024;

export interface SubagentMarkerClear {
  /** The meta files the mark was removed from (file names). */
  cleared: string[];
  /** What could not be checked or rewritten, each left as it was. */
  problems: Array<{ path: string; reason: string }>;
}

/** Remove `stoppedByUser` from every subagent meta file of `sessionId`. Never throws. */
export async function clearSubagentStopMarkers(input: {
  configDir: string;
  cwd: string;
  sessionId: string;
}): Promise<SubagentMarkerClear> {
  const result: SubagentMarkerClear = { cleared: [], problems: [] };
  let transcript: string | undefined;
  try {
    transcript = await locateClaudeTranscript(input);
  } catch (error) {
    result.problems.push({ path: nodePath.join(input.configDir, "projects"), reason: reasonOf(error) });
    return result;
  }
  if (transcript === undefined) return result;
  const dir = nodePath.join(nodePath.dirname(transcript), nodePath.basename(transcript, ".jsonl"), "subagents");
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") result.problems.push({ path: dir, reason: reasonOf(error) });
    return result;
  }
  for (const name of names.filter((entry) => META_FILE_RE.test(entry)).sort()) {
    const path = nodePath.join(dir, name);
    try {
      if (await clearOne(path)) result.cleared.push(name);
    } catch (error) {
      result.problems.push({ path, reason: reasonOf(error) });
    }
  }
  return result;
}

/** True when the mark was removed; throws (leaving the file as it was) when it cannot be. */
async function clearOne(path: string): Promise<boolean> {
  const stat = await fs.lstat(path);
  if (!stat.isFile()) throw new Error("not a regular file");
  if (stat.size > MAX_META_FILE_BYTES) throw new Error(`larger than ${MAX_META_FILE_BYTES} bytes`);
  const text = await fs.readFile(path, "utf8");
  if (!text.includes(STOPPED_BY_USER_NEEDLE)) return false;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new Error(`not valid JSON (${reasonOf(error)})`);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new Error("not a JSON object");
  if (!Object.hasOwn(doc, STOPPED_BY_USER_KEY)) return false;
  const { [STOPPED_BY_USER_KEY]: _dropped, ...kept } = doc as Record<string, unknown>;
  const mode = stat.mode & 0o7777;
  const tmp = nodePath.join(nodePath.dirname(path), `.${nodePath.basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(tmp, "wx", mode);
    try {
      await handle.writeFile(JSON.stringify(kept), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // `open`'s mode passes through the umask; the file keeps exactly the one it had.
    await fs.chmod(tmp, mode);
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  return true;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
