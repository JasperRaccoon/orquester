/**
 * What every block has besides its own settings (workflows spec §3.1), as the
 * inspector's "Run behaviour" section: the disabled switch (a disabled block
 * passes its input through), retries, the time limit where the block-level one
 * is the one that counts (Run workflow) — or an explanation of a stale one —,
 * the project it works in, and notes. A trigger only has the switch and notes.
 */

import React from "react";

import { isTriggerType, WORKFLOW_BLOCK_CATALOG, type WorkflowNode } from "@orquester/api";

import { formatMinutes } from "../../../lib/workflows/durations";
import {
  movedTimeoutPatch,
  nodeTimeout,
  projectLabel,
  runBehaviourSummary,
  takesProjectOverride
} from "../../../lib/workflows/run-behaviour";
import { updateNode } from "../canvas/ops";
import { Callout, DurationInput, NumberInput, SmallButton, TextArea, ToggleRow } from "../ui/controls";
import { ProjectSelect } from "../ui/ProjectSelect";
import {
  ConfigField,
  FieldAnchor,
  InspectorSection,
  useFieldMessages,
  useInspector,
  useNodeSetter
} from "./inspector-context";

/** Every field path this section holds, so a picked problem on one opens it. */
const ANCHORS = ["disabled", "retry", "timeoutMinutes", "projectOverride", "notes"] as const;

const SENTENCE = "flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12.5px] leading-5 text-neutral-300";

const RetryFields: React.FC = () => {
  const { node } = useInspector();
  const setNode = useNodeSetter();
  const retry = node.retry;
  return (
    <FieldAnchor field="retry" className="space-y-3">
      <ToggleRow
        checked={retry !== undefined}
        onChange={(on) => setNode({ retry: on ? { maxTries: 3, delaySeconds: 30 } : undefined }, "retry")}
        label="Try again if it fails"
        description={retry ? undefined : "Off: a failure fails the block at once."}
      />
      {retry ? (
        <div className="space-y-2.5 rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2.5">
          <div className={SENTENCE}>
            <span>Run it up to</span>
            <NumberInput
              value={retry.maxTries}
              onValue={(maxTries) => setNode({ retry: { ...retry, maxTries: Math.round(maxTries ?? 3) } }, "retry-tries")}
              min={1}
              max={10}
              allowEmpty={false}
              aria-label="Tries in all"
              className="w-14"
            />
            <span>times in all,</span>
          </div>
          <div className={SENTENCE}>
            <span>waiting</span>
            <DurationInput
              value={retry.delaySeconds}
              unit="seconds"
              units={["seconds", "minutes"]}
              min={0}
              max={3600}
              ariaLabel="Wait between tries"
              onValue={(delaySeconds) => setNode({ retry: { ...retry, delaySeconds: delaySeconds ?? 0 } }, "retry-delay")}
            />
            <span>between tries.</span>
          </div>
          <p className="text-[11px] leading-4 text-neutral-500">
            The first try counts: 3 means the first try and up to 2 more. A timeout counts as a failure and is tried again.
            {node.type === "agent"
              ? " A usage limit doesn't use a try — the next account or agent takes over; when every account is out of quota, it isn't retried."
              : null}
          </p>
        </div>
      ) : null}
    </FieldAnchor>
  );
};

