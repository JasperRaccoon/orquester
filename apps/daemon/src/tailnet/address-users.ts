/**
 * Who reaches the daemon through its tailnet HTTPS address (tailnet machines spec §4.7.1): the
 * boxes' Connection setting names the URL boxes and paired machines dial (`BoxSettings.route`), so
 * turning that address off disconnects them. Pure: the daemon wiring passes the settings and records.
 */

import type { BoxConnectionSettings } from "@orquester/api";
import type { StoredBox } from "@orquester/config";

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return null;
  }
};

/** Plain names of what dials one of `addresses`; empty when nothing does. */
export function tailnetAddressUsers(settings: Pick<BoxConnectionSettings, "mode" | "publicUrl" | "tailscale">, records: readonly StoredBox[], addresses: readonly string[]): string[] {
  const dialed = settings.mode === "tailscale" ? settings.tailscale.daemonUrl : settings.publicUrl;
  const origin = dialed ? originOf(dialed) : null;
  if (!origin || !addresses.some((address) => originOf(address) === origin)) return [];
  const machines = records.filter((record) => record.provider === "byo" && record.state !== "destroyed").length;
  return [
    settings.mode === "tailscale" ? "Tailscale-mode boxes" : "Boxes",
    ...(machines > 0 ? [machines === 1 ? "1 paired machine" : `${machines} paired machines`] : [])
  ];
}
