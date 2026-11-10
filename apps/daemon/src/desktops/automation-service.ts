// Desktop automation for agents (spec 2026-11-10 §2.3–§3): one DesktopAutomation per running
// desktop, opened on the first action and closed after 5 idle minutes, when the desktop stops or
// its X connection drops (the next action opens a new one); who controls each desktop's input
// (`control.ts`, runtime only) with the agent's control lapsing 2 minutes after its last action;
// the action log (`action-log.ts`); and the kept screenshots (`screenshots.ts`). The manager owns
// one and delegates to it; the routes reach it through the manager.
//
// The screen sequence (`seq`, and a wait's `since`) is the service's, not the engine's: each engine
// counts from 0, so the service adds a per-desktop base. A reopened engine's base is one past the
// last number the previous engine could have reported, so a desktop's numbers only rise; and the
// first base of a daemon run is its start time in microseconds, above any number the run before
// reached (that would take more than one change per microsecond on average). A `since` from an
// earlier engine therefore lies before everything the current one saw and counts as changed (it
// cannot tell what happened meanwhile); a `since` past the current number (none can be) means "from now".

import {
  DESKTOP_AGENT_CONTROL_LAPSE_MS,
  DESKTOP_CONTROLLED_BY_USER_CODE,
  DESKTOP_IDLE_DEFAULT_MS,
  DESKTOP_NOT_RUNNING_CODE,
  DESKTOP_RESIZED_CODE,
  DESKTOP_SCREENSHOT_DEFAULT_MAX,
  DESKTOP_WAIT_DEFAULT_TIMEOUT_MS,
  type DesktopActionEntry,
  type DesktopActionEventPayload,
  type DesktopActionRequest,
  type DesktopActionResponse,
  type DesktopControl,
  type DesktopController,
  type DesktopMouseButton,
  type DesktopRect,
  type DesktopScreenshotInfo,
  type DesktopSize,
  type DesktopWindow,
  isReadOnlyDesktopAction
} from "@orquester/api";
import { DESKTOP_INVALID_ARGUMENT_CODE, parseDesktopActionRequest } from "./action-request.ts";
import { type DesktopActionDraft, type DesktopActionFacts, DesktopActionLog, actionSummary, failedActionSummary, loggedText } from "./action-log.ts";
import {
  type DesktopAutomation,
  DesktopAutomationError,
  type DesktopAutomationTarget,
  type DesktopCapture,
  type OpenDesktopAutomation,
  type XButton
} from "./automation/types.ts";
import { keysymsForText, parseCombo } from "./automation/keys.ts";
import { agentInputControl, requestedControl, sameActor } from "./control.ts";
import { ImagePoolBusyError } from "../devices/image-pool.ts";
import { DesktopError } from "./errors.ts";
import type { DesktopScreenshotStore } from "./screenshots.ts";

/** A capture encoded as the image an action returns (PNG when it fits, else a JPEG; long edge ≤ `maxSize`). */
export interface EncodedDesktopScreenshot {
  mimeType: "image/png" | "image/jpeg";
  data: Buffer;
  width: number;
  height: number;
  /** Display pixels per image pixel (≥ 1). */
  scale: number;
}

/** Encodes a capture in the image workers (never on the event loop). */
export type DesktopScreenshotEncoder = (capture: DesktopCapture, maxSize: number) => Promise<EncodedDesktopScreenshot>;

const UNAVAILABLE = "automation engine unavailable";

// The daemon passes the engine's `openDesktopAutomation` (`automation/engine.ts`) and the image
// workers' `encodeDesktopScreenshot` (`automation/screenshot.ts`) as
// `DesktopManagerOptions.openAutomation` / `.encodeScreenshot` (index.ts); without them (a manager
// built for a test that needs no automation) these defaults refuse every action.
export const automationEngineUnavailable: OpenDesktopAutomation = async () => {
  throw new DesktopError(503, "DESKTOP_AUTOMATION_UNAVAILABLE", UNAVAILABLE);
};
export const screenshotEncoderUnavailable: DesktopScreenshotEncoder = async () => {
  throw new DesktopError(503, "DESKTOP_AUTOMATION_UNAVAILABLE", UNAVAILABLE);
};

