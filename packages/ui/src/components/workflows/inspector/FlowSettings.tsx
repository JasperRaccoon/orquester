/**
 * The flow blocks' forms (workflows spec §4): If and Switch as a no-code rule
 * builder, and the small forms of Merge, Stop, Wait, Run workflow and the
 * sticky note.
 */

import React, { useMemo } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

import {
  UNSET_SUBWORKFLOW_ID,
  type RuleOperator,
  type WorkflowRule
} from "@orquester/api";
import { NOTE_COLORS } from "@orquester/config";

import { cn } from "../../../lib/cn";
import { isUnaryOperator, RULE_OPERATOR_LABELS } from "../../../lib/workflows/catalog-ui";
import { useWorkflowsState } from "../../../lib/workflows/hooks";
import { updateNode } from "../canvas/ops";
import { Field, IconButton, NumberInput, Section, Segmented, SelectInput, SmallButton, TextInput, ToggleRow } from "../ui/controls";
import { FieldAnchor, useConfigSetter, useFieldMessages, useInspector } from "./inspector-context";
import { TemplateEditor } from "./TemplateEditor";

type Combine = "all" | "any";

interface IfConfig {
  combine: Combine;
  rules: WorkflowRule[];
}
interface SwitchCase {
  label: string;
  combine: Combine;
  rules: WorkflowRule[];
}
interface SwitchConfig {
  cases: SwitchCase[];
  fallback: boolean;
}

