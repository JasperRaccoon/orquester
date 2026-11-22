/**
 * The machines routes (`machineRoutes`, tailnet machines spec §4.1, §4.2, §4.8), on both transports
 * (the bearer hook gates remote HTTP like every other route).
 *
 * Who asks is the request's server-stamped principal: `user` is the owner and sees every machine;
 * any other principal (an agent chat's tools, an external MCP client) sees only machines visible to
 * agents (never Hidden, never the daemon host, never one with every use off) — a machine hidden from
 * it answers 404 `MACHINE_NOT_FOUND` exactly like an unknown id — and may only wake, and only a
 * Free-use machine (an Ask-first one is 403 `MACHINE_APPROVAL_REQUIRED`: `wake_machine` wakes it after
 * the owner's card, through {@link wakeApprovedForAgent}, which no HTTP route reaches). Policy
 * changes, pairing and removal are the owner's (403 `MACHINE_OWNER_ONLY`).
 */

import { isAbsolute } from "node:path";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  byoKindOfMachineOs,
  isMachineVisibility,
  MACHINE_CAPABILITIES,
  machineRoutes,
  type MachineCapabilities,
  type MachineErrorCode,
  type MachineProblem,
  type MachineResponse,
  type MachinesResponse,
  type MachineSummary,
  type MachineVisibility,
  type PairMachineOverSshRequest,
  type PairMachineOverSshResponse,
  type RemoveMachineResponse,
  type WakeMachineResponse
} from "@orquester/api";
import type { CallerPrincipal } from "@orquester/api/agent-chat";

import type { MachineRegistry, MachineViewer } from "./registry.ts";
import { MachineStoreReadOnlyError } from "./store.ts";

/** What removal needs from the box service. */
export interface MachineRemoval {
  /** Unpair a paired machine (`ByoMachines.remove`): uninstall, revoke, delete the record. */
  removeBox(boxId: string): Promise<{ uninstalled: boolean }>;
  /** Every bring-your-own box id now (to find the one "Pair over SSH" created). */
  byoBoxIds(): string[];
  /** Whether the Ephemeral AI VMs plugin is on (pairing needs it). */
  pairingEnabled(): boolean;
}

export interface MachineRoutesDeps {
  registry: MachineRegistry;
  boxes: MachineRemoval;
  logger?: Pick<Console, "error">;
}

class MachineRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: MachineErrorCode,
    message: string
  ) {
    super(message);
  }
}

const notFound = (): MachineRouteError => new MachineRouteError(404, "MACHINE_NOT_FOUND", "No such machine.");
const invalid = (message: string): MachineRouteError => new MachineRouteError(400, "MACHINE_INVALID_REQUEST", message);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** An `~/.ssh/config` host alias or SSH user: one token, no options, no shell. */
const SSH_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/=]{20,100}$/;
const MAX_NAME_CHARS = 60;

function viewerOf(principal: CallerPrincipal | undefined): MachineViewer {
  if (!principal || principal.kind === "user") return { kind: "owner" };
  return { kind: "agent", threadId: principal.kind === "agent" ? principal.threadId : null };
}

function requireOwner(principal: CallerPrincipal | undefined, what: string): void {
  if (principal && principal.kind !== "user") throw new MachineRouteError(403, "MACHINE_OWNER_ONLY", `Only the owner ${what}, in Settings → Machines.`);
}

