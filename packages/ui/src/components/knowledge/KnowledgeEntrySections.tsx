// The entry panel's retrieval sections (retrieval spec, "Entry panel and citations (U2)"): the
// body as Markdown or plain text, the possible-duplicates banner with its merge, and the similar
// entries with their reasons. Logic in `panel.logic.ts`.

import React, { useState, useSyncExternalStore } from "react";
import { Copy, Gem, Loader2, Sparkles, Swords } from "lucide-react";
import type { KnowledgeConceptRef, KnowledgeEntry, KnowledgeEntryDetail, KnowledgeNovelty, KnowledgeSimilarEntry } from "@orquester/api";

import { Button } from "../ui";
// Directly, not through `../ui`: that index and confirm-dialog import each other, which a lazy chunk cannot split.
import { ConfirmDialog } from "../ui/confirm-dialog";
import { cn } from "../../lib/cn";
import { ChatMarkdown } from "../agent-chat/timeline/markdown/ChatMarkdown";
import { ErrorLine, SectionLabel } from "./parts";
import { entryByline } from "./knowledge.logic";
import {
  clusterText,
  contradictionSourceText,
  disagreements,
  distinctiveChips,
  duplicateText,
  isPlainTextBody,
  keepDuplicatePair,
  knowledgeMergePlan,
  markdownBodyPreview,
  mergeConfirmMessage,
  mergeErrorText,
  panelSessionVersion,
  reasonLabel,
  reasonTitle,
  setPlainTextBody,
  similarSection,
  subscribePanelSession,
  visibleDuplicates,
  type KnowledgeMergePlan
} from "./panel.logic";

function usePanelSession(): number {
  return useSyncExternalStore(subscribePanelSession, panelSessionVersion, panelSessionVersion);
}

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

const BODY_BOX = "rounded-md border border-neutral-800 bg-neutral-900/50 px-3 py-2.5";

/**
 * The entry's text through the chat's Markdown renderer (no raw HTML, filtered links), or as it
 * was saved with "Plain text" (remembered for the session). A long body renders its first part as
 * Markdown until "Show the rest".
 */
