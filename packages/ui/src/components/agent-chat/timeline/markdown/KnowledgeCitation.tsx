import React from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, Waypoints } from "lucide-react";
import { KNOWLEDGE_GRAPH_PLUGIN_ID, type KnowledgeCollectionView } from "@orquester/api";

import { useOptionalApi } from "../../../../context/orquester-context";
import { cn } from "../../../../lib/cn";
import {
  checkKnowledgeCitation,
  useKnowledgeCitation,
  type KnowledgeCitationAnswer,
  type KnowledgeCitationSummary
} from "../../../../lib/knowledge/citations";
import { useKnowledgeCollections } from "../../../../lib/knowledge/store";
import { isGlobalPluginEnabled } from "../../../../lib/plugins-state";
import { useAppStore } from "../../../../store/app";
import { CollectionChip } from "../../../knowledge/parts";
import { entryByline, entryDate } from "../../../knowledge/knowledge.logic";

/**
 * A knowledge citation in an agent's answer (Knowledge Graph spec,
 * "Citations"): `[Title · @handle](orquester-knowledge:entry/<id>)` renders as
 * a small chip that opens the entry in the server-level Knowledge view.
 *
 * It is a `<button>`, never a link: there is no href to follow, so neither the
 * browser nor the desktop shell can treat it as an external URL. Whether the
 * entry still exists is asked when the chip is hovered, focused or clicked
 * (`lib/knowledge/citations.ts`); a deleted one is struck through. Hover, or
 * keyboard focus, opens a card with the entry's title, byline, date,
 * collections and opening lines, from that same answer (retrieval spec,
 * "Entry panel and citations"); Escape or leaving closes it. While the plugin
 * is off it is the link's plain text.
 */

const OPEN_DELAY_MS = 350;
const CLOSE_DELAY_MS = 150;
const CARD_GAP = 6;
const CARD_MARGIN = 8;
const CARD_WIDTH = 320;

interface CardPosition {
  left: number;
  top?: number;
  bottom?: number;
  maxWidth: number;
}

/** Below the chip when there is room (else above), kept inside the window. */
function placeCard(anchor: HTMLElement): CardPosition {
  // A chip that wraps has several boxes; the card hangs off the first.
  const rect = anchor.getClientRects()[0] ?? anchor.getBoundingClientRect();
  const maxWidth = Math.max(200, window.innerWidth - CARD_MARGIN * 2);
  const width = Math.min(CARD_WIDTH, maxWidth);
  const left = Math.min(Math.max(CARD_MARGIN, rect.left), Math.max(CARD_MARGIN, window.innerWidth - CARD_MARGIN - width));
  const spaceBelow = window.innerHeight - rect.bottom;
  const below = spaceBelow >= 200 || spaceBelow >= rect.top;
  return below ? { left, top: rect.bottom + CARD_GAP, maxWidth } : { left, bottom: window.innerHeight - rect.top + CARD_GAP, maxWidth };
}

function isFocusVisible(element: HTMLElement): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

function SummaryDetails({
  summary,
  collections
}: {
  summary: KnowledgeCitationSummary;
  collections: readonly KnowledgeCollectionView[] | null;
}): React.ReactElement {
  const meta = [entryByline(summary), entryDate(summary)].filter(Boolean).join(" · ");
  const labels = summary.collections
    .map((id) => collections?.find((c) => c.id === id))
    .filter((c): c is KnowledgeCollectionView => !!c);
  return (
    <>
      <p className="text-sm font-medium leading-snug text-neutral-100 [overflow-wrap:anywhere] line-clamp-3">
        {summary.title || "Untitled"}
      </p>
      {meta && <p className="mt-0.5 truncate text-xs text-neutral-400">{meta}</p>}
      {labels.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {labels.map((c) => (
            <CollectionChip key={c.id} name={c.name} color={c.color} />
          ))}
        </div>
      )}
      {summary.snippet && (
        <p className="mt-1.5 text-xs leading-snug text-neutral-400 [overflow-wrap:anywhere] line-clamp-2">
          {summary.snippet}
        </p>
      )}
    </>
  );
}

function CardBody({
  answer,
  pending,
  label,
  collections
}: {
  answer: KnowledgeCitationAnswer | undefined;
  pending: boolean;
  label: React.ReactNode;
  collections: readonly KnowledgeCollectionView[] | null;
}): React.ReactElement {
  if (answer?.state === "deleted") {
    return (
      <>
        <p className="flex items-baseline gap-1.5 text-sm text-neutral-500">
          <span className="min-w-0 truncate line-through">{label}</span>
          <span className="shrink-0 text-[0.6875rem] uppercase tracking-wide">deleted</span>
        </p>
        <p className="mt-1 text-xs text-neutral-500">This knowledge entry was deleted.</p>
      </>
    );
  }
  if (answer?.state === "exists" && answer.summary) return <SummaryDetails summary={answer.summary} collections={collections} />;
  return (
    <>
      <p className="text-sm font-medium leading-snug text-neutral-100 [overflow-wrap:anywhere]">{label}</p>
      {pending ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-xs text-neutral-500" role="status">
          <LoaderCircle size={12} aria-hidden className="animate-spin motion-reduce:animate-none" />
          Loading…
        </p>
      ) : answer === undefined ? (
        <p className="mt-1.5 text-xs text-neutral-500">Details are unavailable right now.</p>
      ) : null}
    </>
  );
}

