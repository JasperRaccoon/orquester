/**
 * The agent block's form (workflows spec §5.1, §7.2): its prompt — written
 * here with templates and `{variables}`, or a saved prompt with an optional
 * addition — the session it runs in, the fallback chain with account
 * policies, and how it behaves unattended.
 */

import React, { useMemo, useState } from "react";
import { Maximize2 } from "lucide-react";

import { upstreamOf, type AgentBlockConfig, type AgentChainEntry } from "@orquester/api";

import { useSavedPrompts } from "../../../lib/saved-prompts/hooks";
import { Modal, ModalCloseButton } from "../../ui/modal";
import { FullScreenEditor } from "../phone/FullScreenEditor";
import { usePhoneLayout } from "../phone/phone-context";
import { Field, NumberInput, Section, Segmented, SelectInput, SmallButton, ToggleRow } from "../ui/controls";
import { ChainEditor } from "./ChainEditor";
import { FieldAnchor, problemsAt, useConfigSetter, useFieldMessages, useInspector } from "./inspector-context";
import { TemplateEditor } from "./TemplateEditor";

const PromptEditorModal: React.FC<{
  open: boolean;
  onClose: () => void;
  value: string;
  onChange: (value: string) => void;
  title: string;
}> = ({ open, onClose, value, onChange, title }) => {
  const { promptScope } = useInspector();
  const phone = usePhoneLayout();
  if (phone) {
    // Full screen, the key bar over the keyboard (`{{`, braces, …).
    return (
      <FullScreenEditor open={open} onClose={onClose} title={title} subtitle="{{ for data from earlier blocks · {branch} and other variables">
        {(height) => (
          <TemplateEditor
            value={value}
            onChange={onChange}
            scope={promptScope}
            multiline
            minHeight={height}
            maxHeight={height}
            ariaLabel={title}
            autoFocus
            className="h-full"
          />
        )}
      </FullScreenEditor>
    );
  }
  return (
    <Modal open={open} onClose={onClose} className="h-[80vh] max-w-4xl flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 px-4">
        <div className="text-sm font-medium text-neutral-100">{title}</div>
        <ModalCloseButton onClose={onClose} />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-4" data-keyboard-surface="">
        <TemplateEditor
          value={value}
          onChange={onChange}
          scope={promptScope}
          multiline
          minHeight={420}
          maxHeight={2000}
          ariaLabel={title}
          autoFocus
          className="h-full"
        />
      </div>
    </Modal>
  );
};

