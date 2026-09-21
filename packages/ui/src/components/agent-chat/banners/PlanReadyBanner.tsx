// Ported from T3 Code (MIT): apps/web/src/components/chat/ComposerPlanFollowUpBanner.tsx
import React from "react";
import { ClipboardList } from "lucide-react";

import { BannerCard } from "../primitives";

export interface PlanReadyBannerProps {
  /** The plan's first heading, when it has one. */
  planTitle: string | null;
}

/**
 * "Plan ready".
 *
 * Deliberately the quietest card in the dock: nothing is blocked, the agent is
 * simply waiting to be told to go. It carries **no buttons at all** — the
 * decision lives in the composer's primary action, which becomes
 * "Implement" on an empty draft and "Refine" once the user types. A second
 * Implement button here would be the same decision in two places, and the two
 * would disagree about what the draft means.
 *
 * *T3: `ComposerPlanFollowUpBanner.tsx:1-20`;
 * `ComposerPrimaryActions.tsx:161-216` for where the action lives instead.*
 */
export function PlanReadyBanner({ planTitle }: PlanReadyBannerProps): React.ReactElement {
  return (
    <BannerCard
      variant="info"
      icon={<ClipboardList size={14} aria-hidden />}
      title="Plan ready"
      description={planTitle ?? undefined}
    />
  );
}
