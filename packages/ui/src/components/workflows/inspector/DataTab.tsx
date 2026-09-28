/**
 * The inspector's Data tab (workflows spec §7.2, §7.6): what this block
 * received and produced in the workflow's latest run, its pinned output
 * (which test runs use instead of running it) and "Test block".
 */

import React, { useMemo, useState } from "react";
import { FlaskConical, Loader2, Pin, PinOff } from "lucide-react";

import { isTriggerType, type WorkflowRunSummary } from "@orquester/api";

import { useApi } from "../../../context/orquester-context";
import { formatAgo, runStatusLabel } from "../../../lib/workflows/format";
import { useWorkflowRun, useWorkflowRuns } from "../../../lib/workflows/hooks";
import { blockInputOf, parsePinnedText } from "../../../lib/workflows/inspector-data";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { Section, Segmented, SmallButton } from "../ui/controls";
import { JsonTree } from "../ui/JsonTree";
import { useInspector } from "./inspector-context";

export const DataTab: React.FC<{ onOpenRun?: (runId: string) => void }> = ({ onOpenRun }) => {
  const api = useApi();
  const { editor, workflow, node, readOnly } = useInspector();
  const runs = useWorkflowRuns(workflow.id);
  const latest: WorkflowRunSummary | undefined = runs.runs[0];
  const run = useWorkflowRun(latest?.id ?? null);
  const block = run?.blocks[node.id];
  const [side, setSide] = useState<"input" | "output">("output");
  const pinned = workflow.pinned?.[node.id];
  const hasPin = workflow.pinned !== undefined && node.id in workflow.pinned;
  const [editing, setEditing] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState<string | null>(null);
  const [confirmAgent, setConfirmAgent] = useState(false);

  const input = useMemo(
    () => (run ? blockInputOf(run.blocks, run.detail?.definition ?? workflow, node.id, run.takenEdges) : { kind: "none" as const }),
    [run, workflow, node.id]
  );

  const pin = (value: unknown | null): void => {
    const refusal = editor.applyOps([{ op: "set_pinned", node: node.id, output: value }]);
    setPinError(refusal);
    if (refusal === null) setEditing(null);
  };

  const test = async (): Promise<void> => {
    setTesting(true);
    setTestNote(null);
    try {
      await editor.flush();
      const answer = await api.testWorkflowNode(workflow.id, node.id, { usePinned: true });
      if (answer.runId) {
        setTestNote("Test run started.");
        onOpenRun?.(answer.runId);
      } else setTestNote(answer.skipped ? "Skipped: the workflow is already running (overlap: skip)." : "The daemon started nothing.");
    } catch (error) {
      setTestNote(error instanceof Error ? error.message : "Couldn't start the test.");
    } finally {
      setTesting(false);
    }
  };

  const trigger = isTriggerType(node.type);

  return (
    <>
      <Section
        title="Latest run"
        aside={
          latest ? (
            <button
              type="button"
              onClick={() => onOpenRun?.(latest.id)}
              className="text-[11px] text-neutral-500 hover:text-neutral-200"
              title="Open this run"
            >
              {runStatusLabel(latest)} · {formatAgo(latest.startedAt ?? latest.queuedAt, Date.now())}
            </button>
          ) : null
        }
      >
        {!latest ? (
          <p className="text-[12px] leading-5 text-neutral-500">
            No run yet. Run the workflow, or test this block, to see what it receives and returns.
          </p>
        ) : !block ? (
          <p className="text-[12px] leading-5 text-neutral-500">
            {run?.detail ? "The latest run did not reach this block." : "Loading the latest run…"}
          </p>
        ) : (
          <div className="space-y-2">
            {!trigger ? (
              <Segmented
                label="Input or output"
                size="sm"
                value={side}
                onChange={setSide}
                options={[
                  { id: "input", label: "Input" },
                  { id: "output", label: "Output" }
                ]}
              />
            ) : null}
            {side === "input" && !trigger ? (
              input.kind === "none" ? (
                <p className="text-[12px] text-neutral-500">It received no input in that run.</p>
              ) : (
                <JsonTree value={input.value} label={input.kind === "single" ? `From ${input.from}` : "Merged inputs"} />
              )
            ) : block.output !== undefined ? (
              <>
                <JsonTree value={block.output} label={block.pinned ? "Output (pinned)" : "Output"} />
                {block.outputTruncated ? (
                  <p className="text-[11px] text-neutral-500">Only a preview is shown; the run view loads the whole output.</p>
                ) : null}
                {!readOnly ? (
                  <SmallButton icon={<Pin size={12} />} onClick={() => pin(block.output)}>
                    Pin this output
                  </SmallButton>
                ) : null}
              </>
            ) : block.error ? (
              <p className="rounded-lg border border-danger/40 bg-danger-soft/20 px-3 py-2 text-[12px] leading-5 text-danger">{block.error.message}</p>
            ) : (
              <p className="text-[12px] text-neutral-500">No output.</p>
            )}
          </div>
        )}
      </Section>

      {!trigger ? (
        <Section
          title="Pinned output"
          aside={hasPin ? <span className="text-[11px] text-neutral-500">test runs use it</span> : null}
        >
          {editing !== null ? (
            <div className="space-y-2">
              <textarea
                value={editing}
                onChange={(event) => {
                  setEditing(event.target.value);
                  setPinError(null);
                }}
                rows={10}
                spellCheck={false}
                aria-label="Pinned output as JSON"
                className="w-full resize-y rounded-md border border-neutral-800 bg-neutral-950/60 px-2.5 py-2 font-mono text-[12px] leading-5 text-neutral-100 focus:border-neutral-600 focus:outline-none"
              />
              {pinError ? <p className="text-[11px] text-danger">{pinError}</p> : null}
              <div className="flex gap-2">
                <SmallButton
                  variant="solid"
                  onClick={() => {
                    const parsed = parsePinnedText(editing);
                    if (parsed.ok) pin(parsed.value);
                    else setPinError(parsed.error);
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
              <JsonTree value={pinned} label="Pinned" />
              {!readOnly ? (
                <div className="flex gap-2">
                  <SmallButton onClick={() => setEditing(JSON.stringify(pinned, null, 2))}>Edit</SmallButton>
                  <SmallButton icon={<PinOff size={12} />} onClick={() => pin(null)}>
                    Unpin
                  </SmallButton>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-[12px] leading-5 text-neutral-500">
                Pin an output to test what comes after this block without running it again.
              </p>
              {!readOnly ? <SmallButton onClick={() => setEditing("{\n  \n}")}>Write one</SmallButton> : null}
            </div>
          )}
        </Section>
      ) : null}

      {!readOnly ? (
        <Section title="Test">
          <p className="text-[12px] leading-5 text-neutral-500">
            Runs just this block, with its inputs from pinned outputs — else from the latest run. Test runs are marked in the history.
          </p>
          <SmallButton
            icon={testing ? <Loader2 size={12} className="motion-safe:animate-spin" /> : <FlaskConical size={12} />}
            disabled={testing}
            onClick={() => (node.type === "agent" && !hasPin ? setConfirmAgent(true) : void test())}
          >
            Test block
          </SmallButton>
          {testNote ? <p className="text-[11px] text-neutral-400">{testNote}</p> : null}
          <ConfirmDialog
            open={confirmAgent}
            title="Start a real agent session?"
            message="This block has no pinned output, so the test runs the agent for real — it opens a chat and uses your quota."
            confirmLabel="Run the agent"
            onCancel={() => setConfirmAgent(false)}
            onConfirm={() => {
              setConfirmAgent(false);
              void test();
            }}
          />
        </Section>
      ) : null}
    </>
  );
};
