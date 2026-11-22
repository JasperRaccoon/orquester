/**
 * Catalog family `machines` (tailnet machines spec 2026-11-22 §4.1.8, §4.8, §5): `list_machines`, the
 * owner's tailnet and paired machines this chat may use, and `wake_machine`, Wake-on-LAN for one of
 * them. Chat-only, advertised only while at least one machine is visible to agents
 * (`session-tools/manifest.ts`).
 *
 * `wake_machine` follows the machine's visibility: a Free-use machine wakes without a card; an
 * Ask-first one only after the owner approves a `machines` spend card (every permission mode, never
 * a grant, like `create_box`'s "Use your machine" card); a Hidden one is unknown (the daemon answers
 * 404 for it exactly as for an id that does not exist). The daemon enforces it too: its wake route
 * wakes only a Free-use machine for an agent (an Ask-first one is 403 `MACHINE_APPROVAL_REQUIRED`),
 * and the approved wake goes through `DaemonApi.machineWakeApproved`, which no HTTP route reaches.
 * The daemon sends an agent's wake only through machines that are not Hidden.
 *
 * The daemon decides what is visible: `GET machineRoutes.list` with the chat's agent principal
 * answers only machines that are not Hidden, not the daemon's own host and not switched off for
 * every use, with the SSH alias this chat may use right now. Nothing here filters or knows about
 * Hidden machines.
 *
 * Everything goes through `DaemonApi` (D-1): this module imports types and pure contracts only.
 */

import { z } from "zod";
import { machineRoutes, MACHINE_OS_LABELS, type ApprovalPreviewSection, type MachineResponse, type MachinesResponse, type MachineSummary, type WakeMachineResponse } from "@orquester/api";

import { defineTool, MUTATING, READ_ONLY, type AnyOrquesterTool, type ApprovalPreview, type ScopeClaim, type ScopeContext } from "../catalog/contract.ts";
import type { DaemonApi } from "../daemon-api.ts";
import { daemonError, ToolError } from "../errors.ts";

/** One machine as `list_machines` shows it. */
function machineView(machine: MachineSummary): Record<string, unknown> {
  return {
    machine_id: machine.id,
    name: machine.name,
    os: MACHINE_OS_LABELS[machine.os],
    state: machine.state,
    visibility: machine.visibility === "free" ? "free use" : "ask first",
    capabilities: {
      device_simulators: machine.capabilities.devices,
      commands_and_ssh: machine.capabilities.commands,
      agent_chats_and_projects: machine.capabilities.chats
    },
    ...(machine.sshAlias ? { ssh_alias: machine.sshAlias } : {}),
    can_wake: machine.wake.canWake
  };
}

const listMachines = defineTool({
  name: "list_machines",
  title: "List the owner's machines",
  description:
    "The owner's own machines you may use: name, OS, state (ready, offline, asleep, not-paired, pairing), visibility, capabilities, ssh_alias (run `ssh <alias>` from bash when present) and can_wake (wake_machine turns it on). \"ask first\": using it needs the owner's approval card (create_box with provider \"byo\"); \"free use\": no card.",
  input: {},
  audiences: ["chat"],
  toolset: "machines",
  tier: "read",
  scope: async (_args, ctx) => ({ projects: [], sessions: ctx.caller.kind === "thread" ? [ctx.caller.threadId] : [], self: "allow", reads: "metadata", writes: false, causesTurnIn: [] }),
  annotations: READ_ONLY,
  resultKind: "json",
  async run(_args, { api, caller }) {
    if (caller.kind !== "thread") throw new ToolError("TOOL_NOT_FOUND", "list_machines is a chat tool.");
    const res = await api.request("GET", machineRoutes.list);
    if (res.status >= 400) throw daemonError(res);
    const machines = (res.body as MachinesResponse).machines.map(machineView);
    return machines.length > 0 ? { machines } : { machines, note: "None of the owner's machines is available to agents right now." };
  }
});

/** The machine as this chat may see it; throws the daemon's refusal (`MACHINE_NOT_FOUND` for an unknown or Hidden one). */
async function visibleMachine(api: DaemonApi, machineId: string): Promise<MachineSummary> {
  const res = await api.request("GET", machineRoutes.machine(machineId));
  if (res.status >= 400) throw daemonError(res);
  return (res.body as MachineResponse).machine;
}

const UNATTENDED_WARNING =
  "This chat runs unattended (an automated workflow, or a turn another agent started). It waits for your answer here; unanswered, it is denied after 30 minutes.";

