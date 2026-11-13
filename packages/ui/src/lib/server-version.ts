import type { ServerInfoResponse } from "@orquester/api";

/**
 * The connected daemon's version for Settings → About: the short commit it runs (`abc1234`). The
 * package.json version is not shown — it never changes; the commit is the version. Null when the
 * daemon reports no commit (an older daemon, or a tree without git metadata or a deploy stamp).
 */
export function serverVersionLabel(info: Pick<ServerInfoResponse, "commit"> | null | undefined): string | null {
  if (!info) return null;
  return typeof info.commit === "string" && /^[0-9a-f]{7,}$/i.test(info.commit) ? info.commit.slice(0, 7) : null;
}
