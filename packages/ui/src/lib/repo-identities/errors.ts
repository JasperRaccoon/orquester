/**
 * The words a repo-identity failure is shown with: the daemon's own message
 * when it sent one (an `ApiError`'s `serverMessage` — it names the domain for
 * favicon failures), else a friendly text for its refusal code, else the
 * error's own message. Duck-typed, so this stays importable without the client.
 */

import type { RepoIdentityErrorCode } from "@orquester/api";

function codeText(code: RepoIdentityErrorCode, domain: string): string | null {
  const site = domain.trim() || "that site";
  switch (code) {
    case "FAVICON_UNREACHABLE":
      return `Couldn't reach ${site}.`;
    case "FAVICON_NOT_FOUND":
      return `No icon found on ${site}.`;
    case "FAVICON_BLOCKED":
      return `${site} points to a private or blocked address.`;
    case "FAVICON_BAD_DOMAIN":
      return `“${site}” isn't a website domain.`;
    case "FAVICON_BUSY":
      return "An icon for this repo is already being fetched — try again in a moment.";
    case "ICON_TOO_LARGE":
      return "That image is too large to use.";
    case "INVALID_ICON":
      return "That image couldn't be used.";
    case "INVALID_EMOJI":
      return "Enter exactly one emoji.";
    case "INVALID_LABEL":
      return "That label can't be used.";
    case "INVALID_REPO_KEY":
      return "This repo can't have an icon.";
    case "ICON_NOT_FOUND":
      return "This repo has no image icon.";
    default:
      return null;
  }
}

export function repoIdentityErrorText(error: unknown, domain = ""): string {
  if (typeof error === "object" && error !== null) {
    const server = (error as { serverMessage?: unknown }).serverMessage;
    if (typeof server === "string" && server.trim().length > 0) return server.trim();
    const body = (error as { body?: unknown }).body;
    const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
    const text = typeof code === "string" ? codeText(code as RepoIdentityErrorCode, domain) : null;
    if (text !== null) return text;
    const status = (error as { status?: unknown }).status;
    if (status === 404) return "This daemon doesn't support repo icons yet — update it.";
    if (typeof status === "number") return `The daemon refused the change (${status}).`;
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message.trim();
  }
  return "Something went wrong.";
}
