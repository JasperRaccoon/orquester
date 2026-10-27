// The Insights view's pure parts (phase 2 spec, "Insights"): the request, the section heads and
// their counts, and the empty state. No React.

import type { KnowledgeInsightsQuery, KnowledgeInsightsResponse } from "@orquester/api";

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
