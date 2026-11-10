// Who controls a desktop's input (spec 2026-11-10 §3.1 R2.1–R2.2): the rules as pure functions.
// The automation service (`automation-service.ts`) holds each desktop's control — runtime only,
// none after a daemon restart — and the timer that lets an agent's control lapse.

import type { DesktopActor, DesktopControl, DesktopController } from "@orquester/api";

/** The same agent: the same chat, or (external clients carry no id) the same label. */
export function sameActor(a: DesktopActor | undefined, b: DesktopActor | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind === "chat") return b.kind === "chat" && a.threadId === b.threadId;
  return b.kind === "external" && a.label === b.label;
}

/**
 * An agent's input action: control passes to that agent (unchanged, `since` included, when it
 * already holds it), or the action is refused while the user has control. Reads never come here:
 * they work whoever controls the desktop.
 */
export function agentInputControl(
  control: DesktopControl | null,
  actor: DesktopActor,
  now: string
): { ok: true; control: DesktopControl } | { ok: false } {
  if (control?.controller === "user") return { ok: false };
  if (control?.controller === "agent" && sameActor(control.actor, actor)) return { ok: true, control };
  return { ok: true, control: { controller: "agent", actor, since: now } };
}

/**
 * `PUT control`: `user` takes over (remembering the agent it took control from), `agent` gives it
 * back to the last agent (clears it when there is none), `null` clears it. Unchanged control is
 * returned as is.
 */
export function requestedControl(control: DesktopControl | null, controller: DesktopController | null, now: string): DesktopControl | null {
  if (controller === null) return null;
  if (controller === "user") {
    if (control?.controller === "user") return control;
    return { controller: "user", ...(control?.actor ? { actor: control.actor } : {}), since: now };
  }
  if (control?.controller === "agent") return control;
  return control?.actor ? { controller: "agent", actor: control.actor, since: now } : null;
}
