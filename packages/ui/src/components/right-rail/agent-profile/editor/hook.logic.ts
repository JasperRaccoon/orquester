/**
 * The hook editor's rules (agent profile spec §7.4): the agent's own event
 * list, the matcher only where the event reads one, a command, a timeout.
 */

import {
  PROFILE_HOOK_EVENTS,
  PROFILE_HOOK_EVENTS_WITHOUT_MATCHER,
  type AgentProfileAgentId,
  type HookDraft,
  type HookView
} from "@orquester/api";

export interface HookForm {
  event: string;
  matcher: string;
  command: string;
  /** Seconds, as typed. */
  timeout: string;
}

/** The events the editor offers: the agent's list, plus an event on disk it does not list (kept selectable). */
export function hookEvents(agent: AgentProfileAgentId, current?: string): string[] {
  const events = [...(PROFILE_HOOK_EVENTS[agent] ?? [])];
  if (current && !events.includes(current)) events.unshift(current);
  return events;
}

export function eventTakesMatcher(event: string): boolean {
  return !PROFILE_HOOK_EVENTS_WITHOUT_MATCHER.includes(event);
}

export function initialHookForm(agent: AgentProfileAgentId, view?: HookView): HookForm {
  if (view) {
    return {
      event: view.event,
      matcher: view.matcher ?? "",
      command: view.command,
      timeout: view.timeoutSec === undefined ? "" : String(view.timeoutSec)
    };
  }
  const events = hookEvents(agent);
  return { event: events.includes("PreToolUse") ? "PreToolUse" : events[0] ?? "", matcher: "", command: "", timeout: "" };
}

function parseTimeout(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value > 0 ? value : null;
}

/** The matcher is left out for an event that ignores it, and when blank (every tool). */
export function hookDraftFromForm(form: HookForm): HookDraft {
  const draft: HookDraft = { event: form.event, command: form.command.trim() };
  const matcher = form.matcher.trim();
  if (eventTakesMatcher(form.event) && matcher !== "") draft.matcher = matcher;
  const timeout = parseTimeout(form.timeout);
  if (timeout !== null) draft.timeoutSec = timeout;
  return draft;
}

export interface HookValidation {
  valid: boolean;
  errors: { event?: string; command?: string; timeout?: string };
}

/** `originalEvent`: the hook's event on disk, accepted even when the agent's list does not name it. */
export function validateHookForm(agent: AgentProfileAgentId, form: HookForm, originalEvent?: string): HookValidation {
  const errors: HookValidation["errors"] = {};
  if (form.event === "" || !hookEvents(agent, originalEvent).includes(form.event)) errors.event = "Pick an event";
  if (form.command.trim() === "") errors.command = "Enter the command to run";
  if (form.timeout.trim() !== "" && parseTimeout(form.timeout) === null) {
    errors.timeout = "Whole seconds, more than 0";
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

export function hookFormSignature(form: HookForm): string {
  return JSON.stringify(form);
}

export const HOOK_MATCHER_PLACEHOLDER = "Bash or Edit|Write";