/** Validate `UpdateMachineRequest`; the ssh overrides come back in the store's field names. */
function parseUpdate(body: unknown): { visibility?: MachineVisibility; capabilities?: Partial<MachineCapabilities>; ssh?: Record<string, string | number | null> } {
  if (!isRecord(body)) throw invalid("Send the fields to change.");
  const out: { visibility?: MachineVisibility; capabilities?: Partial<MachineCapabilities>; ssh?: Record<string, string | number | null> } = {};
  if (body.visibility !== undefined) {
    if (!isMachineVisibility(body.visibility)) throw invalid('`visibility` must be "hidden", "ask" or "free".');
    out.visibility = body.visibility;
  }
  if (body.capabilities !== undefined) {
    if (!isRecord(body.capabilities)) throw invalid("`capabilities` must be an object.");
    const capabilities: Partial<MachineCapabilities> = {};
    for (const [key, value] of Object.entries(body.capabilities)) {
      if (!(MACHINE_CAPABILITIES as readonly string[]).includes(key)) throw invalid(`Unknown capability "${key.slice(0, 40)}".`);
      if (typeof value !== "boolean") throw invalid(`\`capabilities.${key}\` must be true or false.`);
      capabilities[key as keyof MachineCapabilities] = value;
    }
    out.capabilities = capabilities;
  }
  if (body.ssh !== undefined) out.ssh = parseSshOverrides(body.ssh, true);
  if (out.visibility === undefined && out.capabilities === undefined && out.ssh === undefined) throw invalid("Nothing to change.");
  return out;
}

/** SSH overrides (request names → store names); `null` clears a field when `nullable`. */
function parseSshOverrides(value: unknown, nullable: boolean): Record<string, string | number | null> {
  if (!isRecord(value)) throw invalid("`ssh` must be an object.");
  const out: Record<string, string | number | null> = {};
  const field = (key: string, stored: string, check: (raw: unknown) => string | number): void => {
    const raw = value[key];
    if (raw === undefined) return;
    if (raw === null || raw === "") {
      if (!nullable) return;
      out[stored] = null;
      return;
    }
    out[stored] = check(raw);
  };
  field("user", "user", (raw) => {
    if (typeof raw !== "string" || !SSH_TOKEN.test(raw)) throw invalid("The SSH user must be one word of letters, digits, '.', '_', '@' or '-'.");
    return raw;
  });
  field("port", "port", (raw) => {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 65535) throw invalid("The SSH port must be a number from 1 to 65535.");
    return raw;
  });
  field("identityFile", "identityFile", (raw) => {
    if (typeof raw !== "string" || !isAbsolute(raw) || raw.length > 4096 || /[\u0000-\u001f]/.test(raw)) throw invalid("The identity file must be an absolute path on the Orquester host.");
    return raw;
  });
  field("sshAlias", "alias", (raw) => {
    if (typeof raw !== "string" || !SSH_TOKEN.test(raw)) throw invalid("The SSH alias must be a Host name from ~/.ssh/config (letters, digits, '.', '_', '@', '-').");
    return raw;
  });
  return out;
}

function parsePairRequest(body: unknown): PairMachineOverSshRequest {
  const raw = body === undefined || body === null ? {} : body;
  if (!isRecord(raw)) throw invalid("Send the pairing options as an object.");
  const overrides = parseSshOverrides(raw, false);
  const request: PairMachineOverSshRequest = {};
  if (typeof overrides.user === "string") request.user = overrides.user;
  if (typeof overrides.port === "number") request.port = overrides.port;
  if (typeof overrides.identityFile === "string") request.identityFile = overrides.identityFile;
  if (typeof overrides.alias === "string") request.sshAlias = overrides.alias;
  if (raw.acceptHostKeyFingerprint !== undefined) {
    if (typeof raw.acceptHostKeyFingerprint !== "string" || !FINGERPRINT.test(raw.acceptHostKeyFingerprint)) throw invalid("`acceptHostKeyFingerprint` must be a SHA256 fingerprint as shown (SHA256:…).");
    request.acceptHostKeyFingerprint = raw.acceptHostKeyFingerprint;
  }
  if (raw.name !== undefined) {
    if (typeof raw.name !== "string") throw invalid("`name` must be text.");
    const name = raw.name.trim().replace(/\s+/g, " ");
    if (name.length === 0 || name.length > MAX_NAME_CHARS || /[\u0000-\u001f\u007f]/.test(name)) throw invalid(`The name must be one line of 1–${MAX_NAME_CHARS} characters.`);
    request.name = name;
  }
  return request;
}

const failed = (problem: MachineProblem): PairMachineOverSshResponse => ({ status: "failed", problem });