export const AgentSettings: React.FC = () => {
  const { node, workflow, projectPath, promptScope, problems } = useInspector();
  const setConfig = useConfigSetter<AgentBlockConfig>();
  const config = node.config as AgentBlockConfig;
  const saved = useSavedPrompts(projectPath);
  const [expanded, setExpanded] = useState(false);
  const phoneLayout = usePhoneLayout();
  const promptMessages = useFieldMessages(config.prompt.kind === "text" ? "config.prompt.text" : "config.prompt");
  const sessionMessages = useFieldMessages("config.session");

  const upstreamAgents = useMemo(() => {
    const upstream = upstreamOf(workflow, node.id);
    return workflow.nodes.filter((candidate) => candidate.type === "agent" && upstream.has(candidate.id));
  }, [workflow, node.id]);

  const savedPrompt = config.prompt.kind === "saved" ? saved.prompts.find((prompt) => prompt.id === (config.prompt as { promptId: string }).promptId) : undefined;
  const sortedPrompts = useMemo(
    () => [...saved.prompts].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.title.localeCompare(b.title)),
    [saved.prompts]
  );

  const chainError = (index: number): string | null => {
    const found = problemsAt(problems, `config.chain.${index}`).find((problem) => problem.severity === "error");
    return found ? found.message.replace(/^[A-Za-z][A-Za-z0-9_]*: /, "") : null;
  };

  return (
    <>
      <Section title="Prompt">
        <Segmented
          label="Prompt source"
          value={config.prompt.kind}
          onChange={(kind) =>
            setConfig(
              {
                prompt:
                  kind === "text"
                    ? { kind: "text", text: savedPrompt?.body ?? "" }
                    : { kind: "saved", promptId: sortedPrompts[0]?.id ?? "unset" }
              },
              "prompt-kind"
            )
          }
          options={[
            { id: "text", label: "Write it here" },
            { id: "saved", label: "Saved prompt" }
          ]}
        />
        {config.prompt.kind === "text" ? (
          <FieldAnchor field="config.prompt.text">
            <Field
              label="Instructions"
              error={promptMessages.error}
              warning={promptMessages.warning}
              hint={
                <>
                  Type <code className="text-neutral-400">{"{{"}</code> for data from earlier blocks, or{" "}
                  <code className="text-neutral-400">{"{"}</code> for a variable like {"{branch}"}.
                </>
              }
              aside={
                <SmallButton variant="ghost" icon={<Maximize2 size={12} />} onClick={() => setExpanded(true)} className="-mr-1 h-6 px-1.5 [.wf-touch_&]:h-9 [.wf-touch_&]:px-2.5">
                  {phoneLayout ? "Full screen" : "Expand"}
                </SmallButton>
              }
            >
              <TemplateEditor
                value={config.prompt.text}
                onChange={(text) => setConfig({ prompt: { kind: "text", text } }, "prompt-text")}
                scope={promptScope}
                multiline
                minHeight={phoneLayout ? 120 : 140}
                maxHeight={phoneLayout ? 232 : 420}
                placeholder="Describe the task. The agent works alone — say what done looks like."
                ariaLabel="Agent prompt"
                invalid={promptMessages.error !== null}
              />
            </Field>
            <PromptEditorModal
              open={expanded}
              onClose={() => setExpanded(false)}
              value={config.prompt.text}
              onChange={(text) => setConfig({ prompt: { kind: "text", text } }, "prompt-text")}
              title={`${node.name} — prompt`}
            />
          </FieldAnchor>
        ) : (
          <FieldAnchor field="config.prompt" className="space-y-3">
            <Field label="Saved prompt" error={promptMessages.error} warning={promptMessages.warning}>
              <SelectInput
                value={config.prompt.promptId}
                aria-label="Saved prompt"
                onValue={(promptId) =>
                  setConfig((current) => ({ ...current, prompt: { ...(current.prompt as { kind: "saved"; append?: string }), kind: "saved", promptId } }), "prompt-saved")
                }
              >
                {!savedPrompt ? <option value={config.prompt.promptId}>{saved.status === "loading" ? "Loading…" : "Pick a saved prompt"}</option> : null}
                {sortedPrompts.map((prompt) => (
                  <option key={prompt.id} value={prompt.id}>
                    {prompt.pinned ? "★ " : ""}
                    {prompt.title}
                    {prompt.projectPath ? " · this project" : ""}
                  </option>
                ))}
              </SelectInput>
            </Field>
            {savedPrompt ? (
              <div className="max-h-44 overflow-y-auto whitespace-pre-wrap rounded-lg border border-neutral-800 bg-neutral-950/50 px-3 py-2 text-[12px] leading-5 text-neutral-400">
                {savedPrompt.body}
              </div>
            ) : null}
            <Field label="Add to it" hint="Appended after the saved prompt — a good place for {{ … }} data.">
              <TemplateEditor
                value={config.prompt.append ?? ""}
                onChange={(append) =>
                  setConfig(
                    (current) => ({
                      ...current,
                      prompt: { ...(current.prompt as { kind: "saved"; promptId: string }), kind: "saved", ...(append ? { append } : { append: undefined }) }
                    }),
                    "prompt-append"
                  )
                }
                scope={promptScope}
                multiline
                minHeight={72}
                ariaLabel="Text appended to the saved prompt"
              />
            </Field>
          </FieldAnchor>
        )}
      </Section>

      <Section title="Session">
        <FieldAnchor field="config.session" className="space-y-3">
          <Segmented
            label="Session"
            value={config.session.kind}
            onChange={(kind) =>
              setConfig(
                { session: kind === "new" ? { kind: "new" } : { kind: "continue", fromNode: upstreamAgents[0]?.name ?? "" } },
                "session-kind"
              )
            }
            options={[
              { id: "new", label: "New chat" },
              { id: "continue", label: "Continue a chat", disabled: upstreamAgents.length === 0, title: upstreamAgents.length === 0 ? "No agent block runs before this one" : undefined }
            ]}
          />
          {config.session.kind === "new" ? (
            <Field label="Chat title" hint="Shown on the chat tab it opens. Templates work here.">
              <TemplateEditor
                value={config.session.title ?? ""}
                onChange={(title) => setConfig({ session: title ? { kind: "new", title } : { kind: "new" } }, "session-title")}
                scope={promptScope}
                placeholder={node.name}
                ariaLabel="Chat title"
              />
            </Field>
          ) : (
            <Field label="Continue the chat of" error={sessionMessages.error} hint="This prompt is sent as a follow-up in that block's session.">
              <SelectInput value={config.session.fromNode} aria-label="Continue the chat of" onValue={(fromNode) => setConfig({ session: { kind: "continue", fromNode } }, "session-from")}>
                {upstreamAgents.every((agent) => agent.name !== (config.session as { fromNode: string }).fromNode) ? (
                  <option value={config.session.fromNode}>{config.session.fromNode || "Pick a block"}</option>
                ) : null}
                {upstreamAgents.map((agent) => (
                  <option key={agent.id} value={agent.name}>
                    {agent.name}
                  </option>
                ))}
              </SelectInput>
            </Field>
          )}
        </FieldAnchor>
      </Section>

      <Section title="Agents" aside={<span className="text-[11px] text-neutral-500">tried in order on usage limits</span>}>
        <FieldAnchor field="config.chain">
          <ChainEditor
            chain={config.chain}
            onChange={(chain: AgentChainEntry[]) => setConfig({ chain }, "chain")}
            projectPath={projectPath}
            errorAt={chainError}
          />
        </FieldAnchor>
      </Section>

      <Section title="Running unattended" collapsible defaultOpen={false}>
        <ToggleRow
          checked={config.autonomyNote}
          onChange={(autonomyNote) => setConfig({ autonomyNote }, "autonomy")}
          label="Tell the agent nobody will answer"
          description="Adds a note asking it to decide on its own and finish the task."
        />
        <Field label="When only background watchers are left" hint="A dev server or a watch loop the agent left running.">
          <Segmented
            label="When only watch loops remain"
            size="sm"
            value={config.whenOnlyWatchLoopsRemain}
            onChange={(whenOnlyWatchLoopsRemain) => setConfig({ whenOnlyWatchLoopsRemain }, "watch")}
            options={[
              { id: "finish", label: "Count it as done" },
              { id: "wait", label: "Keep waiting" }
            ]}
          />
        </Field>
        <Field label="When every account is out of quota">
          <div className="space-y-2">
            <Segmented
              label="When all accounts are burnt"
              size="sm"
              value={config.whenAllBurnt.kind}
              onChange={(kind) =>
                setConfig({ whenAllBurnt: kind === "fail" ? { kind: "fail" } : { kind: "wait-for-reset", maxWaitHours: 6 } }, "burnt")
              }
              options={[
                { id: "fail", label: "Fail the block" },
                { id: "wait-for-reset", label: "Wait for a reset" }
              ]}
            />
            {config.whenAllBurnt.kind === "wait-for-reset" ? (
              <div className="flex items-center gap-2 text-[12px] text-neutral-400">
                <span>for at most</span>
                <NumberInput
                  value={config.whenAllBurnt.maxWaitHours}
                  onValue={(hours) => setConfig({ whenAllBurnt: { kind: "wait-for-reset", maxWaitHours: hours ?? 6 } }, "burnt-hours")}
                  min={1}
                  max={168}
                  suffix="h"
                  className="w-24"
                  allowEmpty={false}
                  aria-label="Maximum hours to wait for a reset"
                />
              </div>
            ) : null}
          </div>
        </Field>
        <Field label="Give up after" hint="The agent is stopped and the block fails past this.">
          <NumberInput
            value={config.maxMinutes}
            onValue={(maxMinutes) => setConfig({ maxMinutes: Math.round(maxMinutes ?? 240) }, "max-minutes")}
            min={1}
            max={1440}
            suffix="min"
            className="w-32"
            allowEmpty={false}
            aria-label="Maximum minutes"
          />
        </Field>
      </Section>
    </>
  );
};
