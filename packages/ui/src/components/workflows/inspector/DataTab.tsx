/**
 * The inspector's Data tab (workflows spec §7.2, §7.6): how later blocks read
 * this one's output, what it received and produced in the workflow's latest
 * run, its pinned output (what a test of a later block gets instead of running
 * this one) and "Test block".
 *
 * `DataTab` reads the runs and the API; `DataTabView` is the tab itself, fed
 * the latest run, so it renders the same in a static check.
 */

import React, { useMemo, useState } from "react";
import { ExternalLink, FlaskConical, Loader2, Pencil, Pin, PinOff } from "lucide-react";

import {
  isTriggerType,
  WORKFLOW_BLOCK_CATALOG,
  WORKFLOW_EXPRESSION_ROOT_GUIDE,
  type RunWorkflowResponse,
  type WorkflowGuideItem,
  type WorkflowRunSummary
} from "@orquester/api";

import { useApi } from "../../../context/orquester-context";
import { formatAgo } from "../../../lib/workflows/format";
import { blockOutputGuide } from "../../../lib/workflows/guide-text";
import { useWorkflowRun, useWorkflowRuns } from "../../../lib/workflows/hooks";
import {
  blockInputOf,
  canPin,
  outputReference,
  parsePinnedText,
  pinDraftText,
  pinnableOutputOf,
  pinnableValue,
  testStartedNote
} from "../../../lib/workflows/inspector-data";
import { blockStatusView, runStatusView } from "../../../lib/workflows/run-view";
import type { WorkflowRunEntry } from "../../../lib/workflows/store";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { usePhoneLayout } from "../phone/phone-context";
import { JsonTree } from "../runs/JsonTree";
import { StatusGlyph, useNow } from "../runs/shared";
import { Callout, CopyChip, Disclosure, HelpTip, Pill, Section, SmallButton, TextArea } from "../ui/controls";
import { GuideItems, GuideSections, GuideText } from "../ui/GuideText";
import { fieldMessages, useInspector } from "./inspector-context";

export interface DataTabViewProps {
  /** The workflow's latest run, if any. */
  latest: WorkflowRunSummary | undefined;
  /** That run, as loaded so far. */
  run: WorkflowRunEntry | null;
  onOpenRun?: (runId: string) => void;
  /** The block's whole output in a run (when the run kept only a preview). */
  readWholeOutput: (runId: string) => Promise<unknown>;
  /** Start "Test block" (after the draft is saved). */
  startTest: () => Promise<RunWorkflowResponse>;
  /** A fixed clock (static checks); live otherwise. */
  now?: number;
}

const MUTED = "text-[12px] leading-5 text-neutral-500";

/** "an If", "a Switch" (`capital`: "An If"). */
function withArticle(title: string, capital = false): string {
  const article = /^[aeiou]/i.test(title) ? "an" : "a";
  return `${capital ? article[0]!.toUpperCase() + article.slice(1) : article} ${title}`;
}

/** The shared guide's `nodes.<Name>.…` paths, with this block's name in them. */
function nodePathGuide(name: string): WorkflowGuideItem[] {
  return WORKFLOW_EXPRESSION_ROOT_GUIDE.filter((row) => row.root === "nodes").map((row) => ({
    term: row.path.replace("<Name>", () => name),
    text: row.text
  }));
}

/** How later blocks read this block's output, and what it holds. */
const UseItsData: React.FC = () => {
  const { node } = useInspector();
  const entry = WORKFLOW_BLOCK_CATALOG[node.type];
  const reference = outputReference(node.name);
  const outputGuide = blockOutputGuide(node.type);
  if (node.type === "stop") {
    return (
      <Section title="Use this block's data">
        <p className={MUTED}>
          <GuideText text={entry.output} /> Nothing runs after it.
        </p>
      </Section>
    );
  }
  const trigger = isTriggerType(node.type);
  return (
    <Section
      title="Use this block's data"
      aside={
        <HelpTip label="using a block's data" align="end">
          <p>
            Type <code className="font-mono">{"{{"}</code> in a field that takes data — a prompt, a URL, a shell variable's value, a
            condition — to insert data from earlier blocks. Only blocks that finished before the one reading them are there.
          </p>
          <p>
            Add a path for one field: <code className="font-mono">{`{{ nodes.${node.name}.output.text }}`}</code>.
          </p>
          <GuideItems items={nodePathGuide(node.name)} />
          <p>Renaming the block updates every reference to it.</p>
        </HelpTip>
      }
    >
      {trigger ? (
        <div className="space-y-1.5">
          <p className={MUTED}>Blocks after it read the event that started the run as</p>
          <CopyChip text="{{ trigger }}" />
          <p className={MUTED}>whichever trigger fired — or, only when this one did, as</p>
          <CopyChip text={reference} />
        </div>
      ) : (
        <div className="space-y-1.5">
          <p className={MUTED}>Blocks after it read its output as</p>
          <CopyChip text={reference} />
        </div>
      )}
      <div className="space-y-0.5">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-neutral-400">What it outputs</span>
          {outputGuide.length > 0 ? (
            <HelpTip label="what it outputs">
              <GuideSections sections={outputGuide} />
            </HelpTip>
          ) : null}
        </div>
        <p className="break-words text-[12px] leading-5 text-neutral-300">
          <GuideText text={entry.output} />
        </p>
      </div>
    </Section>
  );
};

