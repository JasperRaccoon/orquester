/**
 * Agent chat — the history page cursor (design
 * `docs/superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md`,
 * "History page").
 *
 * A cursor names the turn a page of older history ends BELOW: the
 * `requestedAt` of that turn and its turn id (the tie-break between two turns
 * requested at the same instant), plus the thread it belongs to — and, when
 * the page ends INSIDE that turn, the event sequence it ends strictly below
 * (`beforeSeq`). It is derived from CONTENT, never from an index row id, so it
 * survives an index rebuild and a revert.
 *
 * *T3: `apps/server/src/orchestration/threadDetailCursor.ts` — the cursor is
 * the page's anchor row, not a position.*
 *
 * Opaque on the wire: `base64url(JSON {t, a, i, s?})`, unpadded, so it rides
 * a query string as-is. A malformed cursor, or one minted for another thread,
 * decodes to `null`, which the host reads as "no cursor" (a first-page
 * request) — never as an error.
 *
 * No Node APIs: `@orquester/api` is shared with the browser client.
 */

export interface HistoryCursor {
  threadId: string;
  /** `requestedAt` of the turn the page ends below (or inside, with `beforeSeq`). */
  beforeAnchorAt: string;
  /** That turn's id. */
  beforeTurnId: string;
  /**
   * When present, the page ends strictly below this event sequence INSIDE
   * the turn named above — a turn larger than one page (a subagent fleet's
   * turn runs to thousands of events) is walked in activity-sized blocks,
   * and this is where the previous block began. Absent means "ends at the
   * start of that turn". Sequences are content-derived and never move on an
   * append-only log, so the cursor survives an index rebuild.
   */
  beforeSeq?: number;
}

/** The wire spelling. Short keys: the cursor rides every "load older" URL. */
interface WireHistoryCursor {
  t: string;
  a: string;
  i: string;
  s?: number;
}

export function encodeHistoryCursor(cursor: HistoryCursor): string {
  const wire: WireHistoryCursor = {
    t: cursor.threadId,
    a: cursor.beforeAnchorAt,
    i: cursor.beforeTurnId,
    ...(cursor.beforeSeq === undefined ? {} : { s: cursor.beforeSeq })
  };
  return toBase64Url(new TextEncoder().encode(JSON.stringify(wire)));
}

/**
 * The cursor `encoded` names, or `null` when it is not one of ours for
 * `threadId`. Never throws: the input is a query parameter.
 *
 * Fields beyond `{t, a, i}` are ignored, so a later build can add one without
 * an older host rejecting its cursors.
 */
export function decodeHistoryCursor(encoded: string, threadId: string): HistoryCursor | null {
  if (typeof encoded !== "string") {
    return null;
  }
  const bytes = fromBase64Url(encoded);
  if (bytes === null) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const { t, a, i, s } = value as Record<string, unknown>;
  if (t !== threadId || !isNonEmptyString(a) || !isNonEmptyString(i)) {
    return null;
  }
  if (s !== undefined && !(typeof s === "number" && Number.isInteger(s) && s > 0)) {
    return null;
  }
  return {
    threadId,
    beforeAnchorAt: a,
    beforeTurnId: i,
    ...(s === undefined ? {} : { beforeSeq: s })
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]*$/;

/** base64url (RFC 4648 §5, unpadded) of `bytes`. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The bytes of an unpadded base64url string, or `null`. Only the url-safe
 * alphabet is accepted — a standard-base64 spelling of the same bytes is not
 * one of our cursors — and a length of `4n + 1` is never a whole byte count.
 */
function fromBase64Url(encoded: string): Uint8Array | null {
  if (!BASE64URL_ALPHABET.test(encoded) || encoded.length % 4 === 1) {
    return null;
  }
  const base64 = encoded
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