const OPERATOR_GROUPS: { label: string; ops: RuleOperator[] }[] = [
  { label: "Text", ops: ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith", "matches"] },
  { label: "Number", ops: ["gt", "gte", "lt", "lte"] },
  { label: "Value", ops: ["isEmpty", "isNotEmpty", "exists", "isTrue", "isFalse"] }
];

const RuleRow: React.FC<{
  rule: WorkflowRule;
  index: number;
  field: string;
  onChange: (rule: WorkflowRule) => void;
  onRemove: (() => void) | null;
}> = ({ rule, index, field, onChange, onRemove }) => {
  const { scope } = useInspector();
  const messages = useFieldMessages(field);
  const unary = isUnaryOperator(rule.op);
  return (
    <FieldAnchor field={field}>
      <div className="rounded-lg border border-neutral-800 bg-neutral-950/30 p-2">
        <div className="flex items-start gap-1.5">
          <div className="min-w-0 flex-1 space-y-1.5">
            <TemplateEditor
              value={rule.left}
              onChange={(left) => onChange({ ...rule, left })}
              scope={scope}
              ariaLabel={`Rule ${index + 1}: value`}
              placeholder="{{ input.status }}"
              monospace
              invalid={messages.error !== null}
            />
            <div className="flex items-start gap-1.5">
              <SelectInput
                value={rule.op}
                aria-label={`Rule ${index + 1}: comparison`}
                onValue={(op) => {
                  const next = op as RuleOperator;
                  if (isUnaryOperator(next)) {
                    const { right: _right, ...rest } = rule;
                    onChange({ ...rest, op: next });
                  } else onChange({ ...rule, op: next, right: rule.right ?? "" });
                }}
                className={unary ? "flex-1" : "w-[140px] shrink-0"}
              >
                {OPERATOR_GROUPS.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.ops.map((op) => (
                      <option key={op} value={op}>
                        {RULE_OPERATOR_LABELS[op]}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </SelectInput>
              {!unary ? (
                <div className="min-w-0 flex-1">
                  <TemplateEditor
                    value={rule.right ?? ""}
                    onChange={(right) => onChange({ ...rule, right })}
                    scope={scope}
                    ariaLabel={`Rule ${index + 1}: compared with`}
                    placeholder={rule.op === "matches" ? "^v\\d+" : "value"}
                    monospace
                  />
                </div>
              ) : null}
            </div>
          </div>
          {onRemove ? (
            <IconButton label={`Remove rule ${index + 1}`} tone="danger" size="sm" onClick={onRemove} className="mt-1">
              <Trash2 size={12} />
            </IconButton>
          ) : null}
        </div>
        {messages.error || messages.warning ? (
          <p className={cn("mt-1.5 text-[11px] leading-4", messages.error ? "text-danger" : "text-warn")}>{messages.error ?? messages.warning}</p>
        ) : null}
      </div>
    </FieldAnchor>
  );
};

const RuleList: React.FC<{
  rules: WorkflowRule[];
  combine: Combine;
  fieldPrefix: string;
  onRules: (rules: WorkflowRule[]) => void;
  onCombine: (combine: Combine) => void;
}> = ({ rules, combine, fieldPrefix, onRules, onCombine }) => (
  <div className="space-y-2">
    {rules.length > 1 ? (
      <div className="flex items-center gap-2 text-[12px] text-neutral-400">
        <span>Match</span>
        <Segmented
          label="Combine rules"
          size="sm"
          value={combine}
          onChange={onCombine}
          options={[
            { id: "all", label: "all rules" },
            { id: "any", label: "any rule" }
          ]}
          className="w-44"
        />
      </div>
    ) : null}
    {rules.map((rule, index) => (
      <React.Fragment key={index}>
        {index > 0 ? (
          <div className="pl-2 text-[10.5px] font-medium text-neutral-500">{combine === "all" ? "and" : "or"}</div>
        ) : null}
        <RuleRow
          rule={rule}
          index={index}
          field={`${fieldPrefix}.${index}`}
          onChange={(next) => onRules(rules.map((current, i) => (i === index ? next : current)))}
          onRemove={rules.length > 1 ? () => onRules(rules.filter((_, i) => i !== index)) : null}
        />
      </React.Fragment>
    ))}
    <SmallButton variant="ghost" icon={<Plus size={13} />} onClick={() => onRules([...rules, { left: "", op: "equals", right: "" }])} className="-ml-1">
      Add a rule
    </SmallButton>
  </div>
);

export const IfSettings: React.FC = () => {
  const { node } = useInspector();
  const setConfig = useConfigSetter<IfConfig>();
  const config = node.config as IfConfig;
  return (
    <Section title="Conditions" aside={<span className="text-[11px] text-neutral-500">true → when they hold</span>}>
      <RuleList
        rules={config.rules}
        combine={config.combine}
        fieldPrefix="config.rules"
        onRules={(rules) => setConfig({ rules }, "rules")}
        onCombine={(combine) => setConfig({ combine }, "combine")}
      />
    </Section>
  );
};

export const SwitchSettings: React.FC = () => {
  const { node, editor } = useInspector();
  const setConfig = useConfigSetter<SwitchConfig>();
  const config = node.config as SwitchConfig;

  /** Remove or reorder cases and keep every edge on the case it was drawn from. */
  const reorder = (cases: SwitchCase[], mapping: (index: number) => number | null): void => {
    editor.change(
      (draft) => {
        const withCases = updateNode(draft, node.id, (current) => ({ ...current, config: { ...(current.config as SwitchConfig), cases } }) as typeof current);
        const edges = withCases.edges.flatMap((edge) => {
          if (edge.source !== node.id) return [edge];
          const match = /^case:(\d+)$/.exec(edge.sourceHandle);
          if (!match) return [edge];
          const to = mapping(Number(match[1]));
          return to === null ? [] : [{ ...edge, sourceHandle: `case:${to}` }];
        });
        return { ...withCases, edges };
      },
      { coalesce: null }
    );
  };

  const move = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= config.cases.length) return;
    const cases = [...config.cases];
    [cases[index], cases[target]] = [cases[target]!, cases[index]!];
    reorder(cases, (from) => (from === index ? target : from === target ? index : from));
  };

  const remove = (index: number): void => {
    reorder(
      config.cases.filter((_, i) => i !== index),
      (from) => (from === index ? null : from > index ? from - 1 : from)
    );
  };

  return (
    <>
      <Section title="Cases" aside={<span className="text-[11px] text-neutral-500">the first that matches wins</span>}>
        {config.cases.map((entry, index) => (
          <div key={index} className="rounded-xl border border-neutral-800 bg-neutral-900/60">
            <div className="flex items-center gap-1.5 border-b border-neutral-800/80 py-1.5 pl-2.5 pr-1">
              <span className="flex h-5 min-w-5 items-center justify-center rounded-md bg-info-soft/40 px-1 text-[10.5px] font-semibold tabular-nums text-info">
                {index + 1}
              </span>
              <TextInput
                value={entry.label}
                aria-label={`Case ${index + 1} label`}
                placeholder={`Case ${index + 1}`}
                onValue={(label) => setConfig({ cases: config.cases.map((current, i) => (i === index ? { ...current, label } : current)) }, `case-label-${index}`)}
                className="h-7 border-transparent bg-transparent px-1.5 font-medium hover:border-neutral-800"
              />
              <IconButton size="sm" label="Move case up" disabled={index === 0} onClick={() => move(index, -1)}>
                <ArrowUp size={12} />
              </IconButton>
              <IconButton size="sm" label="Move case down" disabled={index === config.cases.length - 1} onClick={() => move(index, 1)}>
                <ArrowDown size={12} />
              </IconButton>
              <IconButton size="sm" label="Remove case" tone="danger" disabled={config.cases.length === 1} onClick={() => remove(index)}>
                <Trash2 size={12} />
              </IconButton>
            </div>
            <div className="p-2.5">
              <RuleList
                rules={entry.rules}
                combine={entry.combine}
                fieldPrefix={`config.cases.${index}.rules`}
                onRules={(rules) => setConfig({ cases: config.cases.map((current, i) => (i === index ? { ...current, rules } : current)) }, `case-rules-${index}`)}
                onCombine={(combine) => setConfig({ cases: config.cases.map((current, i) => (i === index ? { ...current, combine } : current)) }, `case-combine-${index}`)}
              />
            </div>
          </div>
        ))}
        <SmallButton
          icon={<Plus size={13} />}
          onClick={() =>
            setConfig(
              { cases: [...config.cases, { label: `Case ${config.cases.length + 1}`, combine: "all", rules: [{ left: "{{ input }}", op: "equals", right: "" }] }] },
              "add-case"
            )
          }
        >
          Add a case
        </SmallButton>
      </Section>
      <Section title="No match">
        <ToggleRow
          checked={config.fallback}
          onChange={(fallback) =>
            editor.change((draft) => {
              const next = updateNode(draft, node.id, (current) => ({ ...current, config: { ...(current.config as SwitchConfig), fallback } }) as typeof current);
              // Without its "default" output, the edges drawn from it go too.
              return fallback ? next : { ...next, edges: next.edges.filter((edge) => !(edge.source === node.id && edge.sourceHandle === "default")) };
            })
          }
          label="Add a “default” output"
          description="Taken when no case matches. Without it, a run with no match skips everything after this block."
        />
      </Section>
    </>
  );
};

export const MergeSettings: React.FC = () => {
  const { node } = useInspector();
  const setConfig = useConfigSetter<{ mode: "all" | "first" }>();
  const config = node.config as { mode: "all" | "first" };
  return (
    <Section title="Joining branches">
      <Segmented
        label="Merge mode"
        value={config.mode}
        onChange={(mode) => setConfig({ mode }, "mode")}
        options={[
          { id: "all", label: "Wait for every branch" },
          { id: "first", label: "First to arrive" }
        ]}
      />
      <p className="text-[11px] leading-4 text-neutral-500">
        Its output is {"{ [blockName]: output }"} for every branch that arrived; a branch the run skipped is not waited for.
      </p>
    </Section>
  );
};

export const StopSettings: React.FC = () => {
  const { node, scope } = useInspector();
  const setConfig = useConfigSetter<{ as: "success" | "failure"; message?: string; value?: string }>();
  const config = node.config as { as: "success" | "failure"; message?: string; value?: string };
  return (
    <Section title="Ending the run">
      <Segmented
        label="End the run as"
        value={config.as}
        onChange={(as) => setConfig({ as }, "as")}
        options={[
          { id: "success", label: "Success" },
          { id: "failure", label: "Failure" }
        ]}
      />
      <Field label="Message" hint="Shown in the run history and in the notification.">
        <TemplateEditor
          value={config.message ?? ""}
          onChange={(message) => setConfig({ message: message || undefined }, "message")}
          scope={scope}
          ariaLabel="Stop message"
          placeholder="Nothing new to do"
        />
      </Field>
      <Field label="Final output" hint="One {{ … }} keeps the raw value — a number stays a number.">
        <TemplateEditor
          value={config.value ?? ""}
          onChange={(value) => setConfig({ value: value || undefined }, "value")}
          scope={scope}
          ariaLabel="Final output"
          placeholder="{{ input }}"
          monospace
        />
      </Field>
    </Section>
  );
};

export const WaitSettings: React.FC = () => {
  const { node } = useInspector();
  type WaitConfig = { kind: "duration"; minutes: number } | { kind: "until"; time: string; timezone?: string };
  const setConfig = useConfigSetter<WaitConfig>();
  const config = node.config as WaitConfig;
  const messages = useFieldMessages("config");
  return (
    <Section title="Pause">
      <Segmented
        label="Wait kind"
        value={config.kind}
        onChange={(kind) => setConfig(() => (kind === "duration" ? { kind: "duration", minutes: 5 } : { kind: "until", time: "09:00" }), "kind")}
        options={[
          { id: "duration", label: "For a while" },
          { id: "until", label: "Until a time" }
        ]}
      />
      {config.kind === "duration" ? (
        <Field label="Wait" error={messages.error}>
          <NumberInput
            value={config.minutes}
            onValue={(minutes) => setConfig(() => ({ kind: "duration", minutes: minutes ?? 5 }), "minutes")}
            min={0.1}
            max={7 * 24 * 60}
            suffix="min"
            className="w-36"
            allowEmpty={false}
            aria-label="Minutes to wait"
          />
        </Field>
      ) : (
        <Field label="Until" hint="In the workflow's time zone unless you set one; the next such time." error={messages.error}>
          <div className="flex items-center gap-2">
            <input
              type="time"
              value={config.time}
              aria-label="Time of day"
              onChange={(event) => setConfig((current) => ({ ...(current as { kind: "until"; time: string }), time: event.target.value || "09:00" }), "time")}
              className="h-8 rounded-md border border-neutral-800 bg-neutral-950/60 px-2 text-[13px] text-neutral-100 [color-scheme:inherit] focus:border-neutral-600 focus:outline-none"
            />
          </div>
        </Field>
      )}
    </Section>
  );
};

export const SubWorkflowSettings: React.FC = () => {
  const { node, workflow, scope } = useInspector();
  const setConfig = useConfigSetter<{ workflowId: string; input?: string }>();
  const config = node.config as { workflowId: string; input?: string };
  const state = useWorkflowsState();
  const messages = useFieldMessages("config.workflowId");
  const others = useMemo(
    () => [...state.summaries.values()].filter((summary) => summary.id !== workflow.id).sort((a, b) => a.name.localeCompare(b.name)),
    [state.summaries, workflow.id]
  );
  return (
    <Section title="Workflow to run">
      <FieldAnchor field="config.workflowId">
        <Field label="Workflow" error={messages.error} hint="It runs to the end; its final output becomes this block's output.">
          <SelectInput value={config.workflowId} aria-label="Workflow to run" onValue={(workflowId) => setConfig({ workflowId }, "workflow")}>
            {config.workflowId === UNSET_SUBWORKFLOW_ID || !others.some((other) => other.id === config.workflowId) ? (
              <option value={config.workflowId}>Pick a workflow</option>
            ) : null}
            {others.map((other) => (
              <option key={other.id} value={other.id}>
                {other.name}
              </option>
            ))}
          </SelectInput>
        </Field>
      </FieldAnchor>
      <Field label="Its input" hint="Becomes {{ trigger.input }} in that workflow.">
        <TemplateEditor
          value={config.input ?? ""}
          onChange={(input) => setConfig({ input: input || undefined }, "input")}
          scope={scope}
          ariaLabel="Input for the workflow"
          placeholder="{{ input }}"
          monospace
        />
      </Field>
    </Section>
  );
};

const NOTE_SWATCH: Record<(typeof NOTE_COLORS)[number], string> = {
  yellow: "wf-note-yellow",
  blue: "wf-note-blue",
  green: "wf-note-green",
  pink: "wf-note-pink",
  purple: "wf-note-purple",
  neutral: "wf-note-neutral"
};

export const NoteSettings: React.FC = () => {
  const { node } = useInspector();
  const setConfig = useConfigSetter<{ text: string; color: (typeof NOTE_COLORS)[number] }>();
  const config = node.config as { text: string; color: (typeof NOTE_COLORS)[number] };
  return (
    <Section title="Note">
      <Field label="Colour">
        <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Note colour">
          {NOTE_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={config.color === color}
              aria-label={color}
              title={color}
              onClick={() => setConfig({ color }, "color")}
              className={cn(
                "h-7 w-7 rounded-full border-2 bg-[rgb(var(--wf-note)/0.55)] transition-transform hover:scale-110",
                NOTE_SWATCH[color],
                config.color === color ? "border-neutral-100" : "border-transparent"
              )}
            />
          ))}
        </div>
      </Field>
      <Field label="Text">
        <textarea
          value={config.text}
          onChange={(event) => setConfig({ text: event.target.value }, "text")}
          rows={8}
          aria-label="Note text"
          className="w-full resize-y rounded-md border border-neutral-800 bg-neutral-950/60 px-2.5 py-2 text-[13px] leading-5 text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
          placeholder="What this part of the workflow does"
        />
      </Field>
    </Section>
  );
};
