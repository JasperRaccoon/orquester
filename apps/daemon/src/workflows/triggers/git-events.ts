// Automated workflows — git trigger event detection (spec §6.2), pure: one trigger's cursor + one
// poll's answer in, the cursor's next `seen` map and the events to fire out. The poller
// (git-poller.ts) owns timers, persistence and the host; nothing here does I/O.
//
// `seen` shapes (all in the one string→string map the cursor schema allows):
//   push     `refs/heads/<b>` → sha; `@default` → the default branch it was recorded for (branches: [])
//   tag      `refs/tags/<t>`  → the tag's own object sha (a moved tag is ignored, not re-fired)
//   release  `release:<id>`   → tag
//   PR       `pr:<n>`         → `<state>:<headSha>[:<cycle>]` (cycle = times reopened, absent = 0);
//                              `@high` → the highest PR number ever seen
//
// Dedup keys name the TRANSITION, not just the destination, so a legitimate return to an earlier
// state (a force-push rollback `B..A` after `A..B`, a PR closed again after a reopen) is a new key:
//   push `push:<ref>:<previousSha>..<sha>` (`..<sha>` for a new branch)
//   PR   `pr:<n>:opened:<headSha>`, else `pr:<n>:<action>:<prevHeadSha>..<headSha>[#<cycle>]`
// Keys written by older builds (`push:<ref>:<sha>`, `pr:<n>:<action>:<headSha>`) stay in the ring
// and simply never match again; the committed `seen` map is what prevents a re-fire after a crash.

import type { GitTriggerPayload } from "@orquester/api";
import type { GitPullRequestAction, GitTriggerEvent } from "@orquester/config";
import type { LsRemoteResult } from "../git-remote/index.ts";
import type { PullRequestInfo, ReleaseInfo } from "../../providers/types.ts";
import { matchesAnyGlob, matchesGlob } from "./glob.ts";

/** At most this many runs per trigger per poll; the rest are recorded as skipped (never a burst). */
export const MAX_FIRES_PER_POLL = 10;
/** The fired-key dedup ring, per trigger. */
const FIRED_RING_SIZE = 1000;
/** PR states remembered per trigger (most recently changed kept). */
const MAX_SEEN_PULL_REQUESTS = 2000;

export interface DetectedEvent {
  /** The dedup key (`push:<ref>:<prev>..<sha>`, `tag:<name>:<sha>`, `release:<id>`, `pr:<n>:<action>:<prev>..<headSha>`). */
  key: string;
  payload: GitTriggerPayload;
  text: string;
}

export interface Detection {
  seen: Record<string, string>;
  events: DetectedEvent[];
}

export interface RepoInfo {
  url: string;
  name: string;
}

const DEFAULT_KEY = "@default";
const HIGH_KEY = "@high";

const short = (sha: string): string => sha.slice(0, 7);

function versionCompare(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Equal shas, where one may be an abbreviation (Bitbucket Cloud lists 12 hex). */
export function sameSha(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  const n = Math.min(x.length, y.length);
  return n >= 7 && x.slice(0, n) === y.slice(0, n);
}

/** A stable fingerprint of the event filter: a change re-baselines the trigger. */
export function eventKeyOf(event: GitTriggerEvent): string {
  const sorted = (values: readonly string[] | undefined) =>
    Array.from(new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))).sort();
  switch (event.kind) {
    case "push":
      return JSON.stringify({ kind: "push", branches: sorted(event.branches) });
    case "tag":
      return JSON.stringify({ kind: "tag", pattern: event.pattern?.trim() ?? "" });
    case "release":
      return JSON.stringify({ kind: "release", includePrereleases: event.includePrereleases === true });
    case "pull_request":
      return JSON.stringify({ kind: "pull_request", actions: sorted(event.actions), baseBranches: sorted(event.baseBranches) });
    default: {
      const unhandled: never = event;
      return JSON.stringify(unhandled);
    }
  }
}

/**
 * Push: one event per matching branch whose head moved since the last poll (several pushes in
 * between are ONE event, `previousSha..sha`); a new matching branch fires with no `previousSha`;
 * a deleted branch is forgotten. `branches: []` watches the default branch; when it changes the
 * new branch is recorded silently. Null when nothing can be decided (the default branch unknown).
 */
