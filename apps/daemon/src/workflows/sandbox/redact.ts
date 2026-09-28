// Automated workflows — secret redaction (spec §5.7).
//
// Every VALUE of every secret (≥ 4 characters — shorter ones are noise the UI warns about) is
// replaced by `«secret:NAME»` in everything persisted or broadcast: block outputs, errors, logs and
// run events. Values only — object keys are left as written. Longest values first, so a secret that
// contains another is replaced whole.
//
// Logs are redacted as they are tailed, in chunks, and a secret can be split across two chunks (or
// across a window a client asked for): `redactChunk` / `createChunkRedactor` hold back the last
// `maxSecretLength - 1` characters of a chunk until the next one decides them, which is exactly
// enough — any occurrence starting before that tail fits inside what has been read.

import type { Redactor } from "../contracts.ts";

/** Values shorter than this are never redacted (spec §5.7). */
export const MIN_REDACTED_SECRET_LENGTH = 4;

export interface SecretMatch {
  start: number;
  end: number;
  name: string;
}

export interface SecretRedactor extends Redactor {
  /** The longest redacted value, in UTF-16 code units (0 with nothing to redact). */
  readonly maxSecretLength: number;
  /** The longest redacted value, in UTF-8 bytes (0 with nothing to redact). */
  readonly maxSecretBytes: number;
  /** Every occurrence in `text`, left to right, non-overlapping, the longest value at a position. */
  matches(text: string): SecretMatch[];
  /**
   * The same over raw bytes (UTF-8), positions in bytes — for log files, whose bytes need not be
   * valid UTF-8 and whose offsets must never drift through a decode/encode round trip.
   */
  byteMatches(bytes: Uint8Array): SecretMatch[];
  /** A streaming redactor over this one (see {@link createChunkRedactor}). */
  stream(): ChunkRedactor;
}

export function secretPlaceholder(name: string): string {
  return `«secret:${name}»`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function createRedactor(secrets: Readonly<Record<string, string>>): SecretRedactor {
  // value -> name; the first name (sorted) wins for a value shared by two secrets.
  const byValue = new Map<string, string>();
  for (const name of Object.keys(secrets).sort()) {
    const value = secrets[name];
    if (typeof value !== "string" || value.length < MIN_REDACTED_SECRET_LENGTH) {
      continue;
    }
    if (!byValue.has(value)) {
      byValue.set(value, name);
    }
  }
  const values = [...byValue.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  const pattern = values.length > 0 ? new RegExp(values.map(escapeRegExp).join("|"), "g") : null;
  const maxSecretLength = values.length > 0 ? values[0]!.length : 0;
  const maxSecretBytes = values.reduce((max, value) => Math.max(max, Buffer.byteLength(value, "utf8")), 0);
  const encoded = values.map((value) => ({ bytes: Buffer.from(value, "utf8"), name: byValue.get(value)! }));

  const byteMatches = (bytes: Uint8Array): SecretMatch[] => {
    if (encoded.length === 0 || bytes.length < MIN_REDACTED_SECRET_LENGTH) {
      return [];
    }
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const all: SecretMatch[] = [];
    for (const secret of encoded) {
      for (let at = buf.indexOf(secret.bytes, 0); at !== -1; at = buf.indexOf(secret.bytes, at + 1)) {
        all.push({ start: at, end: at + secret.bytes.length, name: secret.name });
      }
    }
    // Leftmost first, the longest at a position — the regex's own choice — then non-overlapping.
    all.sort((a, b) => a.start - b.start || b.end - a.end);
    const picked: SecretMatch[] = [];
    let lastEnd = 0;
    for (const match of all) {
      if (match.start >= lastEnd) {
        picked.push(match);
        lastEnd = match.end;
      }
    }
    return picked;
  };

  const matches = (text: string): SecretMatch[] => {
    if (pattern === null || text.length < MIN_REDACTED_SECRET_LENGTH) {
      return [];
    }
    const found: SecretMatch[] = [];
    pattern.lastIndex = 0;
    for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
      found.push({ start: m.index, end: m.index + m[0].length, name: byValue.get(m[0])! });
    }
    return found;
  };

  const text = (value: string): string => {
    if (pattern === null || typeof value !== "string") {
      return value;
    }
    return value.replace(pattern, (match) => secretPlaceholder(byValue.get(match)!));
  };

  const deep = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") {
      return text(value);
    }
    if (depth > 256) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => deep(item, depth + 1));
    }
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] = deep(item, depth + 1);
      }
      return out;
    }
    return value;
  };

  const redactor: SecretRedactor = {
    maxSecretLength,
    maxSecretBytes,
    matches,
    byteMatches,
    text,
    value<T>(value: T): T {
      return pattern === null ? value : (deep(value, 0) as T);
    },
    stream: () => createChunkRedactor(redactor)
  };
  return redactor;
}

/** Replace the matches that end at or before `end` in `text.slice(0, end)`. */
function redactPrefix(text: string, end: number, found: readonly SecretMatch[]): string {
  let out = "";
  let at = 0;
  for (const match of found) {
    if (match.end > end) {
      break;
    }
    out += text.slice(at, match.start) + secretPlaceholder(match.name);
    at = match.end;
  }
  return out + text.slice(at, end);
}

/**
 * One step of streaming redaction. `carry` is what the previous step held back; the result's
 * `text` is safe to emit and its `carry` must be handed to the next step. With `final`, everything
 * is emitted (end of stream).
 */
function redactChunk(
  redactor: SecretRedactor,
  carry: string,
  chunk: string,
  final = false
): { text: string; carry: string } {
  const combined = carry + chunk;
  if (redactor.maxSecretLength === 0) {
    return { text: combined, carry: "" };
  }
  if (final) {
    return { text: redactor.text(combined), carry: "" };
  }
  let cut = combined.length - (redactor.maxSecretLength - 1);
  if (cut <= 0) {
    return { text: "", carry: combined };
  }
  const found = redactor.matches(combined);
  // A match that starts before the cut is complete (the longest secret fits in what was read),
  // so it is emitted whole rather than split.
  for (const match of found) {
    if (match.start < cut && match.end > cut) {
      cut = match.end;
    }
  }
  // Never split a surrogate pair.
  const last = combined.charCodeAt(cut - 1);
  if (cut < combined.length && last >= 0xd800 && last <= 0xdbff) {
    cut -= 1;
  }
  return { text: redactPrefix(combined, cut, found), carry: combined.slice(cut) };
}

export interface ChunkRedactor {
  /** Redacts what can be decided; holds back a possible secret prefix. */
  push(chunk: string): string;
  /** Emits (redacted) whatever is held back. */
  flush(): string;
}

export function createChunkRedactor(redactor: SecretRedactor): ChunkRedactor {
  let carry = "";
  return {
    push(chunk: string): string {
      const step = redactChunk(redactor, carry, chunk);
      carry = step.carry;
      return step.text;
    },
    flush(): string {
      const step = redactChunk(redactor, carry, "", true);
      carry = "";
      return step.text;
    }
  };
}