/** What the service reads of one desktop (the manager's runtime). */
export interface DesktopAutomationDesktop {
  /** How the engine reaches the display; throws a DesktopError (409) while it is not running or out of reach. */
  target(): DesktopAutomationTarget;
  /** The tracker's windows now (with their bounds once known). */
  windows(): readonly DesktopWindow[];
}

export interface DesktopAutomationServiceOptions {
  open: OpenDesktopAutomation;
  encode: DesktopScreenshotEncoder;
  screenshots: DesktopScreenshotStore;
  /** The desktop, or undefined when there is none. */
  desktop(desktopId: string): DesktopAutomationDesktop | undefined;
  /** A desktop's control changed (the manager sends `desktop.updated`). */
  controlChanged(desktopId: string): void;
  /** An action was logged (`desktop.action`). */
  actionLogged(payload: DesktopActionEventPayload): void;
  /** How long an unused automation stays open (default 5 min). */
  idleCloseMs?: number;
  now?: () => Date;
  logger?: Pick<Console, "warn">;
}

interface DesktopAutomationState {
  automation: DesktopAutomation | null;
  opening: Promise<DesktopAutomation> | null;
  /** Bumped whenever the automation is let go: an open (or an action) from before is stale. */
  epoch: number;
  inFlight: number;
  idleTimer: NodeJS.Timeout | null;
  control: DesktopControl | null;
  lapseTimer: NodeJS.Timeout | null;
  /** Aborted (and replaced) when the user takes control: input claimed before then stops. */
  inputAbort: AbortController;
  /** The base the next engine's sequence gets (one past the last one's highest). */
  nextSeqBase: number;
}

/** What one action did, before it is logged. */
interface ActionOutcome {
  facts: DesktopActionFacts;
  screenshot?: DesktopActionResponse["screenshot"];
  seq?: number;
  cursor?: { x: number; y: number };
  wait?: { changed: boolean; timedOut: boolean; waitedMs: number };
  text?: string;
}

const IDLE_CLOSE_MS = 5 * 60_000;
/** How long daemon shutdown waits for the automations' clean-up (the CLI force-exits 3 s into a stop). */
const SHUTDOWN_CLOSE_MS = 1_000;
/** `screenshot: true`: the screen must be still this long after the input, waited for at most this long. */
const SETTLE_IDLE_MS = 300;
const SETTLE_TIMEOUT_MS = 3_000;
const DEFAULT_SCROLL_AMOUNT = 3;
const BUTTONS: Record<DesktopMouseButton, XButton> = { left: 1, middle: 2, right: 3 };

export class DesktopAutomationService {
  private readonly states = new Map<string, DesktopAutomationState>();
  /** Each open engine's sequence base (see the header). */
  private readonly seqBases = new WeakMap<DesktopAutomation, number>();
  /** The first base of this daemon run: its start in microseconds. */
  private readonly seqOrigin: number;
  private readonly log = new DesktopActionLog({ now: () => this.now() });
  private readonly idleCloseMs: number;
  private readonly now: () => Date;
  private readonly logger: Pick<Console, "warn">;

  constructor(private readonly options: DesktopAutomationServiceOptions) {
    this.idleCloseMs = options.idleCloseMs ?? IDLE_CLOSE_MS;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? console;
    this.seqOrigin = this.now().getTime() * 1_000;
  }

  /** Who controls the desktop's input now (`null`: nobody). */
  control(desktopId: string): DesktopControl | null {
    return this.states.get(desktopId)?.control ?? null;
  }

  /** The desktop's action log, oldest first. */
  entries(desktopId: string): DesktopActionEntry[] {
    return this.log.list(desktopId);
  }

  /** A kept screenshot's bytes (404 when this desktop kept no such screenshot). */
  async screenshot(desktopId: string, screenshotId: string): Promise<{ mimeType: "image/png" | "image/jpeg"; data: Buffer }> {
    const image = await this.options.screenshots.read(desktopId, screenshotId);
    if (!image) throw screenshotNotFound();
    return image;
  }

