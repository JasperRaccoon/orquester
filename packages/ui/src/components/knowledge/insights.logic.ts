// The Insights view's pure parts (phase 2 spec, "Insights"): the request, the section heads and
// their counts, and the empty state. No React.

import type { KnowledgeContradiction, KnowledgeEntrySummary, KnowledgeInsightsQuery, KnowledgeInsightsResponse } from "@orquester/api";

/** The insights a view asks for: the collections filtered to (empty = every one), the daemon's default list size. */
export function insightsQueryOf(collections: readonly string[]): KnowledgeInsightsQuery {
  return collections.length > 0 ? { collections: [...collections].sort().join(",") } : {};
}

export type InsightsSectionKey = keyof KnowledgeInsightsResponse["totals"];

export interface InsightsSection {
  key: InsightsSectionKey;
  title: string;
  /** One line under the title: what the list is. */
  hint: string;
  /** Without any. */
  none: string;
}

/** The four sections, in the order shown (contradictions first, as the agent tool lists them). */
export const INSIGHTS_SECTIONS: readonly InsightsSection[] = [
  {
    key: "contradictions",
    title: "Contradictions",
    hint: "Entries that disagree: their concepts contradict each other, or an agent checked the pair.",
    none: "No two entries disagree."
  },
  {
    key: "bridges",
    title: "Bridges",
    hint: "Entries whose concepts tie two or more clusters together.",
    none: "No entry links clusters yet."
  },
  {
    key: "singleSource",
    title: "Single source",
    hint: "Claims, rules and results that only one entry backs, in a topic others write about.",
    none: "Every claim has more than one source."
  },
  {
    key: "gaps",
    title: "Link gaps",
    hint: "Entries close in meaning that share no concept yet; both are re-linked with each other in view.",
    none: "No link gaps."
  }
];

/** A section's count beside its title: "12", or "20 of 37" when the list was cut. */
export function insightsCountText(total: number, shown: number): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  return shown < total ? `${fmt(shown)} of ${fmt(total)}` : fmt(total);
}

/** Whether there is nothing to show at all (every section empty). */
export function insightsAreEmpty(insights: Pick<KnowledgeInsightsResponse, "totals">): boolean {
  const { contradictions, bridges, singleSource, gaps } = insights.totals;
  return contradictions + bridges + singleSource + gaps === 0;
}

/** How a contradiction's side is named: its author, else its handle, else its title. */
function sideName(entry: Pick<KnowledgeEntrySummary, "author" | "handle" | "title">): string {
  const author = entry.author?.replace(/\s+/g, " ").trim();
  if (author) return author;
  const handle = entry.handle?.trim().replace(/^@+/, "");
  return handle ? `@${handle}` : entry.title || "Untitled";
}

/**
 * A contradiction's "also" lines: each entry once per side it joins ("Also with jason, against Alex
 * Nguyen:"), or one "also:" line of entries without sides (an older daemon).
 */
export function alsoRows(item: Pick<KnowledgeContradiction, "a" | "b" | "also" | "alsoJoins">): { key: string; label: string; entries: KnowledgeEntrySummary[] }[] {
  const joins = item.alsoJoins;
  if (joins && joins.a.length + joins.b.length > 0) {
    const [a, b] = [sideName(item.a), sideName(item.b)];
    return [
      ...(joins.a.length > 0 ? [{ key: "a", label: `Also with ${a}, against ${b}:`, entries: joins.a }] : []),
      ...(joins.b.length > 0 ? [{ key: "b", label: `Also with ${b}, against ${a}:`, entries: joins.b }] : [])
    ];
  }
  return item.also && item.also.length > 0 ? [{ key: "also", label: "also:", entries: item.also }] : [];
}
