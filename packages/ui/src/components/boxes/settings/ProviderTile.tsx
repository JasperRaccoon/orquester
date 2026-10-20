import React from "react";
import type { BoxProviderInfo } from "@orquester/api";

import { providerAbbreviation } from "./providers.logic";

/** A provider's icon tile: its two-letter abbreviation. */
export const ProviderTile: React.FC<{ provider: Pick<BoxProviderInfo, "id" | "label"> }> = ({ provider }) => (
  <span
    aria-hidden
    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-neutral-800/80 text-[11px] font-semibold tracking-tight text-neutral-300"
  >
    {providerAbbreviation(provider)}
  </span>
);
