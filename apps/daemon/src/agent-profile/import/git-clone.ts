/**
 * Agent profile imports — the default `git clone` (spec §6): argv only (no
 * shell), a shallow single-branch clone with no tags and `core.symlinks=false`,
 * the agent-CLI environment (no daemon secrets) plus git's no-prompt switches,
 * a protocol allowlist, and a deadline after which the process group is killed.
 *
 * With `core.symlinks=false` git checks a repository symlink out as a small
 * file holding the link's target. So that the scan can see — and refuse — it,
 * every path the index records as a symlink (mode 120000) is turned back into
 * a symlink after the clone. Nothing in the import code ever follows one.
 */

import { lstat, readFile, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { profileErrors } from "../errors.ts";
import { redactCliOutput, runAgentCli } from "../infra/index.ts";

/** Clones `url` (at `ref`, a branch or tag, when given) into `dest`, which must not exist yet. */
export type GitCloneFn = (
  url: string,
  ref: string | undefined,
  dest: string,
  options: { timeoutMs: number }
) => Promise<void>;

interface GitCloneOptions {
  timeoutMs: number;
  /** `GIT_ALLOW_PROTOCOL`; `https:ssh` by default. Tests widen it to `file` for a local bare repo. */
  allowProtocols?: string;
  /** The git binary; `git` on the session PATH by default. */
  bin?: string;
}

const DETAIL_MAX = 1000;

/** The `git clone` argv for `url` at `ref` into `dest`. */
function gitCloneArgs(url: string, ref: string | undefined, dest: string): string[] {
  return [
    "clone",
    "--depth",
    "1",
    ...(ref !== undefined ? ["--branch", ref] : []),
    "--no-tags",
    "--single-branch",
    "-c",
    "core.symlinks=false",
    "--",
    url,
    dest
  ];
}

function detail(text: string): string {
  const trimmed = redactCliOutput(text).trim();
  return trimmed.length > DETAIL_MAX ? `${trimmed.slice(0, DETAIL_MAX - 1)}…` : trimmed;
}

/** The default {@link GitCloneFn}. Every failure is a 400 `IMPORT_FAILED` with git's redacted stderr. */
export async function gitClone(url: string, ref: string | undefined, dest: string, options: GitCloneOptions): Promise<void> {
  const bin = options.bin ?? "git";
  const env = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GCM_INTERACTIVE: "never",
    GIT_ALLOW_PROTOCOL: options.allowProtocols ?? "https:ssh",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes"
  };
  let result;
  try {
    result = await runAgentCli({ bin, args: gitCloneArgs(url, ref, dest), timeoutMs: options.timeoutMs, env, killGraceMs: 500 });
  } catch (error) {
    throw profileErrors.importFailed(`git could not be started: ${detail((error as Error).message)}`);
  }
  if (result.timedOut) {
    throw profileErrors.importFailed(`Cloning took longer than ${Math.round(options.timeoutMs / 1000)} s and was stopped.`);
  }
  if (result.code !== 0) {
    const why = detail(result.stderr) || `exit code ${result.code ?? result.signal}`;
    throw profileErrors.importFailed(`git clone failed: ${why}`);
  }
  await restoreSymlinks(bin, dest, options.timeoutMs);
}

/** Turns every index entry of mode 120000 back into a symlink (see the module header). */
async function restoreSymlinks(bin: string, dest: string, timeoutMs: number): Promise<void> {
  const listed = await runAgentCli({ bin, args: ["-C", dest, "ls-files", "-s", "-z"], timeoutMs, killGraceMs: 500 });
  if (listed.timedOut || listed.code !== 0) {
    throw profileErrors.importFailed(`git could not list the clone: ${detail(listed.stderr)}`);
  }
  for (const record of listed.stdout.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0 || !record.startsWith("120000 ")) continue;
    const rel = record.slice(tab + 1);
    const path = join(dest, rel);
    let target: string;
    try {
      if (!(await lstat(path)).isFile()) continue;
      target = await readFile(path, "utf8");
    } catch {
      continue;
    }
    await unlink(path);
    await symlink(target.length > 0 && !target.includes("\0") ? target : "missing", path);
  }
}
