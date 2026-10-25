/**
 * Ephemeral AI VMs — what the sidebar, the "Opened agents" cards, the "+" menu
 * and the agent chat say about a box (spec 2026-10-19 §8.8, §8.10, §8.11, §9.3,
 * §13.3). Pure: the components render these answers, the tests pin them.
 */

import {
  BOX_KIND_LABELS,
  SYSTEM_ACCOUNT_ID,
  boxDestroyedOutsideOrquester,
  escapeApprovalCodeText,
  sanitizeApprovalLabel,
  type BoxConfigChangeFile,
  type BoxConfigChangeSet,
  type BoxKind,
  type BoxSetupStep,
  type BoxSummary,
  type ProjectBoxInfo
} from "@orquester/api";

export type BoxTone = "neutral" | "info" | "warn" | "danger";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------
// Money and time
// ---------------------------------------------------------------------------

/** "$1.23"; a positive amount under a cent reads "<$0.01". */
export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return "<$0.01";
  return `$${amount.toFixed(2)}`;
}

/** "$0.34/h"; under ten cents an hour keeps a third decimal ("$0.045/h"). */
export function formatHourly(hourlyUsd: number): string {
  return `$${hourlyUsd >= 0.1 || hourlyUsd === 0 ? hourlyUsd.toFixed(2) : hourlyUsd.toFixed(3)}/h`;
}

export interface BoxCountdown {
  text: string;
  /** `soon`: under an hour left; `over`: the deadline passed (the box is about to be destroyed). */
  urgency: "normal" | "soon" | "over";
}

/**
 * The time left before a box's deadline, at minute resolution: days and hours
 * from one day up ("4d 6h left"), hours and minutes under a day ("5h 12m
 * left"), "<1 h left" under an hour. Null without a deadline (or one that does
 * not read as a date).
 */
export function formatBoxCountdown(deadlineAt: string | null, now: number): BoxCountdown | null {
  if (deadlineAt === null) return null;
  const deadline = Date.parse(deadlineAt);
  if (!Number.isFinite(deadline)) return null;
  const left = deadline - now;
  if (left <= 0) return { text: "time limit reached", urgency: "over" };
  if (left < HOUR_MS) return { text: "<1 h left", urgency: "soon" };
  if (left < DAY_MS) {
    const hours = Math.floor(left / HOUR_MS);
    const minutes = Math.floor((left % HOUR_MS) / MINUTE_MS);
    return { text: `${hours}h ${minutes}m left`, urgency: "normal" };
  }
  const days = Math.floor(left / DAY_MS);
  const hours = Math.floor((left % DAY_MS) / HOUR_MS);
  return { text: `${days}d ${hours}h left`, urgency: "normal" };
}

function countdownTone(countdown: BoxCountdown): BoxTone {
  return countdown.urgency === "normal" ? "warn" : "danger";
}

/** The step setup is on: the running one, else the one that failed, else the next pending one. */
export function currentSetupStep(setup: readonly BoxSetupStep[]): BoxSetupStep | null {
  return (
    setup.find((step) => step.state === "running") ??
    setup.find((step) => step.state === "failed") ??
    setup.find((step) => step.state === "pending") ??
    null
  );
}

/**
 * What a badge or gate says of a setup step: its label, and while it runs the progress it reports
 * ("Sync agent configuration (Claude account 2 of 5 · 1,240 of 2,000 files)").
 */
export function setupStepText(step: BoxSetupStep | null): string | null {
  if (!step) return null;
  return step.state === "running" && step.message ? `${step.label} (${step.message})` : step.label;
}

/** The short name a badge leads with: "macOS" for a Mac, else the provider. */
function badgeLead(info: Pick<ProjectBoxInfo, "kind" | "providerLabel">): string {
  return info.kind === "macos" ? "macOS" : info.providerLabel;
}

// ---------------------------------------------------------------------------
// Destroyed wording
// ---------------------------------------------------------------------------

