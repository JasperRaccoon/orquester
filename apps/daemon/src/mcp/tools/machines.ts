/**
 * Catalog family `machines` (tailnet machines spec 2026-11-22 §4.1.8, §5): `list_machines`, the
 * owner's tailnet and paired machines this chat may use. Chat-only, advertised only while at least
 * one machine is visible to agents (`session-tools/manifest.ts`).
 *
 * The daemon decides what is visible: `GET machineRoutes.list` with the chat's agent principal
 * answers only machines that are not Hidden, not the daemon's own host and not switched off for
 * every use, with the SSH alias this chat may use right now. Nothing here filters or knows about
 * Hidden machines.
 *
 * Everything goes through `DaemonApi` (D-1): this module imports types and pure contracts only.
 */

import { machineRoutes, MACHINE_OS_LABELS, type MachinesResponse, type MachineSummary } from "@orquester/api";

import { defineTool, READ_ONLY, type AnyOrquesterTool } from "../catalog/contract.ts";
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
    "The owner's own machines you may use: name, OS, state (ready, offline, asleep, not-paired, pairing), visibility, capabilities, ssh_alias (run `ssh <alias>` from bash when present) and whether it can be woken. \"ask first\": using it needs the owner's approval card (create_box with provider \"byo\"); \"free use\": no card.",
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

export const machinesFamily: readonly AnyOrquesterTool[] = [listMachines];