/** Wake a machine `viewer` may see (not the daemon's own). An agent's wake is never sent by a Hidden machine. */
async function wakeAs(registry: MachineRegistry, machine: MachineSummary, viewer: MachineViewer): Promise<WakeMachineResponse> {
  const port = registry.wakePort();
  if (!port) {
    return {
      sent: false,
      via: null,
      problem: {
        code: "wake-unavailable",
        machineId: machine.id,
        message: `Orquester can't wake ${machine.name} in this version.`,
        fix: `Turn ${machine.name} on by hand.`
      }
    };
  }
  const result = await port.wake(machine.id, { agent: viewer.kind === "agent" });
  void registry.refresh();
  return result;
}

/**
 * The wake `wake_machine` runs after the owner approved its card for an Ask-first machine: a
 * daemon-internal call (`DaemonApi.machineWakeApproved`, in-process only), never an HTTP route, so
 * no caller can skip the card by calling the route. The machine must still be one the chat may see.
 */
export async function wakeApprovedForAgent(
  registry: MachineRegistry,
  machineId: string,
  threadId: string
): Promise<{ ok: true; value: WakeMachineResponse } | { ok: false; code: MachineErrorCode; message: string }> {
  const viewer: MachineViewer = { kind: "agent", threadId };
  const machine = registry.get(machineId, viewer);
  if (!machine) return { ok: false, code: "MACHINE_NOT_FOUND", message: "No such machine." };
  return { ok: true, value: await wakeAs(registry, machine, viewer) };
}

