/**
 * What every executable block has (workflows spec §3.1): notes, a disabled
 * switch (a disabled block passes its input through), retries, a timeout and
 * a project override.
 */

import React from "react";

import { isTriggerType, WORKFLOW_LIMITS } from "@orquester/api";

import { Field, NumberInput, Section, ToggleRow } from "../ui/controls";
import { ProjectSelect } from "../ui/ProjectSelect";
import { FieldAnchor, useFieldMessages, useInspector, useNodeSetter } from "./inspector-context";

export const CommonSettings: React.FC = () => {
  const { node } = useInspector();
  const setNode = useNodeSetter();
  const timeout = useFieldMessages("timeoutMinutes");
  const trigger = isTriggerType(node.type);
  const retry = node.retry;
  const runsSomething = node.type === "agent" || node.type === "code" || node.type === "shell" || node.type === "http" || node.type === "workflow";

  return (
    <Section title="Block" collapsible defaultOpen={false}>
      <ToggleRow
        checked={node.disabled === true}
        onChange={(disabled) => setNode({ disabled: disabled ? true : undefined }, "disabled")}
        label="Disabled"
        description={trigger ? "A disabled trigger never fires." : "Skipped when the run reaches it; its input passes straight through."}
      />
      {!trigger ? (
        <>
          <ToggleRow
            checked={retry !== undefined}
            onChange={(on) => setNode({ retry: on ? { maxTries: 3, delaySeconds: 30 } : undefined }, "retry")}
            label="Retry when it fails"
            description="Usage limits never use a try — agents fail over instead."
          />
          {retry ? (
            <div className="grid grid-cols-2 gap-2 pl-0.5">
              <Field label="Tries in all">
                <NumberInput
                  value={retry.maxTries}
                  onValue={(maxTries) => setNode({ retry: { ...retry, maxTries: Math.round(maxTries ?? 3) } }, "retry-tries")}
                  min={1}
                  max={10}
                  allowEmpty={false}
                  aria-label="Tries"
                />
              </Field>
              <Field label="Between tries">
                <NumberInput
                  value={retry.delaySeconds}
                  onValue={(delaySeconds) => setNode({ retry: { ...retry, delaySeconds: delaySeconds ?? 0 } }, "retry-delay")}
                  min={0}
                  max={3600}
                  suffix="s"
                  allowEmpty={false}
                  aria-label="Seconds between tries"
                />
              </Field>
            </div>
          ) : null}
          {runsSomething && node.type !== "agent" ? (
            <FieldAnchor field="timeoutMinutes">
              <Field label="Timeout" error={timeout.error} hint="The block fails past this.">
                <NumberInput
                  value={node.timeoutMinutes}
                  onValue={(timeoutMinutes) => setNode({ timeoutMinutes }, "timeout")}
                  min={1}
                  max={WORKFLOW_LIMITS.processTimeoutMinutes.max}
                  placeholder="default"
                  suffix="min"
                  className="w-36"
                  aria-label="Block timeout"
                />
              </Field>
            </FieldAnchor>
          ) : null}
          {node.type === "agent" || node.type === "code" || node.type === "shell" ? (
            <Field label="Run in another project" hint="Instead of the workflow's own project.">
              <ProjectSelect
                value={node.projectOverride ?? ""}
                onChange={(path) => setNode({ projectOverride: path || undefined }, "project")}
                emptyLabel="The workflow's project"
                ariaLabel="Project override"
              />
            </Field>
          ) : null}
        </>
      ) : null}
      <Field label="Notes" hint="For you — never sent anywhere.">
        <textarea
          value={node.notes ?? ""}
          onChange={(event) => setNode({ notes: event.target.value || undefined }, "notes")}
          rows={3}
          aria-label="Notes"
          className="w-full resize-y rounded-md border border-neutral-800 bg-neutral-950/60 px-2.5 py-2 text-[13px] leading-5 text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
          placeholder="Why this block is here"
        />
      </Field>
    </Section>
  );
};
