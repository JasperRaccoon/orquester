import React from "react";
import { CornerDownRight, GitFork } from "lucide-react";

import type { ThreadLineage } from "@orquester/api";

import { cn } from "../../lib/cn";
import { lineageVerb } from "../../lib/agent-chat/lineage.logic";

/**
 * A child chat's relation at a glance (thread lineage, spec 2026-10-14 §6): a
 * fork's branch icon, a delegate's arrow, titled with whose it is — on the tab
 * strip and the sidebar's agent cards. Renders nothing for a tab with no parent.
 */
export function LineageMark({
  lineage,
  parentTitle,
  size = 11,
  className
}: {
  lineage: ThreadLineage | undefined;
  /** The parent tab's title; absent when that tab is closed. */
  parentTitle?: string | undefined;
  size?: number;
  className?: string;
}): React.ReactElement | null {
  if (!lineage) return null;
  const Icon = lineage.relation === "delegate" ? CornerDownRight : GitFork;
  const label = `${lineageVerb(lineage)} ${parentTitle ? `“${parentTitle}”` : "a closed chat"}`;
  return (
    <span
      className={cn("inline-flex shrink-0 items-center text-neutral-500", className)}
      role="img"
      title={label}
      aria-label={label}
      data-lineage={lineage.relation}
    >
      <Icon size={size} strokeWidth={1.8} aria-hidden />
    </span>
  );
}
