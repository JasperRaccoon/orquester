/**
 * The gate block's form (spec 2026-11-10 §6.1), four sections that each say
 * what they hold in one line when closed:
 *  - Question: what the decider is asked (data from earlier blocks works) and
 *    its Markdown details;
 *  - Choices: 2–8, each an output of the block (`choice:<id>`) with its
 *    label, id, colour and whether it asks for a comment; reordered with the
 *    arrows, the edges drawn from one follow it when its id changes;
 *  - Who decides: the user, a reviewer agent (prompt, who runs it, Agent
 *    Profile, how long it may take — the agent block's own editors), or the
 *    chat that started the run;
 *  - If nobody decides: a deadline for the user and what then happens.
 * Every field validation can point at has its anchor and its own messages.
 * The phone's step editor opens this same form (`PhoneEditor`), finger-sized.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Braces, Plus, Trash2 } from "lucide-react";

import {
  defaultNodeConfig,
  WORKFLOW_LIMITS,
  type AgentChainEntry,
  type AgentPrompt,
  type GateBlockConfig,
  type Workflow,
  type WorkflowGateChoice,
  type WorkflowGateChoiceColor,
  type WorkflowGateCommentMode,
  type WorkflowGateDecider
} from "@orquester/api";
import { WORKFLOW_CHOICE_ID_PATTERN } from "@orquester/config";

import { cn } from "../../../lib/cn";
import { useSavedPrompts } from "../../../lib/saved-prompts/hooks";
import { useSessionProfileList } from "../../../lib/session-profiles/hooks";
import { blockProfileChoices, blockProfileLabel } from "../../../lib/session-profiles/logic";
import { formatMinutes } from "../../../lib/workflows/durations";
import {
  gateDeciderSummary,
  gateTimeoutSummary,
  newChoice,
  removeChoice,
  renameChoice
} from "../../../lib/workflows/gate-settings";
import { Callout, DurationInput, IconButton, ProblemBadge, RadioCards, Segmented, SelectInput, SmallButton, TextInput, useReadOnly } from "../ui/controls";
import { ChainEditor } from "./ChainEditor";
import {
  ConfigField,
  FieldAnchor,
  InspectorContext,
  InspectorSection,
  useConfigSetter,
  useFieldMessages,
  useInspector,
  useRevealOpen,
  useSectionProblems,
  type InspectorContextValue
} from "./inspector-context";
import { TemplateEditor, type TemplateEditorHandle } from "./TemplateEditor";

const LIMIT = WORKFLOW_LIMITS;
const TOUCH_ICON = "[.wf-touch_&]:h-10 [.wf-touch_&]:w-10";
const ASIDE_BUTTON = "-mr-1 h-6 px-1.5 [.wf-touch_&]:h-9 [.wf-touch_&]:px-2.5";

const COLOR_OPTIONS: readonly { id: WorkflowGateChoiceColor; name: string; dot: string }[] = [
  { id: "default", name: "Plain", dot: "bg-neutral-400" },
  { id: "primary", name: "Primary", dot: "bg-info" },
  { id: "success", name: "Green", dot: "bg-ok" },
  { id: "warning", name: "Amber", dot: "bg-warn" },
  { id: "danger", name: "Red", dot: "bg-danger" }
];

const COMMENT_OPTIONS: readonly { id: WorkflowGateCommentMode; label: string; description: string }[] = [
  { id: "none", label: "No comment", description: "One click decides." },
  { id: "optional", label: "Optional", description: "A box opens for a comment; it may stay empty." },
  { id: "required", label: "Required", description: "Send stays off until there is a comment. Blocks after it read it as the gate's `comment`." }
];

const InsertDataButton: React.FC<{ editor: React.RefObject<TemplateEditorHandle | null> }> = ({ editor }) =>
  useReadOnly() ? null : (
    <SmallButton variant="ghost" icon={<Braces size={12} />} onClick={() => editor.current?.insertData()} className={ASIDE_BUTTON} title="Insert data from earlier blocks, the trigger or the run">
      Insert data
    </SmallButton>
  );

// ---------------------------------------------------------------------------
// Question
// ---------------------------------------------------------------------------

const QuestionSection: React.FC<{ config: GateBlockConfig }> = ({ config }) => {
  const { scope } = useInspector();
  const setConfig = useConfigSetter<GateBlockConfig>();
  const questionEditor = useRef<TemplateEditorHandle | null>(null);
  const detailsEditor = useRef<TemplateEditorHandle | null>(null);
  const question = useFieldMessages("config.question");
  const details = useFieldMessages("config.details");
  const summary = config.question.trim() ? `“${config.question.trim()}”` : "No question yet";
  return (
    <InspectorSection title="Question" anchors={["config.question", "config.details"]} summary={summary} defaultOpen sticky>
      <ConfigField
        path="config.question"
        label="Question"
        hint={`What the decider is asked. At most ${LIMIT.gateQuestionChars} characters once the data is filled in.`}
        aside={<InsertDataButton editor={questionEditor} />}
      >
        <TemplateEditor
          ref={questionEditor}
          value={config.question}
          onChange={(next) => setConfig({ question: next }, "question")}
          scope={scope}
          placeholder="Deploy {{ nodes.Build.output.version }} to production?"
          ariaLabel="Question"
          invalid={question.error !== null}
        />
      </ConfigField>
      <ConfigField
        path="config.details"
        label="Details"
        optional
        hint="Markdown, folded under the question: a summary, the changes, a link. At most 8 KB once filled in."
        aside={<InsertDataButton editor={detailsEditor} />}
      >
        <TemplateEditor
          ref={detailsEditor}
          value={config.details ?? ""}
          onChange={(next) =>
            setConfig((current) => {
              const { details: _old, ...rest } = current;
              return next ? { ...rest, details: next } : rest;
            }, "details")
          }
          scope={scope}
          multiline
          minHeight={72}
          maxHeight={280}
          placeholder="{{ nodes.Review.output.summary }}"
          ariaLabel="Details"
          invalid={details.error !== null}
        />
      </ConfigField>
    </InspectorSection>
  );
};

// ---------------------------------------------------------------------------
// Choices
// ---------------------------------------------------------------------------

const ChoiceCard: React.FC<{
  choice: WorkflowGateChoice;
  index: number;
  count: number;
  ids: readonly string[];
  onLabel: (label: string) => void;
  onId: (id: string) => void;
  onColor: (color: WorkflowGateChoiceColor) => void;
  onComment: (comment: WorkflowGateCommentMode) => void;
  onMove: (delta: number) => void;
  onRemove: (() => void) | null;
}> = ({ choice, index, count, ids, onLabel, onId, onColor, onComment, onMove, onRemove }) => {
  const field = `config.choices.${index}`;
  const counts = useSectionProblems([field]);
  const label = useFieldMessages(`${field}.label`);
  const idMessages = useFieldMessages(`${field}.id`);
  // The id is edited as a draft: only a valid, unused one is written (it names the block's output).
  const [draft, setDraft] = useState(choice.id);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(choice.id);
  }, [choice.id, focused]);
  const others = ids.filter((_, i) => i !== index);
  const draftError =
    draft === choice.id
      ? null
      : !WORKFLOW_CHOICE_ID_PATTERN.test(draft)
        ? "A lowercase letter, then lowercase letters, digits or _ (at most 40)."
        : others.includes(draft)
          ? "Another choice has this id."
          : null;
  const color = COLOR_OPTIONS.find((option) => option.id === (choice.color ?? "default")) ?? COLOR_OPTIONS[0]!;
  const name = choice.label.trim() || `choice ${index + 1}`;
  return (
    <FieldAnchor field={field}>
      <div className="space-y-2.5 rounded-xl border border-neutral-800 bg-neutral-900/60 p-2.5">
        <div className="flex items-center gap-1">
          <span aria-hidden className={cn("ml-1 h-2.5 w-2.5 shrink-0 rounded-full", color.dot)} />
          <FieldAnchor field={`${field}.label`} className="min-w-0 flex-1">
            <TextInput
              value={choice.label}
              aria-label={`Choice ${index + 1} label`}
              maxLength={LIMIT.labelChars}
              placeholder={`Choice ${index + 1}`}
              invalid={label.error !== null}
              onValue={onLabel}
              className="h-7 border-transparent bg-transparent px-1.5 font-medium hover:border-neutral-800"
            />
          </FieldAnchor>
          <ProblemBadge problems={counts} />
          <IconButton size="sm" label={`Move ${name} up`} disabled={index === 0} onClick={() => onMove(-1)} className={TOUCH_ICON}>
            <ArrowUp size={12} />
          </IconButton>
          <IconButton size="sm" label={`Move ${name} down`} disabled={index === count - 1} onClick={() => onMove(1)} className={TOUCH_ICON}>
            <ArrowDown size={12} />
          </IconButton>
          <IconButton
            size="sm"
            label={onRemove ? `Remove ${name}` : `A gate keeps at least ${LIMIT.gateChoices.min} choices`}
            tone="danger"
            disabled={onRemove === null}
            onClick={() => onRemove?.()}
            className={TOUCH_ICON}
          >
            <Trash2 size={12} />
          </IconButton>
        </div>
        {label.error ? <p className="px-1 text-[11px] leading-4 text-danger">{label.error}</p> : null}

        <ConfigField
          path={`${field}.id`}
          label="Id"
          hint={
            <>
              Its output is <code className="text-neutral-400">choice:{choice.id}</code>; blocks after the gate read it as{" "}
              <code className="text-neutral-400">output.choice</code>.
            </>
          }
        >
          <TextInput
            value={draft}
            invalid={draftError !== null || idMessages.error !== null}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              setDraft(choice.id);
            }}
            onValue={(text) => {
              const next = text.toLowerCase().replace(/[^a-z0-9_]/g, "_");
              setDraft(next);
              if (next !== choice.id && WORKFLOW_CHOICE_ID_PATTERN.test(next) && !others.includes(next)) onId(next);
            }}
            className="font-mono text-[12.5px]"
          />
        </ConfigField>
        {draftError ? <p className="-mt-1.5 text-[11px] leading-4 text-danger">{draftError}</p> : null}

        <ConfigField path={`${field}.color`} label="Colour">
          <Segmented<WorkflowGateChoiceColor>
            label={`${name} colour`}
            size="sm"
            wrap
            value={choice.color ?? "default"}
            onChange={onColor}
            options={COLOR_OPTIONS.map((option) => ({
              id: option.id,
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden className={cn("h-2 w-2 rounded-full", option.dot)} />
                  {option.name}
                </span>
              )
            }))}
          />
        </ConfigField>

        <ConfigField path={`${field}.comment`} label="Comment">
          <Segmented<WorkflowGateCommentMode>
            label={`${name} comment`}
            size="sm"
            wrap
            value={choice.comment}
            onChange={onComment}
            options={COMMENT_OPTIONS.map((option) => ({ id: option.id, label: option.label, description: option.description }))}
          />
        </ConfigField>
      </div>
    </FieldAnchor>
  );
};

const ChoicesSection: React.FC<{ config: GateBlockConfig }> = ({ config }) => {
  const { node, editor, readOnly, workflow } = useInspector();
  const setConfig = useConfigSetter<GateBlockConfig>();
  const choices = config.choices;
  const ids = choices.map((choice) => choice.id);
  // A stable key per choice, so a card's draft follows its choice when choices move.
  const nextKey = useRef(choices.length);
  const [keys, setKeys] = useState<number[]>(() => choices.map((_, index) => index));
  if (keys.length !== choices.length) {
    const fitted = keys.slice(0, choices.length);
    while (fitted.length < choices.length) fitted.push((nextKey.current += 1));
    setKeys(fitted);
  }

  const updateChoice = (index: number, patch: Partial<WorkflowGateChoice>, key: string): void =>
    setConfig({ choices: choices.map((current, i) => (i === index ? { ...current, ...patch } : current)) }, `${key}-${index}`);

  const move = (index: number, delta: number): void => {
    const target = index + delta;
    if (readOnly || target < 0 || target >= choices.length) return;
    const next = [...choices];
    [next[index], next[target]] = [next[target]!, next[index]!];
    setConfig({ choices: next }, "choice-order");
    const moved = [...keys];
    [moved[index], moved[target]] = [moved[target]!, moved[index]!];
    setKeys(moved);
  };

  /** The whole workflow changes with it: edges leave a choice's output, the timeout may name it. */
  const changeGraph = (recipe: (draft: Workflow) => Workflow, key: string | null): void => {
    if (readOnly) return;
    editor.change(recipe, { coalesce: key === null ? null : `config:${node.id}:${key}` });
  };

  const add = (): void => {
    if (readOnly || choices.length >= LIMIT.gateChoices.max) return;
    setKeys([...keys, (nextKey.current += 1)]);
    setConfig({ choices: [...choices, newChoice(ids)] }, "add-choice");
  };

  const summary = `${choices.length} ${choices.length === 1 ? "choice" : "choices"}: ${choices.map((choice) => choice.label || choice.id).join(", ")}`;
  const unwired = choices.filter((choice) => !workflow.edges.some((edge) => edge.source === node.id && edge.sourceHandle === `choice:${choice.id}`));
  return (
    <InspectorSection
      title="Choices"
      anchors={["config.choices"]}
      defaultOpen
      summary={summary}
      description="Each choice is an output of the block: wire it to what should happen next. A choice wired to nothing ends that path."
    >
      {choices.map((choice, index) => (
        <ChoiceCard
          key={keys[index] ?? `extra-${index}`}
          choice={choice}
          index={index}
          count={choices.length}
          ids={ids}
          onLabel={(label) => updateChoice(index, { label }, "choice-label")}
          onId={(id) => changeGraph((draft) => renameChoice(draft, node.id, choice.id, id), `choice-id-${keys[index] ?? index}`)}
          onColor={(color) => updateChoice(index, color === "default" ? { color: undefined } : { color }, "choice-color")}
          onComment={(comment) => updateChoice(index, { comment }, "choice-comment")}
          onMove={(delta) => move(index, delta)}
          onRemove={
            choices.length > LIMIT.gateChoices.min
              ? () => {
                  changeGraph((draft) => removeChoice(draft, node.id, choice.id), null);
                  setKeys(keys.filter((_, i) => i !== index));
                }
              : null
          }
        />
      ))}
      {choices.length < LIMIT.gateChoices.min ? (
        <Callout tone="warn">A gate needs at least {LIMIT.gateChoices.min} choices.</Callout>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <SmallButton icon={<Plus size={13} />} onClick={add} disabled={choices.length >= LIMIT.gateChoices.max} className="[.wf-touch_&]:h-10">
          Add a choice
        </SmallButton>
        {choices.length >= LIMIT.gateChoices.max ? (
          <span className="text-[11px] text-neutral-500">At most {LIMIT.gateChoices.max} choices.</span>
        ) : null}
      </div>
      {unwired.length > 0 && unwired.length < choices.length ? (
        <p className="text-[11px] leading-4 text-neutral-500">
          {unwired.map((choice) => `“${choice.label || choice.id}”`).join(", ")} {unwired.length === 1 ? "is" : "are"} not wired: choosing{" "}
          {unwired.length === 1 ? "it" : "one"} ends that path.
        </p>
      ) : null}
    </InspectorSection>
  );
};

// ---------------------------------------------------------------------------
// Who decides
// ---------------------------------------------------------------------------

/** The chain editor reads `config.chain` problems: the decider's are shown to it under that name. */
function deciderChainContext(context: InspectorContextValue): InspectorContextValue {
  const from = "config.decider.chain";
  const rename = (field: string): string => `config.chain${field.slice(from.length)}`;
  const under = (field: string | undefined): field is string => field !== undefined && (field === from || field.startsWith(`${from}.`));
  return {
    ...context,
    problems: context.problems.flatMap((problem) => (under(problem.field) ? [{ ...problem, field: rename(problem.field) }] : [])),
    reveal: context.reveal && under(context.reveal.field) ? { ...context.reveal, field: rename(context.reveal.field) } : null
  };
}

const DeciderPrompt: React.FC<{ prompt: AgentPrompt; onPrompt: (prompt: AgentPrompt, key: string) => void }> = ({ prompt, onPrompt }) => {
  const { projectPath, promptScope } = useInspector();
  const saved = useSavedPrompts(projectPath);
  const textEditor = useRef<TemplateEditorHandle | null>(null);
  const appendEditor = useRef<TemplateEditorHandle | null>(null);
  const textMessages = useFieldMessages("config.decider.prompt.text");
  const sorted = useMemo(
    () => [...saved.prompts].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.title.localeCompare(b.title)),
    [saved.prompts]
  );
  const savedPrompt = prompt.kind === "saved" ? sorted.find((candidate) => candidate.id === prompt.promptId) : undefined;
  return (
    <div className="space-y-2.5">
      <Segmented
        label="Where the reviewer's instructions come from"
        wrap
        size="sm"
        value={prompt.kind}
        onChange={(kind) =>
          onPrompt(kind === "text" ? { kind: "text", text: savedPrompt?.body ?? "" } : { kind: "saved", promptId: sorted[0]?.id ?? "unset" }, "decider-prompt-kind")
        }
        options={[
          { id: "text", label: "Write it here" },
          { id: "saved", label: "Use a saved prompt" }
        ]}
      />
      {prompt.kind === "text" ? (
        <ConfigField
          path="config.decider.prompt.text"
          label="What to check"
          hint="The question, its details and the choices are added for it, with how to decide. It must comment on its decision."
          aside={<InsertDataButton editor={textEditor} />}
        >
          <TemplateEditor
            ref={textEditor}
            value={prompt.text}
            onChange={(text) => onPrompt({ ...prompt, kind: "text", text }, "decider-prompt-text")}
            scope={promptScope}
            multiline
            minHeight={96}
            maxHeight={320}
            placeholder="Review the change against the spec. Approve only if the tests pass and nothing is out of scope."
            ariaLabel="Reviewer instructions"
            invalid={textMessages.error !== null}
          />
        </ConfigField>
      ) : (
        <>
          <ConfigField path="config.decider.prompt.promptId" label="Saved prompt">
            <SelectInput value={prompt.promptId} onValue={(promptId) => onPrompt({ ...prompt, kind: "saved", promptId }, "decider-prompt-saved")}>
              {!savedPrompt ? (
                <option value={prompt.promptId}>
                  {saved.status === "loading" ? "Loading…" : prompt.promptId === "unset" ? "Pick a saved prompt" : "A deleted saved prompt"}
                </option>
              ) : null}
              {sorted.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.pinned ? "★ " : ""}
                  {candidate.title}
                  {candidate.projectPath ? " · this project" : ""}
                </option>
              ))}
            </SelectInput>
          </ConfigField>
          <ConfigField path="config.decider.prompt.append" label="Add to it" optional aside={<InsertDataButton editor={appendEditor} />}>
            <TemplateEditor
              ref={appendEditor}
              value={prompt.append ?? ""}
              onChange={(append) => {
                const { append: _old, ...rest } = prompt;
                onPrompt(append ? { ...rest, append } : rest, "decider-prompt-append");
              }}
              scope={promptScope}
              multiline
              minHeight={64}
              ariaLabel="Text added after the saved prompt"
            />
          </ConfigField>
        </>
      )}
    </div>
  );
};