export const DataTabView: React.FC<DataTabViewProps> = ({ latest, run, onOpenRun, readWholeOutput, startTest, now: fixedNow }) => {
  const { editor, workflow, node, readOnly, problems } = useInspector();
  const now = useNow(false, fixedNow);
  const block = run?.blocks[node.id];
  const pinned = workflow.pinned?.[node.id];
  const hasPin = workflow.pinned !== undefined && node.id in workflow.pinned;
  const pinnable = canPin(node);
  const [editing, setEditing] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState<string | null>(null);
  const [confirmAgent, setConfirmAgent] = useState(false);
  const [pinning, setPinning] = useState(false);

  const input = useMemo(
    () => (run ? blockInputOf(run.blocks, run.detail?.definition ?? workflow, node.id, run.takenEdges) : { kind: "none" as const }),
    [run, workflow, node.id]
  );

  const pin = (value: unknown | null): void => {
    const refusal = editor.applyOps([{ op: "set_pinned", node: node.id, output: value }]);
    setPinError(refusal);
    if (refusal === null) setEditing(null);
  };

  /** "Pin this output": the whole output, read from the daemon when the run kept only a preview. */
  const pinFromRun = async (): Promise<void> => {
    if (!block || !latest) return;
    setPinning(true);
    setPinError(null);
    try {
      const whole = await pinnableOutputOf(block, () => readWholeOutput(latest.id));
      // Pinning null would remove the pin instead.
      if (!pinnableValue(whole)) setPinError("Its whole output is null: there is nothing to pin.");
      else pin(whole);
    } catch (error) {
      setPinError(error instanceof Error && error.message ? `Couldn't read the whole output: ${error.message}` : "Couldn't read the whole output.");
    } finally {
      setPinning(false);
    }
  };

  const test = async (): Promise<void> => {
    setTesting(true);
    setTestNote(null);
    try {
      await editor.flush();
      const answer = await startTest();
      setTestNote(testStartedNote(answer));
      if (answer.runId) onOpenRun?.(answer.runId);
    } catch (error) {
      setTestNote(error instanceof Error ? error.message : "Couldn't start the test.");
    } finally {
      setTesting(false);
    }
  };

  const trigger = isTriggerType(node.type);
  const variant = usePhoneLayout() ? "sheet" : "docked";
  const outputPath = `nodes.${node.name}.output`;
  const pinnedMessages = fieldMessages(problems, `pinned.${node.id}`);
  // Parsed once per edit, not per render (the text can be up to 1 MiB).
  const draft = useMemo(() => (editing === null ? null : parsePinnedText(editing)), [editing]);

  const pinnedSection =
    !trigger && (pinnable || hasPin || node.type === "if" || node.type === "switch") ? (
      <Section title="Pinned output">
        {editing !== null ? (
          <div className="space-y-2">
            <TextArea
              value={editing}
              onValue={(text) => {
                setEditing(text);
                setPinError(null);
              }}
              mono
              rows={8}
              autosize
              maxRows={20}
              invalid={draft !== null && !draft.ok}
              aria-label="Pinned output as JSON"
            />
            {draft !== null && !draft.ok ? (
              <p className="text-[11px] leading-4 text-danger">{draft.error}</p>
            ) : (
              <p className="text-[11px] leading-4 text-neutral-500">Valid JSON. A test of a later block gets exactly this.</p>
            )}
            {pinError ? <p className="text-[11px] leading-4 text-danger">{pinError}</p> : null}
            <div className="flex flex-wrap gap-2">
              <SmallButton
                variant="solid"
                icon={<Pin size={12} />}
                disabled={draft === null || !draft.ok}
                onClick={() => {
                  if (draft?.ok) pin(draft.value);
                }}
              >
                Pin
              </SmallButton>
              <SmallButton variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </SmallButton>
            </div>
          </div>
        ) : hasPin ? (
          <div className="space-y-2">
            {pinnable ? (
              <Callout
                tone="info"
                title="Pinned"
                action={
                  !readOnly ? (
                    <>
                      <SmallButton icon={<Pencil size={12} />} onClick={() => setEditing(JSON.stringify(pinned, null, 2) ?? "{}")}>
                        Edit
                      </SmallButton>
                      <SmallButton icon={<PinOff size={12} />} onClick={() => pin(null)}>
                        Unpin
                      </SmallButton>
                    </>
                  ) : null
                }
              >
                When you test a block after this one, it gets this output instead of running this block. Normal runs ignore it.
              </Callout>
            ) : (
              <Callout
                tone="warn"
                title="Pinned, but never used"
                action={
                  !readOnly ? (
                    <SmallButton icon={<PinOff size={12} />} onClick={() => pin(null)}>
                      Unpin
                    </SmallButton>
                  ) : null
                }
              >
                {node.type === "stop"
                  ? "Nothing runs after a Stop block, so a pinned output is never read."
                  : `Tests take ${withArticle(WORKFLOW_BLOCK_CATALOG[node.type].title)} block's result from a recent run instead of a pinned output.`}
              </Callout>
            )}
            {pinnedMessages.error ? <p className="text-[11px] leading-4 text-danger">{pinnedMessages.error}</p> : null}
            {pinnedMessages.warning ? <p className="text-[11px] leading-4 text-warn">{pinnedMessages.warning}</p> : null}
            {pinError ? <p className="text-[11px] leading-4 text-danger">{pinError}</p> : null}
            <JsonTree value={pinned} rootLabel="output" rootPath={outputPath} variant={variant} />
          </div>
        ) : pinnable ? (
          <div className="space-y-2">
            <p className={MUTED}>
              Pin an output to test the blocks after this one without running this one again.
              {pinnableValue(block?.output) ? " Use “Pin this output” above, or write one." : null}
            </p>
            {!readOnly ? (
              <SmallButton icon={<Pencil size={12} />} onClick={() => setEditing(pinDraftText(block))}>
                Write sample output
              </SmallButton>
            ) : null}
          </div>
        ) : (
          <p className={MUTED}>
            {withArticle(WORKFLOW_BLOCK_CATALOG[node.type].title, true)} block can't be pinned: it picks a branch, so tests of later
            blocks take its result from a recent run.
          </p>
        )}
      </Section>
    ) : null;

  const runView = latest ? runStatusView(latest) : null;
  const blockView = block ? blockStatusView(block.status) : null;

  return (
    <>
      <UseItsData />

      {hasPin ? pinnedSection : null}

      <Section title="Latest run">
        {!latest || !runView ? (
          <p className={MUTED}>No run yet. Run the workflow, or test this block below, to see what it receives and returns.</p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
              <StatusGlyph icon={runView.icon} tone={runView.tone} size={13} />
              <span className="text-neutral-200">{runView.label}</span>
              <span className="text-neutral-500">· {formatAgo(latest.startedAt ?? latest.queuedAt, now)}</span>
              {latest.test ? <Pill>Test run</Pill> : null}
              {onOpenRun ? (
                <SmallButton variant="ghost" icon={<ExternalLink size={12} />} onClick={() => onOpenRun(latest.id)} className="ml-auto">
                  Open run
                </SmallButton>
              ) : null}
            </div>

            {!block || !blockView ? (
              <p className={MUTED}>
                {run?.detail
                  ? "The latest run didn't reach this block."
                  : run?.error
                    ? `Couldn't load that run: ${run.error}`
                    : "Loading the latest run…"}
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
                  <span className="text-neutral-500">This block:</span>
                  <StatusGlyph icon={blockView.icon} tone={blockView.tone} size={13} />
                  <span className="text-neutral-200">{blockView.label}</span>
                  {block.attempt > 1 ? <span className="text-neutral-500">· after {block.attempt} tries</span> : null}
                  {block.pinned ? <span className="text-neutral-500">· used its pinned output</span> : null}
                </div>

                {!trigger ? (
                  <Disclosure
                    label="Input"
                    summary={
                      input.kind === "none"
                        ? "none in that run"
                        : input.kind === "single"
                          ? `from ${input.from}`
                          : `from ${Object.keys(input.value).length} blocks`
                    }
                  >
                    {input.kind === "none" ? (
                      <p className={MUTED}>It received no input in that run.</p>
                    ) : (
                      <div className="space-y-1">
                        <p className="text-[11px] text-neutral-500">
                          {input.kind === "single" ? `From ${input.from}` : "Several blocks arrived: their outputs, by block name"}
                        </p>
                        <JsonTree value={input.value} rootLabel="input" rootPath="input" variant={variant} />
                      </div>
                    )}
                  </Disclosure>
                ) : null}

                <Disclosure label="Output" defaultOpen>
                  {block.error ? <Callout tone="danger">{block.error.message}</Callout> : null}
                  {block.output !== undefined ? (
                    <div className="space-y-2">
                      {block.pinned ? <p className="text-[11px] text-neutral-500">Its pinned output, used by that test run</p> : null}
                      <JsonTree value={block.output} rootLabel="output" rootPath={outputPath} variant={variant} />
                      {block.outputTruncated ? (
                        <p className="text-[11px] leading-4 text-neutral-500">Only a preview is shown here; the run view loads the whole output.</p>
                      ) : null}
                      {!readOnly && pinnable && pinnableValue(block.output) ? (
                        <>
                          <SmallButton
                            icon={pinning ? <Loader2 size={12} className="motion-safe:animate-spin" /> : <Pin size={12} />}
                            onClick={() => void pinFromRun()}
                            disabled={pinning}
                            title={block.outputTruncated ? "Pins the whole output, read from the run" : undefined}
                          >
                            {hasPin ? "Pin this output instead" : "Pin this output"}
                          </SmallButton>
                          {pinError && editing === null && !hasPin ? <p className="text-[11px] leading-4 text-danger">{pinError}</p> : null}
                        </>
                      ) : null}
                    </div>
                  ) : !block.error ? (
                    <p className={MUTED}>No output.</p>
                  ) : null}
                </Disclosure>
              </>
            )}
          </div>
        )}
      </Section>

      {hasPin ? null : pinnedSection}

      {!readOnly ? (
        <Section title="Test">
          {trigger ? (
            <p className={MUTED}>
              Runs only this trigger, as a manual test, and opens the test run. It outputs what a manual start would —{" "}
              <code className="font-mono text-[11.5px]">{'{ kind: "manual", input: null }'}</code> — not a real event.
            </p>
          ) : (
            <p className={MUTED}>
              Runs only this block, for real, and opens the test run. Its input comes from the blocks before it: their pinned outputs
              where they have one, else their results from a recent run.
              {hasPin ? " Its own pinned output isn't used — the point is to run it." : null}
              {node.disabled ? " It's disabled, so the test only passes its input through." : null}
            </p>
          )}
          <SmallButton
            icon={testing ? <Loader2 size={12} className="motion-safe:animate-spin" /> : <FlaskConical size={12} />}
            disabled={testing}
            onClick={() => (node.type === "agent" && !node.disabled ? setConfirmAgent(true) : void test())}
          >
            Test block
          </SmallButton>
          {testNote ? <p className="text-[11px] leading-4 text-neutral-400">{testNote}</p> : null}
          {/* Mounted only while asked (closing unmounts it, which hands focus back the same way). */}
          {confirmAgent ? (
            <ConfirmDialog
              open
              title="Start a real agent session?"
              message={`Testing runs the agent for real: it opens a chat, works in the project and uses your quota.${
                hasPin ? " (Its pinned output is only used when you test the blocks after it.)" : ""
              }`}
              confirmLabel="Run the agent"
              onCancel={() => setConfirmAgent(false)}
              onConfirm={() => {
                setConfirmAgent(false);
                void test();
              }}
            />
          ) : null}
        </Section>
      ) : null}
    </>
  );
};

export const DataTab: React.FC<{ onOpenRun?: (runId: string) => void }> = ({ onOpenRun }) => {
  const api = useApi();
  const { workflow, node } = useInspector();
  const runs = useWorkflowRuns(workflow.id);
  const latest: WorkflowRunSummary | undefined = runs.runs[0];
  const run = useWorkflowRun(latest?.id ?? null);
  return (
    <DataTabView
      latest={latest}
      run={run}
      onOpenRun={onOpenRun}
      readWholeOutput={(runId) => api.getWorkflowNodeOutput(runId, node.id)}
      startTest={() => api.testWorkflowNode(workflow.id, node.id, { usePinned: true })}
    />
  );
};
