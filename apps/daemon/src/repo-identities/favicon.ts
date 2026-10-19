import type { RepoIconStoredType } from "@orquester/api";

/**
 * Fetching a website's favicon for a repo icon (spec 2026-10-18 §3b).
 *
 * INTERFACE STUB — the implementation lands separately; the identity routes
 * call {@link fetchFavicon} and map {@link FaviconError} codes to responses.
 */

export type FaviconErrorCode = "FAVICON_BAD_DOMAIN" | "FAVICON_BLOCKED" | "FAVICON_UNREACHABLE" | "FAVICON_NOT_FOUND";

/** A refusal whose `message` is user-facing: it names the domain and never carries a response body. */
export class FaviconError extends Error {
  constructor(
    public readonly code: FaviconErrorCode,
    message: string
  ) {
    super(message);
    this.name = "FaviconError";
  }
}

export interface FetchedFavicon {
  /** The normalized hostname, e.g. `matssmile.com`. */
  domain: string;
  /** Sniffed, never declared. */
  contentType: RepoIconStoredType;
  /** At most `REPO_ICON_MAX_BYTES`. */
  bytes: Uint8Array;
}

/**
 * `matssmile.com` / `https://www.matssmile.com/x` → its hostname (punycode, lowercased, no
 * trailing dot). Throws `FAVICON_BAD_DOMAIN` for IP literals, ports, credentials, `localhost`,
 * single-label names and anything over 253 chars.
 */
export function normalizeFaviconDomain(input: string): string {
  void input;
  throw new FaviconError("FAVICON_BAD_DOMAIN", "Website icons are not available yet.");
}

export interface FetchFaviconOptions {
  signal?: AbortSignal;
}

/** Fetch `domain`'s best icon over HTTPS behind the SSRF guard. Throws {@link FaviconError}. */
export async function fetchFavicon(domain: string, options: FetchFaviconOptions = {}): Promise<FetchedFavicon> {
  void options;
  normalizeFaviconDomain(domain);
  throw new FaviconError("FAVICON_NOT_FOUND", "Website icons are not available yet.");
}