export const EntryBody: React.FC<{ body: string }> = ({ body }) => {
  usePanelSession();
  const plain = isPlainTextBody();
  const [full, setFull] = useState(false);
  const preview = full ? { text: body, rest: 0 } : markdownBodyPreview(body);
  return (
    <div className="space-y-1">
      <div className="flex justify-end">
        <button
          type="button"
          aria-pressed={plain}
          onClick={() => setPlainTextBody(!plain)}
          className={cn(
            "rounded px-1.5 py-0.5 text-[11px]",
            plain ? "bg-neutral-800 text-neutral-200" : "text-neutral-500 hover:text-neutral-300"
          )}
        >
          Plain text
        </button>
      </div>
      {plain ? (
        <div
          data-knowledge-body="plain"
          className={cn(BODY_BOX, "whitespace-pre-wrap break-words text-[13px] leading-relaxed text-neutral-200")}
        >
          {body}
        </div>
      ) : (
        <div data-knowledge-body="markdown" className={BODY_BOX}>
          {/* Saved posts are third-party text: their remote images wait for a click (no tracking pixel fires on open). */}
          <ChatMarkdown text={preview.text} remoteImages="click" className="text-[13px] text-neutral-200" />
          {preview.rest > 0 && (
            <button
              type="button"
              onClick={() => setFull(true)}
              className="mt-2 text-xs text-info-300 hover:underline hover:decoration-dotted"
            >
              Show the rest ({preview.rest.toLocaleString("en-US")} more characters)
            </button>
          )}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Possible duplicates
// ---------------------------------------------------------------------------

/** "Looks like the same content as <Title> (95%)", with Open, Merge and Keep both. */
export const DuplicatesBanner: React.FC<{
  entry: KnowledgeEntry;
  detail: Pick<KnowledgeEntryDetail, "entry" | "possibleDuplicates">;
  canMerge: boolean;
  onOpen: (id: string) => void;
  /** Runs the merge (resolves once done, rejects with what failed). */
  onMerge: (plan: KnowledgeMergePlan) => Promise<void>;
}> = ({ entry, detail, canMerge, onOpen, onMerge }) => {
  usePanelSession();
  const [confirming, setConfirming] = useState<KnowledgeMergePlan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const duplicates = visibleDuplicates(detail);
  if (duplicates.length === 0) return null;

  const merge = async (plan: KnowledgeMergePlan) => {
    setConfirming(null);
    setBusy(plan.keep.id === entry.id ? plan.remove.id : plan.keep.id);
    setError(null);
    try {
      await onMerge(plan);
    } catch (err) {
      setError(mergeErrorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label="Possible duplicates" className="space-y-2 rounded-md border border-warn/30 bg-warn/5 px-3 py-2.5">
      {duplicates.map((item) => (
        <DuplicateRow
          key={item.entry.id}
          item={item}
          busy={busy !== null}
          merging={busy === item.entry.id}
          canMerge={canMerge}
          onOpen={() => onOpen(item.entry.id)}
          onMerge={() => setConfirming(knowledgeMergePlan(entry, item.entry))}
          onKeepBoth={() => keepDuplicatePair(entry.id, item.entry.id)}
        />
      ))}
      {error && <ErrorLine>{error}</ErrorLine>}
      <ConfirmDialog
        open={confirming !== null}
        title="Merge these entries?"
        message={confirming ? mergeConfirmMessage(confirming) : ""}
        confirmLabel="Merge"
        onConfirm={() => {
          if (confirming) void merge(confirming);
        }}
        onCancel={() => setConfirming(null)}
      />
    </section>
  );
};

const DuplicateRow: React.FC<{
  item: KnowledgeSimilarEntry;
  busy: boolean;
  merging: boolean;
  canMerge: boolean;
  onOpen: () => void;
  onMerge: () => void;
  onKeepBoth: () => void;
}> = ({ item, busy, merging, canMerge, onOpen, onMerge, onKeepBoth }) => {
  const { title, percent } = duplicateText(item);
  return (
    <div className="space-y-1.5">
      <p className="flex items-start gap-1.5 text-xs text-neutral-200">
        <Copy size={13} aria-hidden className="mt-px shrink-0 text-warn" />
        <span className="min-w-0">
          Looks like the same content as <span className="font-medium text-neutral-100">{title}</span>
          {percent !== null && <span className="text-neutral-400"> ({percent}%)</span>}
        </span>
      </p>
      <div className="flex flex-wrap gap-1.5 pl-5">
        <Button size="sm" variant="outline" onClick={onOpen} disabled={busy}>
          Open
        </Button>
        <Button size="sm" variant="outline" onClick={onMerge} disabled={busy || !canMerge}>
          {merging && <Loader2 size={12} className="motion-safe:animate-spin" />} Merge
        </Button>
        <Button size="sm" variant="ghost" onClick={onKeepBoth} disabled={busy}>
          Keep both
        </Button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Disagreements and novelty (phase 2 spec)
// ---------------------------------------------------------------------------

/** A concept as a small chip that opens it. */
const ConceptChip: React.FC<{ concept: KnowledgeConceptRef; onOpen: (id: string) => void }> = ({ concept, onOpen }) => (
  <button
    type="button"
    title={concept.type}
    onClick={() => onOpen(concept.id)}
    className="max-w-full truncate rounded-full border border-neutral-800 px-1.5 py-px text-[10.5px] text-neutral-300 hover:border-neutral-600 hover:text-neutral-100"
  >
    {concept.name}
  </button>
);

/** "Disagrees with": entries that contradict this one, each with the note and the concepts that clash. */
export const Disagreements: React.FC<{
  detail: Pick<KnowledgeEntryDetail, "entry" | "similar">;
  onOpen: (id: string) => void;
  onOpenConcept: (id: string) => void;
}> = ({ detail, onOpen, onOpenConcept }) => {
  const items = disagreements(detail);
  if (items.length === 0) return null;
  return (
    <section aria-label="Disagrees with">
      <SectionLabel>Disagrees with</SectionLabel>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item.entry.id} data-knowledge-disagrees={item.entry.id} className="space-y-1 rounded-md border border-danger/30 bg-danger/5 px-2.5 py-2">
            <button type="button" onClick={() => onOpen(item.entry.id)} className="flex w-full items-start gap-1.5 text-left">
              <Swords size={12} aria-hidden className="mt-0.5 shrink-0 text-danger" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-neutral-200 hover:underline">{item.entry.title || "Untitled"}</span>
                {entryByline(item.entry) && <span className="block truncate text-[11px] text-neutral-500">{entryByline(item.entry)}</span>}
              </span>
            </button>
            {item.note && <p className="pl-[18px] text-xs leading-relaxed text-neutral-300">{item.note}</p>}
            {item.pairs.length > 0 && (
              <ul aria-label="Clashing concepts" className="space-y-0.5 pl-[18px]">
                {item.pairs.map((pair) => (
                  <li key={`${pair.from.id}|${pair.to.id}`} className="flex min-w-0 flex-wrap items-center gap-1">
                    <ConceptChip concept={pair.from} onOpen={onOpenConcept} />
                    <span aria-label="contradicts" className="text-[10.5px] text-danger">
                      ≠
                    </span>
                    <ConceptChip concept={pair.to} onOpen={onOpenConcept} />
                  </li>
                ))}
              </ul>
            )}
            <p className="pl-[18px] text-[10.5px] text-neutral-500">{contradictionSourceText(item.source)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
};

/** "New here: A, B · Part of “Paywalls” (12 entries)" — what only this entry brings, and its cluster. */
export const NoveltyLine: React.FC<{ novelty: KnowledgeNovelty | undefined; onOpenConcept: (id: string) => void }> = ({ novelty, onOpenConcept }) => {
  if (!novelty || (novelty.newConcepts.length === 0 && !novelty.cluster)) return null;
  return (
    <div data-knowledge-novelty className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-neutral-400">
      {novelty.newConcepts.length > 0 && (
        <>
          <span className="inline-flex items-center gap-1 text-neutral-300">
            <Gem size={11} aria-hidden className="text-info" /> New here:
          </span>
          {novelty.newConcepts.map((concept) => (
            <ConceptChip key={concept.id} concept={concept} onOpen={onOpenConcept} />
          ))}
        </>
      )}
      {novelty.cluster && (
        <span className="min-w-0">
          {novelty.newConcepts.length > 0 ? "· " : ""}Part of {clusterText(novelty.cluster)}
        </span>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Similar entries
// ---------------------------------------------------------------------------

/** Entries related by meaning, concepts or author, each with its reasons, and "More like this". */
export const SimilarEntries: React.FC<{
  detail: Pick<KnowledgeEntryDetail, "entry" | "related" | "similar">;
  onOpen: (id: string) => void;
  onFindSimilar?: ((entryId: string) => void) | undefined;
}> = ({ detail, onOpen, onFindSimilar }) => {
  const { items } = similarSection(detail);
  if (items.length === 0 && !onFindSimilar) return null;
  return (
    <section aria-label="Similar entries">
      <div className="mb-1.5 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <SectionLabel>Similar</SectionLabel>
        </div>
        {onFindSimilar && (
          <Button size="sm" variant="ghost" className="-mt-1.5 h-6 px-2" onClick={() => onFindSimilar(detail.entry.id)}>
            <Sparkles size={12} /> More like this
          </Button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-neutral-500">Nothing similar yet.</p>
      ) : (
        <ul className="space-y-1">
          {items.map((item) => (
            <li key={item.entry.id}>
              <button
                type="button"
                data-knowledge-similar={item.entry.id}
                onClick={() => onOpen(item.entry.id)}
                className="w-full rounded-md px-2 py-1.5 text-left hover:bg-neutral-900"
              >
                <span className="block truncate text-xs text-neutral-200">{item.entry.title || "Untitled"}</span>
                {entryByline(item.entry) && <span className="block truncate text-[11px] text-neutral-500">{entryByline(item.entry)}</span>}
                {item.reasons.length > 0 && (
                  <span className="mt-1 flex flex-wrap gap-1">
                    {item.reasons.map((reason) => (
                      <React.Fragment key={reason.kind}>
                        <span
                          title={reasonTitle(reason)}
                          className={cn(
                            "max-w-full truncate rounded-full border px-1.5 py-px text-[10.5px]",
                            reason.kind === "contradicts" ? "border-danger/40 text-danger" : "border-neutral-800 text-neutral-400"
                          )}
                        >
                          {reasonLabel(reason)}
                        </span>
                        {distinctiveChips(reason).map(({ concept, label }) => (
                          <span
                            key={`distinctive:${concept.id}`}
                            data-knowledge-distinctive={concept.id}
                            title={`${concept.type}: few entries share it`}
                            className="inline-flex max-w-full items-center gap-0.5 truncate rounded-full border border-info/40 px-1.5 py-px text-[10.5px] text-info"
                          >
                            <Gem size={9} aria-hidden className="shrink-0" />
                            <span className="truncate">{label}</span>
                          </span>
                        ))}
                      </React.Fragment>
                    ))}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
