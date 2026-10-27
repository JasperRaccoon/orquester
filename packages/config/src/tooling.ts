/**
 * Per-target tooling paths and Node preload options. A box may run another OS
 * than the daemon (a Windows box under a Linux daemon), so nothing here uses
 * `node:path` or `process.platform`: the target OS is always an argument.
 *
 * Box layout under `orq-agent`'s data dir (`BoxSysInfo.dataDir`, space-free on
 * every OS — `C:\orq\agent` on Windows):
 *
 *   tooling/<tool>/versions/<version>/   one verified, smoke-tested release of a tool
 *   tooling/<tool>/.tmp/                  upload and extract staging
 *   tooling/<pluginId>/                   the plugin's own files (preload, state file)
 *
 * The host cache of verified archives is `boxToolingArchivePath` in `index.ts`.
 */

/** The operating systems a session can target (Node's `process.platform` names). */
export type ToolingOs = "linux" | "darwin" | "win32";

export function toolingPathSeparator(os: ToolingOs): "\\" | "/" {
  return os === "win32" ? "\\" : "/";
}

/**
 * Join path segments with `os`'s separator. Separators at the joins collapse;
 * on Windows a `/` inside a segment becomes `\`. No `..` resolution: callers
 * pass absolute bases and plain names.
 */
export function toolingJoinPath(os: ToolingOs, ...segments: string[]): string {
  const separator = toolingPathSeparator(os);
  const parts = segments.filter((segment) => segment.length > 0).map((segment) => (os === "win32" ? segment.replace(/\//g, "\\") : segment));
  if (parts.length === 0) return "";
  const [first, ...rest] = parts;
  const trim = os === "win32" ? /[\\]+$/ : /\/+$/;
  const lead = os === "win32" ? /^[\\]+/ : /^\/+/;
  // A bare root ("/", "C:\") keeps its separator.
  const head = first === separator || /^[A-Za-z]:\\$/.test(first ?? "") ? (first ?? "") : (first ?? "").replace(trim, "");
  const tail = rest.map((segment) => segment.replace(lead, "").replace(trim, "")).filter((segment) => segment.length > 0);
  if (tail.length === 0) return head;
  return head.endsWith(separator) ? `${head}${tail.join(separator)}` : [head, ...tail].join(separator);
}

/** `<dataDir>/tooling`: every plugin's tooling in a box. */
export function boxToolingDir(os: ToolingOs, dataDir: string): string {
  return toolingJoinPath(os, dataDir, "tooling");
}

/** `<dataDir>/tooling/<tool>`: one tool's versions/ and .tmp/. */
export function boxToolDir(os: ToolingOs, dataDir: string, tool: string): string {
  return toolingJoinPath(os, boxToolingDir(os, dataDir), tool);
}

/** `<dataDir>/tooling/<tool>/versions/<version>`: one installed release. */
export function boxToolVersionDir(os: ToolingOs, dataDir: string, tool: string, version: string): string {
  return toolingJoinPath(os, boxToolDir(os, dataDir, tool), "versions", version);
}

/** `<dataDir>/tooling/<pluginId>`: a plugin's preload and state file in a box. */
export function boxToolingPluginDir(os: ToolingOs, dataDir: string, pluginId: string): string {
  return toolingJoinPath(os, boxToolingDir(os, dataDir), pluginId);
}

/**
 * Append `--require "<preloadPath>"` to an existing NODE_OPTIONS value, keeping
 * whatever the user already set. Idempotent: a value that already requires the
 * preload is returned unchanged. The path is quoted JSON-style, which is what
 * Node's NODE_OPTIONS parser reads: inside quotes, each backslash escapes
 * the next character, so Windows paths need doubled backslashes.
 */
export function appendNodeRequireOption(existing: string | undefined, preloadPath: string): string {
  const option = `--require ${JSON.stringify(preloadPath)}`;
  const current = (existing ?? "").trim();
  if (current.includes(option)) return current;
  return current.length > 0 ? `${current} ${option}` : option;
}
