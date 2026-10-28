// The concept panel's phase 2 sections (phase 2 spec, "Concept panel"): the concepts merged into
// this one as duplicates, each merge with its Undo (confirmed first), and the similar concepts
// below the merge bar. Logic in `panel.logic.ts`.

import React, { useState } from "react";
import { Loader2, Undo2 } from "lucide-react";
import type { KnowledgeConceptDetail, KnowledgeConceptMergesResponse, KnowledgeConceptRef } from "@orquester/api";

import { Button } from "../ui";
// Directly, not through `../ui`: that index and confirm-dialog import each other, which a lazy chunk cannot split.
import { ConfirmDialog } from "../ui/confirm-dialog";
import { undoKnowledgeConceptMerge, type KnowledgeApi, type KnowledgeConceptMergeApi } from "../../lib/knowledge/store";
import { ErrorLine, SectionLabel } from "./parts";
import { knowledgeErrorText } from "./knowledge.logic";
import { findConceptMerge, similarityPercent, undoMergeMessage } from "./panel.logic";

/** The concept-merge routes; a client without both lists merges with no Undo. */
export interface KnowledgeConceptSectionsApi extends KnowledgeApi {
  listKnowledgeConceptMerges?(signal?: AbortSignal): Promise<KnowledgeConceptMergesResponse>;
  undoKnowledgeConceptMerge?(id: string): Promise<unknown>;
}

/** "Merged from": the duplicates folded into this concept, each with Undo. Nothing from an older daemon. */
export const MergedFrom: React.FC<{
  api: KnowledgeConceptSectionsApi | null;
  detail: Pick<KnowledgeConceptDetail, "concept" | "mergedFrom">;
  /** Read the concept again (the merge it lists is no longer in effect). */
  onRefresh: () => void;
}> = ({ api, detail, onRefresh }) => {
  const [confirming, setConfirming] = useState<KnowledgeConceptRef | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const merged = detail.mergedFrom ?? [];
  if (merged.length === 0) return null;
  const list = api?.listKnowledgeConceptMerges;
  const remove = api?.undoKnowledgeConceptMerge;
  const canUndo = api !== null && list !== undefined && remove !== undefined;

  const undo = async (ref: KnowledgeConceptRef) => {
    if (!api || !list || !remove) return;
    setConfirming(null);
    setBusy(ref.id);
    setError(null);
    try {
      // The concept answer names what was merged, not the merge: the merge list says which one it was.
      const { merges } = await list.call(api);
      const merge = findConceptMerge(merges, detail.concept.id, ref.id);
      if (!merge) {
        setError(`“${ref.name}” is no longer merged into this concept.`);
        onRefresh();
        return;
      }
      // `remove` is its own method: the client is a concept-merge client.
      await undoKnowledgeConceptMerge(api as KnowledgeConceptMergeApi, merge.id);
    } catch (err) {
      setError(`Could not undo the merge: ${knowledgeErrorText(err)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label="Merged from">
      <SectionLabel>Merged from</SectionLabel>
      <p className="mb-1.5 text-[11px] leading-relaxed text-neutral-500">Duplicates folded into this concept automatically; their names are its aliases.</p>
      <ul className="space-y-0.5">
        {merged.map((ref) => (
          <li key={ref.id} data-knowledge-merged={ref.id} className="flex items-center gap-2 rounded-md px-2 py-1">
            <span className="min-w-0 flex-1 truncate text-xs text-neutral-200" title={ref.type}>
              {ref.name}
            </span>
            {canUndo && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 shrink-0 px-2"
                title={`Make “${ref.name}” a concept of its own again`}
                disabled={busy !== null}
                onClick={() => setConfirming(ref)}
              >
                {busy === ref.id ? <Loader2 size={12} className="motion-safe:animate-spin" /> : <Undo2 size={12} />} Undo
              </Button>
            )}
          </li>
        ))}
      </ul>
      {error && <ErrorLine className="mt-1.5">{error}</ErrorLine>}
      <ConfirmDialog
        open={confirming !== null}
        title="Undo this merge?"
        message={confirming ? undoMergeMessage(detail.concept, confirming) : ""}
        confirmLabel="Undo merge"
        danger={false}
        onConfirm={() => {
          if (confirming) void undo(confirming);
        }}
        onCancel={() => setConfirming(null)}
      />
    </section>
  );
};

/**
 * "Positions": what each entry behind the concept says about it (the neutral summary's positions,
 * `KnowledgeConceptDetail.summary`), attributed; each opens its entry. Nothing without a summary.
 */
export const ConceptPositions: React.FC<{
  detail: Pick<KnowledgeConceptDetail, "summary">;
  onOpenEntry: (id: string) => void;
}> = ({ detail, onOpenEntry }) => {
  const positions = detail.summary?.positions ?? [];
  if (positions.length === 0) return null;
  return (
    <section aria-label="Positions">
      <SectionLabel>What each entry says</SectionLabel>
      <ul className="space-y-1.5">
        {positions.map((position) => (
          <li key={position.entryId} data-knowledge-position={position.entryId} className="rounded-md px-2 py-1">
            <button type="button" className="block w-full truncate text-left text-[11px] text-neutral-500 hover:underline" onClick={() => onOpenEntry(position.entryId)}>
              {position.author ?? "Unknown author"} · {position.title || "Untitled"}
            </button>
            <p className="text-xs leading-relaxed text-neutral-200">{position.claim}</p>
          </li>
        ))}
      </ul>
    </section>
  );
};

/** "Similar concepts": the same type, close in meaning but below the merge bar; each opens. Nothing from an older daemon. */
export const SimilarConcepts: React.FC<{
  detail: Pick<KnowledgeConceptDetail, "similarConcepts">;
  onOpen: (id: string) => void;
}> = ({ detail, onOpen }) => {
  const similar = detail.similarConcepts ?? [];
  if (similar.length === 0) return null;
  return (
    <section aria-label="Similar concepts">
      <SectionLabel>Similar concepts</SectionLabel>
      <ul className="space-y-0.5">
        {similar.map(({ concept, similarity }) => (
          <li key={concept.id}>
            <button
              type="button"
              data-knowledge-similar-concept={concept.id}
              onClick={() => onOpen(concept.id)}
              className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left hover:bg-neutral-900"
            >
              <span className="min-w-0 flex-1 truncate text-xs text-neutral-200">{concept.name}</span>
              <span className="shrink-0 text-[10.5px] tabular-nums text-neutral-500">{similarityPercent(similarity)}%</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
};
