// The List view's cards: an entry (plain, or a search hit with its highlighted terms, match band,
// "via" badges and passage), a concept hit, and the "Rediscover" strip. Cards that are results carry
// `data-knowledge-result` so the list can move between them with ↑/↓.

import React from "react";
import { History, Link2, ThumbsDown, Waypoints, X } from "lucide-react";
import type { KnowledgeCollectionView, KnowledgeEntryMatch, KnowledgeEntrySummary, KnowledgeMatchBand, KnowledgeSearchHit } from "@orquester/api";

import { IconButton } from "../ui";
import { Badge, type Tone } from "../settings/primitives";
import { cn } from "../../lib/cn";
import { CollectionChip } from "./parts";
import { BAND_LABEL, entryByline, entryDate, highlightParts, passageText, viaBadges } from "./knowledge.logic";

/** The attribute ↑/↓ moves between. */
export const RESULT_ATTRIBUTE = "data-knowledge-result";
const RESULT_PROPS = { [RESULT_ATTRIBUTE]: "" };

/** Text with the query's matched terms marked — as elements, never HTML. */
export const Highlighted: React.FC<{ text: string; terms: readonly string[] }> = ({ text, terms }) => (
  <>
    {highlightParts(text, terms).map((part, index) =>
      part.match ? (
        <mark key={index} className="rounded-[2px] bg-warn-soft/50 px-px text-neutral-100">
          {part.text}
        </mark>
      ) : (
        <React.Fragment key={index}>{part.text}</React.Fragment>
      )
    )}
  </>
);

const BAND_TONE: Record<KnowledgeMatchBand, Tone> = { strong: "ok", good: "info", weak: "neutral" };

const MatchLine: React.FC<{ match: KnowledgeEntryMatch }> = ({ match }) => {
  const passage = passageText(match);
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge tone={BAND_TONE[match.band]} title={match.band === "weak" ? "A loose match: check it before relying on it." : undefined}>
        {BAND_LABEL[match.band]}
      </Badge>
      {viaBadges(match).map((badge) => (
        <span key={badge.key} className="inline-flex max-w-[14rem] items-center truncate rounded-full border border-neutral-800 px-1.5 py-px text-[10px] text-neutral-400">
          {badge.label}
        </span>
      ))}
      {passage && <span className="text-[10.5px] text-neutral-500">{passage}</span>}
    </span>
  );
};

const LinkState: React.FC<{ entry: KnowledgeEntrySummary }> = ({ entry }) => (
  <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-neutral-500">
    {entry.linkState === "pending" ? (
      "Not linked yet"
    ) : entry.linkState === "failed" ? (
      <span className="text-warn">Linking failed</span>
    ) : (
      <>
        <Link2 size={11} /> {entry.linkCount} {entry.linkCount === 1 ? "link" : "links"}
      </>
    )}
  </span>
);

export const EntryCard: React.FC<{
  entry: KnowledgeEntrySummary;
  collections: readonly KnowledgeCollectionView[];
  selected: boolean;
  onSelect: () => void;
  /** A search hit's explanation (absent from the plain list and from an older daemon). */
  match?: KnowledgeEntryMatch;
  /** "Less like this" (a "More like this" search only). */
  onLessLike?: () => void;
}> = ({ entry, collections, selected, onSelect, match, onLessLike }) => {
  const byline = entryByline(entry);
  const date = entryDate(entry);
  const chips = entry.collections.map((id) => collections.find((c) => c.id === id)).filter((c): c is KnowledgeCollectionView => !!c);
  const terms = match?.terms ?? [];
  const title = entry.title || "Untitled";
  return (
    <li className="group relative">
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        {...RESULT_PROPS}
        className={cn(
          "w-full space-y-1.5 rounded-lg border px-3.5 py-3 text-left transition-colors",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
          selected ? "border-neutral-600 bg-neutral-900" : "border-neutral-800 hover:border-neutral-700 hover:bg-neutral-900/60"
        )}
      >
        <span className={cn("block text-[13px] font-medium leading-snug text-neutral-100", onLessLike ? "pr-7" : null)}>
          <Highlighted text={title} terms={terms} />
        </span>
        {(byline || date) && <span className="block text-[11.5px] text-neutral-500">{[byline, date].filter(Boolean).join(" · ")}</span>}
        {entry.snippet && (
          <span className="line-clamp-2 block text-xs leading-relaxed text-neutral-400">
            <Highlighted text={entry.snippet} terms={terms} />
          </span>
        )}
        {match && <MatchLine match={match} />}
        <span className="flex flex-wrap items-center gap-1 pt-0.5">
          {chips.length === 0 ? <CollectionChip name="Unfiled" color={null} /> : chips.map((c) => <CollectionChip key={c.id} name={c.name} color={c.color} />)}
          <LinkState entry={entry} />
        </span>
      </button>
      {/* Faded, not `invisible`: a hidden button could never take keyboard focus. Always shown on touch screens. */}
      {onLessLike && (
        <IconButton
          label={`Less like “${title}”`}
          onClick={onLessLike}
          className="absolute right-1.5 top-1.5 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 max-md:opacity-100"
        >
          <ThumbsDown size={13} />
        </IconButton>
      )}
    </li>
  );
};

