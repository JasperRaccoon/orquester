/**
 * Repo identities — a user-chosen icon and label per git repository, shown on
 * the sidebar's repo groups and wherever a project's repo is named.
 *
 * Owned by the daemon so every client (desktop, web, phone) and every workspace
 * shares one identity per repo: persisted at `<appdir>/daemon/repo-identities.json`
 * (image icons as files beside it), served by `/api/repo-identities`, and every
 * change is broadcast on {@link REPO_IDENTITIES_CHANNEL}.
 *
 * A repo is known by its `repoKey` — `ProjectSummary.repoKey`, the daemon's
 * canonical lowercased `host/owner/repo` of a checkout's `origin` remote. Only
 * remote-backed repos have one; a local-only repo has no identity.
 */

// ---------------------------------------------------------------------------
// Limits (enforced by the daemon; the UI mirrors them)
// ---------------------------------------------------------------------------

/** A stored icon image, after any client-side shrinking. */
export const REPO_ICON_MAX_BYTES = 2 * 1024 * 1024;
/** Content types an upload may declare (and its bytes must sniff as). */
export const REPO_ICON_UPLOAD_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"] as const;
export type RepoIconUploadType = (typeof REPO_ICON_UPLOAD_TYPES)[number];
/** Content types a stored icon may have: uploads, plus ICO from a website favicon. */
export const REPO_ICON_STORED_TYPES = [...REPO_ICON_UPLOAD_TYPES, "image/x-icon"] as const;
export type RepoIconStoredType = (typeof REPO_ICON_STORED_TYPES)[number];
/** UTF-16 units, after trimming. */
export const REPO_LABEL_MAX = 80;
export const REPO_KEY_MAX = 512;
/** UTF-8 bytes of one emoji (ZWJ family sequences run long). */
export const REPO_EMOJI_MAX_BYTES = 32;
/** A typed website domain, before normalization. */
export const REPO_FAVICON_DOMAIN_MAX = 253;

// ---------------------------------------------------------------------------
// The record and the routes
// ---------------------------------------------------------------------------

export interface RepoFaviconSource {
  kind: "favicon";
  /** The normalized hostname the icon was fetched from, e.g. `matssmile.com`. */
  domain: string;
}

export type RepoIcon =
  | { kind: "emoji"; value: string }
  | {
      kind: "image";
      contentType: RepoIconStoredType;
      /** Changes whenever the bytes do; part of the icon URL so caches never go stale. */
      version: string;
      /** Absent: the user uploaded it. */
      source?: RepoFaviconSource;
    };

export interface RepoIdentity {
  repoKey: string;
  /** Absent: the UI shows the repo's own `owner/repo` name. */
  label?: string;
  /** Absent: the UI shows its neutral repo icon. */
  icon?: RepoIcon;
  updatedAt: string;
}

export const repoIdentityRoutes = {
  /** GET → {@link RepoIdentitiesResponse}. */
  list: "/api/repo-identities",
  /** PUT {@link SetRepoLabelRequest} → {@link RepoIdentityResponse}. */
  label: "/api/repo-identities/label",
  /** PUT {@link SetRepoEmojiRequest} → {@link RepoIdentityResponse}. */
  emoji: "/api/repo-identities/emoji",
  /**
   * `?repoKey=`. POST (raw `application/octet-stream` body, `&contentType=` one of
   * {@link REPO_ICON_UPLOAD_TYPES}) → {@link RepoIdentityResponse}; GET → the image bytes;
   * DELETE (any icon kind) → {@link RepoIdentityResponse}.
   */
  icon: "/api/repo-identities/icon",
  /** POST {@link FetchRepoFaviconRequest} → {@link RepoIdentityResponse}. */
  favicon: "/api/repo-identities/favicon"
} as const;

export interface RepoIdentitiesResponse {
  identities: RepoIdentity[];
}

/** The identity after a change; `null` when it has neither label nor icon left. */
export interface RepoIdentityResponse {
  identity: RepoIdentity | null;
}

export interface SetRepoLabelRequest {
  repoKey: string;
  /** `null` or blank clears it. */
  label: string | null;
}

export interface SetRepoEmojiRequest {
  repoKey: string;
  emoji: string;
}