/** The block-level time limit: editable where it is the one that counts, explained (and clearable) where it isn't. */
const TimeoutField: React.FC = () => {
  const { editor, node, readOnly, revealField } = useInspector();
  const setNode = useNodeSetter();
  const messages = useFieldMessages("timeoutMinutes");
  const timeout = nodeTimeout(node);
  if (timeout.kind === "none") return null;

  if (timeout.kind === "editable") {
    return (
      <ConfigField
        path="timeoutMinutes"
        label="Time limit"
        optional
        hint="If the other workflow hasn't finished by then, its run is cancelled and this block fails."
        defaultNote="none — it waits as long as the other workflow takes"
      >
        <DurationInput
          value={timeout.minutes}
          unit="minutes"
          units={["minutes", "hours"]}
          min={1}
          max={timeout.max}
          ariaLabel="Time limit"
          invalid={messages.error !== null}
          onValue={(timeoutMinutes) => setNode({ timeoutMinutes }, "timeout")}
        />
      </ConfigField>
    );
  }

  const clear = (): void => setNode({ timeoutMinutes: undefined }, "timeout");
  const limit = formatMinutes(timeout.minutes);
  let callout: React.ReactElement;
  if (timeout.kind === "in-effect") {
    const { own } = timeout;
    // One undo step: the value lands in the type's own field and leaves the block.
    const move = (): void => {
      const patch = movedTimeoutPatch(node);
      if (readOnly || patch === null) return;
      editor.change((draft) =>
        updateNode(draft, node.id, (current) => {
          const { timeoutMinutes: _moved, ...rest } = current;
          return { ...rest, config: { ...current.config, ...patch } } as WorkflowNode;
        })
      );
    };
    callout = (
      <Callout
        tone="info"
        title={`Stops after ${limit}`}
        action={
          <>
            <SmallButton onClick={move}>Move to {own.section}</SmallButton>
            <SmallButton variant="ghost" onClick={clear}>
              Clear (back to {own.fallback})
            </SmallButton>
          </>
        }
      >
        An older block-level time limit. It still applies because Timeout under {own.section} is empty — move it there to
        keep it in one place.
      </Callout>
    );
  } else if (timeout.kind === "overridden") {
    const { own } = timeout;
    callout = (
      <Callout
        tone="warn"
        title={`Unused time limit: ${limit}`}
        action={
          <>
            <SmallButton onClick={clear}>Clear it</SmallButton>
            {revealField ? (
              <SmallButton variant="ghost" onClick={() => revealField(own.field)}>
                Show the Timeout
              </SmallButton>
            ) : null}
          </>
        }
      >
        An older block-level setting. Timeout under {own.section} ({own.value}) is the limit this block uses.
      </Callout>
    );
  } else if (node.type === "agent") {
    callout = (
      <Callout
        tone="warn"
        title={`Unused time limit: ${limit}`}
        action={
          <>
            <SmallButton onClick={clear}>Clear it</SmallButton>
            {revealField ? (
              <SmallButton variant="ghost" onClick={() => revealField("config.maxMinutes")}>
                Show the agent's limit
              </SmallButton>
            ) : null}
          </>
        }
      >
        An older block-level setting that agents don't read. The agent's own time limit ({formatMinutes(node.config.maxMinutes)}) is
        what stops it.
      </Callout>
    );
  } else {
    callout = (
      <Callout tone="warn" title={`Unused time limit: ${limit}`} action={<SmallButton onClick={clear}>Clear it</SmallButton>}>
        {WORKFLOW_BLOCK_CATALOG[node.type].title} blocks don't use a block-level time limit.
      </Callout>
    );
  }
  return (
    <FieldAnchor field="timeoutMinutes" className="space-y-1">
      {callout}
      {messages.error ? <p className="text-[11px] leading-4 text-danger">{messages.error}</p> : null}
      {messages.warning ? <p className="text-[11px] leading-4 text-warn">{messages.warning}</p> : null}
    </FieldAnchor>
  );
};

export const CommonSettings: React.FC = () => {
  const { node, projectPath } = useInspector();
  const setNode = useNodeSetter();
  const trigger = isTriggerType(node.type);
  const workflowProject = projectPath ? `The workflow's project (${projectLabel(projectPath)})` : "The workflow's project";

  return (
    <InspectorSection title={trigger ? "Status and notes" : "Run behaviour"} anchors={ANCHORS} summary={runBehaviourSummary(node)}>
      <FieldAnchor field="disabled">
        <ToggleRow
          checked={node.disabled === true}
          onChange={(disabled) => setNode({ disabled: disabled ? true : undefined }, "disabled")}
          label={trigger ? "Disable this trigger" : "Disable this block"}
          description={
            trigger ? "It won't start the workflow until it's on again." : "Runs skip it and pass its input straight to the next block."
          }
        />
      </FieldAnchor>
      {!trigger ? (
        <>
          <RetryFields />
          <TimeoutField />
          {takesProjectOverride(node.type) || node.projectOverride ? (
            <ConfigField
              path="projectOverride"
              label="Runs in"
              hint={
                takesProjectOverride(node.type)
                  ? "The project folder it works in."
                  : "This kind of block doesn't work in a project folder — pick the workflow's project to clear it."
              }
            >
              <ProjectSelect
                value={node.projectOverride ?? ""}
                onChange={(path) => setNode({ projectOverride: path || undefined }, "project")}
                emptyLabel={workflowProject}
                ariaLabel="Runs in"
              />
            </ConfigField>
          ) : null}
        </>
      ) : null}
      <ConfigField path="notes" label="Notes" optional hint="For people reading this workflow — runs ignore them.">
        <TextArea
          value={node.notes ?? ""}
          onValue={(notes) => setNode({ notes: notes || undefined }, "notes")}
          autosize
          placeholder="Why this block is here, what to check before changing it…"
        />
      </ConfigField>
    </InspectorSection>
  );
};
