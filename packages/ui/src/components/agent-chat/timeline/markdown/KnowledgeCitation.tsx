import React from "react";
import { Waypoints } from "lucide-react";
import { KNOWLEDGE_GRAPH_PLUGIN_ID } from "@orquester/api";

import { useOptionalApi } from "../../../../context/orquester-context";
import { cn } from "../../../../lib/cn";
import { checkKnowledgeCitation, useKnowledgeCitationState } from "../../../../lib/knowledge/citations";
import { isGlobalPluginEnabled } from "../../../../lib/plugins-state";
import { useAppStore } from "../../../../store/app";

/**
 * A knowledge citation in an agent's answer (Knowledge Graph spec,
 * "Citations"): `[Title · @handle](orquester-knowledge:entry/<id>)` renders as
 * a small chip that opens the entry in the server-level Knowledge view.
 *
 * It is a `<button>`, never a link: there is no href to follow, so neither the
 * browser nor the desktop shell can treat it as an external URL. Whether the
 * entry still exists is asked when the chip is hovered, focused or clicked
 * (`lib/knowledge/citations.ts`); a deleted one is struck through. While the
 * plugin is off it is the link's plain text.
 */
export function KnowledgeCitation({ entryId, children }: { entryId: string; children?: React.ReactNode }): React.ReactElement {
  const on = useAppStore((state) => isGlobalPluginEnabled(state.plugins, KNOWLEDGE_GRAPH_PLUGIN_ID));
  const contextApi = useOptionalApi();
  const storeApi = useAppStore((state) => state.api);
  const api = contextApi ?? storeApi;
  const state = useKnowledgeCitationState(entryId);
  if (!on) return <span data-knowledge-citation-text={entryId}>{children}</span>;

  const check = () => {
    if (api) void checkKnowledgeCitation(api, entryId);
  };
  const deleted = state === "deleted";
  return (
    <button
      type="button"
      data-knowledge-citation={entryId}
      data-state={state}
      title={deleted ? "This knowledge entry was deleted" : "Open in Knowledge"}
      onPointerEnter={check}
      onFocus={check}
      onClick={(event) => {
        event.preventDefault();
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
  );
}
