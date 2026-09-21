/**
 * Agent host — the tiny semver comparison the OpenCode version gate needs
 * (spec §3.2 "Each adapter gates on a minimum CLI version at session start").
 *
 * No dependency is added for this (COORDINATION §1.5): the gate compares two
 * `major.minor.patch` triples and nothing else. Pre-release and build metadata
 * are parsed off and ignored — `1.18.5-rc.1` is treated as `1.18.5`, which is
 * the permissive direction and matches T3's `compareSemverVersions`.
 *
 * The gate matters more than it looks: `1.18.5` vs `1.18.31` is exactly the
 * case a lexicographic compare gets wrong.
 */

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)/;

/** `null` when no `x.y.z` can be read — which the gate treats as unsupported. */
export function parseSemver(value: string | null | undefined): Semver | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = SEMVER_RE.exec(value.trim());
  if (match === null) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

/** `-1 | 0 | 1`, or `null` when either side is unparseable. */
export function compareSemver(left: string, right: string): number | null {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (a === null || b === null) {
    return null;
  }
  if (a.major !== b.major) {
    return a.major < b.major ? -1 : 1;
  }
  if (a.minor !== b.minor) {
    return a.minor < b.minor ? -1 : 1;
  }
  if (a.patch !== b.patch) {
    return a.patch < b.patch ? -1 : 1;
  }
  return 0;
}

/**
 * The minimum this adapter was validated against (§4.1). An out-of-range CLI
 * is **refused with the required version in the message**, never started and
 * allowed to fail on the first unrecognised frame (§10).
 */
export const MINIMUM_OPENCODE_VERSION = "1.14.19";

/** The version the committed fixtures were captured from (§9 provenance). */
export const VALIDATED_OPENCODE_VERSION = "1.18.5";

export function meetsMinimumOpenCodeVersion(version: string | null | undefined): boolean {
  if (typeof version !== "string") {
    return false;
  }
  const compared = compareSemver(version, MINIMUM_OPENCODE_VERSION);
  return compared !== null && compared >= 0;
}

export function tooOldMessage(version: string | null): string {
  return version === null
    ? `Could not read an OpenCode version. Orquester requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.`
    : `OpenCode v${version} is too old. Upgrade to v${MINIMUM_OPENCODE_VERSION} or newer.`;
}
