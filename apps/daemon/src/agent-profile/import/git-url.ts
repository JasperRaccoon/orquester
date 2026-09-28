/**
 * Agent profile imports — which Git URLs may be cloned (spec §6), and what to
 * clone for a browse URL.
 *
 * Accepted: `https://host/…`, `ssh://[user@]host/…`, the scp-like
 * `user@host:owner/repo(.git)`, and the GitHub-style tree URL
 * `https://host/<owner>/<repo>/tree/<ref>/<sub/path>` or the GitLab-style
 * `https://host/<group…>/<repo>/-/tree/<ref>/<sub/path>` (clone
 * `https://host/<…>/<repo>.git` at `<ref>`, scan only `<sub/path>`; a ref
 * with a `/` in it cannot be told apart from the path, so the ref is the first
 * segment after `tree`).
 *
 * Refused: `file://` and local paths, anything starting with `-` (an option to
 * git), whitespace and control characters, every other scheme (`http://`,
 * `git://`, `ext::`…), and any URL carrying credentials — a password, or for
 * `https://` any user name (GitHub takes a bare token as one). Credentials
 * never reach git's argv. A query or fragment is ignored.
 */

import { profileErrors } from "../errors.ts";

export interface GitImportSource {
  /** What `git clone` is given: credential-free, no query or fragment. */
  cloneUrl: string;
  /** A branch or tag from a tree URL. */
  ref?: string;
  /** The folder a tree URL names, `/`-joined, never `..`; the scan starts there. */
  subPath?: string;
  /** The repository's name (last segment without `.git`): names a skill at the repo root. */
  repoName: string;
}

const MAX_URL_LENGTH = 2048;
const MAX_REF_LENGTH = 250;
const UNSAFE_CHARS = /[\s\u0000-\u001f\u007f]/;
/** `user@host:path` — no scheme, no password, a host without a slash. */
const SCP_RE = /^([A-Za-z0-9._-]+)@([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):(?!\/\/)([^:]+)$/;
/** `user:secret@…` without a scheme: refused for its credentials rather than as a scheme. */
const BARE_CREDENTIALS_RE = /^[^/@:]+:[^/@]*@/;
const REF_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

const UNSUPPORTED = "Only https://, ssh:// and git@host:owner/repo URLs can be imported.";

function refuse(message: string): never {
  throw profileErrors.importFailed(message);
}

function repoNameOf(segment: string | undefined): string {
  return (segment ?? "").replace(/\.git$/i, "") || "repository";
}

function checkRef(ref: string): string {
  if (ref.length === 0 || ref.length > MAX_REF_LENGTH || !REF_RE.test(ref) || ref.includes("..") || ref.endsWith("/")) {
    refuse(`"${ref}" is not a branch or tag name that can be cloned.`);
  }
  return ref;
}

function checkSubPath(segments: string[]): string | undefined {
  for (const segment of segments) {
    if (segment === "." || segment === ".." || segment.includes("\\") || segment.includes("\0")) {
      refuse("The URL's folder path is not a plain path inside the repository.");
    }
  }
  return segments.length > 0 ? segments.join("/") : undefined;
}

/** `https://host/<repo segments>.git`, each segment re-encoded. */
function httpsCloneUrl(host: string, repo: string[]): string {
  const path = repo.map((segment) => encodeURIComponent(segment)).join("/");
  return `https://${host}/${path}${/\.git$/i.test(path) ? "" : ".git"}`;
}

/** A browse URL's repo, ref and folder; null when `segments` is not one. */
function treeParts(segments: string[]): { repo: string[]; ref: string; sub: string[] } | null {
  const gitlab = segments.indexOf("-");
  if (gitlab >= 2 && segments[gitlab + 1] === "tree" && segments.length > gitlab + 2) {
    return { repo: segments.slice(0, gitlab), ref: segments[gitlab + 2]!, sub: segments.slice(gitlab + 3) };
  }
  if (segments.length >= 4 && segments[2] === "tree") {
    return { repo: segments.slice(0, 2), ref: segments[3]!, sub: segments.slice(4) };
  }
  return null;
}

/** What to clone for `input`; throws 400 `IMPORT_FAILED` saying why a URL is refused. */
export function parseGitImportUrl(input: string): GitImportSource {
  const url = typeof input === "string" ? input.trim() : "";
  if (url.length === 0) refuse("Enter the Git URL to import from.");
  if (url.length > MAX_URL_LENGTH) refuse("The Git URL is too long.");
  if (url.startsWith("-")) refuse("The Git URL may not start with '-'.");
  if (UNSAFE_CHARS.test(url)) refuse("The Git URL may not contain spaces or control characters.");
  if (/^file:/i.test(url)) refuse("Local repositories (file://) cannot be imported.");
  if (url.startsWith("/") || url.startsWith(".") || url.startsWith("~") || /^[A-Za-z]:[\\/]/.test(url)) {
    refuse("Local paths cannot be imported; use the repository's https:// or ssh:// URL.");
  }

  const scp = SCP_RE.exec(url);
  if (scp !== null) {
    const path = scp[3]!;
    if (path.startsWith("-")) refuse("The Git URL's path may not start with '-'.");
    const segments = path.split("/").filter((segment) => segment.length > 0);
    return { cloneUrl: url, repoName: repoNameOf(segments.at(-1)) };
  }
  if (BARE_CREDENTIALS_RE.test(url) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    refuse("The Git URL may not contain credentials.");
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    refuse(UNSUPPORTED);
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "https:" && scheme !== "ssh:") refuse(UNSUPPORTED);
  if (parsed.password !== "" || (scheme === "https:" && parsed.username !== "")) {
    refuse("The Git URL may not contain credentials. Use an ssh:// URL or the host's own git credentials for a private repository.");
  }
  if (parsed.hostname === "" || parsed.host.startsWith("-") || parsed.username.startsWith("-")) refuse(UNSUPPORTED);

  let segments: string[];
  try {
    segments = parsed.pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    refuse("The Git URL's path is not valid.");
  }
  if (segments.length === 0) refuse("The Git URL names no repository.");
  if (segments[0]!.startsWith("-")) refuse("The Git URL's path may not start with '-'.");

  if (scheme === "https:") {
    const tree = treeParts(segments);
    if (tree !== null) {
      return {
        cloneUrl: httpsCloneUrl(parsed.host, tree.repo),
        ref: checkRef(tree.ref),
        subPath: checkSubPath(tree.sub),
        repoName: repoNameOf(tree.repo.at(-1))
      };
    }
  }
  const user = parsed.username !== "" ? `${parsed.username}@` : "";
  return { cloneUrl: `${scheme}//${user}${parsed.host}${parsed.pathname}`, repoName: repoNameOf(segments.at(-1)) };
}
