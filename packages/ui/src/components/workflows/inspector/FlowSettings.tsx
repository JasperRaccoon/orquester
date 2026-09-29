/**
 * The flow blocks' forms (workflows spec §4): If and Switch as a no-code rule
 * builder, and the small forms of Merge, Stop, Wait, Run workflow and the
 * sticky note. Each says in words what the block does with its choices, and
 * every field validation can point at is anchored, so picking a problem opens
 * and focuses it.
 */

import React, { useId, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ExternalLink, Plus, Trash2 } from "lucide-react";

import {
  isValidTimeZone,
  UNSET_SUBWORKFLOW_ID,
  WORKFLOW_RULE_GUIDE,
  WORKFLOW_RULE_OPERATOR_GUIDE,
  type RuleOperator,
  type WorkflowRule
} from "@orquester/api";
import { NOTE_COLORS } from "@orquester/config";

import { cn } from "../../../lib/cn";
import { isUnaryOperator, nodeSummary, RULE_OPERATOR_LABELS, ruleText } from "../../../lib/workflows/catalog-ui";
import { formatMinutes } from "../../../lib/workflows/durations";
import { blockGuideSection, guideItemText } from "../../../lib/workflows/guide-text";
import {
  caseLabelNote,
  caseOutputName,
  incomingBlockNames,
  mergeOutputExample,
  rulesSummary,
  timeZoneLabel,
  waitConfigForKind,
  type WaitConfig
} from "../../../lib/workflows/flow-settings";
import { useWorkflowsState } from "../../../lib/workflows/hooks";
import { useAppStore } from "../../../store/app";
import { updateNode } from "../canvas/ops";
import {
  CopyChip,
  DurationInput,
  Field,
  FOCUS_RING,
  HelpTip,
  IconButton,
  ProblemBadge,
  RadioCards,
  Section,
  Segmented,
  SelectInput,
  SmallButton,
  TextArea,
  TextInput,
  TimeInput,
  ViewButton
} from "../ui/controls";
import { GuideItems, GuideText } from "../ui/GuideText";
import { timeZones } from "../WorkflowSettingsModal";
import {
  ConfigField,
  fieldMessages,
  FieldAnchor,
  InspectorSection,
  problemsAt,
  useConfigSetter,
  useFieldMessages,
  useInspector,
  useRevealOpen,
  useSectionProblems
} from "./inspector-context";
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

/** The rule sides as the form names them (the shared guide calls them `left` / `right`). */
const RULE_SIDE_LABELS: Partial<Record<string, string>> = { left: "Value", right: "Compared with" };

/** A rule-guide or operator term as the form shows it: a side's label, an operator's label. */
function ruleTermLabel(term: string): React.ReactNode {
  const side = RULE_SIDE_LABELS[term];
  if (side !== undefined) return side;
  return term in RULE_OPERATOR_LABELS ? RULE_OPERATOR_LABELS[term as RuleOperator] : term;
}

/** How rules compare, for the Conditions / Cases help tip: the shared guide's rules, then each operator by group. */
export const RulesGuide: React.FC = () => (
  <div className="space-y-2.5">
    <GuideItems items={WORKFLOW_RULE_GUIDE} termLabel={ruleTermLabel} />
    {OPERATOR_GROUPS.map((group) => (
      <section key={group.label} className="space-y-1">
        <h4 className="text-[10.5px] font-semibold uppercase tracking-wide text-neutral-500">{group.label} checks</h4>
        <GuideItems items={group.ops.map((op) => ({ term: op, text: WORKFLOW_RULE_OPERATOR_GUIDE[op] }))} termLabel={ruleTermLabel} />
      </section>
    ))}
  </div>
);

const RulesHelp: React.FC = () => (
  <span className="flex items-center gap-1 text-[11px] text-neutral-500">
    How rules compare
    <HelpTip label="how rules compare" align="end">
      <RulesGuide />
    </HelpTip>
  </span>
);