  /** `PUT control`: take over, give back or clear (control.ts); the new control. */
  setControl(desktopId: string, controller: DesktopController | null): DesktopControl | null {
    const state = this.state(desktopId);
    this.changeControl(desktopId, state, requestedControl(state.control, controller, this.now().toISOString()));
    return state.control;
  }

  /**
   * Run one action (`request`: a DesktopActionRequest, validated here). Input claims control for
   * its actor and is refused (409 DESKTOP_CONTROLLED_BY_USER) while the user has it; reads always
   * run. Every validated action on a known desktop is logged, failures included.
   */
  async run(desktopId: string, body: unknown, signal?: AbortSignal): Promise<DesktopActionResponse> {
    const request = parseDesktopActionRequest(body);
    checkKeys(request);
    const desktop = this.options.desktop(desktopId);
    if (!desktop) throw new DesktopError(404, "DESKTOP_NOT_FOUND", "No such desktop.");
    const state = this.state(desktopId);
    const epoch = state.epoch;
    state.inFlight += 1;
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = null;
    try {
      if (!isReadOnlyDesktopAction(request.action) && state.control?.controller === "user") throw controlledByUser();
      const automation = await this.automationFor(desktopId, state, desktop);
      const seqBase = this.seqBases.get(automation) ?? state.nextSeqBase;
      const outcome = await this.perform(desktopId, state, epoch, automation, seqBase, desktop, request, signal);
      // Closed meanwhile: its log is gone.
      if (this.states.get(desktopId) !== state) throw notRunning();
      const entry = this.record(desktopId, {
        actor: request.actor,
        kind: request.action,
        summary: actionSummary(outcome.facts),
        ...entryFacts(outcome.facts),
        ...(outcome.screenshot ? { screenshotId: outcome.screenshot.screenshotId } : {}),
        ok: true
      });
      const cursor = outcome.cursor ?? (await automation.pointer().catch(() => undefined));
      return {
        desktopId,
        action: request.action,
        summary: entry.summary,
        seq: seqBase + (outcome.seq ?? automation.seq()),
        display: automation.size(),
        ...(cursor ? { cursor } : {}),
        ...(outcome.wait ?? {}),
        ...(outcome.text !== undefined ? { text: outcome.text } : {}),
        ...(outcome.screenshot ? { screenshot: outcome.screenshot } : {}),
        control: state.control,
        entry
      };
    } catch (caught) {
      const error = state.epoch !== epoch && !(caught instanceof DesktopError) ? notRunning() : desktopErrorOf(caught);
      if (this.states.get(desktopId) === state) {
        this.record(desktopId, {
          actor: request.actor,
          kind: request.action,
          summary: failedActionSummary(request.action, request.keys),
          ok: false,
          error: error.message
        });
      }
      throw error;
    } finally {
      state.inFlight -= 1;
      if (this.states.get(desktopId) === state) {
        // The agent holding control keeps it for another lapse period after each of its actions.
        if (state.control?.controller === "agent" && sameActor(state.control.actor, request.actor)) this.armLapse(desktopId, state);
        this.armIdleClose(desktopId, state);
      }
    }
  }

  /**
   * The desktop stopped or its display went out of reach: close its automation (control and log
   * stay). Resolves once the close is done (it never rejects); callers that need not wait ignore it.
   */
  release(desktopId: string): Promise<void> {
    const state = this.states.get(desktopId);
    if (!state) return Promise.resolve();
    state.epoch += 1;
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = null;
    state.opening = null;
    const automation = state.automation;
    state.automation = null;
    if (!automation) return Promise.resolve();
    this.retireSeq(state, automation);
    return automation.close().catch((error: unknown) => this.logger.warn(`Desktop ${desktopId}: closing its automation failed`, error));
  }

  /** The desktop closed: its automation, control, log and screenshots go. */
  async forget(desktopId: string): Promise<void> {
    void this.release(desktopId);
    const state = this.states.get(desktopId);
    if (state?.lapseTimer) clearTimeout(state.lapseTimer);
    this.states.delete(desktopId);
    this.log.forget(desktopId);
    await this.options.screenshots.remove(desktopId);
  }

