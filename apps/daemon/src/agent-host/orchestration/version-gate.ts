/**
 * Agent host — the minimum-CLI-version gate (spec §3.2).
 *
 * Ported from T3 Code (MIT): `apps/server/src/provider/opencodeRuntime.ts:42`
 * + `:143-177` (`MINIMUM_OPENCODE_VERSION`) and
 * `apps/server/src/provider/Layers/OpenCodeProvider.ts:472-494` (the same gate
 * on the CLI version).
 *
 * An out-of-range CLI is refused **with the required version in the message**
 * at session start, rather than started and allowed to fail on the first
 * unrecognised frame. A version the probe could not read is never a refusal —
 * we cannot tell, and refusing on "unknown" would make a working install
 * unusable.
 */

import type { AgentAdapterId } from "@orquester/api/agent-chat";

/**
 * Only OpenCode has a pinned floor in the spec; the other three declare their
 * validated range in their own adapter (§10). A `null` here means "no host-side
 * floor".
 */
export const MINIMUM_CLI_VERSIONS: Readonly<Record<AgentAdapterId, string | null>> = {
  claude: null,
  codex: null,
  opencode: "1.14.19",
  grok: null
};

/** Numeric-dotted comparison; a trailing pre-release tag is ignored. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value
      .trim()
      .replace(/^v/i, "")
      .split(/[-+]/, 1)[0]!
      .split(".")
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export interface VersionGateResult {
  ok: boolean;
  message?: string;
}

export function checkMinimumVersion(input: {
  adapter: AgentAdapterId;
  version: string | null | undefined;
  minimums?: Readonly<Record<AgentAdapterId, string | null>>;
}): VersionGateResult {
  const minimum = (input.minimums ?? MINIMUM_CLI_VERSIONS)[input.adapter];
  if (minimum === null || minimum === undefined) {
    return { ok: true };
  }
  const version = input.version;
  if (typeof version !== "string" || version.trim().length === 0) {
    // Unknown is not out-of-range.
    return { ok: true };
  }
  if (compareVersions(version, minimum) >= 0) {
    return { ok: true };
  }
  return {
    ok: false,
    message: `${input.adapter} ${version} is too old for chat: version ${minimum} or newer is required. Update it from Settings → Agents.`
  };
}