/** The "Wake <machine>" card of an Ask-first machine. */
function wakeCard(machine: MachineSummary, unattended: boolean): ApprovalPreview {
  const sections: ApprovalPreviewSection[] = [
    {
      kind: "fields",
      title: "Your machine",
      rows: [
        { label: "Machine", value: machine.name },
        { label: "OS", value: MACHINE_OS_LABELS[machine.os] },
        { label: "State", value: machine.state }
      ]
    },
    {
      kind: "text",
      title: "What happens",
      text: `Another of your machines on ${machine.name}'s network sends it a Wake-on-LAN packet, so it turns on. Approving lets the agent wake it this once; using it afterwards follows its settings in Settings → Machines.`
    }
  ];
  if (unattended) sections.push({ kind: "warning", level: "caution", text: UNATTENDED_WARNING });
  return { title: `Wake ${machine.name}`, scopeLabel: "Your own machine", sections, pins: { machineId: machine.id }, ungrantable: true };
}

function wakeScope(ctx: ScopeContext): ScopeClaim {
  return { projects: [], sessions: ctx.caller.kind === "thread" ? [ctx.caller.threadId] : [], self: "allow", reads: "metadata", writes: true, causesTurnIn: [] };
}

const wakeMachine = defineTool({
  name: "wake_machine",
  title: "Wake one of the owner's machines",
  description:
    "Turn on an asleep machine from list_machines (can_wake: true) with Wake-on-LAN, sent by another of the owner's machines on its network. \"free use\": no card; \"ask first\": the owner approves a card first. It takes a minute or two to come back: list_machines shows state ready once it has.",
  input: {
    machine_id: z.string().trim().min(1).max(200).describe("machine_id from list_machines.")
  },
  audiences: ["chat"],
  toolset: "machines",
  tier: "act",
  // A card unless `scope` found a Free-use machine.
  spendFamily: (_args, scope) => (scope.resolved && scope.resolved.spendFamily === undefined ? undefined : "machines"),
  async scope(args, ctx) {
    const claim = wakeScope(ctx);
    if (ctx.caller.kind !== "thread") return claim;
    try {
      const machine = await visibleMachine(ctx.api, args.machine_id);
      return machine.visibility === "free" ? { ...claim, resolved: { tier: "act" } } : claim;
    } catch {
      // Unknown, Hidden or unreadable: a card is planned, and `approval` names the refusal (fail closed).
      return claim;
    }
  },
  async approval(args, ctx) {
    if (ctx.caller.kind !== "thread") throw new ToolError("TOOL_NOT_FOUND", "wake_machine is a chat tool.");
    const machine = await visibleMachine(ctx.api, args.machine_id);
    return wakeCard(machine, ctx.caller.workflowOwned || ctx.caller.exchange !== null);
  },
  annotations: { ...MUTATING, openWorldHint: true },
  resultKind: "json",
  async run(args, { api, caller, approval }) {
    if (caller.kind !== "thread") throw new ToolError("TOOL_NOT_FOUND", "wake_machine is a chat tool.");
    const machine = await visibleMachine(api, args.machine_id);
    const approved = approval?.pins?.machineId === machine.id;
    // Fail closed: without the approved card only a machine that is Free use now.
    if (!approved && machine.visibility !== "free") {
      throw new ToolError("PERMISSION_DENIED", `Waking ${machine.name} needs the owner's approval on its card.`);
    }
    if (machine.state === "ready") return { machine_id: machine.id, sent: false, note: `${machine.name} is awake already (state ready).` };
    let result: WakeMachineResponse;
    if (approved) {
      // After the card: the daemon-internal wake (the route wakes only Free-use machines for an agent).
      if (!api.machineWakeApproved) throw new ToolError("MACHINES_UNAVAILABLE", "Waking machines is not available here.");
      const outcome = await api.machineWakeApproved(machine.id);
      if (!outcome.ok) throw new ToolError(outcome.code, outcome.message);
      result = outcome.value;
    } else {
      const res = await api.request("POST", machineRoutes.wake(machine.id));
      if (res.status >= 400) throw daemonError(res);
      result = res.body as WakeMachineResponse;
    }
    if (!result.sent) {
      return { machine_id: machine.id, sent: false, problem: result.problem?.message ?? "Nothing could send the wake packet.", ...(result.problem?.fix ? { fix: result.problem.fix } : {}) };
    }
    // The sender is named only when this chat may see it.
    const listed = await api.request("GET", machineRoutes.list);
    const sender = listed.status < 400 ? (listed.body as MachinesResponse).machines.find((entry) => entry.id === result.via) : undefined;
    return {
      machine_id: machine.id,
      sent: true,
      ...(sender ? { sent_via: sender.name } : {}),
      note: `The wake packet was sent. ${machine.name} takes a minute or two to come back; list_machines shows state ready once it has.`
    };
  }
});

export const machinesFamily: readonly AnyOrquesterTool[] = [listMachines, wakeMachine];