/** What happened, in a few words, when the daemon gave no `stateReason`. */
function destroyedReasonText(info: Pick<ProjectBoxInfo, "destroyedReason" | "providerLabel" | "kind">): string | null {
  switch (info.destroyedReason) {
    case "provider-gone":
      return `gone in the ${info.providerLabel} dashboard`;
    case "provider-error":
      return `${info.providerLabel} reported an error`;
    case "time-limit":
      return info.kind === "macos" ? "macOS time limit reached" : "time limit reached";
    case "deleted":
      return "its project was deleted";
    case "agent":
      return "the agent destroyed it";
    case "chat-closed":
      return "its chat was closed";
    case "provisioning-failed":
      return "setting it up failed";
    case "orphan":
      return "cleaned up as a leftover";
    default:
      return null;
  }
}

const READ_ONLY_TAIL = "The transcript stays readable; you can't send new messages. Unpushed changes are lost.";

/**
 * The destroyed banner's sentence, for a chat card and the chat view: whether
 * the box went away outside Orquester (its dashboard, a provider failure, the
 * time limit) or by Orquester's hand, why, and what that means for the chat.
 */
export function boxDestroyedMessage(
  info: Pick<ProjectBoxInfo, "destroyedReason" | "stateReason" | "providerLabel" | "kind">
): string {
  const why = info.stateReason?.trim() || destroyedReasonText(info);
  const paren = why ? ` (${why})` : "";
  if (boxDestroyedOutsideOrquester(info.destroyedReason ?? undefined)) {
    return `The VM was destroyed outside Orquester${paren}. ${READ_ONLY_TAIL}`;
  }
  if (info.destroyedReason === "provisioning-failed") {
    return `The VM's setup failed and it was torn down${paren}. ${READ_ONLY_TAIL}`;
  }
  if (info.destroyedReason === null) {
    return `The VM was destroyed${paren}. ${READ_ONLY_TAIL}`;
  }
  return `The VM was destroyed by Orquester${paren}. ${READ_ONLY_TAIL}`;
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export interface BoxBadgeModel {
  text: string;
  /** A second, quieter part (the setup step while provisioning). */
  detail: string | null;
  tone: BoxTone;
  /** The tooltip: what the box is, and the state's reason. */
  title: string;
  /** The row's name is struck through and dimmed (destroyed). */
  strike: boolean;
}

/** "Linux VM on Hetzner · $0.34/h" — what every badge's tooltip starts with. */
export function boxIdentityLine(info: Pick<ProjectBoxInfo, "kind" | "providerLabel" | "hourlyUsd">): string {
  const base = `${BOX_KIND_LABELS[info.kind]} on ${info.providerLabel}`;
  return info.hourlyUsd === null ? base : `${base} · ${formatHourly(info.hourlyUsd)}`;
}

function withReason(lines: (string | null | undefined)[]): string {
  return lines.filter((line): line is string => Boolean(line && line.trim())).join("\n");
}

/**
 * A project row's badge (§8.10): provider and $/h while it runs, the countdown
 * for a box with a deadline (macOS), and the states that need saying.
 * `setupStep` is the label of the step setup is on, when known.
 */
export function projectBoxBadge(info: ProjectBoxInfo, now: number, setupStep: string | null = null): BoxBadgeModel {
  const identity = boxIdentityLine(info);
  switch (info.state) {
    case "provisioning":
      return {
        text: "Provisioning…",
        detail: setupStep,
        tone: "info",
        title: withReason([identity, setupStep ? `Setting up: ${setupStep}` : null, info.stateReason]),
        strike: false
      };
    case "unreachable":
      return {
        text: "Unreachable",
        detail: null,
        tone: "warn",
        title: withReason([identity, info.stateReason ?? "Reconnecting to the VM…"]),
        strike: false
      };
    case "destroying":
      return { text: "Destroying…", detail: null, tone: "neutral", title: withReason([identity, info.stateReason]), strike: false };
    case "destroy-failed":
      return {
        text: "Destroy failed",
        detail: null,
        tone: "danger",
        title: withReason([
          identity,
          info.stateReason,
          "The VM may still be billing. Use Retry destroy in the project's menu."
        ]),
        strike: false
      };
    case "destroyed":
      return { text: "Destroyed", detail: null, tone: "danger", title: boxDestroyedMessage(info), strike: true };
    case "ready": {
      const countdown = formatBoxCountdown(info.deadlineAt, now);
      if (countdown) {
        return {
          text: `${badgeLead(info)} · ${countdown.text}`,
          detail: null,
          tone: countdownTone(countdown),
          title: withReason([identity, "Destroyed automatically when its time limit ends.", info.stateReason]),
          strike: false
        };
      }
      return {
        text: info.hourlyUsd === null ? info.providerLabel : `${info.providerLabel} · ${formatHourly(info.hourlyUsd)}`,
        detail: null,
        tone: "neutral",
        title: withReason([identity, info.stateReason]),
        strike: false
      };
    }
  }
}

/**
 * The shorter badge an "Opened agents" card carries beside `workspace /
 * project`: "VM", the countdown, or the state.
 */
export function agentCardBoxBadge(info: ProjectBoxInfo, now: number): BoxBadgeModel {
  const identity = boxIdentityLine(info);
  const plain = (text: string, tone: BoxTone): BoxBadgeModel => ({
    text,
    detail: null,
    tone,
    title: withReason([identity, info.stateReason]),
    strike: false
  });
  switch (info.state) {
    case "provisioning":
      return plain("VM setting up", "info");
    case "unreachable":
      return { ...plain("VM unreachable", "warn"), title: withReason([identity, info.stateReason ?? "Reconnecting to the VM…"]) };
    case "destroying":
      return plain("VM destroying…", "neutral");
    case "destroy-failed":
      return plain("VM destroy failed", "danger");
    case "destroyed":
      return { text: "VM destroyed", detail: null, tone: "danger", title: boxDestroyedMessage(info), strike: false };
    case "ready": {
      const countdown = formatBoxCountdown(info.deadlineAt, now);
      return countdown ? plain(countdown.text, countdownTone(countdown)) : plain("VM", "neutral");
    }
  }
}

/** An archived box project keeps its box running (§8.11): its row says so. Null when nothing bills. */
export function archivedBoxNote(info: ProjectBoxInfo | null | undefined): string | null {
  if (!info || info.state === "destroyed") return null;
  return "still billing";
}

// ---------------------------------------------------------------------------
// Project menu
// ---------------------------------------------------------------------------

export interface BoxProjectMenu {
  /** "Retry destroy" (the same as Delete) is offered: the last destroy failed. */
  retryDestroy: boolean;
  /** The Delete confirmation's extra sentence about the box, if any. */
  deleteNote: string | null;
}

export function boxProjectMenu(info: ProjectBoxInfo | null | undefined): BoxProjectMenu {
  if (!info) return { retryDestroy: false, deleteNote: null };
  if (info.state === "destroyed") {
    return { retryDestroy: false, deleteNote: "Its VM is already gone; this removes the project, its chats and records." };
  }
  return {
    retryDestroy: info.state === "destroy-failed",
    deleteNote: `This also destroys its VM at ${info.providerLabel}; anything not pushed is lost.`
  };
}

// ---------------------------------------------------------------------------
// The agent chat (§9.3)
// ---------------------------------------------------------------------------

export interface BoxChatNotice {
  tone: BoxTone;
  title: string;
  text: string;
}

export interface BoxChatGate {
  /** Why the composer is disabled, or null when messages can be sent. */
  blockedReason: string | null;
  /** The banner or notice at the top of the chat, or null for a box that is just running. */
  notice: BoxChatNotice | null;
}

/**
 * Whether a chat of a box project can send, and what it says at its top:
 * destroyed — the read-only banner, composer disabled; provisioning — "Setting
 * up the VM", composer disabled until ready; unreachable — a non-blocking
 * "Reconnecting" notice; destroying / destroy-failed — disabled, the project
 * is going away.
 */
export function boxChatGate(info: ProjectBoxInfo | null | undefined, setupStep: string | null = null): BoxChatGate {
  if (!info) return { blockedReason: null, notice: null };
  switch (info.state) {
    case "ready":
      return { blockedReason: null, notice: null };
    case "unreachable":
      return {
        blockedReason: null,
        notice: { tone: "warn", title: "Reconnecting to the VM…", text: info.stateReason ?? "Messages are delivered once it is back." }
      };
    case "provisioning":
      return {
        blockedReason: "The VM is still being set up. You can send once it is ready.",
        notice: {
          tone: "info",
          title: setupStep ? `Setting up the VM — ${setupStep}` : "Setting up the VM",
          text: info.stateReason ?? "The chat can start once setup finishes."
        }
      };
    case "destroying":
      return {
        blockedReason: "The VM is being destroyed.",
        notice: { tone: "neutral", title: "Destroying the VM…", text: info.stateReason ?? "Its project is being deleted." }
      };
    case "destroy-failed":
      return {
        blockedReason: "Destroying the VM failed; its project is being deleted.",
        notice: {
          tone: "danger",
          title: "Destroying the VM failed",
          text: `${info.stateReason ? `${info.stateReason}. ` : ""}It may still be billing. Use Retry destroy in the project's menu.`
        }
      };
    case "destroyed":
      return {
        blockedReason: "The VM was destroyed; this chat is read-only.",
        notice: { tone: "danger", title: "VM destroyed", text: boxDestroyedMessage(info) }
      };
  }
}

/** The chat header's chip: "Linux VM · Hetzner · $0.34/h", or with the countdown. */
export function boxChatChip(info: ProjectBoxInfo, now: number): { text: string; tone: BoxTone; title: string } {
  const countdown = info.state === "ready" ? formatBoxCountdown(info.deadlineAt, now) : null;
  const parts = [BOX_KIND_LABELS[info.kind], info.providerLabel];
  if (info.hourlyUsd !== null && info.state !== "destroyed") parts.push(formatHourly(info.hourlyUsd));
  if (countdown) parts.push(countdown.text);
  const badge = projectBoxBadge(info, now);
  return {
    text: parts.join(" · "),
    tone: countdown ? countdownTone(countdown) : info.state === "ready" ? "neutral" : badge.tone,
    title: badge.title
  };
}

// ---------------------------------------------------------------------------
// The "+" menu and the account pickers (§8.8, §17.16)
// ---------------------------------------------------------------------------

export const BOX_MANAGED_ACCOUNTS_NOTE = "Box chats use managed accounts only";

export interface NewTabMenuGates {
  /** Desktops are offered: on the host, and in a Linux VM (they run inside it, its own apps offered). */
  showDesktops: boolean;
  /** The project's desktops run in its VM: their prerequisites are the VM's. */
  desktopsInVm: boolean;
  /** The line shown instead when they are not offered (a macOS or Windows VM, a VM that is gone), else null. */
  desktopsUnavailable: string | null;
}

export function newTabMenuGates(info: ProjectBoxInfo | null | undefined): NewTabMenuGates {
  if (!info) return { showDesktops: true, desktopsInVm: false, desktopsUnavailable: null };
  if (info.state === "destroyed" || info.state === "destroying") {
    return { showDesktops: false, desktopsInVm: false, desktopsUnavailable: "Desktops — not available: the VM is gone" };
  }
  if (info.kind === "linux" || info.kind === "linux-gpu") {
    return { showDesktops: true, desktopsInVm: true, desktopsUnavailable: null };
  }
  const os = info.kind === "macos" ? "macOS" : "Windows";
  return { showDesktops: false, desktopsInVm: false, desktopsUnavailable: `Desktops — not available in a ${os} VM (Linux VMs only)` };
}

/**
 * The quiet line under "New desktop…" in a VM project, from the VM's desktop
 * status (`GET /api/desktops/host?projectPath=`): only what the user must act on
 * — packages the VM cannot install by itself, or what a desktop there will lack.
 * Null when nothing is missing, when the first desktop installs what is missing
 * itself (`installsOnOpen`), or when the status is not known yet.
 */
export function vmDesktopNote(
  status:
    | { available: boolean; audioAvailable?: boolean; installHint: string | null; installsOnOpen?: boolean; warnings: readonly string[] }
    | null
    | "error"
): string | null {
  if (status === null) return null;
  if (status === "error") return "Could not check the VM's desktop packages; they are installed when a desktop opens.";
  if (status.installsOnOpen === true) return null;
  if (status.installHint) return status.installHint;
  if (!status.available) return status.warnings[0] ?? null;
  if (status.audioAvailable === false) return "Desktops in this VM run without sound.";
  return null;
}

const WINDOWS_SHELLS: ReadonlySet<string> = new Set(["pwsh", "cmd"]);

/**
 * The shells offered for a box project: those of the box's OS family (Windows
 * shells for a Windows box, the others for Linux and macOS). When the host
 * detected none of that family the list stays as it is: the daemon decides.
 */
export function boxShellChoices<T extends { id: string }>(shells: readonly T[], kind: BoxKind | null): readonly T[] {
  if (kind === null) return shells;
  const windows = kind === "windows" || kind === "windows-gpu";
  const matching = shells.filter((shell) => WINDOWS_SHELLS.has(shell.id) === windows);
  return matching.length > 0 ? matching : shells;
}

/** The shell a box terminal starts: PowerShell on Windows, bash elsewhere. */
export function boxShellRefId(box: Pick<BoxSummary, "kind" | "os">): string {
  return box.os === "win32" || box.kind === "windows" || box.kind === "windows-gpu" ? "pwsh" : "bash";
}

/** Account choices for a chat in a box: the System account is not one (spec §17.16). */
export function boxAccountOptions<T extends { id: string }>(options: readonly T[], inBox: boolean): T[] {
  return inBox ? options.filter((option) => option.id !== SYSTEM_ACCOUNT_ID) : [...options];
}

/**
 * The account a "+" launch uses: the wanted one when it is offered, else — in
 * a box, where System is not — the first managed account, else null (nothing
 * to launch with); on the host, System.
 */
export function launchAccountFor(options: readonly { id: string }[], wanted: string, inBox: boolean): string | null {
  if (options.some((option) => option.id === wanted)) return wanted;
  if (!inBox) return SYSTEM_ACCOUNT_ID;
  return options[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Temporary boxes (§13.3)
// ---------------------------------------------------------------------------

/**
 * The cost so far: the daemon's estimate, moved on with the clock while the
 * box is still up (the estimate is only refreshed with each box event).
 */
export function boxCostSoFar(box: Pick<BoxSummary, "state" | "hourlyUsd" | "estimatedCostUsd" | "createdAt">, now: number): number {
  if (box.state === "destroyed" || box.hourlyUsd === null) return box.estimatedCostUsd;
  const created = Date.parse(box.createdAt);
  if (!Number.isFinite(created)) return box.estimatedCostUsd;
  return Math.max(box.estimatedCostUsd, (box.hourlyUsd * Math.max(0, now - created)) / HOUR_MS);
}

export interface TemporaryBoxCardModel {
  title: string;
  /** "Hetzner · CX22 · Falkenstein" */
  subtitle: string;
  stateText: string;
  tone: BoxTone;
  cost: string;
  countdown: BoxCountdown | null;
  canWatch: boolean;
  canDestroy: boolean;
  /** Why Watch is unavailable, as its tooltip. */
  watchTitle: string;
}

const TEMP_STATE_TEXT: Record<BoxSummary["state"], string> = {
  provisioning: "Starting…",
  ready: "Running",
  unreachable: "Reconnecting…",
  destroying: "Destroying…",
  "destroy-failed": "Destroy failed",
  destroyed: "Destroyed"
};

const TEMP_STATE_TONE: Record<BoxSummary["state"], BoxTone> = {
  provisioning: "info",
  ready: "neutral",
  unreachable: "warn",
  destroying: "neutral",
  "destroy-failed": "danger",
  destroyed: "neutral"
};

export function temporaryBoxCard(box: BoxSummary, now: number): TemporaryBoxCardModel {
  const live = box.state !== "destroyed";
  const subtitle = [box.providerLabel, box.sizeLabel || box.size, box.regionLabel || box.region].filter(Boolean).join(" · ");
  const canWatch = box.state === "ready" && box.connected;
  // The agent wrote the purpose: one sanitised line.
  const purpose = box.purposeNote ? sanitizeApprovalLabel(box.purposeNote) : "";
  return {
    title: purpose ? `${BOX_KIND_LABELS[box.kind]} — ${purpose}` : BOX_KIND_LABELS[box.kind],
    subtitle,
    stateText: box.state === "destroyed" && box.stateReason ? `Destroyed — ${box.stateReason}` : TEMP_STATE_TEXT[box.state],
    tone: TEMP_STATE_TONE[box.state],
    cost: `${formatUsd(boxCostSoFar(box, now))} so far${box.hourlyUsd !== null && live ? ` · ${formatHourly(box.hourlyUsd)}` : ""}`,
    countdown: live ? formatBoxCountdown(box.deadlineAt, now) : null,
    canWatch,
    canDestroy: box.state !== "destroyed" && box.state !== "destroying",
    watchTitle: canWatch ? "Open a terminal in this VM" : box.state === "ready" ? "The VM is not connected right now" : "Available while the VM is running"
  };
}

/** The "Watch" terminal tab's title: "VM · macOS" (the kind), so several boxes' tabs tell apart. */
export function boxTerminalTitle(box: Pick<BoxSummary, "kind" | "purposeNote">): string {
  const purpose = box.purposeNote ? sanitizeApprovalLabel(box.purposeNote, 40) : "";
  return purpose ? `VM · ${purpose}` : `VM · ${BOX_KIND_LABELS[box.kind]}`;
}

/**
 * A box whose create call the provider refused: no machine ever existed and nothing was billed (the
 * daemon counts no cost for a box without an instance; a refused create that still left an instance
 * the destroy found does cost, and stays listed).
 */
export function boxNeverExisted(box: Pick<BoxSummary, "state" | "setup" | "estimatedCostUsd">): boolean {
  return (
    box.state === "destroyed" &&
    box.estimatedCostUsd === 0 &&
    box.setup.some((step) => step.id === "create" && step.state === "failed")
  );
}

/** A chat's temporary boxes, live ones first, newest first within each; failed rentals are left out. */
export function chatTemporaryBoxes(boxes: readonly BoxSummary[], threadId: string): BoxSummary[] {
  return boxes
    .filter((box) => box.purpose === "temporary" && box.threadId === threadId && !boxNeverExisted(box))
    .sort((a, b) => {
      const liveA = a.state === "destroyed" ? 1 : 0;
      const liveB = b.state === "destroyed" ? 1 : 0;
      return liveA - liveB || b.createdAt.localeCompare(a.createdAt);
    });
}

/** The folded box panel's line: "1 VM running · 2 destroyed · 1 config change to review". */
export function boxPanelSummary(temporary: readonly Pick<BoxSummary, "state">[], pendingChanges: number): string {
  const live = temporary.filter((box) => box.state !== "destroyed").length;
  const ended = temporary.length - live;
  const parts: string[] = [];
  if (live > 0) parts.push(`${live} ${live === 1 ? "VM" : "VMs"} running`);
  if (ended > 0) parts.push(`${ended} destroyed`);
  if (pendingChanges > 0) parts.push(`${pendingChanges} config ${pendingChanges === 1 ? "change" : "changes"} to review`);
  return parts.length > 0 ? parts.join(" · ") : "VM details";
}

/** The smallest height the box panel's list is dragged to: about one card. */
const BOX_PANEL_MIN_HEIGHT_PX = 48;

/** A dragged or stored list height, kept between one card and 70% of the view. */
export function clampBoxPanelHeight(px: number, viewportHeight: number): number {
  const max = Math.max(BOX_PANEL_MIN_HEIGHT_PX, Math.round(viewportHeight * 0.7));
  return Math.min(max, Math.max(BOX_PANEL_MIN_HEIGHT_PX, Math.round(px)));
}

/** A stored list height (localStorage text), or null when there is none worth trusting. */
export function parseBoxPanelHeight(raw: string | null): number | null {
  if (raw === null || !/^\d{1,5}$/.test(raw)) return null;
  const px = Number(raw);
  return px >= BOX_PANEL_MIN_HEIGHT_PX ? px : null;
}

// ---------------------------------------------------------------------------
// Box → host config changes (§8.3)
// ---------------------------------------------------------------------------

/** The pending change sets a chat's turn made. */
export function chatPendingConfigChanges(changes: readonly BoxConfigChangeSet[], threadId: string): BoxConfigChangeSet[] {
  return changes.filter((change) => change.state === "pending" && change.threadId === threadId);
}

/** The pending change sets of a project's box that no chat turn made (shown on the project row). */
export function projectPendingConfigChanges(
  changes: readonly BoxConfigChangeSet[],
  boxId: string | null | undefined
): BoxConfigChangeSet[] {
  if (!boxId) return [];
  return changes.filter((change) => change.state === "pending" && change.threadId === null && change.boxId === boxId);
}

/**
 * The change sets a card list keeps showing: every set that was pending while
 * the list was on screen, in the order they appeared — so a set decided here
 * (or gone stale meanwhile) stays with its outcome until dismissed, instead of
 * vanishing under the pointer. A set the daemon no longer reports is dropped;
 * a dismissed one never comes back.
 */
export function nextShownChangeIds(
  shown: readonly string[],
  pendingIds: readonly string[],
  knownIds: ReadonlySet<string>,
  dismissed: ReadonlySet<string>
): string[] {
  const kept = shown.filter((id) => knownIds.has(id) && !dismissed.has(id));
  const added = pendingIds.filter((id) => !kept.includes(id) && !dismissed.has(id));
  return kept.length === shown.length && added.length === 0 ? (shown as string[]) : [...kept, ...added];
}

/** "2 config changes need approval" */
export function configChangesIndicator(count: number): string | null {
  if (count <= 0) return null;
  return `${count} config change${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} approval`;
}

export interface ConfigChangeFileRow {
  path: string;
  /** "Added", "Modified", "Deleted" */
  changeLabel: string;
  executable: boolean;
  /** The diff to show when expanded, or null when there is none to show. */
  diff: string | null;
  /** A note under (or instead of) the diff: binary, truncated, nothing to show. */
  note: string | null;
}

/** A host path is shown whole (a path is never cut in an approval). */
const CONFIG_PATH_MAX_CHARS = 4096;

const CHANGE_LABEL: Record<BoxConfigChangeFile["change"], string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted"
};

/**
 * One file of a change set as the card shows it. The path and diff were written
 * by an agent in the box, so the path is one sanitised line and the diff shows
 * control, bidi and zero-width characters as visible escapes — as an approval
 * card's code does.
 */
export function configChangeFileRow(file: BoxConfigChangeFile): ConfigChangeFileRow {
  const diff = file.binary || file.diff.length === 0 ? null : escapeApprovalCodeText(file.diff);
  const note = file.binary
    ? "Binary file — no diff to show."
    : file.truncated
      ? "The diff is truncated; the rest is not shown."
      : diff === null
        ? "No textual changes."
        : null;
  return {
    path: sanitizeApprovalLabel(file.path, CONFIG_PATH_MAX_CHARS),
    changeLabel: CHANGE_LABEL[file.change],
    // A deletion runs nothing (sets stored before the daemon said so may still flag one).
    executable: file.executable && file.change !== "deleted",
    diff,
    note
  };
}

export interface ConfigChangeCardModel {
  title: string;
  /** "3 files · 1 executable" */
  summary: string;
  rows: ConfigChangeFileRow[];
  executableCount: number;
  /** Approve and Deny are offered (the set is pending and no answer is in flight). */
  canDecide: boolean;
  /** What the set ended as, once it is not pending. */
  outcome: string | null;
}

const OUTCOME: Record<Exclude<BoxConfigChangeSet["state"], "pending">, string> = {
  approved: "Approved — written to this host and the other VMs.",
  denied: "Denied — the VM's copy was reverted.",
  stale: "Stale — the host's copy changed meanwhile, so the host's version was kept."
};

export function configChangeCard(change: BoxConfigChangeSet, submitting: boolean): ConfigChangeCardModel {
  const rows = change.files.map(configChangeFileRow);
  const executableCount = rows.filter((row) => row.executable).length;
  const fileCount = `${rows.length} file${rows.length === 1 ? "" : "s"}`;
  return {
    title: "The VM changed agent configuration",
    summary: executableCount > 0 ? `${fileCount} · ${executableCount} executable` : fileCount,
    rows,
    executableCount,
    canDecide: change.state === "pending" && !submitting,
    outcome: change.state === "pending" ? null : OUTCOME[change.state]
  };
}

/** A refused decision, said plainly: by HTTP status (null: no answer). */
export function configChangeDecisionFailure(status: number | null): string {
  if (status === 404) return "This change is gone — it was decided elsewhere or the VM went away.";
  if (status === 409) return "This change was already decided, or went stale.";
  if (status === null) return "Could not reach Orquester. Try again.";
  return `Orquester refused the decision (${status}). Try again.`;
}