export function detectPush(
  event: Extract<GitTriggerEvent, { kind: "push" }>,
  cursor: { baselined: boolean; seen: Record<string, string> },
  refs: LsRemoteResult,
  defaultBranch: string | undefined,
  repo: RepoInfo
): Detection | null {
  const patterns = event.branches.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);
  const seen: Record<string, string> = {};
  let names: string[];
  let baselined = cursor.baselined;
  if (patterns.length === 0) {
    if (defaultBranch === undefined) return null;
    if (cursor.seen[DEFAULT_KEY] !== defaultBranch) baselined = false;
    seen[DEFAULT_KEY] = defaultBranch;
    names = Object.hasOwn(refs.heads, defaultBranch) ? [defaultBranch] : [];
  } else {
    names = Object.keys(refs.heads).filter((name) => matchesAnyGlob(patterns, name));
  }
  const events: DetectedEvent[] = [];
  for (const branch of names.sort()) {
    const ref = `refs/heads/${branch}`;
    const sha = refs.heads[branch]!;
    const previous = Object.hasOwn(cursor.seen, ref) ? cursor.seen[ref] : undefined;
    seen[ref] = sha;
    if (!baselined || previous === sha) continue;
    events.push({
      key: `push:${ref}:${previous ?? ""}..${sha}`,
      payload: {
        kind: "git",
        event: "push",
        repo,
        ref,
        sha,
        ...(previous !== undefined ? { previousSha: previous } : {}),
        branch
      },
      text: `Push to ${branch} (${short(sha)})`
    });
  }
  return { seen, events };
}

/** Tag: one event per NEW matching tag (sorted as versions); moved and deleted tags fire nothing. */
export function detectTags(
  event: Extract<GitTriggerEvent, { kind: "tag" }>,
  cursor: { baselined: boolean; seen: Record<string, string> },
  refs: LsRemoteResult,
  repo: RepoInfo
): Detection {
  const pattern = event.pattern?.trim() ?? "";
  const seen: Record<string, string> = {};
  const fresh: string[] = [];
  for (const [name, tag] of Object.entries(refs.tags)) {
    if (pattern.length > 0 && !matchesGlob(pattern, name)) continue;
    const ref = `refs/tags/${name}`;
    seen[ref] = tag.sha;
    if (cursor.baselined && !Object.hasOwn(cursor.seen, ref)) fresh.push(name);
  }
  const events = fresh.sort(versionCompare).map((name): DetectedEvent => {
    const commit = refs.tags[name]!.commit;
    return {
      key: `tag:${name}:${commit}`,
      payload: { kind: "git", event: "tag", repo, ref: `refs/tags/${name}`, sha: commit, tag: name },
      text: `Tag ${name}`
    };
  });
  return { seen, events };
}

/**
 * Release (GitHub): one event per release not seen before — drafts never, pre-releases only when
 * asked for. A release is judged when it first becomes visible (a draft published, a pre-release
 * promoted). `sha` is empty: the listing names the tag, not its commit.
 */
