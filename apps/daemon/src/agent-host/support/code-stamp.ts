/**
 * The identity of the code the agent host RUNS, read from the files on disk.
 *
 * Why it exists: the agent host survives a deploy on purpose (§3.1 — it lives
 * in a tmux service session so in-flight turns outlive the daemon restart),
 * and the supervisor only replaced it when {@link AGENT_HOST_PROTOCOL_VERSION}
 * changed. A code-only deploy therefore left the old host running old code
 * for as long as it lived — every fix that touches `agent-host/**` was invisible
 * until someone stopped the host by hand. The host reports the stamp it
 * started from in `/health`; the daemon computes its own at boot from the same
 * checkout; a difference is the §3.1 case-3 drain-restart.
 *
 * The stamp used to be the checkout's git HEAD, so EVERY deploy drain-restarted
 * the host — a UI-only change too, which still waits out every running turn
 * and interrupts nothing only because the drain is patient. It now names only
 * what the host loads: the STATIC import graph from `agent-host/main.ts`
 * (relative imports, and the workspace packages' `exports` such as
 * `@orquester/api/agent-chat` → `packages/api/src/agent-chat/index.ts`). The
 * graph is complete because nothing under `agent-host/` may use a dynamic
 * `import()` (§8); a literal `import("…")` met outside it is followed all the
 * same. The stamp hashes every reached file's path and bytes, `pnpm-lock.yaml`
 * (the third-party code the host loads, by version) and the Node major (the
 * daemon spawns the host with its own binary).
 *
 * Over-inclusion only costs a restart: an import spelled inside a comment or a
 * string is followed when it resolves to a file. A specifier that resolves to
 * nothing is skipped — it is not code the host can load. Anything unreadable
 * — the entry missing, a read that throws — yields `null`, and a `null` on
 * either side never triggers a restart (the protocol version still does).
 *
 * It runs once per boot on each side; within one process every file's digest
 * and specifiers are cached by `mtime`/size, so a second computation reads
 * only the files that changed.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The host's entry, resolved from this module — the checkout this process runs. */
const AGENT_HOST_ENTRY = fileURLToPath(new URL("../main.ts", import.meta.url));

/** How far up from the entry the workspace root (`pnpm-workspace.yaml`) is looked for. */
const MAX_ROOT_HOPS = 12;

interface CachedFile {
  mtimeMs: number;
  size: number;
  digest: string;
  specifiers: readonly string[];
}

/** Per-process cache: a file is read again only when its mtime or size moved. */
const fileCache = new Map<string, CachedFile>();

/**
 * `import … from "x"`, `export … from "x"` (types included: a type-only
 * change costs a restart, never a missed one). No quote or semicolon between
 * the keyword and `from`, so a match never spans two statements or strings.
 */