export const ConceptHitCard: React.FC<{
  hit: Extract<KnowledgeSearchHit, { kind: "concept" }>;
  selected: boolean;
  onSelect: () => void;
}> = ({ hit, selected, onSelect }) => {
  const from = hit.entries?.map((e) => e.title || "Untitled") ?? [];
  const count = hit.entries?.length ?? hit.entryIds.length;
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        {...RESULT_PROPS}
        className={cn(
          "w-full space-y-1 rounded-lg border border-dashed px-3.5 py-2.5 text-left transition-colors",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
          selected ? "border-neutral-600 bg-neutral-900" : "border-neutral-800 hover:border-neutral-700 hover:bg-neutral-900/60"
        )}
      >
        <span className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wide text-neutral-500">
          <Waypoints size={11} /> Concept · {hit.concept.type}
        </span>
        <span className="block text-[13px] font-medium leading-snug text-neutral-100">{hit.concept.name}</span>
        {hit.concept.description && <span className="line-clamp-2 block text-xs leading-relaxed text-neutral-400">{hit.concept.description}</span>}
        {count > 0 && (
          <span className="block truncate text-[11px] text-neutral-500">
            {from.length > 0 ? `From ${from.join(", ")}` : `From ${count} ${count === 1 ? "entry" : "entries"}`}
          </span>
        )}
      </button>
    </li>
  );
};

/** Older entries close to what was saved this week; dismissible for the session. */
export const RediscoverStrip: React.FC<{
  entries: readonly KnowledgeEntrySummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDismiss: () => void;
}> = ({ entries, selectedId, onSelect, onDismiss }) => (
  <section aria-label="Rediscover" className="mx-auto mb-3 max-w-3xl rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2.5">
    <div className="mb-2 flex items-center gap-2">
      <History size={13} className="shrink-0 text-neutral-500" />
      <h3 className="text-[12px] font-medium text-neutral-200">Rediscover</h3>
      <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-500">Older entries close to what you saved this week</span>
      <IconButton label="Dismiss Rediscover" onClick={onDismiss} className="h-6 w-6 shrink-0">
        <X size={12} />
      </IconButton>
    </div>
    <ul className="flex gap-2 overflow-x-auto pb-0.5">
      {entries.map((entry) => {
        const meta = [entryByline(entry), entryDate(entry)].filter(Boolean).join(" · ");
        return (
          <li key={entry.id} className="w-56 shrink-0 max-sm:w-44">
            <button
              type="button"
              aria-pressed={selectedId === entry.id}
              onClick={() => onSelect(entry.id)}
              className={cn(
                "h-full w-full space-y-0.5 rounded-md border px-2.5 py-2 text-left transition-colors",
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
                selectedId === entry.id ? "border-neutral-600 bg-neutral-900" : "border-neutral-800 hover:border-neutral-700 hover:bg-neutral-900/60"
              )}
            >
              <span className="line-clamp-2 block text-[12px] font-medium leading-snug text-neutral-100">{entry.title || "Untitled"}</span>
              {meta && <span className="block truncate text-[10.5px] text-neutral-500">{meta}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  </section>
);