  /**
   * Daemon shutdown: every automation closes, no timer stays. Resolves once the closes are done,
   * so held buttons are released and borrowed keycodes restored on the X server before the daemon
   * exits; at most {@link SHUTDOWN_CLOSE_MS} (each close gives up on a silent server by itself, but
   * later than the daemon's own stop deadline).
   */
  async shutdown(): Promise<void> {
    const closes: Promise<void>[] = [];
    for (const [desktopId, state] of this.states) {
      closes.push(this.release(desktopId));
      if (state.lapseTimer) clearTimeout(state.lapseTimer);
      state.lapseTimer = null;
    }
    let bound: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(closes),
      new Promise<void>((resolve) => {
        bound = setTimeout(resolve, SHUTDOWN_CLOSE_MS);
        bound.unref?.();
      })
    ]);
    clearTimeout(bound);
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  private async perform(
    desktopId: string,
    state: DesktopAutomationState,
    epoch: number,
    automation: DesktopAutomation,
    seqBase: number,
    desktop: DesktopAutomationDesktop,
    request: DesktopActionRequest,
    signal: AbortSignal | undefined
  ): Promise<ActionOutcome> {
    const { action } = request;
    /**
     * Input runs only once control is the actor's (checked again: the user may have taken over
     * meanwhile). The signal it returns aborts when the user takes over after this (or the caller
     * goes away): the engine then stops the input before its turn or between its steps.
     */
    const claim = (): AbortSignal => {
      const next = agentInputControl(state.control, request.actor, this.now().toISOString());
      if (!next.ok) throw controlledByUser();
      this.changeControl(desktopId, state, next.control);
      const takenOver = state.inputAbort.signal;
      return signal ? AbortSignal.any([takenOver, signal]) : takenOver;
    };
    const settled = async (outcome: ActionOutcome): Promise<ActionOutcome> => {
      if (request.screenshot !== true) return outcome;
      // Still for 300 ms counted from the end of the input (the engine's clock), not from the last
      // change before it: an app that has not redrawn yet must get the time to start.
      await automation.wait({ for: "idle", idleMs: SETTLE_IDLE_MS, notBefore: Date.now(), timeoutMs: SETTLE_TIMEOUT_MS, ...(signal ? { signal } : {}) });
      const shot = await this.takeScreenshot(desktopId, state, epoch, automation, undefined, request.maxSize);
      return { ...outcome, screenshot: shot.screenshot, seq: shot.seq, cursor: shot.cursor };
    };
    const pointAt = async (x: number | undefined, y: number | undefined): Promise<{ x: number; y: number }> =>
      x === undefined || y === undefined ? automation.pointer() : this.displayPoint(desktopId, automation, request.screenshotId, x, y);
    const button = request.button ?? "left";
    const modifiers = request.modifiers ?? [];

    switch (action) {
      case "screenshot": {
        const size = automation.size();
        const region =
          request.windowId !== undefined
            ? windowRegion(desktop.windows(), request.windowId, size)
            : request.region !== undefined
              ? displayRegion(request.region, size)
              : undefined;
        const shot = await this.takeScreenshot(desktopId, state, epoch, automation, region, request.maxSize);
        return { facts: { kind: action }, ...shot };
      }
      case "wait": {
        const kind = request.for ?? "idle";
        const result = await automation.wait({
          for: kind,
          idleMs: request.idleMs ?? DESKTOP_IDLE_DEFAULT_MS,
          // In the engine's numbers: before its first one when older, "now" when past the current one.
          ...(request.since !== undefined ? { since: Math.min(request.since - seqBase, automation.seq()) } : {}),
          ...(request.region !== undefined ? { region: displayRegion(request.region, automation.size()) } : {}),
          timeoutMs: request.timeoutMs ?? DESKTOP_WAIT_DEFAULT_TIMEOUT_MS,
          ...(signal ? { signal } : {})
        });
        return {
          facts: { kind: action, wait: { for: kind, waitedMs: result.waitedMs, timedOut: result.timedOut } },
          seq: result.seq,
          wait: { changed: result.changed, timedOut: result.timedOut, waitedMs: result.waitedMs }
        };
      }
      case "move": {
        const point = await pointAt(request.x, request.y);
        await automation.move(point.x, point.y, claim());
        return settled({ facts: { kind: action, point } });
      }
      case "click": {
        const point = await pointAt(request.x, request.y);
        const count = request.count ?? 1;
        await automation.click(point.x, point.y, BUTTONS[button], count, modifiers, claim());
        return settled({ facts: { kind: action, point, button, count, modifiers } });
      }
      case "mouse_down":
      case "mouse_up": {
        const point = await pointAt(request.x, request.y);
        const input = claim();
        if (request.x !== undefined) await automation.move(point.x, point.y, input);
        await automation.button(BUTTONS[button], action === "mouse_down", input);
        return settled({ facts: { kind: action, point, button } });
      }
      case "drag": {
        const from = await pointAt(request.x, request.y);
        const to = await pointAt(request.toX, request.toY);
        await automation.drag(from, to, BUTTONS[button], modifiers, claim());
        return settled({ facts: { kind: action, point: from, to, button, modifiers } });
      }
      case "scroll": {
        const point = await pointAt(request.x, request.y);
        const amount = request.amount ?? DEFAULT_SCROLL_AMOUNT;
        await automation.scroll(request.x === undefined ? null : point, request.direction!, amount, modifiers, claim());
        return settled({ facts: { kind: action, point, direction: request.direction!, amount, modifiers } });
      }
      case "key": {
        const repeat = request.repeat ?? 1;
        await automation.key(request.keys!, repeat, claim());
        return settled({ facts: { kind: action, keys: request.keys!, repeat } });
      }
      case "type":
        await automation.type(request.text!, claim());
        return settled({ facts: { kind: action, text: request.text! } });
      case "clipboard_get":
        return { facts: { kind: action }, text: await automation.getClipboard() };
      case "clipboard_set":
        await automation.setClipboard(request.text!, claim());
        return { facts: { kind: action, text: request.text! } };
    }
  }

  /**
   * A point in display pixels: (x, y) as given, or — with `screenshotId` — pixels of that
   * screenshot mapped through its scale and origin (DESKTOP_RESIZED when the display size changed
   * since). Outside the display (or the screenshot) is INVALID_ARGUMENT.
   */
  private async displayPoint(desktopId: string, automation: DesktopAutomation, screenshotId: string | undefined, x: number, y: number): Promise<{ x: number; y: number }> {
    const size = automation.size();
    if (screenshotId === undefined) {
      if (x >= size.width || y >= size.height) throw invalid(`${Math.round(x)}, ${Math.round(y)} is outside the display (${size.width}×${size.height}).`);
      return { x: Math.min(Math.round(x), size.width - 1), y: Math.min(Math.round(y), size.height - 1) };
    }
    const meta = await this.options.screenshots.meta(desktopId, screenshotId);
    if (!meta) throw screenshotNotFound();
    if (meta.display.width !== size.width || meta.display.height !== size.height) {
      throw new DesktopError(
        409,
        DESKTOP_RESIZED_CODE,
        `The display is ${size.width}×${size.height} now (it was ${meta.display.width}×${meta.display.height} when that screenshot was taken): take a new screenshot.`
      );
    }
    if (x >= meta.width || y >= meta.height) throw invalid(`${Math.round(x)}, ${Math.round(y)} is outside that screenshot (${meta.width}×${meta.height}).`);
    // (A screenshot lies on the display it was taken of: the clamp only absorbs rounding.)
    const mapped = (origin: number, value: number, extent: number) => Math.min(Math.max(0, Math.round(origin + value * meta.scale)), extent - 1);
    return { x: mapped(meta.origin.x, x, size.width), y: mapped(meta.origin.y, y, size.height) };
  }

  /** Capture, encode in the image workers, keep: the response's screenshot and what it observed. */
  private async takeScreenshot(
    desktopId: string,
    state: DesktopAutomationState,
    epoch: number,
    automation: DesktopAutomation,
    region: DesktopRect | undefined,
    maxSize: number | undefined
  ): Promise<{ screenshot: DesktopScreenshotInfo & { base64: string }; seq: number; cursor: { x: number; y: number } }> {
    const capture = await automation.capture(region);
    const image = await this.options.encode(capture, maxSize ?? DESKTOP_SCREENSHOT_DEFAULT_MAX);
    // Closed or stopped meanwhile: nothing is kept for it any more.
    if (this.states.get(desktopId) !== state || state.epoch !== epoch) throw notRunning();
    const origin = { x: capture.origin.x, y: capture.origin.y };
    const screenshotId = await this.options.screenshots.save(
      desktopId,
      { mimeType: image.mimeType, data: image.data },
      { width: image.width, height: image.height, scale: image.scale, origin, display: { ...capture.display } }
    );
    return {
      screenshot: {
        screenshotId,
        mimeType: image.mimeType,
        width: image.width,
        height: image.height,
        scale: image.scale,
        origin,
        base64: image.data.toString("base64")
      },
      seq: capture.seq,
      cursor: capture.cursor
    };
  }

  // ---------------------------------------------------------------------------
  // The automation, control and the log
  // ---------------------------------------------------------------------------

  /** The desktop's automation: the open one, or a new one (one open at a time). */
  private automationFor(desktopId: string, state: DesktopAutomationState, desktop: DesktopAutomationDesktop): Promise<DesktopAutomation> {
    if (state.automation && !state.automation.closed) return Promise.resolve(state.automation);
    if (state.automation) {
      // Its connection dropped: a new one replaces it.
      const dropped = state.automation;
      state.automation = null;
      this.retireSeq(state, dropped);
      void dropped.close().catch(() => undefined);
    }
    if (state.opening) return state.opening;
    const epoch = state.epoch;
    const target = desktop.target();
    const opening = this.options.open(target).then(
      async (automation) => {
        if (state.epoch !== epoch || this.states.get(desktopId) !== state) {
          await automation.close().catch(() => undefined);
          throw notRunning();
        }
        state.automation = automation;
        this.seqBases.set(automation, state.nextSeqBase);
        return automation;
      }
    );
    state.opening = opening;
    void opening.then(
      () => undefined,
      () => undefined
    ).then(() => {
      if (state.opening === opening) state.opening = null;
    });
    return opening;
  }

  /** An engine let go: the next one's numbers start past every number it could have reported. */
  private retireSeq(state: DesktopAutomationState, automation: DesktopAutomation): void {
    const base = this.seqBases.get(automation);
    if (base !== undefined) state.nextSeqBase = Math.max(state.nextSeqBase, base + automation.seq() + 1);
  }

  private changeControl(desktopId: string, state: DesktopAutomationState, control: DesktopControl | null): void {
    if (control === state.control) return;
    state.control = control;
    if (control?.controller === "user") {
      // The agent's input in flight or queued stops (DESKTOP_CONTROLLED_BY_USER); later input claims anew.
      state.inputAbort.abort(controlledByUser());
      state.inputAbort = new AbortController();
    }
    this.armLapse(desktopId, state);
    if (this.states.get(desktopId) === state) this.options.controlChanged(desktopId);
  }

  /** An agent's control lapses DESKTOP_AGENT_CONTROL_LAPSE_MS after its last action (one timer, re-armed by each). */
  private armLapse(desktopId: string, state: DesktopAutomationState): void {
    if (state.lapseTimer) clearTimeout(state.lapseTimer);
    state.lapseTimer = null;
    if (state.control?.controller !== "agent") return;
    state.lapseTimer = setTimeout(() => {
      state.lapseTimer = null;
      if (state.control?.controller === "agent") this.changeControl(desktopId, state, null);
    }, DESKTOP_AGENT_CONTROL_LAPSE_MS);
    state.lapseTimer.unref?.();
  }

  /** No action running: the automation closes after idleCloseMs unless another comes. */
  private armIdleClose(desktopId: string, state: DesktopAutomationState): void {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = null;
    if (state.inFlight > 0 || (!state.automation && !state.opening)) return;
    state.idleTimer = setTimeout(() => {
      state.idleTimer = null;
      if (state.inFlight === 0) this.release(desktopId);
    }, this.idleCloseMs);
    state.idleTimer.unref?.();
  }

  /** Log a row and send it out (`desktop.action`). */
  private record(desktopId: string, draft: DesktopActionDraft): DesktopActionEntry {
    const entry = this.log.append(desktopId, draft);
    this.options.actionLogged({ desktopId, entry });
    return entry;
  }

  private state(desktopId: string): DesktopAutomationState {
    let state = this.states.get(desktopId);
    if (!state) {
      state = { automation: null, opening: null, epoch: 0, inFlight: 0, idleTimer: null, control: null, lapseTimer: null, inputAbort: new AbortController(), nextSeqBase: this.seqOrigin };
      this.states.set(desktopId, state);
    }
    return state;
  }
}

