// Cloning at a ref (spec §5.10): a temp workflow project is cloned at the workflow's or the git
// trigger's sha/branch/tag. Pure argument building, so the transport code stays in
// AccountsService and every step is testable with a fake exec.

/** Longest ref a request may name. */
export const MAX_CLONE_REF_LENGTH = 250;

/** Default ceiling on a whole clone (every step it takes). */
export const DEFAULT_CLONE_TIMEOUT_MS = 10 * 60_000;

/** Why `ref` may not name a clone ref, or null when it may. */
export function cloneRefProblem(ref: unknown): string | null {
  if (typeof ref !== "string" || ref.length === 0) {
    return "The ref must be a non-empty string.";
  }
  if (ref.length > MAX_CLONE_REF_LENGTH) {
    return `The ref may be at most ${MAX_CLONE_REF_LENGTH} characters.`;
  }
  if (ref.startsWith("-")) {
    return "The ref may not start with '-'.";
  }
  if (/[\s\u0000-\u001f\u007f]/.test(ref)) {
    return "The ref may not contain whitespace or control characters.";
  }
  return null;
}

/** A full commit id (SHA-1 or SHA-256): cloned, then checked out detached. */
export function isFullSha(ref: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(ref);
}

/** A ref that may be an abbreviated commit id — tried as a branch/tag first, then as a commit. */
export function mayBeAbbreviatedSha(ref: string): boolean {
  return /^[0-9a-f]{7,63}$/i.test(ref) && !isFullSha(ref);
}

/**
 * The `git clone` arguments (after any `-c` config): `--branch <ref>` for a branch or tag name,
 * nothing for a commit (checked out after the clone, `checkoutArgs`). The URL follows `--`.
 */
export function cloneArgs(url: string, destName: string, ref?: string): string[] {
  const branch = ref !== undefined && !isFullSha(ref) ? ["--branch", ref] : [];
  return ["clone", ...branch, "--", url, destName];
}

/** `git checkout --detach <commit>` in the clone. */
export function checkoutArgs(commit: string): string[] {
  return ["checkout", "--detach", commit];
}

/** Fetch one commit a plain clone did not bring (a PR head from a fork, an unreachable sha). */
export function fetchCommitArgs(commit: string): string[] {
  return ["fetch", "origin", commit];
}

/** True when a `clone --branch` failed because the remote has no such branch or tag. */
export function isMissingRemoteRef(stderr: string): boolean {
  return /Remote branch .* not found|couldn't find remote ref|not found in upstream/i.test(stderr);
}
