/**
 * The "go to" palette's pure half: which sessions and projects a query
 * matches, and in what order.
 *
 * - **Matching**: every word of the query must appear somewhere in a row's
 *   fields (a session: its title, its project's name, its workspace; a
 *   project: its name, its workspace), case- and accent-insensitive. So
 *   "auth main" finds the auth chat in a project of the `main` workspace.
 * - **Ranking**: a field the query matches whole beats one it starts, which
 *   beats one where every word starts a word ("fix" in "Quick fix"), which
 *   beats a match inside a word ("fix" in "prefix"). A word-start match in any
 *   field beats a mid-word one in all of them; past that, the earlier field
 *   (the title before the project name) wins.
 * - **Ties** go to the most recent: a session's latest turn or this client's
 *   last visit, else its creation; a project's last interaction (the
 *   daemon's recent-projects list). Then the old order: the tab strip's.
 * - **Groups** stay (sessions, then projects), but the group holding the best
 *   match comes first, so the top row is always the best one. With no query
 *   the most recent lead each group.
 */

import type { ProjectSummary, SessionSummary } from "../../types";

/** Lower case, accents dropped, whitespace collapsed. */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

const ALPHANUMERIC = /[\p{L}\p{N}]/u;

// Adapted from T3 Code (MIT): apps/web/src/components/CommandPalette.logic.ts
function startsWord(field: string, token: string): boolean {
  for (let index = field.indexOf(token); index !== -1; index = field.indexOf(token, index + 1)) {
    if (index === 0 || !ALPHANUMERIC.test(field[index - 1]!)) return true;
  }
  return false;
}

/** How a query matches one field: 3 whole, 2 its start, 1 every word starts a word, 0 mid-word; null no match. */
export function rankField(field: string, normalizedQuery: string, tokens: readonly string[]): number | null {
  const normalized = normalizeSearchText(field);
  if (normalized.length === 0 || !tokens.every((token) => normalized.includes(token))) return null;
  if (normalized === normalizedQuery) return 3;
  if (normalized.startsWith(normalizedQuery)) return 2;
  if (tokens.every((token) => startsWord(normalized, token))) return 1;
  return 0;
}

/**
 * A row's rank over its fields (most important first), or null when some
 * word of the query is in none of them. Only the order of ranks means
 * anything.
 */
// Adapted from T3 Code (MIT): apps/web/src/components/CommandPalette.logic.ts
export function rankFields(fields: readonly string[], query: string): number | null {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return 0;
  const tokens = normalizedQuery.split(" ");
  const haystack = normalizeSearchText(fields.join(" "));
  if (!tokens.every((token) => haystack.includes(token))) return null;
  // Matched across fields only ("auth main"): the weakest rank there is.
  let best = 0;
  fields.forEach((field, index) => {
    const rank = rankField(field, normalizedQuery, tokens);
    if (rank === null) return;
    best = Math.max(best, (rank > 0 ? 10_000 : 0) + 1_000 - index * 100 + rank);
  });
  return best;
}

/** Milliseconds of an ISO stamp; 0 for none or garbage. */
function stampOf(value: string | null | undefined): number {
  if (!value) return 0;
  const at = Date.parse(value);
  return Number.isNaN(at) ? 0 : at;
}

/** When a session was last used: its latest turn, this client's last visit to it, else its creation. */
export function sessionRecency(
  session: Pick<SessionSummary, "createdAt" | "latestTurn">,
  visitedAt: string | undefined
): number {
  return Math.max(
    stampOf(session.createdAt),
    stampOf(session.latestTurn?.startedAt),
    stampOf(session.latestTurn?.completedAt),
    stampOf(visitedAt)
  );
}

export interface PaletteSession {
  session: SessionSummary;
  project: ProjectSummary;
}

export interface PaletteResults {
  sessions: PaletteSession[];
  projects: ProjectSummary[];
  /** "Active" for the empty query's projects with an open tab, else "Projects". */
  projectsLabel: string;
  /** The best match is a project: its group leads. */
  projectsFirst: boolean;
}

interface Ranked<T> {
  item: T;
  rank: number;
  recency: number;
  index: number;
}

function ranked<T>(items: readonly T[], fields: (item: T) => string[], recency: (item: T) => number, query: string): Ranked<T>[] {
  const out: Ranked<T>[] = [];
  items.forEach((item, index) => {
    const rank = rankFields(fields(item), query);
    if (rank !== null) out.push({ item, rank, recency: recency(item), index });
  });
  return out.sort((a, b) => b.rank - a.rank || b.recency - a.recency || a.index - b.index);
}

/**
 * What the palette lists for `query`. `sessions` and `projects` are the
 * visible ones (past the archived curtain), in their stable order: the tab
 * strip's, and workspace then name.
 */
export function paletteResults(input: {
  query: string;
  sessions: readonly PaletteSession[];
  projects: readonly ProjectSummary[];
  sessionRecency: (session: SessionSummary) => number;
  /** A project's last interaction, 0 when unknown. */
  projectRecency: (project: ProjectSummary) => number;
}): PaletteResults {
  const query = normalizeSearchText(input.query);
  const sessionFields = (row: PaletteSession) => [row.session.title, row.project.name, row.project.workspace];
  const projectFields = (project: ProjectSummary) => [project.name, project.workspace];
  const sessions = ranked(input.sessions, sessionFields, (row) => input.sessionRecency(row.session), query);

  if (query.length === 0) {
    // The "Active" set the sidebar shows (projects with an open tab); with
    // nothing open there is nothing to be active, so list everything instead.
    const active = new Set(input.sessions.map((row) => row.project.path));
    const activeProjects = input.projects.filter((project) => active.has(project.path));
    const shown = activeProjects.length > 0 ? activeProjects : input.projects;
    return {
      sessions: sessions.map((entry) => entry.item),
      projects: ranked(shown, projectFields, input.projectRecency, query).map((entry) => entry.item),
      projectsLabel: activeProjects.length > 0 ? "Active" : "Projects",
      projectsFirst: false
    };
  }

  const projects = ranked(input.projects, projectFields, input.projectRecency, query);
  return {
    sessions: sessions.map((entry) => entry.item),
    projects: projects.map((entry) => entry.item),
    projectsLabel: "Projects",
    projectsFirst: projects.length > 0 && (sessions.length === 0 || projects[0]!.rank > sessions[0]!.rank)
  };
}

/**
 * Where to emphasise the query in `text`: one `[start, end)` run per query
 * word, at a word start when there is one, merged where they touch. Plain
 * lower-casing (not the accent folding above), so offsets stay the text's own;
 * a word found only through folding is simply not marked.
 */
export function matchRanges(text: string, query: string): Array<[number, number]> {
  const lower = text.toLowerCase();
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const ranges: Array<[number, number]> = [];
  for (const token of tokens) {
    let at = -1;
    for (let index = lower.indexOf(token); index !== -1; index = lower.indexOf(token, index + 1)) {
      if (at === -1) at = index;
      if (index === 0 || !ALPHANUMERIC.test(lower[index - 1]!)) {
        at = index;
        break;
      }
    }
    if (at !== -1) ranges.push([at, at + token.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}
