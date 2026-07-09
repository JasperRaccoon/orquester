// Hand-rolled linear-time glob matcher for the file-browser search include/exclude
// fields. Deliberately NOT backed by picomatch/minimatch or any JS `RegExp`: those
// compile user-supplied globs into a regular expression, which reintroduces the ReDoS
// surface the daemon's search path is required to avoid. Everything here is a bounded,
// iterative two-pointer match with explicit caps — no regex is ever built from input.
//
// Supported (a VS Code-like subset): `*` (any run except `/`), `?` (one char except
// `/`), `**` (any run of segments, only as a whole segment), one level of `{a,b}` brace
// alternation. No `[]` character classes. See parseGlobList for normalization rules.

/** Thrown when a glob field/term is malformed or exceeds a safety cap. */
export class GlobError extends Error {
  constructor(
    message: string,
    /** The offending term (or the raw field for field-level errors). */
    public readonly pattern: string,
  ) {
    super(message);
    this.name = "GlobError";
  }
}

interface GlobSegment {
  readonly doublestar: boolean;
  /** Code points of the segment, used for the wildcard two-pointer. Empty for `**`. */
  readonly chars: readonly string[];
  /** The plain segment string when it has no `*`/`?`, enabling a direct-equality fast path. */
  readonly literal: string | null;
}

export interface CompiledPattern {
  /** The normalized pattern string this compiled from (diagnostics only). */
  readonly source: string;
  /**
   * True when the term was root-anchored (leading `/`). `source` drops the leading slash,
   * so consumers that re-emit the pattern to another engine (e.g. ripgrep's `-g`) must
   * restore the anchor themselves — a slash-less rg glob matches the basename at any depth,
   * which would silently widen an anchored include/exclude versus the node matcher.
   */
  readonly anchored: boolean;
  readonly segments: readonly GlobSegment[];
  /**
   * The RAW field this pattern was parsed from ("include"/"exclude"), independent of
   * which bucket it landed in — a `!term` in an include field lands in the `exclude`
   * bucket but keeps `field: "include"`. Lets a downstream engine (ripgrep) attribute a
   * glob-parse failure back to the user-visible field. Undefined for lists built by
   * callers that don't parse a field (e.g. bare `compilePattern` use in tests).
   */
  readonly field?: "include" | "exclude";
}

/**
 * A parsed include/exclude field. A file passes iff:
 *   (include is empty OR it matches at least one include) AND it matches no exclude.
 * Note `include`/`exclude` here are buckets, not fields: a `!term` in an include field
 * lands in `exclude`, so parsing one field can populate both buckets.
 */
export interface CompiledGlobList {
  readonly include: readonly CompiledPattern[];
  readonly exclude: readonly CompiledPattern[];
}

const MAX_FIELD_CHARS = 1024;
const MAX_TERM_CHARS = 256;
const MAX_TERMS = 64;
const MAX_EXPANDED = 128;

/** Split a field on commas that sit at brace-depth 0 (commas inside `{…}` stay). */
function splitFieldTerms(raw: string): string[] {
  const terms: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of raw) {
    if (ch === "{") {
      depth++;
      current += ch;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
      }
      current += ch;
    } else if (ch === "," && depth === 0) {
      terms.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  terms.push(current);
  return terms;
}

/** Expand one level of `{a,b}` alternation into concrete strings. Rejects nesting. */
function expandBraces(term: string): string[] {
  let results = [""];
  let i = 0;
  while (i < term.length) {
    const ch = term[i];
    if (ch === "{") {
      let j = i + 1;
      const alts: string[] = [];
      let alt = "";
      while (j < term.length && term[j] !== "}") {
        if (term[j] === "{") {
          throw new GlobError("Nested braces are not supported", term);
        }
        if (term[j] === ",") {
          alts.push(alt);
          alt = "";
        } else {
          alt += term[j];
        }
        j++;
      }
      if (j >= term.length) {
        throw new GlobError("Unbalanced braces", term);
      }
      alts.push(alt);
      const next: string[] = [];
      for (const prefix of results) {
        for (const value of alts) {
          next.push(prefix + value);
        }
      }
      if (next.length > MAX_EXPANDED) {
        throw new GlobError("Too many brace expansions", term);
      }
      results = next;
      i = j + 1;
    } else if (ch === "}") {
      throw new GlobError("Unbalanced braces", term);
    } else {
      for (let k = 0; k < results.length; k++) {
        results[k] += ch;
      }
      i++;
    }
  }
  return results;
}

/** Compile a normalized (post-brace, post-anchor) pattern string into segments. */
function compilePattern(source: string, term: string, anchored: boolean): CompiledPattern {
  const segments: GlobSegment[] = [];
  for (const seg of source.split("/")) {
    if (seg === "") {
      continue;
    }
    if (seg === "**") {
      // Collapse consecutive `**` — they are semantically identical and keeping one
      // keeps the match loop minimal.
      if (segments.length > 0 && segments[segments.length - 1].doublestar) {
        continue;
      }
      segments.push({ doublestar: true, chars: [], literal: null });
      continue;
    }
    if (seg.includes("**")) {
      throw new GlobError("`**` is only valid as a whole path segment", term);
    }
    const hasWildcard = seg.includes("*") || seg.includes("?");
    segments.push({
      doublestar: false,
      chars: [...seg],
      literal: hasWildcard ? null : seg,
    });
  }
  return { source, segments, anchored };
}

