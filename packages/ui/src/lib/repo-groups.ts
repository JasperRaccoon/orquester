/**
 * The open workspace's projects grouped by the repo they are clones of
 * (spec 2026-10-18 §1): one group per `ProjectSummary.repoKey`, then every
 * project without one under "OTHER PROJECTS". Pure — the sidebar feeds it the
 * store's projects, the repo identities, the search and the collapsed set.
 */

import type { ProjectSummary, RepoIdentity } from "@orquester/api";

import { matchesSidebarQuery } from "./opened-agents";

export interface RepoProjectGroup {
  repoKey: string;
  /** What the header shows: the custom label, else `defaultLabel`. */
  label: string;
  /** The remote's `owner/repo` (`repoName`), else the key without its host. */
  defaultLabel: string;
  /** A credential-free `origin` URL for a fresh clone; absent when no project carried one. */
  cloneUrl?: string;
  /** The group's rows, by name — narrowed by a search that matched only some of them. */
  projects: ProjectSummary[];
  /** Rows hidden under the header (never during a search, never for the active project's group). */
  collapsed: boolean;
  /** Shown expanded whatever its saved state: a search is on, or it holds the open project. */
  pinnedOpen: boolean;
}

export interface RepoGrouping {
  groups: RepoProjectGroup[];
  /** Projects with no remote repo, by name. */
  other: ProjectSummary[];
}

export interface GroupProjectsInput {
  /** The workspace's visible (unarchived) projects. */
  projects: readonly ProjectSummary[];
  identities: ReadonlyMap<string, Pick<RepoIdentity, "label">>;
  query: string;
  /** Collapsed repo keys (saved per device). */
  collapsed: ReadonlySet<string>;
  /** The open project's path, if any. */
  activePath?: string | null;
}

/** Project order: by name, as the daemon lists them. */
const byName = (a: ProjectSummary, b: ProjectSummary): number => a.name.localeCompare(b.name);

/** Group order: natural, case-insensitive. */
const naturally = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** `github.com/owner/repo` → `owner/repo`. */
function withoutHost(repoKey: string): string {
  const slash = repoKey.indexOf("/");
  return slash === -1 ? repoKey : repoKey.slice(slash + 1);
}

export function groupProjectsByRepo({
  projects,
  identities,
  query,
  collapsed,
  activePath
}: GroupProjectsInput): RepoGrouping {
  const searching = query.trim().length > 0;
  const byRepo = new Map<string, ProjectSummary[]>();
  const other: ProjectSummary[] = [];
  for (const project of projects) {
    if (project.repoKey) {
      const list = byRepo.get(project.repoKey) ?? [];
      list.push(project);
      byRepo.set(project.repoKey, list);
    } else if (matchesSidebarQuery(query, project.name)) {
      other.push(project);
    }
  }

  const groups: RepoProjectGroup[] = [];
  for (const [repoKey, members] of byRepo) {
    members.sort(byName);
    const defaultLabel = members.find((p) => p.repoName)?.repoName ?? withoutHost(repoKey);
    const label = identities.get(repoKey)?.label ?? defaultLabel;
    const shown = matchesSidebarQuery(query, label, defaultLabel, repoKey)
      ? members
      : members.filter((p) => matchesSidebarQuery(query, p.name));
    if (shown.length === 0) continue;
    const active = activePath ? members.find((p) => p.path === activePath) : undefined;
    const pinnedOpen = searching || active !== undefined;
    const cloneUrl = active?.cloneUrl ?? members.find((p) => p.cloneUrl)?.cloneUrl;
    groups.push({
      repoKey,
      label,
      defaultLabel,
      ...(cloneUrl ? { cloneUrl } : {}),
      projects: shown,
      collapsed: !pinnedOpen && collapsed.has(repoKey),
      pinnedOpen
    });
  }

  groups.sort((a, b) => naturally(a.label, b.label) || (a.repoKey < b.repoKey ? -1 : a.repoKey > b.repoKey ? 1 : 0));
  other.sort(byName);
  return { groups, other };
}
