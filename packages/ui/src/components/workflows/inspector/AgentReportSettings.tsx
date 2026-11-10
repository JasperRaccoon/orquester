/**
 * The agent block's Result section (spec 2026-11-10 §5.1): named outcomes —
 * each its own output on the canvas, in this order — and typed outputs the
 * agent reports with `report_step_result`. The id of an outcome is its
 * handle, so the edits go through `outcomes-edit` (connections follow a
 * renamed outcome, a removed one's go, turning outcomes on moves the
 * `success` connections to the first). Ids and names stay valid as typed; a
 * draft that cannot be one is shown with why, and reverts on leaving the
 * field.
 */

import React, { useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

import { WORKFLOW_LIMITS, type AgentBlockConfig, type WorkflowOutcomeDecl, type WorkflowOutputDecl, type WorkflowOutputType } from "@orquester/api";
import { WORKFLOW_OUTPUT_TYPES } from "@orquester/config";

import { cn } from "../../../lib/cn";
import {
  canAddOutcome,
  canAddOutput,
  canRemoveOutcome,
  disableOutcomes,
  enableOutcomes,
  moveOutcome,
  newOutcome,
  newOutput,
  parseEnumValues,
  removeOutcome,
  renameOutcome,
  reportSummary,
  toOutputName,
  withOutputType
} from "../../../lib/workflows/outcomes-edit";
import { usePhoneLayout } from "../phone/phone-context";
import { Field, IconButton, SelectInput, SmallButton, TextArea, TextInput, ToggleRow } from "../ui/controls";
import { FieldAnchor, InspectorSection, useConfigSetter, useFieldMessages, useInspector } from "./inspector-context";

const OUTPUT_TYPE_LABELS: Record<WorkflowOutputType, string> = {
  string: "Text",
  number: "Number",
  boolean: "Yes / no",
  enum: "One of a list",
  json: "Any JSON"
};

/** Row buttons: 24 px on the desktop, 40 px touch targets in the phone's sheet. */
function useRowButtonClass(): string | undefined {
  return usePhoneLayout() ? "h-10 w-10" : undefined;
}

/**
 * A stable key per row, so a row's drafts follow its entry when entries move or
 * go (as the inputs and gate choices do). Rows added or removed elsewhere (undo,
 * another client) keep the first keys and mint the rest.
 */
function useRowKeys(count: number): { keys: readonly number[]; move: (index: number, delta: number) => void; remove: (index: number) => void } {
  const nextKey = useRef(count);
  const [keys, setKeys] = useState<number[]>(() => Array.from({ length: count }, (_, index) => index));
  if (keys.length !== count) {
    const fitted = keys.slice(0, count);
    while (fitted.length < count) fitted.push((nextKey.current += 1));
    setKeys(fitted);
  }
  return {
    keys,
    move: (index, delta) => {
      const target = index + delta;
      if (target < 0 || target >= keys.length) return;
      const moved = [...keys];
      [moved[index], moved[target]] = [moved[target]!, moved[index]!];
      setKeys(moved);
    },
    remove: (index) => setKeys(keys.filter((_, i) => i !== index))
  };
}

/** A name/id field that keeps what is typed while it cannot be applied, and says why. */
const DraftNameInput: React.FC<{
  value: string;
  ariaLabel: string;
  /** Apply the typed text; false when it cannot be (the draft stays, with `refusal`). */
  apply: (text: string) => boolean;
  refusal: string;
  invalid?: boolean;
  className?: string;
}> = ({ value, ariaLabel, apply, refusal, invalid, className }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const refused = draft !== null && draft !== value;
  return (
    <div className={cn("min-w-0", className)}>
      <TextInput
        value={draft ?? value}
        aria-label={ariaLabel}
        invalid={invalid || refused}
        onValue={(text) => {
          const applied = apply(text);
          setDraft(applied ? null : text);
        }}
        onBlur={() => setDraft(null)}
        className="font-mono text-[12px]"
      />
      {refused ? <p className="mt-0.5 text-[11px] leading-4 text-warn">{refusal}</p> : null}
    </div>
  );
};

type RowMoves = {
  /** The row moved by `delta` (its key follows it). */
  onMoved: (delta: -1 | 1) => void;
  /** The row was removed (its key goes with it). */
  onRemoved: () => void;
};

const OutcomeRow: React.FC<{ outcome: WorkflowOutcomeDecl; index: number; count: number; outcomes: readonly WorkflowOutcomeDecl[] } & RowMoves> = ({
  outcome,
  index,
  count,
  outcomes,
  onMoved,
  onRemoved
}) => {
  const { editor, node, readOnly, workflow } = useInspector();
  const setConfig = useConfigSetter<AgentBlockConfig>();
  const buttonClass = useRowButtonClass();
  const field = `config.outcomes.${index}`;
  const idMessages = useFieldMessages(`${field}.id`);
  const descriptionMessages = useFieldMessages(`${field}.description`);
  const connections = workflow.edges.filter((edge) => edge.source === node.id && edge.sourceHandle === `outcome:${outcome.id}`).length;
  const strip = (patch: { label?: string; description?: string }, key: string): void =>
    setConfig((current) => {
      const outcomesNow = (current.outcomes ?? []).map((entry, i) => {
        if (i !== index) return entry;
        const next: WorkflowOutcomeDecl = { ...entry, ...patch };
        if (!next.label) delete next.label;
        if (!next.description) delete next.description;
        return next;
      });
      return { ...current, outcomes: outcomesNow };
    }, `${key}-${index}`);
  return (
    <FieldAnchor field={field}>
      <div className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-900/60 p-2.5">
        <div className="flex items-start gap-1">
          <span className="mt-1.5 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md bg-info-soft/40 px-1 text-[10.5px] font-semibold tabular-nums text-info">{index + 1}</span>
          <TextInput
            value={outcome.label ?? ""}
            aria-label={`Outcome ${index + 1} label`}
            placeholder={outcome.id}
            onValue={(label) => strip({ label }, "outcome-label")}
            className="min-w-0 flex-1 font-medium"
          />
          <IconButton
            size="sm"
            className={buttonClass}
            label={`Move outcome ${index + 1} up`}
            disabled={readOnly || index === 0}
            onClick={() => {
              onMoved(-1);
              editor.change((draft) => moveOutcome(draft, node.id, index, -1), { coalesce: null });
            }}
          >
            <ArrowUp size={12} />
          </IconButton>
          <IconButton
            size="sm"
            className={buttonClass}
            label={`Move outcome ${index + 1} down`}
            disabled={readOnly || index === count - 1}
            onClick={() => {
              onMoved(1);
              editor.change((draft) => moveOutcome(draft, node.id, index, 1), { coalesce: null });
            }}
          >
            <ArrowDown size={12} />
          </IconButton>
          <IconButton
            size="sm"
            className={buttonClass}
            tone="danger"
            label={`Remove outcome ${index + 1}${connections > 0 ? ` and its ${connections === 1 ? "connection" : `${connections} connections`}` : ""}`}
            disabled={readOnly || !canRemoveOutcome(outcomes)}
            onClick={() => {
              onRemoved();
              editor.change((draft) => removeOutcome(draft, node.id, index), { coalesce: null });
            }}
          >
            <Trash2 size={12} />
          </IconButton>
        </div>
        <Field label="Id" hint={`Its output is “outcome:${outcome.id}”; the agent reports this id.`} error={idMessages.error} warning={idMessages.warning}>
          <DraftNameInput
            value={outcome.id}
            ariaLabel={`Outcome ${index + 1} id`}
            invalid={idMessages.error !== null}
            refusal="An id starts with a lowercase letter (then letters, digits or _) and differs from the others."
            apply={(text) => {
              if (readOnly) return false;
              let applied = false;
              editor.change(
                (draft) => {
                  const next = renameOutcome(draft, node.id, index, text);
                  applied = next !== null;
                  return next ?? draft;
                },
                { coalesce: `config:${node.id}:outcome-id-${index}` }
              );
              return applied;
            }}
          />
        </Field>
        <Field label="When to pick it" optional hint="Shown to the agent beside the id." error={descriptionMessages.error} warning={descriptionMessages.warning}>
          <TextArea
            value={outcome.description ?? ""}
            rows={1}
            autosize
            maxRows={4}
            maxLength={WORKFLOW_LIMITS.inputDescriptionChars}
            aria-label={`Outcome ${index + 1} description`}
            onValue={(description) => strip({ description }, "outcome-description")}
          />
        </Field>
      </div>
    </FieldAnchor>
  );
};

const OutputRow: React.FC<{ output: WorkflowOutputDecl; index: number; count: number } & RowMoves> = ({ output, index, count, onMoved, onRemoved }) => {
  const { readOnly } = useInspector();
  const setConfig = useConfigSetter<AgentBlockConfig>();
  const buttonClass = useRowButtonClass();
  const field = `config.outputs.${index}`;
  const nameMessages = useFieldMessages(`${field}.name`);
  const valuesMessages = useFieldMessages(`${field}.values`);
  const descriptionMessages = useFieldMessages(`${field}.description`);
  const [valuesDraft, setValuesDraft] = useState<string | null>(null);
  const replace = (next: (current: WorkflowOutputDecl, all: readonly WorkflowOutputDecl[]) => WorkflowOutputDecl | null, key: string): boolean => {
    let applied = false;
    setConfig((current) => {
      const all = current.outputs ?? [];
      const entry = all[index];
      if (!entry) return current;
      const changed = next(entry, all);
      if (changed === null) return current;
      applied = true;
      return { ...current, outputs: all.map((item, i) => (i === index ? changed : item)) };
    }, `${key}-${index}`);
    return applied;
  };
  const move = (delta: -1 | 1): void => {
    onMoved(delta);
    setConfig((current) => {
      const all = [...(current.outputs ?? [])];
      const target = index + delta;
      if (target < 0 || target >= all.length) return current;
      [all[index], all[target]] = [all[target]!, all[index]!];
      return { ...current, outputs: all };
    }, `output-move-${index}`);
  };
  const remove = (): void => {
    onRemoved();
    setConfig((current) => {
      const all = (current.outputs ?? []).filter((_, i) => i !== index);
      const { outputs: _outputs, ...rest } = current;
      return all.length > 0 ? { ...current, outputs: all } : (rest as AgentBlockConfig);
    }, `output-remove-${index}`);
  };
  return (
    <FieldAnchor field={field}>
      <div className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-900/60 p-2.5">
        <div className="flex items-start gap-1">
          <DraftNameInput
            className="flex-1"
            value={output.name}
            ariaLabel={`Output ${index + 1} name`}
            invalid={nameMessages.error !== null}
            refusal="A name starts with a letter (then letters, digits or _) and differs from the others."
            apply={(text) => {
              if (readOnly) return false;
              return replace((current, all) => {
                const name = toOutputName(text);
                if (name === null || all.some((item, i) => i !== index && item.name === name)) return null;
                return { ...current, name };
              }, "output-name");
            }}
          />
          <IconButton size="sm" className={buttonClass} label={`Move output ${output.name} up`} disabled={readOnly || index === 0} onClick={() => move(-1)}>
            <ArrowUp size={12} />
          </IconButton>
          <IconButton size="sm" className={buttonClass} label={`Move output ${output.name} down`} disabled={readOnly || index === count - 1} onClick={() => move(1)}>
            <ArrowDown size={12} />
          </IconButton>
          <IconButton size="sm" className={buttonClass} tone="danger" label={`Remove output ${output.name}`} disabled={readOnly} onClick={remove}>
            <Trash2 size={12} />
          </IconButton>
        </div>
        {nameMessages.error ? <p className="text-[11px] leading-4 text-danger">{nameMessages.error}</p> : null}
        <Field label="Type">
          <SelectInput value={output.type} onValue={(type) => replace((current) => withOutputType(current, type as WorkflowOutputType), "output-type")}>
            {WORKFLOW_OUTPUT_TYPES.map((type) => (
              <option key={type} value={type}>
                {OUTPUT_TYPE_LABELS[type]}
              </option>
            ))}
          </SelectInput>
        </Field>
        {output.type === "enum" ? (
          <FieldAnchor field={`${field}.values`}>
            <Field label="Allowed values" hint="Separated by commas or new lines." error={valuesMessages.error} warning={valuesMessages.warning}>
              <TextArea
                value={valuesDraft ?? (output.values ?? []).join(", ")}
                rows={1}
                autosize
                maxRows={4}
                aria-label={`Allowed values of ${output.name}`}
                invalid={valuesMessages.error !== null}
                onValue={(text) => {
                  setValuesDraft(text);
                  replace((current) => ({ ...current, values: parseEnumValues(text) }), "output-values");
                }}
                onBlur={() => setValuesDraft(null)}
              />
            </Field>
          </FieldAnchor>
        ) : null}
        <ToggleRow
          checked={output.required !== false}
          onChange={(required) =>
            replace((current) => {
              const { required: _required, ...rest } = current;
              return required ? rest : { ...rest, required: false };
            }, "output-required")
          }
          label="Required"
          description={output.required !== false ? "The report is refused without it." : "The agent may leave it out."}
          disabled={readOnly}
        />
        <Field label="Description" optional hint="Shown to the agent: what to put here." error={descriptionMessages.error} warning={descriptionMessages.warning}>
          <TextArea
            value={output.description ?? ""}
            rows={1}
            autosize
            maxRows={4}
            maxLength={WORKFLOW_LIMITS.inputDescriptionChars}
            aria-label={`Description of ${output.name}`}
            onValue={(description) =>
              replace((current) => {
                const { description: _description, ...rest } = current;
                return description ? { ...rest, description } : rest;
              }, "output-description")
            }
          />
        </Field>
      </div>
    </FieldAnchor>
  );
};

/** The agent block's Result section: outcomes (its outputs on the canvas) and typed outputs. */
export const AgentReportSection: React.FC<{ config: AgentBlockConfig }> = ({ config }) => {
  const { editor, node, readOnly } = useInspector();
  const setConfig = useConfigSetter<AgentBlockConfig>();
  const outcomes = config.outcomes ?? [];
  const outputs = config.outputs ?? [];
  const outcomesMessages = useFieldMessages("config.outcomes");
  const outputsMessages = useFieldMessages("config.outputs");
  const hasOutcomes = config.outcomes !== undefined;
  const outcomeKeys = useRowKeys(outcomes.length);
  const outputKeys = useRowKeys(outputs.length);
  const addClass = usePhoneLayout() ? "h-10 px-3.5" : undefined;
  return (
    <InspectorSection
      title="Result"
      anchors={["config.outcomes", "config.outputs"]}
      summary={reportSummary(config)}
      description="Outcomes give the block one output per result, so the run can branch on the agent's judgment. Outputs are typed values it hands on. With either, the agent must report them with a tool before it ends; if it doesn't, it is reminded once, then the block fails."
      sticky
    >
      <ToggleRow
        checked={hasOutcomes}
        onChange={(on) => editor.change((draft) => (on ? enableOutcomes(draft, node.id) : disableOutcomes(draft, node.id)), { coalesce: null })}
        label="Branch on outcomes"
        description={
          hasOutcomes
            ? "Each outcome is its own output; the “success” output is replaced (its connections moved to the first outcome)."
            : "One “success” output, as now."
        }
        disabled={readOnly}
      />
      {hasOutcomes ? (
        <FieldAnchor field="config.outcomes" className="space-y-2">
          {outcomesMessages.error ? <p className="text-[11px] leading-4 text-danger">{outcomesMessages.error}</p> : null}
          {outcomes.map((outcome, index) => (
            <OutcomeRow
              key={outcomeKeys.keys[index] ?? `extra-${index}`}
              outcome={outcome}
              index={index}
              count={outcomes.length}
              outcomes={outcomes}
              onMoved={(delta) => outcomeKeys.move(index, delta)}
              onRemoved={() => outcomeKeys.remove(index)}
            />
          ))}
          <SmallButton
            icon={<Plus size={13} />}
            className={addClass}
            disabled={readOnly || !canAddOutcome(outcomes)}
            onClick={() => setConfig((current) => ({ ...current, outcomes: [...(current.outcomes ?? []), newOutcome(current.outcomes ?? [])] }), "add-outcome")}
          >
            Add an outcome
          </SmallButton>
        </FieldAnchor>
      ) : null}
      <FieldAnchor field="config.outputs" className="space-y-2">
        <div className="text-xs font-medium text-neutral-400">Outputs</div>
        {outputsMessages.error ? <p className="text-[11px] leading-4 text-danger">{outputsMessages.error}</p> : null}
        {outputs.length === 0 ? <p className="text-[11px] leading-4 text-neutral-500">None. Read them later as nodes.{node.name}.output.outputs.&lt;name&gt;.</p> : null}
        {outputs.map((output, index) => (
          <OutputRow
            key={outputKeys.keys[index] ?? `extra-${index}`}
            output={output}
            index={index}
            count={outputs.length}
            onMoved={(delta) => outputKeys.move(index, delta)}
            onRemoved={() => outputKeys.remove(index)}
          />
        ))}
        <SmallButton
          icon={<Plus size={13} />}
          className={addClass}
          disabled={readOnly || !canAddOutput(outputs)}
          onClick={() => setConfig((current) => ({ ...current, outputs: [...(current.outputs ?? []), newOutput(current.outputs ?? [])] }), "add-output")}
        >
          Add an output
        </SmallButton>
      </FieldAnchor>
    </InspectorSection>
  );
};