export function KnowledgeCitation({ entryId, children }: { entryId: string; children?: React.ReactNode }): React.ReactElement {
  const on = useAppStore((state) => isGlobalPluginEnabled(state.plugins, KNOWLEDGE_GRAPH_PLUGIN_ID));
  const contextApi = useOptionalApi();
  const storeApi = useAppStore((state) => state.api);
  const api = contextApi ?? storeApi;
  const { answer, pending } = useKnowledgeCitation(entryId);
  const collections = useKnowledgeCollections()?.collections ?? null;
  const anchorRef = React.useRef<HTMLButtonElement>(null);
  const [open, setOpen] = React.useState(false);
  const [position, setPosition] = React.useState<CardPosition | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardId = React.useId();

  const clearTimer = React.useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  React.useEffect(() => clearTimer, [clearTimer]);
  const show = React.useCallback(
    (delay: number) => {
      clearTimer();
      if (delay === 0) setOpen(true);
      else timer.current = setTimeout(() => setOpen(true), delay);
    },
    [clearTimer]
  );
  const hide = React.useCallback(
    (delay: number) => {
      clearTimer();
      if (delay === 0) setOpen(false);
      else timer.current = setTimeout(() => setOpen(false), delay);
    },
    [clearTimer]
  );
  const reposition = React.useCallback(() => {
    if (anchorRef.current) setPosition(placeCard(anchorRef.current));
  }, []);

  // A passive effect (the static renderer warns on a layout one): the card stays hidden until placed.
  React.useEffect(() => {
    if (open) reposition();
    else setPosition(null);
  }, [open, reposition]);

  React.useEffect(() => {
    if (!open) return;
    // Escape closes the card without taking the key from the chat; window capture, so no other
    // Escape handler can hide it from us.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide(0);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, hide, reposition]);

  // The plugin turning off while the card is open.
  React.useEffect(() => {
    if (!on) hide(0);
  }, [on, hide]);

  if (!on) return <span data-knowledge-citation-text={entryId}>{children}</span>;

  const check = () => {
    if (api) void checkKnowledgeCitation(api, entryId);
  };
  const state = answer?.state ?? "unknown";
  const deleted = state === "deleted";
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        data-knowledge-citation={entryId}
        data-state={state}
        aria-describedby={open ? cardId : undefined}
        onPointerEnter={(event) => {
          check();
          // A tap opens the entry; a card would only stand in its way.
          if (event.pointerType !== "touch") show(OPEN_DELAY_MS);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType !== "touch") hide(CLOSE_DELAY_MS);
        }}
        onFocus={(event) => {
          check();
          if (isFocusVisible(event.currentTarget)) show(0);
        }}
        onBlur={() => hide(0)}
        onClick={(event) => {
          event.preventDefault();
          hide(0);
          check();
          useAppStore.getState().openKnowledgeEntry(entryId);
        }}
        className={cn(
          "mx-0.5 inline-flex max-w-full items-baseline gap-1 rounded-md border px-1.5 py-px align-baseline text-[0.8125rem] leading-[1.35]",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
          deleted
            ? "border-neutral-800 text-neutral-500"
            : "border-neutral-700 bg-neutral-900/70 text-neutral-200 hover:border-neutral-500 hover:text-neutral-50"
        )}
      >
        <Waypoints size={11} aria-hidden className="shrink-0 self-center text-info-300" />
        <span className={cn("min-w-0 truncate", deleted && "line-through")}>{children}</span>
        {deleted && <span className="shrink-0 text-[0.6875rem] uppercase tracking-wide text-neutral-500">deleted</span>}
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              id={cardId}
              role="tooltip"
              data-knowledge-citation-card={entryId}
              onPointerEnter={() => clearTimer()}
              onPointerLeave={() => hide(CLOSE_DELAY_MS)}
              style={{
                position: "fixed",
                left: position?.left ?? -9999,
                top: position?.top,
                bottom: position?.bottom,
                maxWidth: position?.maxWidth,
                visibility: position ? "visible" : "hidden"
              }}
              className="z-[120] w-80 rounded-lg border border-neutral-800 bg-neutral-900 p-3 text-left shadow-xl shadow-black/40"
            >
              <p className="mb-1 flex items-center gap-1 text-[11px] text-neutral-500">
                <Waypoints size={11} aria-hidden className="text-info-300" /> Knowledge
              </p>
              <CardBody answer={answer} pending={pending} label={children} collections={collections} />
              {!deleted && <p className="mt-2 text-[11px] text-neutral-600">Click to open in Knowledge</p>}
            </div>,
            document.body
          )
        : null}
    </>
  );
}
