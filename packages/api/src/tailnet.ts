/**
 * Tailscale on the daemon host, beyond box connections (spec
 * docs/superpowers/specs/2026-11-22-tailnet-machines-and-agent-ssh-design.md §4.7): the daemon's
 * tailnet HTTPS address for web clients (Settings → Server), the one-time operator grant, and
 * dev-server previews shared on the tailnet.
 *
 * The raw facts come from the same `LocalTailscale` (`apps/daemon/src/boxes/tailscale/local.ts`)
 * that fills `BoxLocalTailscale` (`boxes.ts`); {@link TailnetHttpsStatus} is Settings → Server's
 * view of them. Ownership rule for every `tailscale serve` change: Orquester never takes a port
 * another live app serves (`serve-port-taken`) and removes only routes it created.
 */

import type { MachineProblem } from "./machines.ts";

/**
 * Orquester's own `tailscale serve` route to the daemon:
 * - `off` — not set up (or disabled);
 * - `serving` — the route exists and points at the daemon's live port;
 * - `repairing` — the 30 s check found it missing or stale and is recreating it;
 * - `taken` — the port serves another app; nothing was changed;
 * - `failed` — the last setup or repair failed (`problem` says why and how to fix it).
 */
export type TailnetServeState = "off" | "serving" | "repairing" | "taken" | "failed";

/** Settings → Server's tailnet HTTPS row (shown with a QR code of `url`). */
export interface TailnetHttpsStatus {
  /** Tailscale runs and is logged in on the daemon host. */
  available: boolean;
  /** `https://<host>.<tailnet>.ts.net:<port>` while `serving`; null otherwise. */
  url: string | null;
  /** The daemon's user may change serve config without sudo (`tailscale set --operator=<user>` done). */
  operatorOk: boolean;
  serveState: TailnetServeState;
  /** The HTTPS port served, or the one setup would use. */
  port: number;
  /** ISO time of the last check; null before the first. */
  checkedAt: string | null;
  problem?: MachineProblem;
}

/** A dev-server port shared on the tailnet as `https://<host>.ts.net:<port>` (spec §4.7.4). */
export interface TailnetPreviewShare {
  /** The local port; the tailnet HTTPS port is the same number. */
  port: number;
  url: string;
  /** The chat that shared it (removed when it closes); null when shared from the UI outside a chat. */
  threadId: string | null;
  /** ISO time it was shared. */
  createdAt: string;
}

export interface TailnetPreviewSharesResponse {
  previews: TailnetPreviewShare[];
}

/** `POST tailnetRoutes.previews` (UI or the preview-share agent tool). */
export interface CreateTailnetPreviewShareRequest {
  port: number;
  /** Set by the daemon from an agent principal; a person may name a chat or none. */
  threadId?: string | null;
}

export interface TailnetPreviewShareResponse {
  preview: TailnetPreviewShare;
}

/**
 * Both transports, owner-facing except `previews` (an agent principal lists and shares only its
 * chat's previews). Classified failures answer 409 `{ code: "TAILNET_PROBLEM", message, problem }`.
 */
export const tailnetRoutes = {
  /**
   * `GET` → {@link TailnetHttpsStatus}; `POST` → {@link TailnetHttpsStatus}: set up (or repair) the
   * serve route through the existing "Set up for me" path; `DELETE` → {@link TailnetHttpsStatus}:
   * remove Orquester's own route only.
   */
  https: "/api/tailnet/https",
  /** `POST` → {@link TailnetHttpsStatus}: run `tailscale set --operator=<daemon user>` once (with `sudo -n`). */
  operator: "/api/tailnet/operator",
  /** `GET` → {@link TailnetPreviewSharesResponse}; `POST` {@link CreateTailnetPreviewShareRequest} → {@link TailnetPreviewShareResponse}. */
  previews: "/api/tailnet/previews",
  /** `DELETE` → {@link TailnetPreviewSharesResponse}: stop sharing the port (Orquester's route only). */
  preview: (port: number): string => `/api/tailnet/previews/${encodeURIComponent(String(port))}`
} as const;

/** The `/events` channel tailnet changes go out on. */
export const TAILNET_CHANNEL = "tailnet";
/** Payload: {@link TailnetChangedPayload}. */
export const TAILNET_CHANGED_EVENT = "tailnet.changed";

export interface TailnetChangedPayload {
  https: TailnetHttpsStatus;
  previews: TailnetPreviewShare[];
}

export type TailnetErrorCode = "TAILNET_PROBLEM" | "TAILNET_INVALID_REQUEST" | "TAILNET_PREVIEW_NOT_FOUND";
