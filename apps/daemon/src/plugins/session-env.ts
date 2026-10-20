// What built-in plugins add to the env of new sessions (today: the tsc-rs
// preload through NODE_OPTIONS), kept per execution target: `"host"` — shells,
// workflows and desktops on this machine — or one box (Ephemeral AI VMs spec
// §10). The plugins service sets the host's contribution, the box tooling
// provisioner each box's; the shell, workflow and agent-host env builders only
// ask. Every value is in its target's path syntax, so a host path never reaches
// a box. Spec: docs/superpowers/specs/2026-10-14-plugins-ts-rust-design.md §3.3.

import { TS_RUST_PLUGIN_ID } from "@orquester/api";
import { type ToolingEnvContribution, appendNodeRequireOption } from "@orquester/config";

/** Where a session runs: this machine, or a box. */
export type ToolingExecutionTarget = "host" | { boxId: string };

/** Per target, each plugin's contribution, in the order the plugins first set one. */
const host = new Map<string, ToolingEnvContribution>();
const boxes = new Map<string, Map<string, ToolingEnvContribution>>();

function contributionsOf(target: ToolingExecutionTarget, create: true): Map<string, ToolingEnvContribution>;
function contributionsOf(target: ToolingExecutionTarget, create: false): Map<string, ToolingEnvContribution> | undefined;
function contributionsOf(target: ToolingExecutionTarget, create: boolean): Map<string, ToolingEnvContribution> | undefined {
  if (target === "host") return host;
  let map = boxes.get(target.boxId);
  if (!map && create) {
    map = new Map();
    boxes.set(target.boxId, map);
  }
  return map;
}

/**
 * Set (or with `null` clear) what `pluginId` adds to new sessions on `target`.
 * A contribution must only name files that exist on that target: Node refuses
 * to start when a `--require` file is missing.
 */
export function setSessionToolingContribution(
  target: ToolingExecutionTarget,
  pluginId: string,
  contribution: ToolingEnvContribution | null
): void {
  if (contribution === null) {
    const map = contributionsOf(target, false);
    map?.delete(pluginId);
    if (target !== "host" && map?.size === 0) boxes.delete(target.boxId);
    return;
  }
  contributionsOf(target, true).set(pluginId, {
    pathPrepend: [...contribution.pathPrepend],
    env: { ...contribution.env },
    nodeRequire: [...contribution.nodeRequire]
  });
}

/** Every plugin's contribution to new sessions on `target` (empty when none). */
export function sessionToolingContributions(target: ToolingExecutionTarget): ToolingEnvContribution[] {
  return [...(contributionsOf(target, false)?.values() ?? [])];
}

/** Drop everything a box's sessions would get (the box is gone). */
export function clearBoxToolingContributions(boxId: string): void {
  boxes.delete(boxId);
}

/**
 * Set by the plugins service: the host preload's absolute path while the
 * plugin is on and the file has been written, otherwise `null`.
 */
export function setSessionNodePreload(path: string | null): void {
  setSessionToolingContribution(
    "host",
    TS_RUST_PLUGIN_ID,
    path === null ? null : { pathPrepend: [], env: {}, nodeRequire: [path] }
  );
}

/** The first file host sessions `--require`, or `null` when no plugin needs one. */
export function sessionNodePreload(): string | null {
  for (const contribution of host.values()) {
    const first = contribution.nodeRequire[0];
    if (first !== undefined) return first;
  }
  return null;
}

/**
 * NODE_OPTIONS for a new host session: `existing` with every host preload
 * appended, or `existing` unchanged (possibly `undefined`) when none is active.
 * Host sessions take only the preloads: no host contribution sets PATH or env
 * (a box's are applied with `applyToolingContributions` from `@orquester/config`).
 */
export function sessionNodeOptions(existing: string | undefined): string | undefined {
  let value = existing;
  for (const contribution of host.values()) {
    for (const file of contribution.nodeRequire) value = appendNodeRequireOption(value, file);
  }
  return value;
}
