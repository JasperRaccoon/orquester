/**
 * Agent host — provider stderr capture, classification and redaction
 * (spec §3.1 "stderr is captured, not discarded").
 *
 * Ported from T3 Code (MIT): `apps/server/src/provider/acp/AcpStderr.ts`
 * (the 4 KiB ring tail and the redaction) and
 * `apps/server/src/provider/Layers/CodexSessionRuntime.ts:670-688`
 * (`classifyCodexStderrLine`).
 *
 * Without any of this a child that dies on a missing binary, a bad `HOME` or a
 * stale login produces a silent hang. The excerpt is redacted **before it
 * leaves the host**, because it is shown to the user and written to
 * `events.ndjson`.
 */

/** The bounded tail an exit error carries an excerpt from (§3.1). */
export const STDERR_TAIL_BYTES = 4096;

/** What one classified stderr line becomes. */
export type StderrLineClass = "drop" | "warning" | "error";

export interface ClassifiedStderrLine {
  /** The line, ANSI-stripped and redacted. */
  text: string;
  class: StderrLineClass;
}

// ---------------------------------------------------------------------------
// ANSI
// ---------------------------------------------------------------------------

// OSC first, then CSI. The order is load-bearing: the CSI alternative's
// parameter class contains `]`, so it would otherwise swallow the `\u001b]`
// of an OSC sequence and leave its payload (`;title\u0007…`) in the output.
// Written out rather than pulled from a dependency: this runs on every stderr
// line of every child.
const ANSI_RE =
  /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-PR-TZcf-nqry=><]/g;

/** Strip ANSI escape sequences (colour, cursor moves, OSC titles). */
export function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

// ---------------------------------------------------------------------------
// Redaction (§3.1)
// ---------------------------------------------------------------------------

/**
 * A credential header's value is the REST OF THE LINE, not one token: masking
 * only the first word left `Authorization: [redacted] <the actual token>`.
 * `m` keeps it from eating the next line of a multi-line tail.
 */
/**
 * A device-pairing URL is a bearer credential: anyone who opens it completes
 * the sign-in. §4.5 Grok names it explicitly in the stderr rule ("home dir,
 * **pairing URLs**, `Bearer`, `x-api-key`, …"), and it is the one path no
 * capture covers — a healthy Grok run writes nothing to stderr, so this only
 * ever appears when a login is needed, which is exactly when it must not be
 * written to `events.ndjson` (R4 #3).
 *
 * *T3: `apps/server/src/provider/acp/AcpStderr.ts:7` (`PAIRING_URL_PATTERN`).*
 */
const PAIRING_URL_RE = /https?:\/\/[^\s]*\/pair#[^\s]*/gi;
const AUTH_HEADER_RE = /\b(authorization|x-api-key|proxy-authorization)\b(\s*[:=]\s*)\S.*$/gim;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
/**
 * `sk-`, `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`, and Slack's `xox?-` shapes. The
 * length floors keep a bare `sk-` or a prose "ghp_" from being masked.
 */
const TOKEN_SHAPE_RE =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[abprs]-[A-Za-z0-9-]{8,})/g;

export interface RedactOptions {
  /**
   * Absolute home paths collapsed to `~`. Longest first, so a nested home is
   * not half-replaced by its parent.
   */
  homeDirs?: readonly string[];
  /**
   * Exact secrets the HOST itself injected, masked verbatim.
   *
   * The shape patterns below only catch credentials that look like
   * credentials. The cliproxy `ANTHROPIC_AUTH_TOKEN` handed to every
   * `claudex`/`claudemix` child is `randomBytes(24).toString("hex")` — a bare
   * 48-char hex string that matches none of them — so a CLI that echoes its
   * resolved config or an env dump on stderr would land it unmasked in
   * `events.ndjson` and in the timeline. The host knows exactly what it
   * injected, so it says so. Masked longest-first, like `homeDirs`.
   */
  literals?: readonly string[];
}

/**
 * Mask credential-shaped text and collapse home paths. Applied to every line
 * before it becomes an event, and to the tail before it becomes an excerpt.
 */