export interface FetchRepoFaviconRequest {
  repoKey: string;
  /** `matssmile.com`, `www.matssmile.com` or `https://matssmile.com/any/path`. */
  domain: string;
}

/**
 * Refusal codes (`{ code, message }` bodies). The message is user-facing and names the domain
 * for the favicon codes; it never carries a fetched response body.
 */
export type RepoIdentityErrorCode =
  | "INVALID_REPO_KEY" // 400
  | "INVALID_LABEL" // 400
  | "INVALID_EMOJI" // 400
  | "INVALID_ICON" // 400 — bad content type, bytes that don't sniff as it, a broken SVG
  | "ICON_TOO_LARGE" // 413
  | "ICON_NOT_FOUND" // 404 — GET of a repo with no image icon
  | "FAVICON_BAD_DOMAIN" // 400
  | "FAVICON_BLOCKED" // 400 — resolves to a loopback/private/link-local/metadata address
  | "FAVICON_UNREACHABLE" // 502 — DNS, TLS, timeout, non-2xx page
  | "FAVICON_NOT_FOUND" // 404 — the site has no usable icon
  | "FAVICON_BUSY" // 409 — a fetch for this repo is already running
  | "REPO_IDENTITIES_UNAVAILABLE" // 503 — the store could not be read; changes are refused
  | "REPO_IDENTITIES_ERROR"; // 500 — an unexpected failure

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** The `/events` channel every identity change is broadcast on. */
export const REPO_IDENTITIES_CHANNEL = "repo-identities";
/** Payload: {@link RepoIdentityChangedPayload}. */
export const REPO_IDENTITY_CHANGED = "repoIdentity.changed";

export type RepoIdentityChangedPayload = { identity: RepoIdentity } | { repoKey: string; deleted: true };

// ---------------------------------------------------------------------------
// Validation shared by the daemon and the UI
// ---------------------------------------------------------------------------

/**
 * Why `repoKey` is not a repo key, or null when it is one: a lowercased `host/owner[/…]/repo`
 * of at most {@link REPO_KEY_MAX} chars — never a filesystem path, never `..`.
 */
export function repoKeyProblem(repoKey: unknown): string | null {
  if (typeof repoKey !== "string" || repoKey.length === 0) return "The repo key is empty.";
  if (repoKey.length > REPO_KEY_MAX) return "The repo key is too long.";
  if (/[\s\u0000-\u001f\u007f]/.test(repoKey)) return "The repo key may not contain whitespace or control characters.";
  if (repoKey !== repoKey.toLowerCase()) return "The repo key must be lowercase.";
  if (/^[/\\]|^[a-z]:/i.test(repoKey) || repoKey.includes("\\")) return "The repo key may not be a path.";
  const segments = repoKey.split("/");
  if (segments.length < 3 || segments.some((s) => s.length === 0 || s === "." || s === "..")) {
    return "The repo key must look like host/owner/repo.";
  }
  return null;
}

/** The label as stored: trimmed; `null` when blank (clear it). Throws nothing; check {@link repoLabelProblem}. */
export function normalizeRepoLabel(label: string | null | undefined): string | null {
  const trimmed = (label ?? "").trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function repoLabelProblem(label: string): string | null {
  if (label.length > REPO_LABEL_MAX) return `A label is at most ${REPO_LABEL_MAX} characters.`;
  if (/[\u0000-\u001f\u007f]/.test(label)) return "A label may not contain control characters.";
  return null;
}

const EMOJI_MARK = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

/** True when `value` (already trimmed) is exactly one emoji grapheme of bounded size. */
export function isSingleEmoji(value: string): boolean {
  if (value.length === 0 || new TextEncoder().encode(value).length > REPO_EMOJI_MAX_BYTES) return false;
  if (!EMOJI_MARK.test(value)) return false;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let count = 0;
  for (const _ of segmenter.segment(value)) {
    count += 1;
    if (count > 1) return false;
  }
  return count === 1;
}

export function isRepoIconUploadType(value: unknown): value is RepoIconUploadType {
  return typeof value === "string" && (REPO_ICON_UPLOAD_TYPES as readonly string[]).includes(value);
}

export function isRepoIconStoredType(value: unknown): value is RepoIconStoredType {
  return typeof value === "string" && (REPO_ICON_STORED_TYPES as readonly string[]).includes(value);
}