/** Normalize+compile one concrete (brace-expanded) term into its pattern(s). */
function compileTerm(term: string): CompiledPattern[] {
  let core = term;
  while (core.startsWith("./")) {
    core = core.slice(2);
  }
  const anchored = core.startsWith("/");
  if (anchored) {
    core = core.slice(1);
  }
  if (core === "" || core === "/") {
    return [];
  }
  const base = anchored ? core : `**/${core}`;
  const patterns = [compilePattern(base, term, anchored)];
  // Folder shorthand: a metachar-free term whose last segment has no `.` (looks like a
  // directory, e.g. `src` or `node_modules`) also matches everything beneath it.
  const lastSeg = core.split("/").filter(Boolean).pop() ?? "";
  const metaFree = !core.includes("*") && !core.includes("?");
  if (metaFree && !lastSeg.includes(".")) {
    patterns.push(compilePattern(`${base}/**`, term, anchored));
  }
  return patterns;
}

/**
 * Parse a raw comma-separated glob field into a matchable list. Throws GlobError on
 * malformed input or cap violations. `kind` controls `!` handling: in an include field a
 * leading `!` moves the term to the exclude bucket; in an exclude field a leading `!` is
 * stripped (users often paste rg/VS Code-style negations).
 */
export function parseGlobList(raw: string, kind: "include" | "exclude"): CompiledGlobList {
  const include: CompiledPattern[] = [];
  const exclude: CompiledPattern[] = [];
  if (raw.includes("\0")) {
    throw new GlobError("Glob contains a NUL byte", raw);
  }
  if (raw.length > MAX_FIELD_CHARS) {
    throw new GlobError(`Glob field exceeds ${MAX_FIELD_CHARS} characters`, raw);
  }

  const terms = splitFieldTerms(raw)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
  if (terms.length > MAX_TERMS) {
    throw new GlobError(`Too many glob terms (limit ${MAX_TERMS})`, raw);
  }

  let expanded = 0;
  for (const rawTerm of terms) {
    if (rawTerm.length > MAX_TERM_CHARS) {
      throw new GlobError(`Glob term exceeds ${MAX_TERM_CHARS} characters`, rawTerm);
    }
    let term = rawTerm;
    let negated = false;
    if (term.startsWith("!")) {
      negated = true;
      term = term.slice(1).trim();
      if (term === "") {
        continue;
      }
    }
    const concrete = expandBraces(term);
    expanded += concrete.length;
    if (expanded > MAX_EXPANDED) {
      throw new GlobError(`Too many expanded glob patterns (limit ${MAX_EXPANDED})`, rawTerm);
    }
    const bucket = kind === "include" && !negated ? include : exclude;
    for (const value of concrete) {
      for (const pattern of compileTerm(value)) {
        // Stamp the RAW field (`kind`), not the bucket, so an include-field `!term`
        // routed into `exclude` still reports `field: "include"`.
        bucket.push({ ...pattern, field: kind });
      }
    }
  }

  return { include, exclude };
}

/** Merge several parsed lists (e.g. the include field and the exclude field) into one. */
export function mergeGlobLists(...lists: CompiledGlobList[]): CompiledGlobList {
  const include: CompiledPattern[] = [];
  const exclude: CompiledPattern[] = [];
  for (const list of lists) {
    include.push(...list.include);
    exclude.push(...list.exclude);
  }
  return { include, exclude };
}

/** Match one path segment against a compiled segment (`*`/`?` two-pointer, no regex). */
function matchSegment(seg: GlobSegment, value: string): boolean {
  if (seg.literal !== null) {
    return seg.literal === value;
  }
  const pat = seg.chars;
  const str = [...value];
  let pi = 0;
  let si = 0;
  let starPi = -1;
  let starSi = -1;
  while (si < str.length) {
    if (pi < pat.length && pat[pi] === "*") {
      starPi = pi;
      starSi = si;
      pi++;
    } else if (pi < pat.length && (pat[pi] === "?" || pat[pi] === str[si])) {
      pi++;
      si++;
    } else if (starPi !== -1) {
      starSi++;
      si = starSi;
      pi = starPi + 1;
    } else {
      return false;
    }
  }
  while (pi < pat.length && pat[pi] === "*") {
    pi++;
  }
  return pi === pat.length;
}

/** Match a path (segment array) against a compiled pattern (`**` two-pointer, no regex). */
function matchPattern(pattern: CompiledPattern, path: string[]): boolean {
  const pat = pattern.segments;
  let pi = 0;
  let si = 0;
  let starPi = -1;
  let starSi = -1;
  while (si < path.length) {
    if (pi < pat.length && pat[pi].doublestar) {
      starPi = pi;
      starSi = si;
      pi++;
    } else if (pi < pat.length && !pat[pi].doublestar && matchSegment(pat[pi], path[si])) {
      pi++;
      si++;
    } else if (starPi !== -1) {
      starSi++;
      si = starSi;
      pi = starPi + 1;
    } else {
      return false;
    }
  }
  while (pi < pat.length && pat[pi].doublestar) {
    pi++;
  }
  return pi === pat.length;
}

/**
 * Test a relative path (forward-slash separated, no leading `/`) against a parsed list.
 * Passes iff it matches an include (or there are none) and matches no exclude.
 */
export function matchesGlobList(list: CompiledGlobList, relPath: string): boolean {
  const path = relPath.split("/").filter((seg) => seg !== "" && seg !== ".");
  if (list.exclude.some((pattern) => matchPattern(pattern, path))) {
    return false;
  }
  if (list.include.length === 0) {
    return true;
  }
  return list.include.some((pattern) => matchPattern(pattern, path));
}