const FROM_SPECIFIER = /\b(?:import|export)\b[^;'"`]*?\bfrom\s*(["'])([^"'\n]+)\1/g;
/** `import "x"` (side effect) and a literal `import("x")`. */
const BARE_SPECIFIER = /\bimport\s*(?:\(\s*)?(["'])([^"'\n]+)\1/g;

function specifiersOf(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of [FROM_SPECIFIER, BARE_SPECIFIER]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      if (match[2] !== undefined) found.add(match[2]);
    }
  }
  return [...found];
}

/** The digest (and, for source, the specifiers) of a file, through the cache. */
function readFileEntry(path: string, parse: boolean): CachedFile {
  const info = statSync(path);
  const cached = fileCache.get(path);
  if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return cached;
  }
  const bytes = readFileSync(path);
  const entry: CachedFile = {
    mtimeMs: info.mtimeMs,
    size: info.size,
    digest: createHash("sha256").update(bytes).digest("hex"),
    specifiers: parse ? specifiersOf(bytes.toString("utf8")) : []
  };
  fileCache.set(path, entry);
  return entry;
}

function isFile(path: string): boolean {
  // No throw for a missing candidate: most candidates are missing, and an
  // exception per candidate made resolving the graph take seconds.
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/** The file a relative specifier names: as written, a `.js` spelling's `.ts`, or with an extension or index added. */
function resolveFile(base: string): string | null {
  const candidates = [base];
  const js = /\.(m|c)?js$/.exec(base);
  if (js !== null) {
    const stem = base.slice(0, -js[0].length);
    candidates.push(`${stem}.${js[1] ?? ""}ts`, `${stem}.tsx`);
  }
  candidates.push(`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx"));
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function findWorkspaceRoot(from: string): string | null {
  let cursor = dirname(from);
  for (let hop = 0; hop < MAX_ROOT_HOPS; hop += 1) {
    if (existsSync(join(cursor, "pnpm-workspace.yaml"))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
  return null;
}

interface WorkspacePackage {
  dir: string;
  exports: unknown;
  main: unknown;
}

/**
 * Every workspace package by name, from `pnpm-workspace.yaml`'s `dir/*`
 * patterns (the only shape this repository uses).
 */
function workspacePackages(root: string): Map<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>();
  const manifest = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  for (const line of manifest.split("\n")) {
    const pattern = /^\s*-\s*["']?([^"'\s]+)\/\*["']?\s*$/.exec(line);
    if (pattern === null) continue;
    const parent = join(root, pattern[1]!);
    let names: string[];
    try {
      names = readdirSync(parent);
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = join(parent, name);
      try {
        const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
        if (typeof json.name === "string") {
          packages.set(json.name, { dir, exports: json.exports, main: json.main });
        }
      } catch {
        // Not a package (no or unreadable `package.json`): nothing imports it by name.
      }
    }
  }
  return packages;
}

/** A subpath's target in a package's `exports`: a string, or a conditions object's `import`/`default`. */
function exportTarget(exportsField: unknown, subpath: string): string | null {
  if (typeof exportsField === "string") return subpath === "." ? exportsField : null;
  if (typeof exportsField !== "object" || exportsField === null) return null;
  const entry = (exportsField as Record<string, unknown>)[subpath];
  if (typeof entry === "string") return entry;
  if (typeof entry === "object" && entry !== null) {
    const conditions = entry as Record<string, unknown>;
    for (const key of ["import", "default", "node"]) {
      if (typeof conditions[key] === "string") return conditions[key] as string;
    }
  }
  return null;
}

function resolveWorkspaceImport(
  specifier: string,
  packages: Map<string, WorkspacePackage>
): string | null {
  const parts = specifier.split("/");
  const nameLength = specifier.startsWith("@") ? 2 : 1;
  const name = parts.slice(0, nameLength).join("/");
  const pkg = packages.get(name);
  if (pkg === undefined) return null;
  const rest = parts.slice(nameLength).join("/");
  const subpath = rest === "" ? "." : `./${rest}`;
  const target =
    exportTarget(pkg.exports, subpath) ??
    (subpath === "." && typeof pkg.main === "string" ? pkg.main : null) ??
    (pkg.exports === undefined ? subpath : null);
  if (target === null) return null;
  return resolveFile(resolve(pkg.dir, target));
}

export interface CodeStampInput {
  /** The host entry; this checkout's `agent-host/main.ts` by default. */
  entry?: string;
  /** The Node major the host runs under; this process's by default. */
  nodeMajor?: number;
}

/**
 * The stamp of the code reachable from `entry`, or `null` when it cannot be
 * computed. Deterministic: the same files, lockfile and Node major always give
 * the same stamp, whatever order the graph was walked in.
 */
export function computeCodeStamp(input: CodeStampInput = {}): string | null {
  try {
    return walkAndHash(input);
  } catch {
    // A file the cache resolved to was removed since: once more from the disk.
    resolvedTargets.clear();
    try {
      return walkAndHash(input);
    } catch {
      return null;
    }
  }
}

/**
 * What each file's specifiers resolved to, keyed by the file and its digest:
 * resolving costs a few `stat`s per edge, and the graph has thousands of
 * edges. A target that vanished makes its read throw, and
 * {@link computeCodeStamp} then walks again with this cleared.
 */
const resolvedTargets = new Map<string, { digest: string; targets: readonly string[] }>();

function walkAndHash(input: CodeStampInput): string | null {
  const entry = resolve(input.entry ?? AGENT_HOST_ENTRY);
  if (!isFile(entry)) return null;
  const root = findWorkspaceRoot(entry);
  if (root === null) return null;
  const packages = workspacePackages(root);
  const reached = new Map<string, string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (reached.has(file)) continue;
    const cached = readFileEntry(file, /\.(m|c)?[jt]sx?$/.test(file));
    reached.set(file, cached.digest);
    let resolved = resolvedTargets.get(file);
    if (resolved === undefined || resolved.digest !== cached.digest) {
      const targets: string[] = [];
      for (const specifier of cached.specifiers) {
        let target: string | null = null;
        if (specifier.startsWith("./") || specifier.startsWith("../")) {
          target = resolveFile(resolve(dirname(file), specifier));
        } else if (!specifier.startsWith("node:")) {
          target = resolveWorkspaceImport(specifier, packages);
        }
        if (target !== null) targets.push(target);
      }
      resolved = { digest: cached.digest, targets };
      resolvedTargets.set(file, resolved);
    }
    for (const target of resolved.targets) {
      if (!reached.has(target)) pending.push(target);
    }
  }
  const hash = createHash("sha256");
  hash.update(`node-major\0${input.nodeMajor ?? Number(process.versions.node.split(".")[0])}\0`);
  const lockfile = join(root, "pnpm-lock.yaml");
  hash.update(`pnpm-lock.yaml\0${isFile(lockfile) ? readFileEntry(lockfile, false).digest : "absent"}\0`);
  const files = [...reached].map(([path, digest]) => [relative(root, path).split(sep).join("/"), digest] as const);
  files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [path, digest] of files) {
    hash.update(`${path}\0${digest}\0`);
  }
  return hash.digest("hex");
}

/** The stamp of the agent-host code in this process's checkout (see {@link computeCodeStamp}). */
export function readCodeStamp(): string | null {
  return computeCodeStamp();
}

/**
 * True when two stamps are both known and differ. Unknown on either side is
 * never a mismatch: the protocol version remains the hard gate.
 */
export function codeStampsDiffer(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === "string" && typeof b === "string" && a !== b;
}
