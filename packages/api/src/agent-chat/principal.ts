/**
 * Who is acting on a daemon route (unified MCP design 2026-10-15; coordinator rulings on the agent
 * principal, rounds 1 and 2).
 *
 * Several routes behave differently when the caller is an in-chat AGENT acting through an
 * Orquester tool, or an EXTERNAL MCP client: what an agent creates is stamped `agentCreated` /
 * `createdBy: agent`, an agent-created prompt may be pinned only by the user, notify rate limits
 * key on the chat or the external credential, and only a person answers cards. That fact must
 * never come from anything a network client can write — not a body field, not a header value it
 * chooses.
 *
 * ## How the principal travels (requirements for Task 2)
 *
 * 1. **One process-wide registry.** The daemon holds ONE in-memory `nonce → {principal, expiresAt}`
 *    registry shared by both Fastify apps (unix-socket and remote HTTP).
 * 2. **Minting.** Only in-process callers mint: the catalog executor for chat callers
 *    (`{kind: "agent", …}`) and the external `/mcp` transport for its tool calls
 *    (`{kind: "external", credentialId}` — the id of the bearer that authenticated the MCP
 *    session, never the bearer). Each `DaemonApi.request(…, {principal})` through `InjectDaemonApi`
 *    — on whichever app that `DaemonApi` is bound to — mints a fresh nonce and sends it in
 *    {@link PRINCIPAL_TOKEN_HEADER}. `app.inject` never crosses the network, so a network client
 *    never sees a live nonce.
 * 3. **Token requirements (hard):**
 *    - at least {@link PRINCIPAL_TOKEN_MIN_BYTES} bytes (128 bits) from `crypto.randomBytes`,
 *      encoded base64url;
 *    - SINGLE-USE: consumed (deleted) on its first resolve, and deleted by the minter in a
 *      `finally` after the inject settles whether or not it was resolved;
 *    - short expiry ({@link PRINCIPAL_TOKEN_TTL_MS} from minting to resolve);
 *    - never logged, echoed in a response or error, stored, or forwarded to the agent host;
 *    - a request that CARRIES the header with an unknown, already-used or expired token is
 *      refused 401 `PRINCIPAL_TOKEN_INVALID` — never silently downgraded to `user`.
 * 4. **Resolving.** An `onRequest` hook on BOTH apps resolves the header against the registry and
 *    decorates the request (`request.principal`), then removes the header. A request without the
 *    header is `{kind: "user"}` on either app (the GUI over HTTP or the socket, a local CLI).
 *
 * ## Which fields are gated how
 *
 * **Principal-gated** — honoured only when `request.principal` is the matching agent
 * ({@link isAgentPrincipalFor}); ignored for every other caller, socket callers included:
 * - `CreateAgentChatSessionFields.lineage.agentCreated` (principal = agent of `parentThreadId`);
 * - `ForkSessionRequest.agentCreated` (principal = agent of the forked chat);
 * - saved-prompt `createdBy` — derived from the principal, never read from a body;
 * - the pin refusal for agent-created prompts (only `user` may pin one; `agent` and `external` get
 *   403 `AGENT_PROMPT_PIN_REFUSED`);
 * - push-notify rate-limit keys (agent → its chat; external → its credential; user → none);
 * - refusals of `agent` principals on card answers and grant revocation (403): only a person
 *   answers cards or revokes grants;
 * - the Device panel's `/api/devices/leases/:leaseId/user-action` buttons: only `user` may act
 *   (403 for `agent` or `external`); agents use `device_action` under the controller rules.
 *
 * **Socket-trusted** — honoured from ANY unix-socket / in-process caller (trusted local control,
 * AGENTS.md; the daemon's own workers post through the internal `DaemonApi` with no principal) and
 * STRIPPED by the remote transport before the route sees the body:
 * - `TurnCommandBody.causedBy` ({@link REMOTE_STRIPPED_TURN_FIELDS}, `stripRemoteTurnFields`);
 * - `MergeBackRequest.causedBy` ({@link REMOTE_STRIPPED_MERGE_BACK_FIELDS},
 *   `stripRemoteMergeBackFields`);
 * - `InterruptCommandBody.cause` ({@link REMOTE_STRIPPED_INTERRUPT_FIELDS},
 *   `stripRemoteInterruptFields`): the delegate stop cascade's mark;
 * - every field of the reply-subscription routes, which exist on the socket app only. When the
 *   request carries an agent principal, its `threadId` must equal `fromThreadId` (403 otherwise).
 *
 * ## Trust assumption (spec §12.6)
 *
 * The unix socket is unauthenticated, trusted local control. An agent that runs shell commands as
 * the daemon's OS user can reach it, and so can set `causedBy`, post reply subscriptions, answer
 * its own cards, or edit `agent-tools.json`. Spec §12.6 accepts this: cards, denials, grants and
 * principals protect against model mistakes and injected tool calls, not against an agent
 * deliberately subverting its host. Nothing here may be weakened on the REMOTE app on that ground:
 * there, socket-trusted fields are stripped and only live in-process tokens carry a principal.
 */

/** The server-stamped principal of one request. */
export type CallerPrincipal =
  /** The GUI (desktop, web) or a local client — any request without a principal token. */
  | { kind: "user" }
  /** An external MCP client, minted by the external `/mcp` transport. `credentialId`: its bearer's id (never the bearer). */
  | { kind: "external"; credentialId?: string }
  /** An in-chat agent, minted by the catalog executor. */
  | {
      kind: "agent";
      /** The calling chat (= session id). */
      threadId: string;
      /** Its canonical project root; "" when it has none. */
      projectPath: string;
      /** Its agent adapter id (for `createdBy.agent`). */
      agent?: string;
      /** Its tab title when the call ran (for `createdBy.title`). */
      title?: string;
      /** The running turn's exchange (`causedBy` of the turn the call came from), when agent-caused. */
      exchange?: { id: string; hop: number };
    };

export type AgentPrincipal = Extract<CallerPrincipal, { kind: "agent" }>;

/** The header that carries a principal NONCE (never a serialised principal); resolved on both apps. */
export const PRINCIPAL_TOKEN_HEADER = "x-orquester-principal-token";
/** Minimum nonce entropy: 16 bytes (128 bits) from `crypto.randomBytes`. */
export const PRINCIPAL_TOKEN_MIN_BYTES = 16;
/** A nonce is valid this long after minting (it is consumed on first resolve anyway). */
export const PRINCIPAL_TOKEN_TTL_MS = 30_000;
/** 401 code for a request carrying an unknown, used or expired principal token. */
export const PRINCIPAL_TOKEN_INVALID = "PRINCIPAL_TOKEN_INVALID";

/** The principal of a request that carries no token. */
export const USER_PRINCIPAL: CallerPrincipal = Object.freeze({ kind: "user" });

/** Whether a principal-gated hint may be honoured: the principal is that very agent. */
export function isAgentPrincipalFor(principal: CallerPrincipal | undefined, threadId: string): principal is AgentPrincipal {
  return principal?.kind === "agent" && principal.threadId === threadId;
}
