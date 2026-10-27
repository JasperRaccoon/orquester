/**
 * Box records → the `BoxSummary`/`BoxesTotals` views (spec §8.10). Costs are estimates: uptime
 * (creation to destruction, or now) × the hourly price recorded at creation.
 */

import {
  BOX_SETUP_STEP_IDS,
  isBoxKind,
  isBoxProviderId,
  type BoxArch,
  type BoxDestroyedReason,
  type BoxOs,
  type BoxProjectRef,
  type BoxPurpose,
  type BoxSetupStep,
  type BoxSetupStepId,
  type BoxSetupStepState,
  type BoxState,
  type BoxSummary,
  type BoxesTotals,
  BOX_STATES
} from "@orquester/api";
import type { StoredBox } from "@orquester/config";

import type { BoxProviderRegistry } from "../contracts.ts";

const HOUR_MS = 3_600_000;

const DESTROYED_REASONS: readonly BoxDestroyedReason[] = [
  "deleted",
  "agent",
  "time-limit",
  "chat-closed",
  "provider-gone",
  "provider-error",
  "provisioning-failed",
  "orphan"
];

export const SETUP_STEP_LABELS: Readonly<Record<BoxSetupStepId, string>> = {
  create: "Create the machine",
  connect: "Wait for orq-agent to connect",
  paths: "Create the host paths",
  config: "Sync agent configuration",
  tooling: "Install plugin tooling",
  clone: "Clone the repository",
  toolchain: "Install the toolchain",
  agents: "Install the agent CLIs",
  ready: "Ready"
};

/** The steps a box runs: all of them for a project box, create/connect/ready for a temporary one. */
export function setupStepIds(purpose: BoxPurpose): BoxSetupStepId[] {
  return purpose === "temporary" ? ["create", "connect", "ready"] : [...BOX_SETUP_STEP_IDS];
}

export function initialStoredSetup(purpose: BoxPurpose): NonNullable<StoredBox["setup"]> {
  return setupStepIds(purpose).map((id) => ({ id, label: SETUP_STEP_LABELS[id], state: "pending", startedAt: null, finishedAt: null, message: null }));
}

export function isBoxState(value: unknown): value is BoxState {
  return typeof value === "string" && (BOX_STATES as readonly string[]).includes(value);
}

export function isDestroyedReason(value: unknown): value is BoxDestroyedReason {
  return typeof value === "string" && (DESTROYED_REASONS as readonly string[]).includes(value);
}

/** Whether the box may still exist at its provider (anything but `destroyed`; unknown states count as live). */
export function isActiveRecord(record: StoredBox): boolean {
  return record.state !== "destroyed";
}

function epoch(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A destroyed box with no `providerRef` never had an instance: its create call failed (an unconfirmed
 * create the destroy found an instance for records that instance's ref), so nothing was billed.
 */
function neverCreated(record: StoredBox): boolean {
  return record.state === "destroyed" && !record.providerRef;
}

/** Uptime × hourly price, in USD. A box with no price, or no instance, costs 0 in the estimate. */
export function estimatedCostUsd(record: StoredBox, now: number): number {
  if (neverCreated(record)) return 0;
  const hourly = record.hourlyUsd ?? null;
  const start = epoch(record.createdAt);
  if (hourly === null || start === null) return 0;
  const end = epoch(record.destroyedAt) ?? now;
  return roundUsd((Math.max(0, end - start) / HOUR_MS) * hourly);
}

/** Start of the UTC calendar month `now` falls in. */
export function utcMonthStart(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/** The part of the box's uptime inside this UTC month × its hourly price. */
export function monthCostUsd(record: StoredBox, now: number): number {
  if (neverCreated(record)) return 0;
  const hourly = record.hourlyUsd ?? null;
  const created = epoch(record.createdAt);
  if (hourly === null || created === null) return 0;
  const start = Math.max(created, utcMonthStart(now));
  const end = Math.min(epoch(record.destroyedAt) ?? now, now);
  return end > start ? ((end - start) / HOUR_MS) * hourly : 0;
}

export function boxesTotals(records: readonly StoredBox[], now: number): BoxesTotals {
  let activeCount = 0;
  let hourlyUsd = 0;
  let month = 0;
  for (const record of records) {
    if (isActiveRecord(record)) {
      activeCount += 1;
      hourlyUsd += record.hourlyUsd ?? 0;
    }
    month += monthCostUsd(record, now);
  }
  return { activeCount, hourlyUsd: roundUsd(hourlyUsd), monthEstimatedUsd: roundUsd(month) };
}

function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function setupOf(record: StoredBox): BoxSetupStep[] {
  const purpose: BoxPurpose = record.purpose === "temporary" ? "temporary" : "project";
  const stored = new Map((record.setup ?? []).map((step) => [step.id, step]));
  return setupStepIds(purpose).map((id) => {
    const step = stored.get(id);
    const state: BoxSetupStepState =
      step && ["pending", "running", "done", "failed", "skipped"].includes(step.state) ? (step.state as BoxSetupStepState) : "pending";
    return {
      id,
      label: step?.label ?? SETUP_STEP_LABELS[id],
      state,
      startedAt: step?.startedAt ?? null,
      finishedAt: step?.finishedAt ?? null,
      message: step?.message ?? null
    };
  });
}

function projectRef(record: StoredBox): BoxProjectRef | null {
  const project = record.project;
  return project ? { workspace: project.workspace, name: project.name, path: project.path } : null;
}

const OSES: readonly BoxOs[] = ["linux", "win32", "darwin"];
const ARCHES: readonly BoxArch[] = ["x64", "arm64"];

/**
 * The summary of one record, or null when the record names a kind, provider or state this build
 * does not know (it is kept in the store, just not shown).
 */
export function toBoxSummary(record: StoredBox, options: { providers: BoxProviderRegistry; connected: boolean; now: number }): BoxSummary | null {
  if (!isBoxKind(record.kind) || !isBoxProviderId(record.provider) || !isBoxState(record.state)) return null;
  const adapter = options.providers.get(record.provider);
  return {
    id: record.id,
    purpose: record.purpose === "temporary" ? "temporary" : "project",
    kind: record.kind,
    provider: record.provider,
    providerLabel: adapter?.label ?? record.provider,
    region: record.region,
    regionLabel: record.regionLabel ?? record.region,
    size: record.size,
    sizeLabel: record.sizeLabel ?? record.size,
    image: record.image ?? null,
    os: OSES.includes(record.os as BoxOs) ? (record.os as BoxOs) : null,
    arch: ARCHES.includes(record.arch as BoxArch) ? (record.arch as BoxArch) : null,
    state: record.state,
    stateReason: record.stateReason ?? null,
    destroyedReason: isDestroyedReason(record.destroyedReason) ? record.destroyedReason : null,
    hourlyUsd: record.hourlyUsd ?? null,
    estimatedCostUsd: estimatedCostUsd(record, options.now),
    createdAt: record.createdAt,
    readyAt: record.readyAt ?? null,
    deadlineAt: record.deadlineAt ?? null,
    destroyedAt: record.destroyedAt ?? null,
    connected: record.state !== "destroyed" && options.connected,
    lastSeenAt: record.lastSeenAt ?? null,
    project: projectRef(record),
    threadId: record.threadId ?? null,
    purposeNote: record.purposeNote ?? null,
    setup: setupOf(record)
  };
}