export function registerMachineRoutes(app: FastifyInstance, deps: MachineRoutesDeps): void {
  const { registry, boxes } = deps;
  const logger = deps.logger ?? console;

  const handle =
    <R extends FastifyRequest>(run: (request: R) => Promise<unknown> | unknown) =>
    async (request: R, reply: FastifyReply): Promise<unknown> => {
      try {
        return await run(request);
      } catch (error) {
        if (error instanceof MachineRouteError) return reply.code(error.status).send({ code: error.code, message: error.message });
        if (error instanceof MachineStoreReadOnlyError) return reply.code(409).send({ code: "MACHINE_INVALID_REQUEST", message: error.message });
        const box = error as { status?: unknown; code?: unknown; message?: unknown } | null;
        if (box && box.code === "BOX_IN_USE" && typeof box.message === "string") return reply.code(409).send({ code: "MACHINE_IN_USE", message: box.message });
        logger.error("[machines] a route failed", error instanceof Error ? error.message : String(error));
        return reply.code(500).send({ code: "MACHINES_ERROR", message: "The machine operation failed." });
      }
    };

  /** The machine `viewer` may see, or 404. */
  const machineFor = (id: string, viewer: MachineViewer) => {
    const machine = registry.get(id, viewer);
    if (!machine) throw notFound();
    return machine;
  };

  type IdRequest = FastifyRequest<{ Params: { id: string } }>;

  /** An owner-only action: a machine hidden from the caller is 404 first (its existence is not told), then 403. */
  const ownerMachine = (request: IdRequest, what: string) => {
    machineFor(request.params.id, viewerOf(request.principal));
    requireOwner(request.principal, what);
    return machineFor(request.params.id, { kind: "owner" });
  };

  app.get(
    machineRoutes.list,
    handle(async (request): Promise<MachinesResponse> => {
      await registry.ensureFresh();
      return registry.list(viewerOf(request.principal));
    })
  );

  app.get(
    "/api/machines/:id",
    handle(async (request: IdRequest): Promise<MachineResponse> => ({ machine: machineFor(request.params.id, viewerOf(request.principal)) }))
  );

  app.patch(
    "/api/machines/:id",
    handle(async (request: FastifyRequest<{ Params: { id: string }; Body: unknown }>): Promise<MachineResponse> => {
      const machine = ownerMachine(request, "changes a machine's settings");
      if (machine.self) throw new MachineRouteError(409, "MACHINE_UNSUPPORTED", "This is the machine Orquester runs on: agents always work here, so it has no settings.");
      const updated = await registry.updatePolicy(machine.id, parseUpdate(request.body));
      if (!updated) throw notFound();
      return { machine: updated };
    })
  );

  app.delete(
    "/api/machines/:id",
    handle(async (request: IdRequest): Promise<RemoveMachineResponse> => {
      const machine = ownerMachine(request, "removes a machine");
      if (machine.self) throw new MachineRouteError(409, "MACHINE_UNSUPPORTED", "The machine Orquester runs on can't be removed.");
      let uninstalled = false;
      if (machine.boxId !== null) ({ uninstalled } = await boxes.removeBox(machine.boxId));
      await registry.resetMachine(machine.id);
      return { uninstalled, problems: [] };
    })
  );

  app.post(
    "/api/machines/:id/pair-ssh",
    handle(async (request: FastifyRequest<{ Params: { id: string }; Body: unknown }>): Promise<PairMachineOverSshResponse> => {
      const machine = ownerMachine(request, "pairs a machine");
      if (machine.self) throw new MachineRouteError(409, "MACHINE_UNSUPPORTED", "Orquester already runs on this machine; there is nothing to pair.");
      if (byoKindOfMachineOs(machine.os) === null) throw new MachineRouteError(409, "MACHINE_UNSUPPORTED", `${machine.name} runs an OS Orquester can't pair (Linux, macOS and Windows can be).`);
      if (machine.boxId !== null && machine.state !== "pairing") throw new MachineRouteError(409, "MACHINE_ALREADY_PAIRED", `${machine.name} is paired already.`);
      const pairRequest = parsePairRequest(request.body);
      // The overrides given are saved on the machine (spec §4.2.1), whatever the outcome.
      const overrides = parseSshOverrides(request.body ?? {}, false);
      if (Object.keys(overrides).length > 0) await registry.updatePolicy(machine.id, { ssh: overrides });
      if (!boxes.pairingEnabled()) {
        return failed({
          code: "pair-bootstrap-failed",
          machineId: machine.id,
          message: "Pairing needs the Ephemeral AI VMs plugin, which is turned off.",
          fix: "Turn on Ephemeral AI VMs in Settings → Plugins, then pair again."
        });
      }
      const port = registry.pairingPort();
      if (!port) {
        return failed({
          code: "pair-bootstrap-failed",
          machineId: machine.id,
          message: `Orquester can't pair ${machine.name} over SSH in this version.`,
          fix: "Use Settings → Plugins → Ephemeral AI VMs → Add your machine, and run the command it shows on the machine."
        });
      }
      if (!registry.beginPairing(machine.id)) throw new MachineRouteError(409, "MACHINE_PAIRING_IN_PROGRESS", `${machine.name} is being paired already.`);
      const before = new Set(boxes.byoBoxIds());
      try {
        const target = registry.target(machine.id);
        if (!target) throw notFound();
        const outcome = await port.pairOverSsh(target, pairRequest);
        if (outcome.status !== "pairing") return outcome;
        // The record the bootstrap created is this machine's, before its orq-agent ever connects.
        const created = boxes.byoBoxIds().filter((id) => !before.has(id));
        if (created.length === 1) await registry.linkBox(machine.id, created[0]!);
        return { status: "pairing", machine: registry.get(machine.id) ?? outcome.machine };
      } finally {
        registry.endPairing(machine.id);
        void registry.refresh();
      }
    })
  );

  app.post(
    "/api/machines/:id/wake",
    handle(async (request: IdRequest): Promise<WakeMachineResponse> => {
      const viewer = viewerOf(request.principal);
      const machine = machineFor(request.params.id, viewer);
      if (machine.self) throw new MachineRouteError(409, "MACHINE_UNSUPPORTED", "This is the machine Orquester runs on; it is awake.");
      if (viewer.kind === "agent" && machine.visibility !== "free") {
        throw new MachineRouteError(403, "MACHINE_APPROVAL_REQUIRED", `${machine.name} is set to Ask first: waking it needs the owner's approval, which wake_machine asks for on a card.`);
      }
      return wakeAs(registry, machine, viewer);
    })
  );
}