/** How long an agent decider may take before the user is asked. */
const AgentPhaseField: React.FC<{ minutes: number; onMinutes: (minutes: number) => void; label: string }> = ({ minutes, onMinutes, label }) => {
  const messages = useFieldMessages("config.decider.maxMinutes");
  return (
    <ConfigField path="config.decider.maxMinutes" label={label} hint="Then it is handed to you." defaultNote={formatMinutes(LIMIT.gateAgentPhaseDefaultMinutes)}>
      <DurationInput
        value={minutes}
        unit="minutes"
        units={["minutes", "hours", "days"]}
        min={1}
        max={LIMIT.gatePersonPhaseMaxMinutes}
        ariaLabel={label}
        invalid={messages.error !== null}
        onValue={(next) => {
          if (next !== undefined) onMinutes(Math.max(1, Math.round(next)));
        }}
      />
    </ConfigField>
  );
};

const DeciderSection: React.FC<{ config: GateBlockConfig }> = ({ config }) => {
  const context = useInspector();
  const setConfig = useConfigSetter<GateBlockConfig>();
  const decider = config.decider;
  const profiles = useSessionProfileList().profiles;
  const chainContext = useMemo(() => deciderChainContext(context), [context]);
  const setDecider = (next: WorkflowGateDecider, key: string): void => setConfig({ decider: next }, key);
  const withAgent = (patch: Partial<Extract<WorkflowGateDecider, { kind: "agent" }>>, key: string): void =>
    setConfig((current) => (current.decider.kind === "agent" ? { ...current, decider: { ...current.decider, ...patch } } : current), key);

  const switchTo = (kind: WorkflowGateDecider["kind"]): void => {
    if (kind === decider.kind) return;
    const minutes = decider.kind === "human" ? LIMIT.gateAgentPhaseDefaultMinutes : decider.maxMinutes;
    if (kind === "human") setDecider({ kind: "human" }, "decider-kind");
    else if (kind === "launcher") setDecider({ kind: "launcher", maxMinutes: minutes }, "decider-kind");
    else {
      const chain = (defaultNodeConfig("agent") as { chain: AgentChainEntry[] }).chain;
      setDecider({ kind: "agent", prompt: { kind: "text", text: "" }, chain, maxMinutes: minutes }, "decider-kind");
    }
  };

  const summary = gateDeciderSummary(decider, (profileId) => blockProfileLabel(profiles, profileId));
  return (
    <InspectorSection title="Who decides" anchors={["config.decider"]} summary={summary} defaultOpen sticky>
      <RadioCards<WorkflowGateDecider["kind"]>
        ariaLabel="Who decides"
        value={decider.kind}
        onValue={switchTo}
        options={[
          {
            value: "human",
            label: "You",
            description: "The run waits for you: a notification, a “Needs you” row in the sidebar and the card in the run view and the Workflows panel. Your own MCP client may decide too."
          },
          {
            value: "agent",
            label: "A reviewer agent",
            description: "A new agent chat reviews and decides, with a comment. If it can't decide, fails or runs out of time, the decision comes to you. You can always decide first.",
            children:
              decider.kind === "agent" ? (
                <div className="space-y-3">
                  <FieldAnchor field="config.decider.prompt">
                    <DeciderPrompt prompt={decider.prompt} onPrompt={(prompt, key) => withAgent({ prompt }, key)} />
                  </FieldAnchor>
                  <FieldAnchor field="config.decider.chain" className="space-y-1.5">
                    <span className="block text-xs font-medium text-neutral-400">Who reviews</span>
                    <InspectorContext.Provider value={chainContext}>
                      <ChainEditor chain={decider.chain} onChange={(chain) => withAgent({ chain }, "decider-chain")} projectPath={context.projectPath} />
                    </InspectorContext.Provider>
                  </FieldAnchor>
                  <ConfigField
                    path="config.decider.profileId"
                    label="Agent Profile"
                    optional
                    hint="What the reviewer's chat loads. If the profile is gone or can't be prepared, the decision comes to you."
                    defaultNote="Global"
                  >
                    <SelectInput
                      value={decider.profileId ?? ""}
                      onValue={(profileId) =>
                        setConfig((current) => {
                          if (current.decider.kind !== "agent") return current;
                          const { profileId: _old, ...rest } = current.decider;
                          return { ...current, decider: profileId ? { ...rest, profileId } : rest };
                        }, "decider-profile")
                      }
                    >
                      {blockProfileChoices(profiles, decider.profileId).map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {choice.label}
                        </option>
                      ))}
                    </SelectInput>
                  </ConfigField>
                  <AgentPhaseField label="Give it at most" minutes={decider.maxMinutes} onMinutes={(maxMinutes) => withAgent({ maxMinutes }, "decider-minutes")} />
                </div>
              ) : null
          },
          {
            value: "launcher",
            label: "The chat that started the run",
            description: "When an agent chat runs this workflow (run_workflow), that chat is asked, with a comment. Started any other way — or if it doesn't answer in time — the decision comes to you.",
            children:
              decider.kind === "launcher" ? (
                <AgentPhaseField
                  label="Give it at most"
                  minutes={decider.maxMinutes}
                  onMinutes={(maxMinutes) =>
                    setConfig((current) => (current.decider.kind === "launcher" ? { ...current, decider: { ...current.decider, maxMinutes } } : current), "decider-minutes")
                  }
                />
              ) : null
          }
        ]}
      />
    </InspectorSection>
  );
};

