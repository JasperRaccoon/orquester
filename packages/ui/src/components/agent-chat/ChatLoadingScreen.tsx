import React from "react";
import { Check, Loader2 } from "lucide-react";
import { getRegistryIcon } from "../../icons";
import { cn } from "../../lib/cn";

/**
 * Where opening a past conversation stands, oldest step first:
 * - `opening`: the tab is being created (the launch request is in flight);
 * - `reading`: the agent is starting and its own history is being read;
 * - `importing`: `done` of `total` history events are in the thread.
 */
export type ChatLoadingStage =
  | { kind: "opening" }
  | { kind: "reading" }
  | { kind: "importing"; done: number; total: number };

const STEPS = [
  { kind: "opening", label: "Opening the tab" },
  { kind: "reading", label: "Starting the agent and reading its history" },
  { kind: "importing", label: "Loading the conversation" }
] as const;

/**
 * The screen a resumed conversation shows until its history is in: which
 * step it is on, and how far the import is. It covers whatever was under it,
 * so nothing (the recent-conversations list above all) can be clicked twice
 * while it loads.
 */
export const ChatLoadingScreen: React.FC<{
  title: string;
  agentRefId: string;
  agentName: string;
  stage: ChatLoadingStage;
  className?: string;
}> = ({ title, agentRefId, agentName, stage, className }) => {
  const current = STEPS.findIndex((step) => step.kind === stage.kind);
  const percent =
    stage.kind === "importing" && stage.total > 0
      ? Math.min(100, Math.round((stage.done / stage.total) * 100))
      : null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("flex h-full w-full items-center justify-center bg-neutral-950 px-6", className)}
    >
      <div className="w-full max-w-sm">
        <div className="mb-5 flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-neutral-900 text-neutral-200">
            {getRegistryIcon("agent", agentRefId, 20)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-neutral-100">{title}</p>
            <p className="text-xs text-neutral-500">Opening this {agentName} conversation…</p>
          </div>
        </div>

        <ol className="space-y-2.5">
          {STEPS.map((step, index) => {
            const done = index < current;
            const active = index === current;
            return (
              <li key={step.kind} className="flex items-center gap-2.5 text-[13px]">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {done ? (
                    <Check size={14} className="text-ok" />
                  ) : active ? (
                    <Loader2 size={14} className="animate-spin text-neutral-300" />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-neutral-700" />
                  )}
                </span>
                <span
                  className={cn(
                    done ? "text-neutral-500" : active ? "text-neutral-100" : "text-neutral-600"
                  )}
                >
                  {step.label}
                </span>
              </li>
            );
          })}
        </ol>

        <div className="mt-5">
          <div className="relative h-1.5 overflow-hidden rounded-full bg-neutral-800">
            {percent !== null ? (
              <div
                className="h-full rounded-full bg-neutral-300 transition-[width] duration-300"
                style={{ width: `${percent}%` }}
              />
            ) : (
              <div className="upload-sheen absolute inset-y-0 left-0 w-1/4 rounded-full bg-neutral-500" />
            )}
          </div>
          <p className="mt-1.5 text-right text-[11px] tabular-nums text-neutral-500">
            {stage.kind === "importing"
              ? `${stage.done} / ${stage.total} events · ${percent ?? 0}%`
              : "Long conversations can take a few seconds"}
          </p>
        </div>
      </div>
    </div>
  );
};
