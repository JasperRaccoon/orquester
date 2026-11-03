/**
 * Ephemeral AI VMs — temporary boxes for agent chats (spec
 * docs/superpowers/specs/2026-10-19-ephemeral-ai-vms-design.md §13): the HTTP routes between the
 * box MCP tools (`apps/daemon/src/mcp/tools/boxes.ts`, through `DaemonApi`) and the daemon, and the
 * limits both sides share.
 *
 * A temporary box belongs to the agent chat that created it (`BoxSummary.threadId`). The daemon
 * enforces that on every route: a request carrying an agent principal reaches only its own chat's
 * boxes (another chat's box reads as not found); a person (no principal) reaches every temporary
 * box; an external MCP client reaches none (the box tools are chat-only).
 *
 * Streaming operations (exec, file transfer, port forwards) are not routes: they are `DaemonApi`
 * methods with the same ownership rule, so file bytes never travel through JSON.
 */

import type { BoxDestroyedReason, BoxKind, BoxLendAgent, BoxLentAccount, BoxProviderId, BoxSummary } from "./boxes.ts";

/** `create_box`'s default time limit (spec §13.1). */
export const TEMPORARY_BOX_DEFAULT_LIFETIME_MINUTES = 120;
export const TEMPORARY_BOX_MIN_LIFETIME_MINUTES = 10;
/** The ceiling when the provider states no maximum of its own (one week). */
export const TEMPORARY_BOX_MAX_LIFETIME_MINUTES = 7 * 24 * 60;
/** The agent's short purpose, shown on the approval card and the box's card. */
export const TEMPORARY_BOX_PURPOSE_MAX_CHARS = 300;

/**
 * `POST temporaryBoxRoutes.list` — an APPROVED `create_box`: provider, size and region are the ones
 * the approval card showed (resolved before the card opened), never re-chosen by the daemon.
 */
export interface CreateTemporaryBoxRequest {
  kind: BoxKind;
  provider: BoxProviderId;
  /** A `BoxSizeOffer.id`. */
  size: string;
  /** A `BoxRegionOffer.id`. */
  region: string;
  /** A `BoxImageOffer.id`, when the provider offers a choice for the kind. */
  image?: string;
  lifetimeMinutes: number;
  /** The agent's purpose (≤ {@link TEMPORARY_BOX_PURPOSE_MAX_CHARS}). */
  purposeNote: string;
}

/** `GET temporaryBoxRoutes.list`. */
export interface TemporaryBoxesResponse {
  boxes: BoxSummary[];
}

/** Why an agent destroys its box: `agent` (it is done) or `provisioning-failed` (it never became ready). */
export type TemporaryBoxDestroyReason = Extract<BoxDestroyedReason, "agent" | "provisioning-failed">;

const temporaryBoxPath = (id: string): string => `/api/boxes/temporary/${encodeURIComponent(id)}`;

export const temporaryBoxRoutes = {
  /**
   * `GET` → {@link TemporaryBoxesResponse}: an agent gets its chat's boxes; a person every temporary
   * box, or one chat's with `?threadId=`. `POST` {@link CreateTemporaryBoxRequest} → `BoxResponse`
   * (state `provisioning`): agent principals only — the chat's approved `create_box`.
   */
  list: "/api/boxes/temporary",
  /** `GET` → `BoxResponse`; `DELETE ?reason=agent|provisioning-failed` → `BoxResponse` once the provider confirmed. */
  box: temporaryBoxPath
} as const;

// ---------------------------------------------------------------------------
// Lending accounts to a box (spec docs/superpowers/specs/2026-11-03-lend-accounts-to-boxes-design.md)
// ---------------------------------------------------------------------------

function lendsPath(boxId: string): string {
  return `/api/boxes/${encodeURIComponent(boxId)}/account-lends`;
}

/**
 * Ownership as for temporary boxes: an agent principal reaches only the box its chat runs in or its
 * own temporary boxes (another box reads as not found); a person reaches every box; an external
 * MCP client reaches none. No route ever returns a token.
 */
export const accountLendRoutes = {
  /** `GET` → {@link AccountLendsResponse}: the calling chat's active lends on every box (a person: every lend). */
  all: "/api/account-lends",
  /**
   * `POST` {@link LendAccountsRequest} → {@link LendAccountsResponse}: an APPROVED lend; the accounts
   * are the ones the card showed. `DELETE` ends every lend the caller may end on this box
   * (`?threadId=` limits a person to one chat's) → {@link AccountLendsResponse}.
   */
  box: (boxId: string): string => lendsPath(boxId),
  /** `POST` {@link LendAccountsPreviewRequest} → {@link LendAccountsPreviewResponse}: resolves and validates for the card; changes nothing. */
  preview: (boxId: string): string => `${lendsPath(boxId)}/preview`,
  /** `DELETE` ends one lend → {@link AccountLendsResponse}. */
  lend: (boxId: string, lendId: string): string => `${lendsPath(boxId)}/${encodeURIComponent(lendId)}`
} as const;

/** What an agent names: a label, the label's part before `@`, or an id prefix, per agent. */
export interface LendAccountsPreviewRequest {
  claude?: string[];
  codex?: string[];
  minutes?: number;
}

/** One account as resolved for the card. */
export interface LendAccountPlan {
  accountId: string;
  agent: BoxLendAgent;
  label: string;
  /** Expiry of the account's current token (ISO); null when unknown. */
  tokenExpiresAt: string | null;
  /** Already lent to this box: approving replaces the end time. */
  alreadyLent: boolean;
}

export interface LendAccountsPreviewResponse {
  accounts: LendAccountPlan[];
  /** The asked minutes, clamped to the limits and to a temporary box's time limit. */
  minutes: number;
  expiresAt: string;
  /** What the card calls the box ("Hetzner · 8 vCPU", or the project's name). */
  boxLabel: string;
}

/** An APPROVED lend: exactly the accounts and minutes the card showed. */
export interface LendAccountsRequest {
  accounts: { agent: BoxLendAgent; accountId: string }[];
  minutes: number;
  /** The agent's purpose (≤ {@link TEMPORARY_BOX_PURPOSE_MAX_CHARS}). */
  purposeNote: string;
}

export interface LendAccountsResponse {
  boxId: string;
  /** The appdir on the box, as evals take it (`--appdir` / `ORQUESTER_APPDIR`). */
  appdir: string;
  lent: BoxLentAccount[];
}

export interface AccountLendsResponse {
  lends: (BoxLentAccount & { boxId: string })[];
}