// ---------------------------------------------------------------------------
// If nobody decides
// ---------------------------------------------------------------------------

const TimeoutSection: React.FC<{ config: GateBlockConfig }> = ({ config }) => {
  const setConfig = useConfigSetter<GateBlockConfig>();
  const timeout = config.timeout;
  const minutes = useFieldMessages("config.timeout.minutes");
  const thenChoice = useFieldMessages("config.timeout.then");
  const [, setOpen] = useRevealOpen(["config.timeout"]);
  const known = timeout?.then.kind === "choice" ? config.choices.some((choice) => choice.id === (timeout.then as { choice: string }).choice) : true;
  const setTimeout = (next: GateBlockConfig["timeout"]): void =>
    setConfig((current) => {
      const { timeout: _old, ...rest } = current;
      return next ? { ...rest, timeout: next } : rest;
    }, "timeout");

  return (
    <InspectorSection
      title="If nobody decides"
      anchors={["config.timeout"]}
      summary={gateTimeoutSummary(config)}
      description="Counted from when you are asked. An agent decider's own time doesn't count: an automatic choice only ever comes after you were asked."
    >
      <RadioCards<"none" | "deadline">
        ariaLabel="If nobody decides"
        value={timeout ? "deadline" : "none"}
        onValue={(value) => {
          setOpen(true);
          if (value === "none") setTimeout(undefined);
          else if (!timeout) setTimeout({ minutes: 24 * 60, then: { kind: "fail" } });
        }}
        options={[
          { value: "none", label: "Wait up to 7 days, then fail", description: "The block fails with “Gate expired”; its failure output, or the run's failure, follows." },
          {
            value: "deadline",
            label: "Set a deadline",
            description: "When it passes, the gate takes a choice for you — or fails.",
            children: timeout ? (
              <div className="space-y-3">
                <ConfigField path="config.timeout.minutes" label="Deadline" hint="At most 7 days.">
                  <DurationInput
                    value={timeout.minutes}
                    unit="minutes"
                    units={["minutes", "hours", "days"]}
                    min={1}
                    max={LIMIT.gatePersonPhaseMaxMinutes}
                    ariaLabel="Deadline"
                    invalid={minutes.error !== null}
                    onValue={(next) => {
                      if (next !== undefined) setTimeout({ ...timeout, minutes: next });
                    }}
                  />
                </ConfigField>
                <ConfigField path="config.timeout.then" label="Then">
                  <SelectInput
                    value={timeout.then.kind === "choice" ? `choice:${timeout.then.choice}` : "fail"}
                    aria-invalid={thenChoice.error !== null || !known || undefined}
                    onValue={(value) =>
                      setTimeout({ ...timeout, then: value === "fail" ? { kind: "fail" } : { kind: "choice", choice: value.slice("choice:".length) } })
                    }
                  >
                    <option value="fail">Fail the block (“Gate expired”)</option>
                    {config.choices.map((choice) => (
                      <option key={choice.id} value={`choice:${choice.id}`}>
                        Take “{choice.label || choice.id}”
                      </option>
                    ))}
                    {!known && timeout.then.kind === "choice" ? (
                      <option value={`choice:${timeout.then.choice}`}>Take “{timeout.then.choice}” (no longer a choice)</option>
                    ) : null}
                  </SelectInput>
                </ConfigField>
                {!known ? <p className="text-[11px] leading-4 text-danger">That choice was removed: pick another, or fail.</p> : null}
              </div>
            ) : null
          }
        ]}
      />
    </InspectorSection>
  );
};

export const GateSettings: React.FC = () => {
  const { node } = useInspector();
  const config = node.config as GateBlockConfig;
  return (
    <>
      <QuestionSection config={config} />
      <ChoicesSection config={config} />
      <DeciderSection config={config} />
      <TimeoutSection config={config} />
    </>
  );
};
