/**
 * Per-target session tooling (Ephemeral AI VMs spec §10): where plugin tooling
 * lives inside a box, and how a session's env takes a plugin's contribution
 * with the TARGET's rules, not the daemon's. A box may run another OS than the
 * daemon (a Windows box under a Linux daemon), so nothing here uses
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

/** What one plugin adds to a session's env on one target; paths in the target's syntax. */
export interface ToolingEnvContribution {
  /** Prepended to PATH, in order. */
  pathPrepend: readonly string[];
  /** Set as they are (they win over the session's own value). */
  env: Readonly<Record<string, string>>;
  /** Files appended to NODE_OPTIONS as `--require "<file>"`. */
  nodeRequire: readonly string[];
}

export const EMPTY_TOOLING_CONTRIBUTION: ToolingEnvContribution = Object.freeze({
  pathPrepend: Object.freeze([]) as readonly string[],
  env: Object.freeze({}),
  nodeRequire: Object.freeze([]) as readonly string[]
});

export function toolingPathSeparator(os: ToolingOs): "\\" | "/" {
  return os === "win32" ? "\\" : "/";
}

/** The PATH list delimiter on `os`. */
export function toolingPathDelimiter(os: ToolingOs): ";" | ":" {
  return os === "win32" ? ";" : ":";
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
 * The key `name` is stored under in `env` on `os`: Windows env names are
 * case-insensitive (`Path` is the usual spelling of PATH there), so the first
 * existing spelling wins; `fallback` (default `name`) when none exists.
 */
export function toolingEnvKey(env: Readonly<Record<string, string | undefined>>, name: string, os: ToolingOs, fallback = name): string {
  if (os !== "win32") return name;
  const upper = name.toUpperCase();
  return Object.keys(env).find((key) => key.toUpperCase() === upper) ?? fallback;
}

/**
 * `env` with every contribution applied for a session on `os`; `env` itself
 * is not changed. Pass the whole env the session launches with: a PATH to
 * prepend to must be in it.
 *
 * - **env**: each contribution's variables are set (Windows: under the
 *   spelling `env` already uses).
 * - **NODE_OPTIONS**: each `nodeRequire` file is appended as
 *   `--require "<file>"` ({@link appendNodeRequireOption}'s JSON-style quoting).
 *   Node splits NODE_OPTIONS on spaces outside double quotes and, inside
 *   them, reads a backslash as escaping the next character — so a Windows
 *   path's backslashes are doubled, and a path with spaces stays one argument.
 * - **PATH**: the `pathPrepend` entries go first, joined with `os`'s
 *   delimiter. On Windows every spelling of PATH in `env` (`Path`, `PATH`, …)
 *   is merged into one key — the first one present — since a child given two
 *   spellings sees only one of them; this happens with nothing to prepend too.
 *
 * Throws when a contribution prepends to PATH and `env` has none: a PATH of
 * only the plugin's dirs would hide every other program from the session.
 */
export function applyToolingContributions(
  env: Readonly<Record<string, string>>,
  contributions: readonly ToolingEnvContribution[],
  os: ToolingOs
): Record<string, string> {
  const next: Record<string, string> = { ...env };
  for (const contribution of contributions) {
    for (const [name, value] of Object.entries(contribution.env)) {
      next[toolingEnvKey(next, name, os)] = value;
    }
  }
  const requires = contributions.flatMap((contribution) => contribution.nodeRequire);
  if (requires.length > 0) {
    const key = toolingEnvKey(next, "NODE_OPTIONS", os);
    let value = next[key];
    for (const file of requires) value = appendNodeRequireOption(value, file);
    if (value !== undefined) next[key] = value;
  }
  const prepend = contributions.flatMap((contribution) => contribution.pathPrepend);
  const keys = os === "win32" ? Object.keys(next).filter((key) => key.toUpperCase() === "PATH") : "PATH" in next ? ["PATH"] : [];
  // Windows: two spellings of PATH are merged even with nothing to prepend.
  if (prepend.length > 0 || keys.length > 1) {
    const delimiter = toolingPathDelimiter(os);
    const existing = keys
      .map((key) => next[key] ?? "")
      .flatMap((value) => value.split(delimiter))
      .filter((entry) => entry.length > 0);
    if (keys.length === 0) {
      throw new Error("The session env has no PATH for the tooling to prepend to");
    }
    for (const key of keys) delete next[key];
    const seen = new Set<string>();
    const entries = [...prepend, ...existing].filter((entry) => {
      // Windows paths compare case-insensitively.
      const id = os === "win32" ? entry.toLowerCase() : entry;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    next[keys[0] ?? "PATH"] = entries.join(delimiter);
  }
  return next;
}

/**
 * Append `--require "<preloadPath>"` to an existing NODE_OPTIONS value, keeping
 * whatever the user already set. Idempotent: a value that already requires the
 * preload is returned unchanged. The path is quoted JSON-style, which is what
 * Node's NODE_OPTIONS parser reads (see {@link applyToolingContributions}).
 */
export function appendNodeRequireOption(existing: string | undefined, preloadPath: string): string {
  const option = `--require ${JSON.stringify(preloadPath)}`;
  const current = (existing ?? "").trim();
  if (current.includes(option)) return current;
  return current.length > 0 ? `${current} ${option}` : option;
}
