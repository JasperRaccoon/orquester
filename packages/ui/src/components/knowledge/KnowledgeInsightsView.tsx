// The Knowledge view's Insights view (phase 2 spec, "Insights"): what crossing the concept graph
// with the similarity graph shows — entries that disagree, entries that bridge clusters, claims one
// entry alone backs, and entries close in meaning that share no concept. Each item opens its entry
// or concept in the side panel; the collection chips narrow it like the other views. A daemon that
// predates the route answers 404, and the Knowledge view then does not offer this view.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Lightbulb, Loader2, RefreshCw } from "lucide-react";
import type {
  KnowledgeBridge,
  KnowledgeCollectionView,
  KnowledgeConceptRef,
  KnowledgeContradiction,
  KnowledgeEntrySummary,
  KnowledgeInsightsQuery,
  KnowledgeInsightsResponse,
  KnowledgeLinkGap,
  KnowledgeSingleSource
} from "@orquester/api";

import { Button } from "../ui";
import { cn } from "../../lib/cn";
import { knowledgeStore } from "../../lib/knowledge/store";
import { CollectionChip, Centered, ErrorLine, PHONE_CHIP, PHONE_CHIP_ROW } from "./parts";
import { isMissingRoute } from "./graph.logic";
import { entryByline, knowledgeErrorText } from "./knowledge.logic";
import { clusterText, contradictionSourceText, similarityPercent } from "./panel.logic";
import { INSIGHTS_SECTIONS, insightsAreEmpty, insightsCountText, insightsQueryOf, type InsightsSectionKey } from "./insights.logic";
import type { KnowledgeSelection } from "./KnowledgePanel";

export interface KnowledgeInsightsApi {
  /** Absent from a client without it: the Insights view is not offered. */
  getKnowledgeInsights?(query?: KnowledgeInsightsQuery, signal?: AbortSignal): Promise<KnowledgeInsightsResponse>;
}

/** Per client: whether its daemon serves insights (one that predates them answers 404). */
const insightsSupport = new WeakMap<object, boolean>();

/**
 * Whether the daemon serves insights: null until known. While `enabled`, a one-item read asks,
 * unless the view's own read will (`viewReads`); the answer is remembered per client.
 */
