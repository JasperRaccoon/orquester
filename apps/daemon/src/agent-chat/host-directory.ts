/**
 * Host updates (spec 2026-11-01 P2.4 R24): which agent host serves a thread.
 *
 * During an update the daemon talks to more than one host: the **primary** (current code; every
 * new thread and every non-thread route) and up to `MAX_RETIRING_HOSTS` **retiring** hosts, each
 * keeping the threads that were working when it retired until they go idle. The supervisor owns
 * that state and implements this interface; the routing client (`host-client.ts`) and the
 * summary poll read it, so no caller of the client has to know a second host exists.
 */

import type { HostClient } from "./host-client.ts";

export type HostRole = "primary" | "retiring";

/** One live host the daemon can address. */
export interface HostEndpoint {
  readonly generation: number;
  readonly role: HostRole;
  /** A client bound to this host's own socket and token (an `AgentHostClient`) — no routing. */
  readonly client: HostClient;
}

export interface HostDirectory {
  /** The primary, or null while none is ready (a restart or a switch in progress: answer 503). */
  primary(): HostEndpoint | null;
  /** Every live host, the primary first. The summary poll merges over these (P2.4 R25). */
  hosts(): readonly HostEndpoint[];
  /**
   * The host a request about `threadId` must go to: the retiring host that owns it, else the
   * primary. Resolves only once no adoption of the thread is in flight (I2: release → adopt →
   * the primary accepts commands), so a caller never reaches a host that does not own it yet.
   * Null when no host can serve it now (no primary).
   */
  hostForThread(threadId: string): Promise<HostEndpoint | null>;
  /**
   * A host answered 409 `THREAD_NOT_OWNED` for `threadId`: re-read ownership (and start or await
   * the adoption that answer implies) before the caller retries once.
   */
  ownershipStale(threadId: string, generation: number): Promise<void>;
}

/**
 * One host that is always the primary and owns every thread: the daemon's directory while only
 * one host exists. Routing over it is exactly today's single-socket client.
 */
export function singleHostDirectory(client: HostClient, generation = 0): HostDirectory {
  const endpoint: HostEndpoint = { generation, role: "primary", client };
  return {
    primary: () => endpoint,
    hosts: () => [endpoint],
    hostForThread: async () => endpoint,
    ownershipStale: async () => undefined
  };
}
