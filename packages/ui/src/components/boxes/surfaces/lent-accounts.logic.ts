/**
 * What the owner sees of accounts lent to boxes (lending spec 2026-11-03 §9): a box's "Lent logins"
 * rows, and the chip on an account in Settings. No React, no store.
 */

import type { BoxLendAgent, BoxLentAccount, BoxLentAccountStatus, BoxSummary } from "@orquester/api";

import { resetClock } from "../../topbar/usage-format";

export type LentAccountTone = "neutral" | "ok" | "info" | "warn" | "danger";

export interface LentAccountRow {
  id: string;
  agent: BoxLendAgent;
  label: string;
  tone: LentAccountTone;
  statusText: string;
  /** The daemon's line on a status other than `active`. */
  statusMessage: string | null;
  /** "until 21:40", with the date when that is not today; null without a readable end time. */
  until: string | null;
  /** `statusText` is a way to Settings → Agent accounts. */
  needsLogin: boolean;
  canEnd: boolean;
}

export interface LentAccountsModel {
  rows: LentAccountRow[];
  canEndAll: boolean;
}

const STATUS_VIEW: Record<BoxLentAccountStatus, { tone: LentAccountTone; text: string }> = {
  installing: { tone: "info", text: "Installing" },
  active: { tone: "ok", text: "Active" },
  "waiting-for-vm": { tone: "warn", text: "VM offline, will renew when it returns" },
  "renewal-failing": { tone: "warn", text: "Could not renew yet, retrying" },
  "needs-login": { tone: "danger", text: "Sign in again" }
};

function isExpired(lend: Pick<BoxLentAccount, "expiresAt">, now: number): boolean {
  return Date.parse(lend.expiresAt) <= now;
}

/**
 * A person can end any lend, whatever its status. Not once its time passed (the daemon is already
 * ending it, and the row goes with its next event), nor on a box being destroyed, which ends them all.
 */
function lentAccountRow(lend: BoxLentAccount, box: Pick<BoxSummary, "state">, now: number): LentAccountRow {
  const base = { id: lend.id, agent: lend.agent, label: lend.label };
  if (isExpired(lend, now)) {
    return { ...base, tone: "neutral", statusText: "Ending", statusMessage: null, until: "time limit reached", needsLogin: false, canEnd: false };
  }
  const view = STATUS_VIEW[lend.status];
  const clock = resetClock(lend.expiresAt, now);
  return {
    ...base,
    tone: view.tone,
    statusText: view.text,
    statusMessage: lend.status === "active" ? null : lend.statusMessage,
    until: clock ? `until ${clock}` : null,
    needsLogin: lend.status === "needs-login",
    canEnd: box.state !== "destroying"
  };
}

/** A box's rows; none when nothing is lent, on an older daemon, or once the box is destroyed. */
export function lentAccountsModel(box: Pick<BoxSummary, "state" | "lentAccounts">, now: number): LentAccountsModel {
  const rows = box.state === "destroyed" ? [] : (box.lentAccounts ?? []).map((lend) => lentAccountRow(lend, box, now));
  return { rows, canEndAll: rows.filter((row) => row.canEnd).length >= 2 };
}

/**
 * The chip per account lent anywhere, by account id: "Lent to 2 VMs until 21:40", the latest end
 * time across its boxes. A lend past its time no longer counts.
 */
export function accountLendChips(boxes: readonly Pick<BoxSummary, "state" | "lentAccounts">[], now: number): ReadonlyMap<string, string> {
  const lent = new Map<string, { count: number; latest: BoxLentAccount | null }>();
  for (const box of boxes) {
    if (box.state === "destroyed") continue;
    for (const lend of box.lentAccounts ?? []) {
      if (isExpired(lend, now)) continue;
      const entry = lent.get(lend.accountId) ?? { count: 0, latest: null };
      entry.count += 1;
      const ends = Date.parse(lend.expiresAt);
      if (Number.isFinite(ends) && !(entry.latest && Date.parse(entry.latest.expiresAt) >= ends)) entry.latest = lend;
      lent.set(lend.accountId, entry);
    }
  }
  const chips = new Map<string, string>();
  for (const [accountId, { count, latest }] of lent) {
    const clock = latest ? resetClock(latest.expiresAt, now) : "";
    chips.set(accountId, `Lent to ${count} ${count === 1 ? "VM" : "VMs"}${clock ? ` until ${clock}` : ""}`);
  }
  return chips;
}