/** Messages on a rule's `left` / `right`, and on the rule itself (anything else under it). */
function ruleMessages(problems: Parameters<typeof problemsAt>[0], field: string) {
  const left = fieldMessages(problems, `${field}.left`);
  const right = fieldMessages(problems, `${field}.right`);
  const rest = problemsAt(problems, field).filter(
    (problem) => !problem.field!.startsWith(`${field}.left`) && !problem.field!.startsWith(`${field}.right`)
  );
  return { left, right, rule: fieldMessages(rest, field) };
}

const Note: React.FC<{ error?: string | null; warning?: string | null }> = ({ error, warning }) => (
  <>
    {error ? <p className="text-[11px] leading-4 text-danger">{error}</p> : null}
    {warning ? <p className="text-[11px] leading-4 text-warn">{warning}</p> : null}
  </>
);

const RuleRow: React.FC<{
  rule: WorkflowRule;
  index: number;
  count: number;
  field: string;
  onChange: (rule: WorkflowRule) => void;
  onRemove: (() => void) | null;
}> = ({ rule, index, count, field, onChange, onRemove }) => {
  const { scope, problems } = useInspector();
  const messages = ruleMessages(problems, field);
  const unary = isUnaryOperator(rule.op);
  const name = count > 1 ? `Rule ${index + 1}` : "Rule";
  const label = "pt-1.5 text-[11px] leading-4 text-neutral-500";
  return (
    <FieldAnchor field={field}>
      <div className="space-y-2 rounded-lg border border-neutral-800 bg-neutral-950/30 p-2.5">
        {count > 1 ? (
          <div className="-mt-0.5 flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-neutral-400">{name}</span>
            {onRemove ? (
              <IconButton label={`Remove rule ${index + 1}`} tone="danger" size="sm" onClick={onRemove}>
                <Trash2 size={12} />
              </IconButton>
            ) : null}
          </div>
        ) : null}
        <div className="grid grid-cols-[5.25rem_minmax(0,1fr)] items-start gap-x-2 gap-y-1.5">
          <span className={label} aria-hidden>
            Value
          </span>
          <FieldAnchor field={`${field}.left`} className="min-w-0 space-y-1">
            <TemplateEditor
              value={rule.left}
              onChange={(left) => onChange({ ...rule, left })}
              scope={scope}
              ariaLabel={`${name}: value`}
              placeholder="{{ input.status }}"
              monospace
              invalid={messages.left.error !== null}
            />
            <Note error={messages.left.error} warning={messages.left.warning} />
          </FieldAnchor>
          <span className={label} aria-hidden>
            Check
          </span>
          <SelectInput
            value={rule.op}
            aria-label={`${name}: comparison`}
            onValue={(op) => {
              const next = op as RuleOperator;
              if (isUnaryOperator(next)) {
                const { right: _right, ...rest } = rule;
                onChange({ ...rest, op: next });
              } else onChange({ ...rule, op: next, right: rule.right ?? "" });
            }}
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
            <>
              <span className={label} aria-hidden>
                Compared with
              </span>
              <FieldAnchor field={`${field}.right`} className="min-w-0 space-y-1">
                <TemplateEditor
                  value={rule.right ?? ""}
                  onChange={(right) => onChange({ ...rule, right })}
                  scope={scope}
                  ariaLabel={`${name}: compared with`}
                  placeholder={rule.op === "matches" ? "^v\\d+" : rule.op === "gt" || rule.op === "gte" || rule.op === "lt" || rule.op === "lte" ? "0" : "value"}
                  monospace
                  invalid={messages.right.error !== null}
                />
                <Note error={messages.right.error} warning={messages.right.warning} />
              </FieldAnchor>
            </>
          ) : null}
        </div>
        <p className="break-words text-[11px] leading-4 text-neutral-500">
          Checks <code className="font-mono text-neutral-400">{ruleText(rule)}</code>
        </p>
        <Note error={messages.rule.error} warning={messages.rule.warning} />
      </div>
    </FieldAnchor>
  );
};

