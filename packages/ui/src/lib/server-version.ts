import type { ServerInfoResponse } from "@orquester/api";

/**
 * The connected daemon's version for Settings → About: `1.2.3 · abc1234` (short commit), either half
 * alone when the other is unknown, or null when the daemon reports neither (an older daemon).
 */
export function serverVersionLabel(info: Pick<ServerInfoResponse, "version" | "commit"> | null | undefined): string | null {
  if (!info) return null;
  const version = typeof info.version === "string" && info.version ? info.version : null;
  const commit = typeof info.commit === "string" && /^[0-9a-f]{7,}$/i.test(info.commit) ? info.commit.slice(0, 7) : null;
  if (version && commit) return `${version} · ${commit}`;
  return version ?? commit;
}