export function useInsightsSupport(api: KnowledgeInsightsApi | null, enabled: boolean, viewReads: boolean): [boolean | null, (supported: boolean) => void] {
  const known = (): boolean | null => (api ? (api.getKnowledgeInsights ? (insightsSupport.get(api) ?? null) : false) : null);
  const [supported, setSupported] = useState<boolean | null>(known);
  const record = useCallback(
    (value: boolean) => {
      if (api) insightsSupport.set(api, value);
      setSupported(value);
    },
    [api]
  );
  useEffect(() => {
    setSupported(known());
    if (!api || !api.getKnowledgeInsights || insightsSupport.has(api) || !enabled || viewReads) return;
    const controller = new AbortController();
    api
      .getKnowledgeInsights({ limit: 1 }, controller.signal)
      .then(() => {
        if (!controller.signal.aborted) record(true);
      })
      .catch((error: unknown) => {
        // Any answer but "no such route" means the daemon has it (a refusal shows when it is used).
        if (!controller.signal.aborted) record(!isMissingRoute(error));
      });
    return () => controller.abort();
    // `known` reads `api`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, enabled, viewReads, record]);
  return [supported, record];
}

type Load =
  | { status: "loading"; insights: KnowledgeInsightsResponse | null }
  | { status: "ready"; insights: KnowledgeInsightsResponse }
  | { status: "error"; message: string; insights: KnowledgeInsightsResponse | null };

export interface KnowledgeInsightsViewProps {
  api: KnowledgeInsightsApi | null;
  collections: readonly KnowledgeCollectionView[];
  /** Collection ids it is narrowed to; empty = all. */
  filter: readonly string[];
  onFilter: (filter: string[]) => void;
  selection: KnowledgeSelection | null;
  onSelect: (selection: KnowledgeSelection) => void;
  /** The daemon has no insights route (it predates them). */
  onUnsupported: () => void;
  /** The daemon answered with insights. */
  onSupported?: () => void;
  toolbarEnd: React.ReactNode;
}

export const KnowledgeInsightsView: React.FC<KnowledgeInsightsViewProps> = ({
  api,
  collections,
  filter,
  onFilter,
  selection,
  onSelect,
  onUnsupported,
  onSupported,
  toolbarEnd
}) => {
  const [load, setLoad] = useState<Load>({ status: "loading", insights: null });
  const [tick, setTick] = useState(0);
  const retry = useCallback(() => setTick((t) => t + 1), []);
  // `knowledge.changed` (through the store's revisions): entries or the graph moved.
  useEffect(
    () =>
      knowledgeStore.subscribe((state, previous) => {
        if (state.graphRevision !== previous.graphRevision || state.entriesRevision !== previous.entriesRevision) setTick((t) => t + 1);
      }),
    []
  );
  const callbacks = useRef({ onUnsupported, onSupported });
  callbacks.current = { onUnsupported, onSupported };
  const filterKey = [...filter].sort().join(",");
  useEffect(() => {
    const read = api?.getKnowledgeInsights;
    if (!api || !read) return;
    const controller = new AbortController();
    setLoad((l) => ({ status: "loading", insights: l.insights }));
    read
      .call(api, insightsQueryOf(filterKey === "" ? [] : filterKey.split(",")), controller.signal)
      .then((insights) => {
        if (controller.signal.aborted) return;
        setLoad({ status: "ready", insights });
        callbacks.current.onSupported?.();
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (isMissingRoute(error)) {
          callbacks.current.onUnsupported();
          return;
        }
        setLoad((l) => ({ status: "error", message: knowledgeErrorText(error), insights: l.insights }));
      });
    return () => controller.abort();
  }, [api, filterKey, tick]);

  const toggleFilter = (id: string) => onFilter(filter.includes(id) ? filter.filter((f) => f !== id) : [...filter, id]);
  const openEntry = (id: string) => onSelect({ kind: "entry", id });
  const openConcept = (id: string) => onSelect({ kind: "concept", id });
  const selected = selection ? `${selection.kind}:${selection.id}` : null;
  const insights = load.insights;

  let body: React.ReactNode;
  if (!insights) {
    body =
      load.status === "error" ? (
        <Centered>
          <ErrorLine>{load.message}</ErrorLine>
          <Button size="sm" variant="outline" onClick={retry}>
            <RefreshCw size={13} /> Retry
          </Button>
        </Centered>
      ) : (
        <Centered>
          <Loader2 size={16} className="motion-safe:animate-spin" /> Looking for insights…
        </Centered>
      );
  } else if (insightsAreEmpty(insights)) {
    body = (
      <Centered>
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-800/80 text-neutral-500">
          <Lightbulb size={18} />
        </span>
        <p className="text-neutral-300">Nothing to point out yet</p>
        <p className="max-w-sm text-xs leading-relaxed text-neutral-500">
          Insights appear as entries are linked and embedded: entries that disagree, entries that bridge topics, claims only one entry backs, and entries
          that should share concepts.
        </p>
        {load.status === "error" && <ErrorLine className="max-w-md">{load.message}</ErrorLine>}
      </Centered>
    );
  } else {
    const link = { selected, openEntry, openConcept };
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="mx-auto max-w-3xl space-y-6">
          {load.status === "error" && (
            <div className="flex items-center gap-3">
              <ErrorLine className="flex-1">{load.message}</ErrorLine>
              <Button size="sm" variant="ghost" onClick={retry}>
                <RefreshCw size={12} /> Retry
              </Button>
            </div>
          )}
          {INSIGHTS_SECTIONS.map((section) => {
            const items = itemsOf(insights, section.key);
            return (
              <section key={section.key} aria-label={section.title} data-insights-section={section.key}>
                <div className="mb-0.5 flex items-baseline gap-2">
                  <h3 className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">{section.title}</h3>
                  <span data-insights-count className="text-[11px] tabular-nums text-neutral-500">
                    {insightsCountText(insights.totals[section.key], items.length)}
                  </span>
                </div>
                <p className="mb-2 text-[11.5px] leading-relaxed text-neutral-500">{section.hint}</p>
                {items.length === 0 ? (
                  <p className="text-xs text-neutral-500">{section.none}</p>
                ) : (
                  <ul className="space-y-1.5">
                    {section.key === "contradictions" &&
                      insights.contradictions.map((item) => <ContradictionItem key={`${item.a.id}|${item.b.id}`} item={item} {...link} />)}
                    {section.key === "bridges" && insights.bridges.map((item) => <BridgeItem key={item.entry.id} item={item} {...link} />)}
                    {section.key === "singleSource" &&
                      insights.singleSource.map((item) => <SingleSourceItem key={`${item.concept.id}|${item.entry.id}`} item={item} {...link} />)}
                    {section.key === "gaps" && insights.gaps.map((item) => <GapItem key={`${item.a.id}|${item.b.id}`} item={item} {...link} />)}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* On a phone: the title and the view toggle, then one sideways-scrolling row of chips. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <h2 className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-neutral-100">
          <Lightbulb size={14} className="text-neutral-400" /> Insights
        </h2>
        {load.status === "loading" && insights && <Loader2 size={13} aria-label="Refreshing" className="shrink-0 text-neutral-500 motion-safe:animate-spin" />}
        <div
          role="group"
          aria-label="Filter by collection"
          className={cn("flex min-w-0 items-center gap-1 md:min-w-[12rem] md:flex-1 md:flex-wrap max-md:order-last max-md:basis-full", PHONE_CHIP_ROW)}
        >
          <CollectionChip name="All" color={null} active={filter.length === 0} onClick={() => onFilter([])} dot={false} className={PHONE_CHIP} />
          {collections.map((c) => (
            <CollectionChip
              key={c.id}
              name={c.name}
              color={c.color}
              active={filter.includes(c.id)}
              onClick={() => toggleFilter(c.id)}
              title={c.description || undefined}
              className={PHONE_CHIP}
            />
          ))}
        </div>
        {toolbarEnd && <div className="ml-auto flex shrink-0 items-center">{toolbarEnd}</div>}
      </div>
      {body}
    </div>
  );
};

function itemsOf(insights: KnowledgeInsightsResponse, key: InsightsSectionKey): readonly unknown[] {
  return key === "contradictions" ? insights.contradictions : key === "bridges" ? insights.bridges : key === "singleSource" ? insights.singleSource : insights.gaps;
}

// ---------------------------------------------------------------------------
// Items (daemon text is rendered as text, never as HTML)
// ---------------------------------------------------------------------------

interface LinkProps {
  /** `kind:id` of the panel's item, marked where it appears. */
  selected: string | null;
  openEntry: (id: string) => void;
  openConcept: (id: string) => void;
}

const ITEM = "space-y-1.5 rounded-md border border-neutral-800 px-3 py-2";
const META = "text-[11px] text-neutral-500";

const EntryLink: React.FC<{ entry: KnowledgeEntrySummary; selected: string | null; onOpen: (id: string) => void; className?: string }> = ({
  entry,
  selected,
  onOpen,
  className
}) => {
  const byline = entryByline(entry);
  const current = selected === `entry:${entry.id}`;
  return (
    <button
      type="button"
      data-insight-entry={entry.id}
      aria-current={current || undefined}
      onClick={() => onOpen(entry.id)}
      className={cn("block min-w-0 max-w-full rounded px-1 py-0.5 text-left hover:bg-neutral-900", current && "bg-neutral-800/70", className)}
    >
      <span className="block truncate text-xs font-medium text-neutral-200">{entry.title || "Untitled"}</span>
      {byline && <span className="block truncate text-[11px] text-neutral-500">{byline}</span>}
    </button>
  );
};

const ConceptLink: React.FC<{ concept: KnowledgeConceptRef; selected: string | null; onOpen: (id: string) => void; strong?: boolean }> = ({
  concept,
  selected,
  onOpen,
  strong
}) => (
  <button
    type="button"
    data-insight-concept={concept.id}
    title={concept.type}
    aria-current={selected === `concept:${concept.id}` || undefined}
    onClick={() => onOpen(concept.id)}
    className={cn(
      "max-w-full truncate rounded-full border px-2 py-0.5 text-[11px] hover:border-neutral-600 hover:text-neutral-100 max-md:min-h-7",
      strong ? "border-neutral-700 font-medium text-neutral-100" : "border-neutral-800 text-neutral-300",
      selected === `concept:${concept.id}` && "border-neutral-500 bg-neutral-800"
    )}
  >
    {concept.name}
  </button>
);

const Concepts: React.FC<{ concepts: readonly KnowledgeConceptRef[] } & LinkProps> = ({ concepts, selected, openConcept }) =>
  concepts.length === 0 ? null : (
    <div className="flex flex-wrap gap-1">
      {concepts.map((concept) => (
        <ConceptLink key={concept.id} concept={concept} selected={selected} onOpen={openConcept} />
      ))}
    </div>
  );

/** Two entries side by side on a wide screen, one above the other on a phone. */
const EntryPair: React.FC<{ a: KnowledgeEntrySummary; b: KnowledgeEntrySummary; between: React.ReactNode } & LinkProps> = ({
  a,
  b,
  between,
  selected,
  openEntry
}) => (
  <div className="grid grid-cols-1 items-center gap-0.5 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:gap-2">
    <EntryLink entry={a} selected={selected} onOpen={openEntry} />
    <span className="px-1 text-[11px] text-neutral-500">{between}</span>
    <EntryLink entry={b} selected={selected} onOpen={openEntry} />
  </div>
);

const ContradictionItem: React.FC<{ item: KnowledgeContradiction } & LinkProps> = ({ item, ...link }) => (
  <li data-insight="contradiction" className={cn(ITEM, "border-danger/30")}>
    <EntryPair a={item.a} b={item.b} between={<span className="text-danger">disagrees with</span>} {...link} />
    {item.note && <p className="text-xs leading-relaxed text-neutral-300">{item.note}</p>}
    {item.pairs.length > 0 && (
      <ul aria-label="Clashing concepts" className="space-y-0.5">
        {item.pairs.map((pair) => (
          <li key={`${pair.from.id}|${pair.to.id}`} className="flex min-w-0 flex-wrap items-center gap-1">
            <ConceptLink concept={pair.from} selected={link.selected} onOpen={link.openConcept} />
            <span aria-label="contradicts" className="text-[11px] text-danger">
              ≠
            </span>
            <ConceptLink concept={pair.to} selected={link.selected} onOpen={link.openConcept} />
          </li>
        ))}
      </ul>
    )}
    <p className={META}>
      {contradictionSourceText(item.source)}
      {item.similarity !== null && ` · ${similarityPercent(item.similarity)}% similar`}
    </p>
  </li>
);

const BridgeItem: React.FC<{ item: KnowledgeBridge } & LinkProps> = ({ item, ...link }) => (
  <li data-insight="bridge" className={ITEM}>
    <EntryLink entry={item.entry} selected={link.selected} onOpen={link.openEntry} />
    {item.clusters.length > 0 && (
      <p className="text-[11.5px] leading-relaxed text-neutral-400">
        Links {item.clusters.length.toLocaleString("en-US")} {item.clusters.length === 1 ? "cluster" : "clusters"}:{" "}
        {item.clusters.map((cluster) => clusterText(cluster)).join(", ")}
      </p>
    )}
    <Concepts concepts={item.concepts} {...link} />
  </li>
);

const SingleSourceItem: React.FC<{ item: KnowledgeSingleSource } & LinkProps> = ({ item, ...link }) => (
  <li data-insight="single-source" className={ITEM}>
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <ConceptLink concept={item.concept} selected={link.selected} onOpen={link.openConcept} strong />
      <span className={META}>{item.concept.type}</span>
    </div>
    <div className="flex min-w-0 items-center gap-1">
      <span className={cn(META, "shrink-0")}>only in</span>
      <EntryLink entry={item.entry} selected={link.selected} onOpen={link.openEntry} className="flex-1" />
    </div>
    {item.cluster && <p className={META}>In {clusterText(item.cluster)}</p>}
  </li>
);

const GapItem: React.FC<{ item: KnowledgeLinkGap } & LinkProps> = ({ item, ...link }) => (
  <li data-insight="gap" className={ITEM}>
    <EntryPair a={item.a} b={item.b} between={`${similarityPercent(item.similarity)}% similar`} {...link} />
    <p className={META}>
      Share no concept yet
      {item.queued && (
        <>
          {" · "}
          <span data-insight-queued className="text-neutral-300">
            Queued for re-linking
          </span>
        </>
      )}
    </p>
  </li>
);
