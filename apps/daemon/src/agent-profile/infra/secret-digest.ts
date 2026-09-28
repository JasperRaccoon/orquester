/**
 * Keyed digests stand in for secret values in revisions: an edit of a value
 * still moves the revision, but a revision (sent to clients) cannot be
 * brute-forced back into a short secret. The key lives for the process, so
 * revisions of items with secrets move once across a daemon restart.
 */

import { createHmac, randomBytes } from "node:crypto";

/** Maps whose every VALUE is secret (an MCP server's env and headers, per agent's spelling). */
const SECRET_MAPS = new Set(["env", "environment", "headers", "http_headers"]);
/** Single fields whose value is secret wherever they appear. */
const SECRET_FIELDS = /^(client_?secret|bearer_?token|token|password|api_?key|secret)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class SecretDigester {
  private readonly key = randomBytes(32);

  digest(value: string): string {
    return createHmac("sha256", this.key).update(value).digest("hex").slice(0, 16);
  }

  /** The definition with its top-level `env`/`headers` values replaced by digests. */
  masked(def: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...def };
    for (const field of ["env", "headers"] as const) {
      const map = def[field];
      if (isRecord(map)) {
        out[field] = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, this.digest(String(v))]));
      }
    }
    return out;
  }

  /**
   * A deep copy with every secret replaced by its digest: the values of any
   * `env` / `environment` / `headers` / `http_headers` map at any depth, and
   * any `clientSecret` / `bearer_token` / `token` / `password` / `apiKey` /
   * `secret` field. For hashing into a revision — never for display.
   */
  deepMasked(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((entry) => this.deepMasked(entry));
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_MAPS.has(key) && isRecord(entry)) {
        out[key] = Object.fromEntries(Object.entries(entry).map(([k, v]) => [k, this.digest(String(v))]));
      } else if (SECRET_FIELDS.test(key) && typeof entry === "string") {
        out[key] = this.digest(entry);
      } else {
        out[key] = this.deepMasked(entry);
      }
    }
    return out;
  }
}
