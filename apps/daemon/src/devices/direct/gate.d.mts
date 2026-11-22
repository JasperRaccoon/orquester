/** Types of `gate.mjs` (plain JavaScript: the daemon uploads it to the owner's device machines). */

import type { Server } from "node:http";

export const IDENTITY_PATH: string;
export const TICKET_PARAM: string;
export const CONTROL_PREFIX: string;

export interface StreamTicketClaims {
  hostId: string;
  /** The hub's device parameter (simulator UDID, emulator serial). */
  device: string;
  /** Epoch ms. */
  expiresAt: number;
  /** The page origin the ticket was issued to; null: issued without one (the desktop app). */
  origin?: string | null;
}

export type StreamTicketVerdict =
  | { ok: true; claims: { hostId: string; device: string; expiresAt: number; origin: string | null } }
  | { ok: false; reason: "malformed" | "signature" | "expired" | "host" | "device" };

export function signStreamTicket(secret: Buffer, claims: StreamTicketClaims): string;
export function verifyStreamTicket(secret: Buffer, ticket: string | null | undefined, expect: { hostId: string; device?: string; now: number }): StreamTicketVerdict;
export function controlToken(secret: Buffer): string;

export function lanAddresses(interfaces: Readonly<Record<string, readonly { address: string; family: string | number; internal?: boolean }[] | undefined>>): string[];
export function readHubState(dir: string): { port: number; token: string | null } | null;

export class FrameScanner {
  constructor(onMessage: (opcode: number, fin: boolean, text: string | null) => void, inspectMax?: number);
  push(chunk: Buffer): void;
}

/** What `GET /.orq/gate/events` answers. */
export interface GateEvents {
  boot: string;
  seq: number;
  hostId: string;
  machineId: string | null;
  /** Open streams per device. */
  viewers: Record<string, number>;
  /** Devices that saw input since the caller's `after` (same boot only). */
  inputs: string[];
  /** The machine's LAN IPv4 addresses. */
  lan: string[];
}

export interface StreamGateOptions {
  hostId: string;
  machineId: string | null;
  secret: Buffer;
  version?: string | null;
  hub(): { port: number; token: string | null } | null;
  hubFailed?(): void;
  now?(): number;
  lan?(): string[];
  onMachineId?(machineId: string): void;
  onStop?(): void;
  longPollMs?: number;
  lanPollMs?: number;
}

export function createStreamGate(options: StreamGateOptions): { server: Server; boot: string; close(): void };
