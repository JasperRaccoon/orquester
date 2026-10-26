// Shared fixtures for the knowledge store, wiring and Knowledge view tests.

import type {
  KnowledgeCollectionView,
  KnowledgeCollectionsResponse,
  KnowledgeEntry,
  KnowledgeEntrySummary,
  KnowledgeGraphNode,
  KnowledgeStatus,
  PluginInfo
} from "@orquester/api";

export function status(overrides: Partial<KnowledgeStatus> = {}): KnowledgeStatus {
  return {
    enabled: true,
    installed: true,
    entries: 2,
    concepts: 3,
    edges: 2,
    collections: 2,
    failedEntries: 0,
    linking: { state: "idle" },
    lastRun: null,
    recentRuns: [],
    workers: [],
    tokens: { week: { in: 0, out: 0 }, total: { in: 0, out: 0 } },
    lastError: null,
    ...overrides
  };
}

export function collection(overrides: Partial<KnowledgeCollectionView> = {}): KnowledgeCollectionView {
  return {
    id: "kc_seo",
    name: "SEO",
    description: "Ranking in search engines",
    color: "chart-1",
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-20T10:00:00.000Z",
    entryCount: 1,
    profiles: [],
    ...overrides
  };
}

export function collections(list: KnowledgeCollectionView[] = [collection(), collection({ id: "kc_ads", name: "Ads", color: "chart-2" })]): KnowledgeCollectionsResponse {
  return { collections: list, unfiledCount: 0, totalEntries: list.reduce((sum, c) => sum + c.entryCount, 0) };
}

export function entry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: "ke_aaaaaaaaaaaa",
    title: "Alternatives pages",
    kind: "post",
    author: "Hridoy",
    handle: "hridoyreh",
    url: "https://x.com/hridoyreh/status/1",
    postedAt: "2026-10-11",
    savedAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-20T10:00:00.000Z",
    savedFrom: { by: "agent", sessionId: "s1" },
    collections: ["kc_seo"],
    contentHash: "abc",
    linkState: "linked",
    body: "Make a page for every competitor: [competitor] vs [you].",
    ...overrides
  };
}

export function summary(overrides: Partial<KnowledgeEntrySummary> = {}): KnowledgeEntrySummary {
  const { body: _body, ...meta } = entry();
  return { ...meta, snippet: "Make a page for every competitor", linkCount: 2, citation: "[c](orquester-knowledge:entry/ke_aaaaaaaaaaaa)", ...overrides };
}

export function node(overrides: Partial<KnowledgeGraphNode> = {}): KnowledgeGraphNode {
  return { id: "tactic-alternatives", name: "Alternatives pages", type: "Tactic", confidence: 0.9, collections: ["kc_seo"], entryCount: 1, degree: 1, ...overrides };
}

export function knowledgePlugin(enabled: boolean, overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: "knowledge-graph",
    name: "Knowledge Graph",
    description: "",
    source: { label: "SenolIsci/mykg", url: "https://github.com/SenolIsci/mykg" },
    provider: "Community",
    scope: "global",
    updates: true,
    platform: "supported",
    enabled,
    enabledWorkspaces: [],
    current: null,
    previous: null,
    skippedVersion: null,
    lastCheckAt: null,
    lastError: null,
    job: "idle",
    ...overrides
  };
}

export const event = (channel: string, type: string, payload: unknown) => ({
  id: `${channel}:1`,
  channel,
  type,
  createdAt: "2026-10-20T10:00:00.000Z",
  payload
});

/** Settles every promise already queued (no timers). */
export const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};