export function redactStderr(value: string, options: RedactOptions = {}): string {
  // NUL bytes first: they can split a pattern in two and they have no business
  // in a log line either way.
  let out = value.replaceAll("\0", "");

  const homes = [...(options.homeDirs ?? [])]
    .filter((dir) => dir.length > 1)
    .sort((a, b) => b.length - a.length);
  for (const dir of homes) {
    out = out.split(dir).join("~");
  }

  out = out.replace(PAIRING_URL_RE, "[pairing-url]");
  out = out.replace(AUTH_HEADER_RE, (_m, key: string, sep: string) => `${key}${sep}[redacted]`);
  out = out.replace(BEARER_RE, "Bearer [redacted]");
  out = out.replace(TOKEN_SHAPE_RE, "[redacted]");
  // §4.5 Grok names it explicitly: a pairing URL is a bearer credential, and
  // the one it prints on stderr is the whole handshake.

  // Exact host-injected secrets last, so a value that also matched a shape
  // pattern is already gone and this only catches what the shapes cannot see.
  const literals = [...(options.literals ?? [])]
    .filter((literal) => literal.length >= 8)
    .sort((a, b) => b.length - a.length);
  for (const literal of literals) {
    out = out.split(literal).join("[redacted]");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Classification (§3.1)
// ---------------------------------------------------------------------------

/**
 * Routine noise every provider prints. A line matching one of these is
 * dropped outright — surfacing it would train the user to ignore the warning
 * row. Snippets are matched case-insensitively against the stripped line.
 */
export const DEFAULT_BENIGN_SNIPPETS: readonly string[] = [
  "state db missing rollout path for thread",
  "record_discrepancy",
  "falling_back",
  "experimentalwarning",
  "deprecationwarning",
  "punycode module is deprecated"
];

/**
 * A line matching one of these is a `runtime.error {class: "provider_error"}`:
 * the child is not going to recover on its own and the user must act.
 */
export const DEFAULT_FATAL_SNIPPETS: readonly string[] = [
  "command not found",
  "no such file or directory",
  "permission denied",
  "eacces",
  "enoent",
  "not logged in",
  "not authenticated",
  "invalid api key",
  "unauthorized",
  "panic:",
  "fatal error"
];

/** Log levels below ERROR that are dropped when a line carries one (§3.1). */
const SUBERROR_LEVEL_RE = /\b(?:TRACE|DEBUG|INFO|NOTICE|VERBOSE)\b/;
const ERROR_LEVEL_RE = /\b(?:ERROR|FATAL|CRITICAL)\b/;

export interface ClassifyOptions extends RedactOptions {
  benignSnippets?: readonly string[];
  fatalSnippets?: readonly string[];
}

/**
 * ANSI-strip, redact, then classify one line: log lines below ERROR and the
 * benign list are dropped, the fatal list becomes an error, everything else a
 * warning. A blank line is dropped.
 */
export function classifyStderrLine(
  raw: string,
  options: ClassifyOptions = {}
): ClassifiedStderrLine {
  const text = redactStderr(stripAnsi(raw), options).trimEnd();
  if (text.trim().length === 0) {
    return { text, class: "drop" };
  }

  const lower = text.toLowerCase();
  const benign = options.benignSnippets ?? DEFAULT_BENIGN_SNIPPETS;
  if (benign.some((snippet) => lower.includes(snippet))) {
    return { text, class: "drop" };
  }

  const fatal = options.fatalSnippets ?? DEFAULT_FATAL_SNIPPETS;
  if (fatal.some((snippet) => lower.includes(snippet))) {
    return { text, class: "error" };
  }

  // A structured log line that names a level below ERROR is noise, unless it
  // also names ERROR (some formats print both a level and a logger name).
  if (SUBERROR_LEVEL_RE.test(text) && !ERROR_LEVEL_RE.test(text)) {
    return { text, class: "drop" };
  }

  return { text, class: "warning" };
}

// ---------------------------------------------------------------------------
// The capture
// ---------------------------------------------------------------------------

/**
 * Splits a child's stderr into lines (carrying a remainder), classifies each
 * one, and keeps a bounded rolling tail so an exit error can carry an excerpt.
 *
 * The tail holds the REDACTED text: nothing unredacted is ever retained, so
 * there is no path by which a token reaches `events.ndjson` even if a later
 * caller forgets to redact.
 */
export class StderrCapture {
  private remainder = "";
  private tail = "";
  private readonly options: ClassifyOptions;
  private readonly tailBytes: number;

  constructor(options: ClassifyOptions & { tailBytes?: number } = {}) {
    const { tailBytes, ...classify } = options;
    this.options = classify;
    this.tailBytes = tailBytes ?? STDERR_TAIL_BYTES;
  }

  /** Feed a chunk; returns the classified lines it completed. */
  push(chunk: Uint8Array | string): ClassifiedStderrLine[] {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    this.remainder += text;

    const out: ClassifiedStderrLine[] = [];
    let start = 0;
    for (;;) {
      const nl = this.remainder.indexOf("\n", start);
      if (nl === -1) {
        break;
      }
      let end = nl;
      if (end > start && this.remainder.charCodeAt(end - 1) === 13) {
        end -= 1;
      }
      out.push(this.take(this.remainder.slice(start, end)));
      start = nl + 1;
    }
    this.remainder = this.remainder.slice(start);
    return out;
  }

  /** Classify whatever is left when the stream ends. */
  flush(): ClassifiedStderrLine[] {
    const line = this.remainder;
    this.remainder = "";
    if (line.trim().length === 0) {
      return [];
    }
    return [this.take(line)];
  }

  /**
   * The redacted rolling tail, safe to attach to an exit error. Never longer
   * than the configured byte budget.
   */
  excerpt(): string {
    return this.tail;
  }

  private take(raw: string): ClassifiedStderrLine {
    const line = classifyStderrLine(raw, this.options);
    if (line.text.length > 0) {
      this.tail = appendBounded(this.tail, `${line.text}\n`, this.tailBytes);
    }
    return line;
  }
}

/** Append and trim from the front, on a byte budget, never mid-codepoint. */
function appendBounded(tail: string, addition: string, maxBytes: number): string {
  let next = tail + addition;
  while (Buffer.byteLength(next) > maxBytes) {
    const nl = next.indexOf("\n");
    if (nl === -1 || nl + 1 >= next.length) {
      // One line longer than the whole budget: keep its tail, cut on a
      // character boundary by slicing the string rather than the buffer.
      const over = Buffer.byteLength(next) - maxBytes;
      next = next.slice(Math.min(over, next.length));
      break;
    }
    next = next.slice(nl + 1);
  }
  return next;
}
