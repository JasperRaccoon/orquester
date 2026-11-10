/**
 * The manual trigger's typed inputs (spec 2026-11-10 §4.1, §4.3): add,
 * reorder and remove inputs, and set each one's name, type, whether it is
 * required, its default, its help text, an enum's values and whether text is
 * multi-line. Run now builds its form from them, and every run is checked
 * against them. The same editor serves the desktop inspector and the phone's
 * step settings (its `wf-touch` sheet sizes the fields; the icon buttons grow
 * to 40 px there). Validation problems show on their own field.
 */

import React, { useEffect, useId, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";

import type { WorkflowInputDecl, WorkflowInputType } from "@orquester/api";

import { cn } from "../../../lib/cn";
import {
  addInputDecl,
  INPUT_TYPE_LABELS,
  INPUT_TYPES,
  inputDeclSummary,
  moveInputDecl,
  patchInputDecl,
  removeInputDecl,
  retypeInputDecl,
  valuesFromLines,
  withEnumValues,
  withInputs
} from "../../../lib/workflows/input-decls";
import {
  CopyChip,
  Field,
  FOCUS_RING,
  IconButton,
  NumberInput,
  ProblemBadge,
  Segmented,
  SelectInput,
  SmallButton,
  TextArea,
  TextInput,
  ToggleRow,
  ViewButton
} from "../ui/controls";
import { FieldAnchor, InspectorSection, useConfigSetter, useFieldMessages, useInspector, useRevealOpen, useSectionProblems } from "./inspector-context";

interface ManualConfig {
  inputExample?: string;
  inputs?: WorkflowInputDecl[];
}

const TOUCH_ICON = "[.wf-touch_&]:h-10 [.wf-touch_&]:w-10";

/** An enum's values, one per line: the text is the user's while typing, re-read from the config when it changes elsewhere (undo). */
const ValuesEditor: React.FC<{ values: readonly string[]; onValues: (values: string[]) => void; invalid: boolean }> = ({ values, onValues, invalid }) => {
  const [text, setText] = useState(() => values.join("\n"));
  const joined = values.join("\n");
  useEffect(() => {
    if (valuesFromLines(text).join("\n") !== joined) setText(joined);
    // Only a change of the config itself re-reads it; the text's own edits write it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);
  return (
    <TextArea
      value={text}
      onValue={(next) => {
        setText(next);
        onValues(valuesFromLines(next));
      }}
      rows={3}
      autosize
      invalid={invalid}
      placeholder={"staging\nproduction"}
      className="font-mono text-[12px]"
    />
  );
};

/** The default, in the control its type takes. */
const DefaultEditor: React.FC<{ decl: WorkflowInputDecl; onDefault: (value: WorkflowInputDecl["default"]) => void; invalid: boolean }> = ({
  decl,
  onDefault,
  invalid
}) => {
  switch (decl.type) {
    case "string":
      return decl.multiline ? (
        <TextArea
          value={typeof decl.default === "string" ? decl.default : ""}
          onValue={(value) => onDefault(value === "" ? undefined : value)}
          rows={2}
          autosize
          invalid={invalid}
          placeholder="None"
        />
      ) : (
        <TextInput
          value={typeof decl.default === "string" ? decl.default : ""}
          onValue={(value) => onDefault(value === "" ? undefined : value)}
          invalid={invalid}
          placeholder="None"
        />
      );
    case "number":
      return <NumberInput value={typeof decl.default === "number" ? decl.default : undefined} onValue={onDefault} invalid={invalid} placeholder="None" className="max-w-[10rem]" />;
    case "boolean":
      return (
        <Segmented
          label="Default"
          value={decl.default === true ? "true" : decl.default === false ? "false" : "none"}
          options={[
            { id: "none", label: "None" },
            { id: "true", label: "On" },
            { id: "false", label: "Off" }
          ]}
          onChange={(next) => onDefault(next === "none" ? undefined : next === "true")}
        />
      );
    case "enum":
      return (
        <SelectInput value={typeof decl.default === "string" ? decl.default : ""} onValue={(value) => onDefault(value === "" ? undefined : value)}>
          <option value="">None</option>
          {(decl.values ?? []).map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
          {typeof decl.default === "string" && !(decl.values ?? []).includes(decl.default) ? <option value={decl.default}>{decl.default} (not a value)</option> : null}
        </SelectInput>
      );
  }
};

const InputCard: React.FC<{
  decl: WorkflowInputDecl;
  index: number;
  count: number;
  isNew: boolean;
  onChange: (decl: WorkflowInputDecl) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}> = ({ decl, index, count, isNew, onChange, onMove, onRemove }) => {
  const field = `config.inputs.${index}`;
  const [open, setOpen] = useRevealOpen([field], isNew);
  const counts = useSectionProblems([field]);
  const bodyId = useId();
  const name = useFieldMessages(`${field}.name`);
  const values = useFieldMessages(`${field}.values`);
  const fallback = useFieldMessages(`${field}.default`);
  const description = useFieldMessages(`${field}.description`);
  const multiline = useFieldMessages(`${field}.multiline`);
  const type = useFieldMessages(`${field}.type`);
  return (
    <FieldAnchor field={field}>
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/60">
        <div className="flex items-center gap-1 py-1.5 pl-1 pr-1">
          <ViewButton
            aria-expanded={open}
            aria-controls={open ? bodyId : undefined}
            aria-label={`${open ? "Hide" : "Show"} the settings of input ${decl.name || index + 1}`}
            onClick={() => setOpen(!open)}
            className={cn("flex h-6 shrink-0 items-center rounded-md px-1 text-neutral-500 hover:text-neutral-200 [.wf-touch_&]:h-10", FOCUS_RING)}
          >
            {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
          </ViewButton>
          <FieldAnchor field={`${field}.name`} className="min-w-0 flex-1">
            <TextInput
              value={decl.name}
              aria-label={`Input ${index + 1} name`}
              placeholder="name"
              invalid={name.error !== null}
              onValue={(next) => onChange(patchInputDecl(decl, { name: next }))}
              className="h-7 border-transparent bg-transparent px-1.5 font-mono font-medium hover:border-neutral-800"
            />
          </FieldAnchor>
          <ProblemBadge problems={counts} />
          <IconButton size="sm" label={`Move input ${decl.name || index + 1} up`} disabled={index === 0} onClick={() => onMove(-1)} className={TOUCH_ICON}>
            <ArrowUp size={12} />
          </IconButton>
          <IconButton size="sm" label={`Move input ${decl.name || index + 1} down`} disabled={index === count - 1} onClick={() => onMove(1)} className={TOUCH_ICON}>
            <ArrowDown size={12} />
          </IconButton>
          <IconButton size="sm" label={`Remove input ${decl.name || index + 1}`} tone="danger" onClick={onRemove} className={TOUCH_ICON}>
            <Trash2 size={12} />
          </IconButton>
        </div>
        <div className="space-y-1 px-2.5 pb-2">
          {name.error ? <p className="text-[11px] leading-4 text-danger">{name.error}</p> : null}
          {!open ? <p className="text-[11.5px] leading-4 text-neutral-500">{inputDeclSummary(decl)}</p> : null}
        </div>
        {open ? (
          <div id={bodyId} className="space-y-3 border-t border-neutral-800/80 p-2.5">
            <FieldAnchor field={`${field}.type`}>
              <Field label="Type" error={type.error}>
                <SelectInput value={decl.type} onValue={(next) => onChange(retypeInputDecl(decl, next as WorkflowInputType))}>
                  {INPUT_TYPES.map((option) => (
                    <option key={option} value={option}>
                      {INPUT_TYPE_LABELS[option]}
                    </option>
                  ))}
                </SelectInput>
              </Field>
            </FieldAnchor>
            {decl.type === "enum" ? (
              <FieldAnchor field={`${field}.values`}>
                <Field label="Values" hint="One per line — Run now offers them as choices." error={values.error} warning={values.warning}>
                  <ValuesEditor values={decl.values ?? []} invalid={values.error !== null} onValues={(next) => onChange(withEnumValues(decl, next))} />
                </Field>
              </FieldAnchor>
            ) : values.warning ? (
              <FieldAnchor field={`${field}.values`}>
                <p className="text-[11px] leading-4 text-warn">{values.warning}</p>
              </FieldAnchor>
            ) : null}
            <ToggleRow
              checked={decl.required === true}
              onChange={(required) => onChange(patchInputDecl(decl, { required: required ? true : undefined }))}
              label="Required"
              description="A run without it is refused (test runs excepted)."
            />
            {decl.type === "string" || multiline.error ? (
              <FieldAnchor field={`${field}.multiline`}>
                <ToggleRow
                  checked={decl.multiline === true}
                  onChange={(next) => onChange(patchInputDecl(decl, { multiline: next ? true : undefined }))}
                  label="Multi-line"
                  description="A text box instead of a single line."
                />
                {multiline.error ? <p className="mt-1 text-[11px] leading-4 text-danger">{multiline.error}</p> : null}
              </FieldAnchor>
            ) : null}
            <FieldAnchor field={`${field}.default`}>
              <Field label="Default" optional hint="Prefilled in Run now, and used when a run leaves it out." error={fallback.error} warning={fallback.warning}>
                <DefaultEditor decl={decl} invalid={fallback.error !== null} onDefault={(next) => onChange(patchInputDecl(decl, { default: next }))} />
              </Field>
            </FieldAnchor>
            <FieldAnchor field={`${field}.description`}>
              <Field label="Help text" optional hint="Shown under the field in Run now, and to agents." error={description.error}>
                <TextInput
                  value={decl.description ?? ""}
                  onValue={(next) => onChange(patchInputDecl(decl, { description: next === "" ? undefined : next }))}
                  invalid={description.error !== null}
                  placeholder="What to enter"
                />
              </Field>
            </FieldAnchor>
            <p className="text-[11px] leading-4 text-neutral-500">
              Read as <CopyChip text={`{{ trigger.input.${decl.name || "name"} }}`} className="align-middle text-[10.5px]" />
            </p>
          </div>
        ) : null}
      </div>
    </FieldAnchor>
  );
};

export const InputsSection: React.FC = () => {
  const { node, readOnly, problems } = useInspector();
  const setConfig = useConfigSetter<ManualConfig>();
  const inputs = (node.config as ManualConfig).inputs ?? [];
  // A problem with the list itself (too many inputs); each input's own show on its card.
  const listError = problems.find((problem) => problem.field === "config.inputs" && problem.severity === "error")?.message.replace(/^[A-Za-z][A-Za-z0-9_]*: /, "") ?? null;

  // A stable key per input, so a card's open state follows its input when inputs move.
  const nextKey = useRef(inputs.length);
  const [keys, setKeys] = useState<number[]>(() => inputs.map((_, index) => index));
  const [added, setAdded] = useState<ReadonlySet<number>>(() => new Set());
  if (keys.length !== inputs.length) {
    // Inputs added or removed elsewhere (undo, another client): keep the first keys, mint the rest.
    const fitted = keys.slice(0, inputs.length);
    while (fitted.length < inputs.length) fitted.push((nextKey.current += 1));
    setKeys(fitted);
  }

  const write = (next: readonly WorkflowInputDecl[], key: string): void => {
    if (readOnly) return;
    setConfig((config) => withInputs(config, next), key);
  };

  return (
    <InspectorSection
      title="Inputs"
      anchors={["config.inputs"]}
      defaultOpen
      summary={inputs.length === 0 ? "Any JSON input" : inputs.map((decl) => decl.name).join(", ")}
      description="Typed inputs make Run now a form, and every run — from here, the API or an agent — is checked against them."
    >
      <FieldAnchor field="config.inputs">
        <div className="space-y-2">
          {listError ? <p className="text-[11px] leading-4 text-danger">{listError}</p> : null}
          {inputs.length === 0 ? (
            <p className="text-[11.5px] leading-4 text-neutral-500">None: a run takes any JSON, prefilled from the example input.</p>
          ) : null}
          {inputs.map((decl, index) => {
            const key = keys[index] ?? index;
            return (
              <InputCard
                key={key}
                decl={decl}
                index={index}
                count={inputs.length}
                isNew={added.has(key)}
                onChange={(next) => write(inputs.map((current, i) => (i === index ? next : current)), `input-${key}`)}
                onMove={(delta) => {
                  const target = index + delta;
                  if (target < 0 || target >= inputs.length) return;
                  const moved = [...keys];
                  [moved[index], moved[target]] = [moved[target]!, moved[index]!];
                  setKeys(moved);
                  write(moveInputDecl(inputs, index, delta), "move-input");
                }}
                onRemove={() => {
                  setKeys(keys.filter((_, i) => i !== index));
                  write(removeInputDecl(inputs, index), "remove-input");
                }}
              />
            );
          })}
          <SmallButton
            variant="ghost"
            icon={<Plus size={13} />}
            disabled={readOnly}
            onClick={() => {
              const key = (nextKey.current += 1);
              setKeys([...keys, key]);
              setAdded(new Set([...added, key]));
              write(addInputDecl(inputs), "add-input");
            }}
            className="-ml-1 [.wf-touch_&]:h-10"
          >
            Add input
          </SmallButton>
        </div>
      </FieldAnchor>
    </InspectorSection>
  );
};
