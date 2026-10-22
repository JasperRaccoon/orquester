import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The daemon checkout's short git commit, for `/api/info` (and so for a
 * client's connection diagnostics). The daemon runs from source through tsx, so
 * the checkout it runs from is its build. Read once; null when this is not a git
 * checkout or git is missing.
 */
let build: Promise<string | null> | null = null;

export function daemonBuild(): Promise<string | null> {
  build ??= new Promise((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--short", "HEAD"],
      { cwd: dirname(fileURLToPath(import.meta.url)), timeout: 3_000, windowsHide: true },
      (error, stdout) => {
        const sha = String(stdout ?? "").trim();
        resolve(!error && /^[0-9a-f]{4,40}$/.test(sha) ? sha : null);
      }
    );
  });
  return build;
}