export function detectReleases(
  event: Extract<GitTriggerEvent, { kind: "release" }>,
  cursor: { baselined: boolean; seen: Record<string, string> },
  items: readonly ReleaseInfo[],
  repo: RepoInfo
): Detection {
  const visible = items.filter((release) => !release.draft && (event.includePrereleases || !release.prerelease));
  const seen: Record<string, string> = {};
  const events: DetectedEvent[] = [];
  // The page is newest first; fire oldest first.
  for (const release of [...visible].reverse()) {
    const key = `release:${release.id}`;
    seen[key] = release.tag;
    if (!cursor.baselined || Object.hasOwn(cursor.seen, key)) continue;
    events.push({
      key,
      payload: {
        kind: "git",
        event: "release",
        repo,
        ref: `refs/tags/${release.tag}`,
        sha: "",
        tag: release.tag,
        release: {
          id: release.id,
          name: release.name,
          tag: release.tag,
          body: release.body,
          url: release.url,
          prerelease: release.prerelease
        }
      },
      text: `Release ${release.name || release.tag}`
    });
  }
  return { seen, events };
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Pull requests: `opened` = a PR number above the highest ever seen; `updated` = an open PR's head
 * sha changed; `merged` / `closed` = an open PR's state moved. A PR opened and settled between two
 * polls yields both. An unseen PR at or below the high-water mark is an old one that scrolled into
 * the page: recorded silently. The `baseBranches` globs filter on the target branch.
 */
export function detectPullRequests(
  event: Extract<GitTriggerEvent, { kind: "pull_request" }>,
  cursor: { baselined: boolean; seen: Record<string, string> },
  items: readonly PullRequestInfo[],
  repo: RepoInfo
): Detection {
  const seen: Record<string, string> = { ...cursor.seen };
  let baseHigh = Number(seen[HIGH_KEY] ?? "0");
  if (!Number.isFinite(baseHigh)) baseHigh = 0;
  // "Opened" is judged against the mark as it stood BEFORE this page: raising it while walking would
  // hide a lower-numbered new PR walked after a higher-numbered one.
  let high = baseHigh;
  const wanted = new Set<GitPullRequestAction>(event.actions);
  const bases = (event.baseBranches ?? []).map((base) => base.trim()).filter((base) => base.length > 0);
  const events: DetectedEvent[] = [];
  // Newest-updated first on the wire; walk oldest first so events come in the order they happened.
  for (const pr of [...items].reverse()) {
    const key = `pr:${pr.number}`;
    const previous = Object.hasOwn(seen, key) ? seen[key] : undefined;
    const actions: GitPullRequestAction[] = [];
    let prevSha = "";
    let cycle = 0;
    if (previous !== undefined) {
      const [prevState = "", sha = "", rawCycle = "0"] = previous.split(":");
      prevSha = sha;
      cycle = Number.parseInt(rawCycle, 10) || 0;
      if (prevState !== "open" && pr.state === "open") cycle += 1;
      if (cursor.baselined) {
        if (prevState === "open" && pr.state === "open" && !sameSha(prevSha, pr.headSha)) actions.push("updated");
        if (prevState === "open" && pr.state === "merged") actions.push("merged");
        if (prevState === "open" && pr.state === "closed") actions.push("closed");
      }
    } else if (cursor.baselined && pr.number > baseHigh) {
      actions.push("opened");
      if (pr.state === "merged") actions.push("merged");
      if (pr.state === "closed") actions.push("closed");
    }
    // Re-insert so the map's order is least-recently-changed first (eviction below).
    delete seen[key];
    seen[key] = cycle > 0 ? `${pr.state}:${pr.headSha}:${cycle}` : `${pr.state}:${pr.headSha}`;
    if (pr.number > high) high = pr.number;
    if (bases.length > 0 && !matchesAnyGlob(bases, pr.base)) continue;
    for (const action of actions) {
      if (!wanted.has(action)) continue;
      events.push({
        key:
          action === "opened"
            ? `pr:${pr.number}:opened:${pr.headSha}`
            : `pr:${pr.number}:${action}:${prevSha}..${pr.headSha}${cycle > 0 ? `#${cycle}` : ""}`,
        payload: {
          kind: "git",
          event: "pull_request",
          repo,
          ref: `refs/heads/${pr.head}`,
          sha: pr.headSha,
          branch: pr.head,
          pr: {
            number: pr.number,
            title: pr.title,
            body: pr.body,
            url: pr.url,
            author: pr.author,
            head: pr.head,
            base: pr.base,
            action,
            headSha: pr.headSha
          }
        },
        text: `PR #${pr.number} ${action} · ${oneLine(pr.title, 80)}`
      });
    }
  }
  seen[HIGH_KEY] = String(high);
  const prKeys = Object.keys(seen).filter((k) => k.startsWith("pr:"));
  for (const k of prKeys.slice(0, Math.max(0, prKeys.length - MAX_SEEN_PULL_REQUESTS))) delete seen[k];
  return { seen, events };
}

/** Appends `keys` to the ring, newest last, keeping the newest `FIRED_RING_SIZE`. */
export function pushFired(ring: readonly string[], keys: readonly string[]): string[] {
  const next = [...ring, ...keys];
  return next.length > FIRED_RING_SIZE ? next.slice(next.length - FIRED_RING_SIZE) : next;
}
