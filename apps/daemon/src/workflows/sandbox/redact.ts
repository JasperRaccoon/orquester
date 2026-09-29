// Automated workflows — secret redaction (spec §5.7).
//
// Every VALUE of every secret (≥ 4 characters — shorter ones are noise the UI warns about) is
// replaced by `«secret:NAME»` in everything persisted or broadcast: block outputs, errors, logs and
// run events. Values only — object keys are left as written. Longest values first, so a secret that
// contains another is replaced whole.
//
// Growing log files use byte-aware windows in log-reader.ts.

import type { Redactor } from "../contracts.ts";

/** Values shorter than this are never redacted (spec §5.7). */
export const MIN_REDACTED_SECRET_LENGTH = 4;

export interface SecretMatch {
  start: number;
  end: number;
  name: string;
}

export interface SecretRedactor extends Redactor {
  /** The longest redacted value, in UTF-8 bytes (0 with nothing to redact). */
  readonly maxSecretBytes: number;
  /** Every occurrence in `text`, left to right, non-overlapping, the longest value at a position. */
  matches(text: string): SecretMatch[];
  /**
   * The same over raw bytes (UTF-8), positions in bytes — for log files, whose bytes need not be
   * valid UTF-8 and whose offsets must never drift through a decode/encode round trip.
   */
  byteMatches(bytes: Uint8Array): SecretMatch[];
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

  return {
    maxSecretBytes,
    matches,
    byteMatches,
    text,
    value<T>(value: T): T {
      return pattern === null ? value : (deep(value, 0) as T);
    }
  };
}
