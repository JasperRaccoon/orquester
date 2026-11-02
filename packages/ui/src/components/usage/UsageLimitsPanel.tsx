import React, { useCallback, useEffect, useRef, useState } from "react";

import { useUsageResetFormat } from "../../hooks";
import { useAppStore } from "../../store/app";
import { SegmentedControl } from "../settings/primitives";
import { UsageOverview } from "../settings/UsageOverview";
import { RESET_OPTIONS } from "../settings/UsageSettings";
import type { UsageLimitsPanelProps } from "./types";

/** The Limits tab: each agent's quota windows with a pace marker. */
export const UsageLimitsPanel: React.FC<UsageLimitsPanelProps> = ({ active }) => {
  const loadUsage = useAppStore((s) => s.loadUsage);
  const [resetFormat, setResetFormat] = useUsageResetFormat();
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    []
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadUsage(true);
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, [loadUsage]);

  // Entering the tab reads the quotas afresh: the snapshot the store holds may be minutes old.
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  return (
    <section className="flex flex-col gap-3" aria-label="Limits">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="text-[11px] text-neutral-500">Resets as</span>
        <SegmentedControl
          size="xs"
          ariaLabel="Show reset times as"
          value={resetFormat}
          onChange={setResetFormat}
          options={RESET_OPTIONS.map((o) => ({ ...o, title: `Show reset times as a ${o.label.toLowerCase()}` }))}
        />
      </div>
      <UsageOverview refreshing={refreshing} onRefresh={() => void refresh()} showPace />
    </section>
  );
};
