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

import type { BoxDestroyedReason, BoxKind, BoxProviderId, BoxSummary } from "./boxes.ts";

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