const RuleList: React.FC<{
  rules: WorkflowRule[];
  combine: Combine;
  fieldPrefix: string;
  /** Leads the all / any switch: "True when", "Matches when". */
  lead: string;
  onRules: (rules: WorkflowRule[]) => void;
  onCombine: (combine: Combine) => void;
}> = ({ rules, combine, fieldPrefix, lead, onRules, onCombine }) => (
  <div className="space-y-2">
    {rules.length > 1 ? (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-neutral-400">
        <span>{lead}</span>
        <Segmented
          label={`${lead}: all or any rule`}
          size="sm"
          value={combine}
          onChange={onCombine}
          options={[
            { id: "all", label: "all rules hold" },
            { id: "any", label: "any rule holds" }
          ]}
          className="min-w-0 flex-1"
        />
      </div>
    ) : null}
    {rules.map((rule, index) => (
      <React.Fragment key={index}>
        {index > 0 ? <div className="pl-2 text-[10.5px] font-medium text-neutral-500">{combine === "all" ? "and" : "or"}</div> : null}
        <RuleRow
          rule={rule}
          index={index}
          count={rules.length}
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
  const combine = useFieldMessages("config.combine");
  return (
    <InspectorSection
      title="Conditions"
      anchors={["config.rules", "config.combine"]}
      defaultOpen
      description="Goes to True when the conditions hold, otherwise to False."
      summary={rulesSummary(config.combine, config.rules)}
      aside={<RulesHelp />}
    >
      {combine.error || combine.warning ? (
        <FieldAnchor field="config.combine">
          <Note error={combine.error} warning={combine.warning} />
        </FieldAnchor>
      ) : null}
      <FieldAnchor field="config.rules">
        <RuleList
          rules={config.rules}
          combine={config.combine}
          fieldPrefix="config.rules"
          lead="True when"
          onRules={(rules) => setConfig({ rules }, "rules")}
          onCombine={(value) => {
            if (value !== config.combine) setConfig({ combine: value }, "combine");
          }}
        />
      </FieldAnchor>
    </InspectorSection>
  );
};

/** One Switch case: its number and label always shown, its rules folded away behind a one-line summary. */
const CaseCard: React.FC<{
  entry: SwitchCase;
  index: number;
  labels: readonly string[];
  isNew: boolean;
  onLabel: (label: string) => void;
  onRules: (rules: WorkflowRule[]) => void;
  onCombine: (combine: Combine) => void;
  onMove: (delta: number) => void;
  onRemove: (() => void) | null;
}> = ({ entry, index, labels, isNew, onLabel, onRules, onCombine, onMove, onRemove }) => {
  const field = `config.cases.${index}`;
  const [open, setOpen] = useRevealOpen([field], labels.length === 1 || isNew);
  const counts = useSectionProblems([field]);
  const note = caseLabelNote(labels, index);
  const bodyId = useId();
  const labelMessages = useFieldMessages(`${field}.label`);
  return (
    <FieldAnchor field={field}>
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/60">
        <div className="flex items-center gap-1 py-1.5 pl-1 pr-1">
          {/* Folding only changes the view, so it works on a read-only workflow too. */}
          <ViewButton
            aria-expanded={open}
            aria-controls={open ? bodyId : undefined}
            aria-label={`${open ? "Hide" : "Show"} the rules of case ${index + 1}`}
            onClick={() => setOpen(!open)}
            className={cn("flex h-6 shrink-0 items-center gap-1 rounded-md px-1 text-neutral-500 hover:text-neutral-200", FOCUS_RING)}
          >
            {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
            <span className="flex h-5 min-w-5 items-center justify-center rounded-md bg-info-soft/40 px-1 text-[10.5px] font-semibold tabular-nums text-info">
              {index + 1}
            </span>
          </ViewButton>
          <FieldAnchor field={`${field}.label`} className="min-w-0 flex-1">
            <TextInput
              value={entry.label}
              aria-label={`Case ${index + 1} label`}
              placeholder={`case ${index + 1}`}
              invalid={labelMessages.error !== null}
              onValue={onLabel}
              className="h-7 border-transparent bg-transparent px-1.5 font-medium hover:border-neutral-800"
            />
          </FieldAnchor>
          <ProblemBadge problems={counts} />
          <IconButton size="sm" label={`Move case ${index + 1} up`} disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp size={12} />
          </IconButton>
          <IconButton size="sm" label={`Move case ${index + 1} down`} disabled={index === labels.length - 1} onClick={() => onMove(1)}>
            <ArrowDown size={12} />
          </IconButton>
          <IconButton size="sm" label={`Remove case ${index + 1}`} tone="danger" disabled={onRemove === null} onClick={() => onRemove?.()}>
            <Trash2 size={12} />
          </IconButton>
        </div>
        <div className="space-y-1 px-2.5 pb-2">
          <Note error={labelMessages.error} warning={labelMessages.warning ?? note.warning} />
          {note.hint ? <p className="text-[11px] leading-4 text-neutral-500">{note.hint}</p> : null}
          {!open ? (
            <p className="break-words text-[11.5px] leading-4 text-neutral-500">
              When <code className="font-mono text-neutral-400">{rulesSummary(entry.combine, entry.rules)}</code>
            </p>
          ) : null}
        </div>
        {open ? (
          <div id={bodyId} className="border-t border-neutral-800/80 p-2.5">
            <FieldAnchor field={`${field}.rules`}>
              <RuleList
                rules={entry.rules}
                combine={entry.combine}
                fieldPrefix={`${field}.rules`}
                lead="Matches when"
                onRules={onRules}
                onCombine={onCombine}
              />
            </FieldAnchor>
          </div>
        ) : null}
      </div>
    </FieldAnchor>
  );
};

export const SwitchSettings: React.FC = () => {
  const { node, editor, workflow, readOnly } = useInspector();
  const setConfig = useConfigSetter<SwitchConfig>();
  const config = node.config as SwitchConfig;

  // A stable key per case, so a card's open state follows its case when cases move.
  const nextKey = useRef(config.cases.length);
  const [keys, setKeys] = useState<number[]>(() => config.cases.map((_, index) => index));
  const [added, setAdded] = useState<ReadonlySet<number>>(() => new Set());
  if (keys.length !== config.cases.length) {
    // Cases added or removed elsewhere (undo, another client): keep the first keys, mint the rest.
    const fitted = keys.slice(0, config.cases.length);
    while (fitted.length < config.cases.length) fitted.push((nextKey.current += 1));
    setKeys(fitted);
  }

  /** Remove or reorder cases and keep every edge on the case it was drawn from. */
  const reorder = (cases: SwitchCase[], mapping: (index: number) => number | null): void => {
    if (readOnly) return;
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
    if (readOnly || target < 0 || target >= config.cases.length) return;
    const cases = [...config.cases];
    [cases[index], cases[target]] = [cases[target]!, cases[index]!];
    reorder(cases, (from) => (from === index ? target : from === target ? index : from));
    const moved = [...keys];
    [moved[index], moved[target]] = [moved[target]!, moved[index]!];
    setKeys(moved);
  };

  const remove = (index: number): void => {
    if (readOnly) return;
    reorder(
      config.cases.filter((_, i) => i !== index),
      (from) => (from === index ? null : from > index ? from - 1 : from)
    );
    setKeys(keys.filter((_, i) => i !== index));
  };

  const addCase = (): void => {
    if (readOnly) return;
    const key = (nextKey.current += 1);
    setKeys([...keys, key]);
    setAdded(new Set([...added, key]));
    setConfig(
      { cases: [...config.cases, { label: `Case ${config.cases.length + 1}`, combine: "all", rules: [{ left: "{{ input }}", op: "equals", right: "" }] }] },
      "add-case"
    );
  };

  const setFallback = (fallback: boolean): void => {
    if (readOnly || fallback === config.fallback) return;
    editor.change((draft) => {
      const next = updateNode(draft, node.id, (current) => ({ ...current, config: { ...(current.config as SwitchConfig), fallback } }) as typeof current);
      // Without its "default" output, the edges drawn from it go too.
      return fallback ? next : { ...next, edges: next.edges.filter((edge) => !(edge.source === node.id && edge.sourceHandle === "default")) };
    });
  };

  const labels = config.cases.map((entry) => entry.label);
  const defaultEdges = workflow.edges.filter((edge) => edge.source === node.id && edge.sourceHandle === "default").length;
  const updateCase = (index: number, patch: Partial<SwitchCase>, key: string): void =>
    setConfig({ cases: config.cases.map((current, i) => (i === index ? { ...current, ...patch } : current)) }, `${key}-${index}`);

  return (
    <>
      <InspectorSection
        title="Cases"
        anchors={["config.cases"]}
        defaultOpen
        description="Checked top to bottom; the first case that matches picks the output. Each case has its own output."
        summary={`${config.cases.length} ${config.cases.length === 1 ? "case" : "cases"}: ${config.cases.map((entry, index) => caseOutputName(entry.label, index)).join(", ")}`}
        aside={<RulesHelp />}
      >
        {config.cases.map((entry, index) => (
          <CaseCard
            key={keys[index] ?? `extra-${index}`}
            entry={entry}
            index={index}
            labels={labels}
            isNew={keys[index] !== undefined && added.has(keys[index]!)}
            onLabel={(label) => updateCase(index, { label }, "case-label")}
            onRules={(rules) => updateCase(index, { rules }, "case-rules")}
            onCombine={(combine) => {
              if (combine !== entry.combine) updateCase(index, { combine }, "case-combine");
            }}
            onMove={(delta) => move(index, delta)}
            onRemove={config.cases.length > 1 ? () => remove(index) : null}
          />
        ))}
        <SmallButton icon={<Plus size={13} />} onClick={addCase}>
          Add a case
        </SmallButton>
      </InspectorSection>
      <InspectorSection
        title="When nothing matches"
        anchors={["config.fallback"]}
        defaultOpen
        summary={config.fallback ? "Takes the “default” output" : "Skips everything after this block"}
      >
        <FieldAnchor field="config.fallback">
          <RadioCards
            ariaLabel="When no case matches"
            value={config.fallback ? "default" : "skip"}
            onValue={(value) => setFallback(value === "default")}
            options={[
              {
                value: "default",
                label: "Use a “default” output",
                description: "Connect what should happen when no case matches."
              },
              {
                value: "skip",
                label: "Skip everything after this block",
                description: (
                  <>
                    Nothing wired to this block runs when no case matches; the rest of the run carries on.
                    {config.fallback && defaultEdges > 0 ? (
                      <span className="mt-1 block text-warn">
                        Picking this removes the {defaultEdges === 1 ? "connection" : `${defaultEdges} connections`} from its “default” output.
                      </span>
                    ) : null}
                  </>
                )
              }
            ]}
          />
        </FieldAnchor>
      </InspectorSection>
    </>
  );
};

const MERGE_JOINING = blockGuideSection("merge", "Joining")?.items ?? [];
/** What each Merge mode does (the shared guide's Joining facts). */
const MERGE_GUIDE = {
  all: guideItemText(MERGE_JOINING, "all") ?? "",
  first: guideItemText(MERGE_JOINING, "first") ?? ""
};

export const MergeSettings: React.FC = () => {
  const { node, workflow } = useInspector();
  const setConfig = useConfigSetter<{ mode: "all" | "first" }>();
  const config = node.config as { mode: "all" | "first" };
  const names = incomingBlockNames(workflow, node.id);
  const reference = `{{ nodes.${node.name}.output.${names[0] ?? "BlockA"} }}`;
  return (
    <InspectorSection title="Joining branches" anchors={["config.mode"]} defaultOpen summary={nodeSummary(node)}>
      <FieldAnchor field="config.mode">
        <RadioCards
          ariaLabel="When it runs"
          value={config.mode}
          onValue={(mode) => {
            if (mode !== config.mode) setConfig({ mode }, "mode");
          }}
          options={[
            {
              value: "all",
              label: "Wait for every branch",
              description: <GuideText text={MERGE_GUIDE.all} />
            },
            {
              value: "first",
              label: "Go on with the first branch",
              description: <GuideText text={MERGE_GUIDE.first} />
            }
          ]}
        />
      </FieldAnchor>
      <div className="space-y-1.5">
        <div className="text-xs font-medium text-neutral-400">Its output</div>
        <p className="text-[11px] leading-4 text-neutral-500">
          One entry per branch that arrived, by block name
          {config.mode === "first" ? " — with “first”, only what had arrived when it ran, usually one" : ""}:
        </p>
        <pre className="overflow-x-auto rounded-md bg-neutral-950/60 px-2 py-1.5 font-mono text-[11.5px] leading-4 text-neutral-300 ring-1 ring-inset ring-neutral-800">
          {mergeOutputExample(names)}
        </pre>
        {names.length < 2 ? <p className="text-[11px] leading-4 text-neutral-500">Wire two or more branches into it.</p> : null}
        <p className="text-[11px] leading-4 text-neutral-500">A later block reads one branch as</p>
        <CopyChip text={reference} />
      </div>
    </InspectorSection>
  );
};

type StopConfig = { as: "success" | "failure"; message?: string; value?: string };

const STOP_ENDING = blockGuideSection("stop", "Ending")?.items ?? [];
/** What a Stop's final output and message are (the shared guide's Ending facts). */
const STOP_GUIDE = {
  value: guideItemText(STOP_ENDING, "value") ?? "",
  message: guideItemText(STOP_ENDING, "message") ?? ""
};

export const StopSettings: React.FC = () => {
  const { node, scope } = useInspector();
  const setConfig = useConfigSetter<StopConfig>();
  const config = node.config as StopConfig;
  const message = useFieldMessages("config.message");
  const value = useFieldMessages("config.value");
  return (
    <InspectorSection
      title="Ending the run"
      anchors={["config.as", "config.message", "config.value"]}
      defaultOpen
      description="Ends the whole run when it's reached; blocks still running in other branches are cancelled."
      summary={nodeSummary(node)}
    >
      <FieldAnchor field="config.as">
        <Field label="End the run as">
          <RadioCards
            ariaLabel="End the run as"
            value={config.as}
            onValue={(as) => {
              if (as !== config.as) setConfig({ as }, "as");
            }}
            options={[
              { value: "success", label: "Success", description: "Shown as Stopped in the run history — it counts as a success, not a failure." },
              { value: "failure", label: "Failure", description: "Shown as Failed, like any failed run; failure notifications go out when they're on." }
            ]}
          />
        </Field>
      </FieldAnchor>
      <ConfigField path="config.message" label="Message" optional hint={<GuideText text={STOP_GUIDE.message} />}>
        <TemplateEditor
          value={config.message ?? ""}
          onChange={(next) => setConfig({ message: next || undefined }, "message")}
          scope={scope}
          ariaLabel="Stop message"
          placeholder="Nothing new to do"
          invalid={message.error !== null}
        />
      </ConfigField>
      <ConfigField
        path="config.value"
        label="Final output"
        optional
        help={
          <>
            <p>
              <GuideText text={STOP_GUIDE.value} />
            </p>
            <p>It is what a Run workflow block that started this run gets as its output.</p>
          </>
        }
        hint="Left empty, this block's input is the final output."
      >
        <TemplateEditor
          value={config.value ?? ""}
          onChange={(next) => setConfig({ value: next || undefined }, "value")}
          scope={scope}
          ariaLabel="Final output"
          placeholder="{{ input }}"
          monospace
          invalid={value.error !== null}
        />
      </ConfigField>
    </InspectorSection>
  );
};

export const WaitSettings: React.FC = () => {
  const { node, workflow } = useInspector();
  const setConfig = useConfigSetter<WaitConfig>();
  const config = node.config as WaitConfig;
  const minutes = useFieldMessages("config.minutes");
  const time = useFieldMessages("config.time");
  const timezone = useFieldMessages("config.timezone");
  const workflowZone = workflow.settings.timezone;
  const zones = useMemo(timeZones, []);
  const summary =
    config.kind === "duration"
      ? `Waits ${formatMinutes(config.minutes)}`
      : `Until ${config.time} · ${config.timezone ? timeZoneLabel(config.timezone) : `${timeZoneLabel(workflowZone)} (the workflow's)`}`;
  return (
    <InspectorSection title="Pause" anchors={["config"]} defaultOpen summary={summary}>
      <FieldAnchor field="config.kind">
        <Segmented
          label="Wait kind"
          value={config.kind}
          onChange={(kind) => {
            if (kind !== config.kind) setConfig((current) => waitConfigForKind(current, kind), "kind");
          }}
          options={[
            { id: "duration", label: "For a while", description: "Waits a set time, then passes its input on." },
            { id: "until", label: "Until a time of day", description: "Waits for the next time the clock shows this time, then passes its input on." }
          ]}
        />
      </FieldAnchor>
      {config.kind === "duration" ? (
        <ConfigField path="config.minutes" label="Wait for" hint="At most 7 days. The wait carries on across a daemon restart.">
          <DurationInput
            value={config.minutes}
            unit="minutes"
            units={["minutes", "hours", "days"]}
            onValue={(next) => {
              if (next !== undefined) setConfig((current) => ({ ...current, kind: "duration", minutes: next }) as WaitConfig, "minutes");
            }}
            min={0.1}
            max={7 * 24 * 60}
            invalid={minutes.error !== null}
            ariaLabel="Wait for"
          />
        </ConfigField>
      ) : (
        <>
          <ConfigField path="config.time" label="Time of day" hint="If that time has already passed today, it waits until tomorrow.">
            <TimeInput
              value={config.time}
              onValue={(next) => setConfig((current) => ({ ...current, time: next }) as WaitConfig, "time")}
              invalid={time.error !== null}
              className="w-32"
            />
          </ConfigField>
          <ConfigField path="config.timezone" label="Time zone">
            <SelectInput
              value={config.timezone ?? ""}
              aria-invalid={timezone.error !== null || undefined}
              onValue={(zone) =>
                setConfig((current) => {
                  const { timezone: _previous, ...rest } = current as Extract<WaitConfig, { kind: "until" }>;
                  return (zone ? { ...rest, timezone: zone } : rest) as WaitConfig;
                }, "timezone")
              }
            >
              <option value="">The workflow's time zone ({timeZoneLabel(workflowZone)})</option>
              {/* A zone missing from this browser's list stays selectable, so it isn't silently replaced; valid aliases (Etc/UTC, US/Pacific) aren't "unknown". */}
              {config.timezone && !zones.includes(config.timezone) ? (
                <option value={config.timezone}>
                  {isValidTimeZone(config.timezone) ? timeZoneLabel(config.timezone) : `${config.timezone} (unknown)`}
                </option>
              ) : null}
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {timeZoneLabel(zone)}
                </option>
              ))}
            </SelectInput>
          </ConfigField>
        </>
      )}
    </InspectorSection>
  );
};

/** What a Run workflow block starts and gets back (the shared guide's Child run facts). */
const CHILD_RUN = blockGuideSection("workflow", "Child run")?.items ?? [];

export const SubWorkflowSettings: React.FC = () => {
  const { node, workflow, scope } = useInspector();
  const setConfig = useConfigSetter<{ workflowId: string; input?: string }>();
  const config = node.config as { workflowId: string; input?: string };
  const state = useWorkflowsState();
  const currentProjectPath = useAppStore((app) => app.currentProject?.path ?? null);
  const input = useFieldMessages("config.input");
  const others = useMemo(
    () => [...state.summaries.values()].filter((summary) => summary.id !== workflow.id).sort((a, b) => a.name.localeCompare(b.name)),
    [state.summaries, workflow.id]
  );
  const unset = config.workflowId === UNSET_SUBWORKFLOW_ID;
  const target = unset ? undefined : others.find((other) => other.id === config.workflowId);
  const self = config.workflowId === workflow.id;
  const loaded = state.load.status === "loaded";
  const missing = !unset && !self && target === undefined && loaded;
  const placeholder = unset
    ? "Pick a workflow"
    : self
      ? "This workflow (it can't run itself)"
      : missing
        ? `Missing workflow (id ${config.workflowId})`
        : `Workflow ${config.workflowId} (loading…)`;
  const summary = unset ? "Pick a workflow" : target ? nodeSummary(node, { workflowName: () => target.name }) : self ? "Runs itself (not allowed)" : missing ? "Missing workflow" : nodeSummary(node);
  return (
    <InspectorSection title="Workflow to run" anchors={["config.workflowId", "config.input"]} defaultOpen summary={summary}>
      <ConfigField
        path="config.workflowId"
        label="Workflow"
        help={
          <>
            <p>It runs to the end as its own run, linked to this one. It runs even while that workflow is turned off — its own triggers don&apos;t matter.</p>
            <GuideItems items={CHILD_RUN.filter((item) => item.term !== "input")} />
          </>
        }
        hint={target?.description?.trim() || "It runs to the end; its final output becomes this block's output."}
        aside={
          target && currentProjectPath ? (
            // Opening it is navigation, not an edit: it works on a read-only workflow too.
            <ViewButton
              onClick={() => useAppStore.getState().openWorkflowTab(currentProjectPath, target.id, { title: target.name })}
              title={`Open “${target.name}” in a tab`}
              className={cn(
                "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100",
                FOCUS_RING
              )}
            >
              <ExternalLink size={12} aria-hidden />
              Open
            </ViewButton>
          ) : null
        }
      >
        <SelectInput value={config.workflowId} onValue={(workflowId) => setConfig({ workflowId }, "workflow")}>
          {target === undefined ? <option value={config.workflowId}>{placeholder}</option> : null}
          {others.map((other) => (
            <option key={other.id} value={other.id}>
              {other.name}
            </option>
          ))}
        </SelectInput>
      </ConfigField>
      {target && target.errorCount > 0 ? (
        <p className="-mt-2 text-[11px] leading-4 text-warn">
          “{target.name}” has {target.errorCount === 1 ? "an error" : `${target.errorCount} errors`}; it won't start until {target.errorCount === 1 ? "it's" : "they're"} fixed.
        </p>
      ) : null}
      <ConfigField
        path="config.input"
        label="Its input"
        optional
        help={
          <p>
            <GuideText text={guideItemText(CHILD_RUN, "input") ?? ""} />
          </p>
        }
        hint="Left empty, this block's input is passed on."
      >
        <TemplateEditor
          value={config.input ?? ""}
          onChange={(next) => setConfig({ input: next || undefined }, "input")}
          scope={scope}
          ariaLabel="Input for the workflow"
          placeholder="{{ input }}"
          monospace
          invalid={input.error !== null}
        />
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] leading-4 text-neutral-500">
          <span>That workflow reads it as</span>
          <CopyChip text="{{ trigger.input }}" />
        </div>
      </ConfigField>
    </InspectorSection>
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

const NOTE_COLOR_LABEL: Record<(typeof NOTE_COLORS)[number], string> = {
  yellow: "Yellow",
  blue: "Blue",
  green: "Green",
  pink: "Pink",
  purple: "Purple",
  neutral: "Grey"
};

export const NoteSettings: React.FC = () => {
  const { node } = useInspector();
  const setConfig = useConfigSetter<{ text: string; color: (typeof NOTE_COLORS)[number] }>();
  const config = node.config as { text: string; color: (typeof NOTE_COLORS)[number] };
  const colourId = useId();
  return (
    <Section title="Note" description="A sticky note on the canvas; it never runs.">
      <FieldAnchor field="config.color" className="space-y-1.5">
        <div id={colourId} className="text-xs font-medium text-neutral-400">
          Colour
        </div>
        <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-labelledby={colourId}>
          {NOTE_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={config.color === color}
              aria-label={NOTE_COLOR_LABEL[color]}
              title={NOTE_COLOR_LABEL[color]}
              onClick={() => setConfig({ color }, "color")}
              className={cn(
                "h-7 w-7 rounded-full border-2 bg-[rgb(var(--wf-note)/0.55)] transition-transform hover:scale-110 [.wf-touch_&]:h-9 [.wf-touch_&]:w-9",
                FOCUS_RING,
                NOTE_SWATCH[color],
                config.color === color ? "border-neutral-100" : "border-transparent"
              )}
            />
          ))}
        </div>
      </FieldAnchor>
      <FieldAnchor field="config.text">
        <Field label="Text">
          <TextArea
            value={config.text}
            onValue={(text) => setConfig({ text }, "text")}
            rows={8}
            placeholder="What this part of the workflow does"
          />
        </Field>
      </FieldAnchor>
    </Section>
  );
};
