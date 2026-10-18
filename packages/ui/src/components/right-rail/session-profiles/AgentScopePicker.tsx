/**
 * Which agents an item applies to (agent profiles spec §4.2): "All agents" or
 * a subset for skills, MCP servers and commands; exactly one agent for
 * plugins and hooks (a hook only on an agent with hooks of its own). Agent
 * chips with the agent's own icon; the problem, if any, under them.
 */

import React from "react";
import { Check } from "lucide-react";

import {
  SESSION_PROFILE_AGENTS,
  SESSION_PROFILE_HOOK_AGENTS,
  SESSION_PROFILE_SINGLE_AGENT_KINDS,
  sessionProfileScopeProblem,
  type SessionProfileAgentId,
  type SessionProfileAgentScope,
  type SessionProfileItemKind
} from "@orquester/api";

import { cn } from "../../../lib/cn";
import { agentLabel } from "../../../lib/session-profiles/logic";
import { agentIcon } from "../agent-profile/AgentPicker";

const FOCUS_RING = "focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500";

/** The agents `kind` may name. */
export function scopeAgentsFor(kind: SessionProfileItemKind): readonly SessionProfileAgentId[] {
  return kind === "hook" ? SESSION_PROFILE_HOOK_AGENTS : SESSION_PROFILE_AGENTS;
}

/** A new item's scope: every agent, or the first agent a single-agent kind may name. */
export function defaultScopeFor(kind: SessionProfileItemKind): SessionProfileAgentScope {
  return SESSION_PROFILE_SINGLE_AGENT_KINDS.includes(kind) ? [scopeAgentsFor(kind)[0]!] : "all";
}

/**
 * Toggle `agent` in a multi-agent scope. From "All agents", picking one agent
 * narrows to that agent; all four ticked reads as "all" again.
 */
export function toggleScopeAgent(scope: SessionProfileAgentScope, agent: SessionProfileAgentId): SessionProfileAgentScope {
  if (scope === "all") return [agent];
  const current = [...scope];
  const next = current.includes(agent) ? current.filter((candidate) => candidate !== agent) : [...current, agent];
  const ordered = SESSION_PROFILE_AGENTS.filter((candidate) => next.includes(candidate));
  return ordered.length === SESSION_PROFILE_AGENTS.length ? "all" : ordered;
}

export const AgentScopePicker: React.FC<{
  id: string;
  kind: SessionProfileItemKind;
  value: SessionProfileAgentScope;
  onChange: (scope: SessionProfileAgentScope) => void;
  touch?: boolean;
  /** Show the problem even before the owner touched it (after a Save). */
  showError?: boolean;
}> = ({ id, kind, value, onChange, touch = false, showError = true }) => {
  const single = SESSION_PROFILE_SINGLE_AGENT_KINDS.includes(kind);
  const agents = scopeAgentsFor(kind);
  const problem = sessionProfileScopeProblem(kind, value);
  const selected = (agent: SessionProfileAgentId) => value === "all" || value.includes(agent);
  const chip = (active: boolean) =>
    cn(
      "inline-flex items-center gap-1.5 rounded-full border text-xs font-medium transition-colors",
      FOCUS_RING,
      touch ? "h-10 px-3" : "h-7 px-2.5",
      active
        ? "border-neutral-300 bg-neutral-100 text-neutral-900"
        : "border-neutral-800 bg-neutral-900/40 text-neutral-300 hover:border-neutral-700 hover:text-neutral-100"
    );

  return (
    <div className="space-y-1.5">
      <div id={`${id}-label`} className="text-xs font-medium text-neutral-300">
        {single ? "Agent" : "Agents"}
      </div>
      <div
        role={single ? "radiogroup" : "group"}
        aria-labelledby={`${id}-label`}
        aria-describedby={problem && showError ? `${id}-error` : undefined}
        className="flex flex-wrap gap-1.5"
      >
        {single ? null : (
          <button
            type="button"
            aria-pressed={value === "all"}
            onClick={() => onChange("all")}
            className={chip(value === "all")}
          >
            {value === "all" ? <Check size={12} aria-hidden /> : null}
            All agents
          </button>
        )}
        {agents.map((agent) => {
          const on = single ? value !== "all" && value[0] === agent : value !== "all" && selected(agent);
          return (
            <button
              key={agent}
              type="button"
              role={single ? "radio" : undefined}
              aria-checked={single ? on : undefined}
              aria-pressed={single ? undefined : on}
              data-scope-agent={agent}
              onClick={() => onChange(single ? [agent] : toggleScopeAgent(value, agent))}
              className={chip(on)}
            >
              <span className="flex h-3.5 w-3.5 items-center justify-center">{agentIcon(agent, 12)}</span>
              {agentLabel(agent)}
            </button>
          );
        })}
      </div>
      {single && kind === "hook" ? (
        <p className="text-[11px] leading-4 text-neutral-500">
          A hook is written in one agent's own events. OpenCode has none — add an OpenCode plugin instead.
        </p>
      ) : null}
      {problem && showError ? (
        <p id={`${id}-error`} className="text-xs text-danger">
          {problem}
        </p>
      ) : null}
    </div>
  );
};