/**
 * What the engine would refuse of a key combo or a text, checked before the action claims control:
 * an unknown key name or an untypeable character is a malformed request (400), not an action.
 */
function checkKeys(request: DesktopActionRequest): void {
  try {
    if (request.action === "key") parseCombo(request.keys!);
    if (request.action === "type") keysymsForText(request.text!);
  } catch (error) {
    throw desktopErrorOf(error);
  }
}

/** The row's facts: display coordinates, typed text cut to 60 characters, never clipboard contents. */
function entryFacts(facts: DesktopActionFacts): Partial<DesktopActionEntry> {
  return {
    ...(facts.point ? { point: facts.point } : {}),
    ...(facts.to ? { to: facts.to } : {}),
    ...(facts.button ? { button: facts.button } : {}),
    ...(facts.count !== undefined ? { count: facts.count } : {}),
    ...(facts.direction ? { direction: facts.direction } : {}),
    ...(facts.kind === "type" && facts.text !== undefined ? { text: loggedText(facts.text) } : {}),
    ...(facts.keys !== undefined ? { keys: facts.keys } : {})
  };
}

/** A crop to a window: its bounds, clipped to the display. */
function windowRegion(windows: readonly DesktopWindow[], windowId: string, size: DesktopSize): DesktopRect {
  const window = windows.find((candidate) => candidate.id.toLowerCase() === windowId.toLowerCase());
  if (!window) throw new DesktopError(404, "DESKTOP_WINDOW_NOT_FOUND", "No such window in this desktop.");
  if (!window.bounds) throw invalid("window bounds unknown");
  const x = Math.max(0, window.bounds.x);
  const y = Math.max(0, window.bounds.y);
  const right = Math.min(size.width, window.bounds.x + window.bounds.width);
  const bottom = Math.min(size.height, window.bounds.y + window.bounds.height);
  if (right <= x || bottom <= y) throw invalid("That window is off the screen.");
  return { x, y, width: right - x, height: bottom - y };
}

