/**
 * The Agent profile panel's agent picker: a segmented control of the four
 * agents (icon + name) while the PANEL is wide enough to show "OpenCode"
 * whole, else one dropdown ("Claude ▾") — `agentPickerLayout`. An agent known
 * not to be installed is disabled, with a tooltip saying so.
 *
 * Presentational: the layout arrives as a prop (the view measures the panel).
 */

import React from "react";
import { Check, ChevronDown } from "lucide-react";

import type { AgentProfileAgentId } from "@orquester/api";

import { getRegistryIcon } from "../../../icons";
import { cn } from "../../../lib/cn";
import { AdaptiveMenu } from "../../ui/adaptive-menu";
import { DropdownItem } from "../../ui/dropdown";
import type { AgentProfileAgentOption } from "./list.logic";

const FOCUS_RING = "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500";

export function agentIcon(agent: AgentProfileAgentId, size = 14): React.ReactNode {
  return getRegistryIcon("agent", agent, size);
}

function optionTitle(option: AgentProfileAgentOption): string {
  if (option.installed === false) return `${option.label} is not installed`;
  return option.version ? `${option.label} ${option.version}` : option.label;
}

interface AgentPickerProps {
  agents: readonly AgentProfileAgentOption[];
  value: AgentProfileAgentId;
  onChange: (agent: AgentProfileAgentId) => void;
  layout: "segmented" | "dropdown";
  sheet: boolean;
}

export const AgentPicker: React.FC<AgentPickerProps> = ({ agents, value, onChange, layout, sheet }) => {
  const current = agents.find((option) => option.id === value);
  if (layout === "dropdown") {
    return (
      <AdaptiveMenu
        align="left"
        width="w-56"
        title="Agent"
        focusOnOpen
        triggerClassName={cn("flex w-full rounded-lg", FOCUS_RING)}
        trigger={
          <span
            data-agent-picker="dropdown"
            className={cn(
              "flex w-full min-w-0 items-center gap-2 rounded-lg bg-neutral-900/60 px-2.5 text-left text-[13px] font-medium text-neutral-100 ring-1 ring-neutral-800 transition-colors hover:ring-neutral-700",
              sheet ? "h-10" : "h-8"
            )}
          >
            <span aria-hidden className="flex h-4 w-4 shrink-0 items-center justify-center">
              {agentIcon(value)}
            </span>
            <span className="sr-only">Agent: </span>
            <span className="min-w-0 flex-1 truncate">{current?.label ?? value}</span>
            <ChevronDown size={14} aria-hidden className="shrink-0 text-neutral-500" />
          </span>
        }
      >
        {agents.map((option) => (
          <DropdownItem
            key={option.id}
            icon={agentIcon(option.id)}
            disabled={option.installed === false && option.id !== value}
            title={optionTitle(option)}
            aria-current={option.id === value ? "true" : undefined}
            onClick={() => onChange(option.id)}
            className={cn(sheet && "py-3", option.id === value && "text-neutral-100")}
          >
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.installed === false ? (
                <span className="shrink-0 text-[11px] text-neutral-500">Not installed</span>
              ) : option.id === value ? (
                <Check size={13} aria-hidden className="shrink-0 text-neutral-300" />
              ) : null}
            </span>
          </DropdownItem>
        ))}
      </AdaptiveMenu>
    );
  }

  return (
    <div
      role="group"
      aria-label="Agent"
      data-agent-picker="segmented"
      className="flex items-center gap-0.5 rounded-lg bg-neutral-900/60 p-0.5 ring-1 ring-neutral-800"
    >
      {agents.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            disabled={option.installed === false && !active}
            title={optionTitle(option)}
            onClick={() => onChange(option.id)}
            className={cn(
              // Content-sized, never clipped: the picker collapses to the
              // dropdown before the names stop fitting.
              "inline-flex flex-auto items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-1.5 text-xs font-medium transition-colors",
              FOCUS_RING,
              "disabled:cursor-not-allowed disabled:opacity-40",
              sheet ? "h-10" : "h-7",
              active
                ? "bg-neutral-700/70 text-neutral-50"
                : "text-neutral-400 hover:text-neutral-200 disabled:hover:text-neutral-400"
            )}
          >
            <span aria-hidden className={cn("flex h-3.5 w-3.5 shrink-0 items-center justify-center", !active && "opacity-80")}>
              {agentIcon(option.id, 13)}
            </span>
            {option.label}
          </button>
        );
      })}
    </div>
  );
};
