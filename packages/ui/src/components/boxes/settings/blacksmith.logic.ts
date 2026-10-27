/**
 * The Blacksmith (macOS and Linux) row of the Providers card (spec §11.2): five steps —
 * a connected GitHub account, an org, the Blacksmith app, the control repo
 * (automatic) and a test run — each with the state the daemon reports.
 */

import type {
  AccountSummary,
  BlacksmithSetupResponse,
  BlacksmithSetupStep,
  BlacksmithSetupStepId,
  OwnerSummary
} from "@orquester/api";

import type { Tone } from "../../settings/primitives";

/** The Git hosting accounts Blacksmith can use: GitHub ones (it is GitHub-only). */
export function blacksmithAccounts(accounts: readonly AccountSummary[]): AccountSummary[] {
  return accounts.filter((account) => account.provider === "github");
}

/** The orgs of the chosen account (Blacksmith is organization-only). */
export function blacksmithOrgs(owners: readonly OwnerSummary[] | null): OwnerSummary[] {
  return (owners ?? []).filter((owner) => owner.kind === "org");
}

export function blacksmithStep(
  setup: BlacksmithSetupResponse | null,
  id: BlacksmithSetupStepId
): BlacksmithSetupStep | null {
  return setup?.steps.find((step) => step.id === id) ?? null;
}

export type BlacksmithStatus =
  | { kind: "pill"; tone: Tone; label: string }
  /** Nothing picked yet: the row offers "Set up". */
  | { kind: "setup" };

/** The row's status: Connected once every step is done; else where it stands. */
export function blacksmithStatus(setup: BlacksmithSetupResponse | null): BlacksmithStatus {
  if (!setup) return { kind: "setup" };
  const states = setup.steps.map((step) => step.state);
  if (states.every((state) => state === "ok")) return { kind: "pill", tone: "ok", label: "Connected" };
  if (states.includes("failed")) return { kind: "pill", tone: "danger", label: "Error" };
  if (states.includes("running")) return { kind: "pill", tone: "info", label: "Setting up…" };
  if (states.includes("action-needed")) return { kind: "pill", tone: "warn", label: "Action needed" };
  if (!setup.gitAccountId) return { kind: "setup" };
  return { kind: "pill", tone: "neutral", label: "In progress" };
}

/** Whether a step is running (the setup is then re-read until it settles). */
export function blacksmithBusy(setup: BlacksmithSetupResponse | null): boolean {
  return setup?.steps.some((step) => step.state === "running") ?? false;
}

/** The test run can start once the control repo is in place, and not while one runs. */
export function blacksmithCanTest(setup: BlacksmithSetupResponse | null): boolean {
  const repo = blacksmithStep(setup, "repo");
  const test = blacksmithStep(setup, "test");
  return repo?.state === "ok" && test?.state !== "running";
}

/**
 * An automatic step that stopped (the control repo) offers Retry: it re-runs the automatic steps
 * (`PUT` with an empty body). The test step has its own "Run the test again".
 */
export function blacksmithCanRetry(step: BlacksmithSetupStep): boolean {
  return step.id === "repo" && (step.state === "failed" || step.state === "action-needed");
}

/** The org step can be chosen once the account step is done. */
export function blacksmithCanPickOrg(setup: BlacksmithSetupResponse | null): boolean {
  return !!setup?.gitAccountId && blacksmithStep(setup, "account")?.state === "ok";
}

/**
 * Re-reading a running setup: the delay before the next read (growing by half
 * each time, capped) and whether the deadline still allows one.
 */
export const BLACKSMITH_POLL = { firstMs: 2_000, maxMs: 15_000, deadlineMs: 15 * 60_000 } as const;

export function nextBlacksmithPoll(previousMs: number | null, startedAt: number, now: number): number | null {
  const delay =
    previousMs === null ? BLACKSMITH_POLL.firstMs : Math.min(BLACKSMITH_POLL.maxMs, Math.round(previousMs * 1.5));
  return now + delay - startedAt > BLACKSMITH_POLL.deadlineMs ? null : delay;
}