/** A region given in display pixels, which must lie on the display. */
function displayRegion(region: DesktopRect, size: DesktopSize): DesktopRect {
  if (region.x + region.width > size.width || region.y + region.height > size.height) {
    throw invalid(`region is outside the display (${size.width}×${size.height}).`);
  }
  return { x: region.x, y: region.y, width: region.width, height: region.height };
}

function invalid(message: string): DesktopError {
  return new DesktopError(400, DESKTOP_INVALID_ARGUMENT_CODE, message);
}

function notRunning(): DesktopError {
  return new DesktopError(409, DESKTOP_NOT_RUNNING_CODE, "The desktop is not running.");
}

function controlledByUser(): DesktopError {
  return new DesktopError(409, DESKTOP_CONTROLLED_BY_USER_CODE, "The user has control of this desktop: wait until they give it back, or ask them.");
}

function screenshotNotFound(): DesktopError {
  return new DesktopError(404, "DESKTOP_SCREENSHOT_NOT_FOUND", "No such screenshot of this desktop: take a new one.");
}

/** Any failure as the DesktopError the routes answer with. */
function desktopErrorOf(error: unknown): DesktopError {
  if (error instanceof DesktopError) return error;
  if (error instanceof DesktopAutomationError) return new DesktopError(error.code === "INVALID_ARGUMENT" ? 400 : 409, error.code, error.message);
  if (error instanceof ImagePoolBusyError) return new DesktopError(503, "DESKTOP_BUSY", "Too many screenshots are being encoded right now; try again shortly.");
  return new DesktopError(500, "DESKTOP_AUTOMATION_FAILED", error instanceof Error ? error.message : String(error));
}
