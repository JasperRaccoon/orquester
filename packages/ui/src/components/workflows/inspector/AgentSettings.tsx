/**
 * The agent block's form (workflows spec §5.1, §7.2), four sections that
 * each say what they hold in one line when closed:
 *  - Prompt: written here with `{{ … }}` data and `{variables}`, or a saved
 *    prompt (previewed, variables marked) with an optional addition;
 *  - Chat: a new chat (optionally titled) or a follow-up in the chat an
 *    earlier agent block opened in the same run;
 *  - Who runs it: the choices, tried in order on usage limits (ChainEditor);
 *  - When no one is watching: the autonomy note, leftover background
 *    processes, running out of quota, and when to stop.
 * Every field validation can point at has its anchor and shows its own
 * messages.
 */

import React, { useMemo, useRef, useState } from "react";
import { Braces, Maximize2 } from "lucide-react";

import {
  isPromptVariableName,
  upstreamOf,
  WORKFLOW_LIMITS,
  WORKFLOW_SECRETS_GUIDE,
  type AgentBlockConfig,
  type AgentChainEntry
} from "@orquester/api";

import { cn } from "../../../lib/cn";
import { useProviderSnapshots } from "../../../lib/agent-chat/hooks";
import { providerForRefId } from "../../../lib/agent-chat/providers";
import { useSavedPrompts } from "../../../lib/saved-prompts/hooks";
import { defaultAgentLabel, defaultModelLabel } from "../../../lib/workflows/catalog-ui";
import { formatMinutes } from "../../../lib/workflows/durations";
import { guideItemText } from "../../../lib/workflows/guide-text";
import { useAppStore } from "../../../store/app";
import { Modal, ModalCloseButton } from "../../ui/modal";
import { FullScreenEditor } from "../phone/FullScreenEditor";
import { usePhoneLayout } from "../phone/phone-context";
import { Callout, DurationInput, Field, FOCUS_RING, RadioCards, Segmented, SelectInput, SmallButton, ToggleRow, useReadOnly, ViewButton } from "../ui/controls";
import { GuideText } from "../ui/GuideText";
import { ChainEditor } from "./ChainEditor";
import { ConfigField, FieldAnchor, InspectorSection, useConfigSetter, useFieldMessages, useInspector } from "./inspector-context";
import { TemplateEditor, type TemplateEditorHandle } from "./TemplateEditor";

/** What a secret in an agent prompt costs (the shared guide). */
const PROMPT_SECRET_GUIDE = guideItemText(WORKFLOW_SECRETS_GUIDE, "agent prompts");

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

/** The small ghost buttons beside a field's label. */
const ASIDE_BUTTON = "-mr-1 h-6 px-1.5 [.wf-touch_&]:h-9 [.wf-touch_&]:px-2.5";

/** "Insert data": types `{{  }}` into the editor and opens its completion list. */
const InsertDataButton: React.FC<{ editor: React.RefObject<TemplateEditorHandle | null> }> = ({ editor }) =>
  useReadOnly() ? null : (
  <SmallButton variant="ghost" icon={<Braces size={12} />} onClick={() => editor.current?.insertData()} className={ASIDE_BUTTON} title="Insert data from earlier blocks, the trigger or the run">
    Insert data
  </SmallButton>
  );

/** "Expand": the prompt in a large editor — a read-only form can still open it to read. */
const ExpandButton: React.FC<{ onClick: () => void; label: string }> = ({ onClick, label }) => (
  <ViewButton
    onClick={onClick}
    className={cn(
      "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md text-xs font-medium text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100",
      FOCUS_RING,
      ASIDE_BUTTON
    )}
  >
    <Maximize2 size={12} aria-hidden />
    {label}
  </ViewButton>
);

/** A saved prompt's body with its `{variables}` marked the way the editor marks them. */
const SavedPromptBody: React.FC<{ body: string }> = ({ body }) => {
  const parts: React.ReactNode[] = [];
  const pattern = /\{\{[A-Za-z][A-Za-z0-9]*\}\}|\{[A-Za-z][A-Za-z0-9]*\}/g;
  let last = 0;
  for (const match of body.matchAll(pattern)) {
    const text = match[0];
    const at = match.index ?? 0;
    // `{{name}}` is the escape for a literal `{name}`; only known names are variables.
    if (text.startsWith("{{") || !isPromptVariableName(text.slice(1, -1))) continue;
    parts.push(body.slice(last, at), <span key={at} className="cm-wf-var">{text}</span>);
    last = at + text.length;
  }
  parts.push(body.slice(last));
  return <>{parts}</>;
};

// ---------------------------------------------------------------------------
// Config edits. Each keeps what else the object holds (fields another app version wrote) when its
// kind stays the same, and starts it over only when the kind changes.
// ---------------------------------------------------------------------------

/** The prompt written here set to `text`. */
export function withPromptText(config: AgentBlockConfig, text: string): AgentBlockConfig {
  return { ...config, prompt: config.prompt.kind === "text" ? { ...config.prompt, text } : { kind: "text", text } };
}

/** A new chat titled `title` ("" = no title: the default). */
export function withChatTitle(config: AgentBlockConfig, title: string): AgentBlockConfig {
  const { title: _old, ...rest } = config.session.kind === "new" ? config.session : { kind: "new" as const };
  return { ...config, session: title ? { ...rest, kind: "new", title } : { ...rest, kind: "new" } };
}

/** Continue the chat of the block named `fromNode`. */
export function withContinueFrom(config: AgentBlockConfig, fromNode: string): AgentBlockConfig {
  return { ...config, session: config.session.kind === "continue" ? { ...config.session, fromNode } : { kind: "continue", fromNode } };
}

/** Wait for quota to refill, at most `maxWaitHours`. */
export function withMaxWaitHours(config: AgentBlockConfig, maxWaitHours: number): AgentBlockConfig {
  return {
    ...config,
    whenAllBurnt: config.whenAllBurnt.kind === "wait-for-reset" ? { ...config.whenAllBurnt, maxWaitHours } : { kind: "wait-for-reset", maxWaitHours }
  };
}

/**
 * A saved prompt as the text it runs as — the daemon's `promptSource`: the body, then a blank line
 * and the addition when it has any text — so "Write it here" starts from what was being sent.
 */
export function savedText(body: string, append: string | undefined): string {
  return append?.trim() ? `${body}\n\n${append}` : body;
}

/** Messages on exactly `field` (schema problems on a section's root), as lines. */
const RootMessages: React.FC<{ field: string }> = ({ field }) => {
  const { problems } = useInspector();
  const own = problems.filter((problem) => problem.field === field && problem.severity !== "info");
  if (own.length === 0) return null;
  return (
    <div className="space-y-0.5">
      {own.map((problem, index) => (
        <p key={index} className={problem.severity === "error" ? "text-[11px] leading-4 text-danger" : "text-[11px] leading-4 text-warn"}>
          {problem.message.replace(/^[A-Za-z][A-Za-z0-9_]*: /, "")}
        </p>
      ))}
    </div>
  );
};

const PromptSection: React.FC<{ config: AgentBlockConfig }> = ({ config }) => {
  const { node, projectPath, promptScope, problems } = useInspector();
  const setConfig = useConfigSetter<AgentBlockConfig>();
  const saved = useSavedPrompts(projectPath);
  const [expanded, setExpanded] = useState(false);
  const phoneLayout = usePhoneLayout();
  const textEditor = useRef<TemplateEditorHandle | null>(null);
  const readOnly = useReadOnly();
  const appendEditor = useRef<TemplateEditorHandle | null>(null);
  const textMessages = useFieldMessages("config.prompt.text");

  const prompt = config.prompt;
  const savedPrompt = prompt.kind === "saved" ? saved.prompts.find((candidate) => candidate.id === prompt.promptId) : undefined;
  const sortedPrompts = useMemo(
    () => [...saved.prompts].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.title.localeCompare(b.title)),
    [saved.prompts]
  );
  const unpicked = prompt.kind === "saved" && prompt.promptId === "unset";

  // The saved prompt's messages, in words ("unset" is the placeholder id of none picked).
  const promptIdMessages = { error: null as string | null, warning: null as string | null };
  for (const problem of problems.filter((candidate) => candidate.field === "config.prompt.promptId")) {
    const text =
      problem.code === "unknown_saved_prompt"
        ? unpicked
          ? "Pick a saved prompt."
          : "The saved prompt it used was deleted. Pick another one."
        : problem.message.replace(/^[A-Za-z][A-Za-z0-9_]*: /, "");
    if (problem.severity === "error") promptIdMessages.error ??= text;
    else if (problem.severity === "warning") promptIdMessages.warning ??= text;
  }

  const summary =
    prompt.kind === "text"
      ? prompt.text.trim().length === 0
        ? "Written here · empty"
        : `Written here · ${prompt.text.length.toLocaleString()} characters`
      : savedPrompt
        ? `Saved: ${savedPrompt.title}${prompt.append ? " + an addition" : ""}`
        : unpicked
          ? "Saved prompt · none picked"
          : saved.status === "loading"
            ? "Saved prompt"
            : "Saved prompt · deleted";

  const setText = (text: string): void =>
    setConfig((current) => withPromptText(current, text), "prompt-text");

  return (
    <InspectorSection title="Prompt" anchors={["config.prompt"]} summary={summary} defaultOpen sticky>
      <Segmented
        label="Where the prompt comes from"
        wrap
        value={prompt.kind}
        onChange={(kind) =>
          setConfig(
            {
              prompt:
                kind === "text"
                  ? { kind: "text", text: savedText(savedPrompt?.body ?? "", prompt.kind === "saved" ? prompt.append : undefined) }
                  : { kind: "saved", promptId: sortedPrompts[0]?.id ?? "unset" }
            },
            "prompt-kind"
          )
        }
        options={[
          { id: "text", label: "Write it here" },
          { id: "saved", label: "Use a saved prompt" }
        ]}
      />
      <RootMessages field="config.prompt" />
      {prompt.kind === "text" ? (
        <>
          <ConfigField
            path="config.prompt.text"
            label="Instructions"
            hint={
              <>
                Type <code className="text-neutral-400">{"{{"}</code> for data from earlier blocks, <code className="text-neutral-400">{"{"}</code> for a
                variable like {"{branch}"}.
              </>
            }
            help={
              <>
                <p>The agent works on its own: say what the task is and what done looks like.</p>
                <p>
                  <code>{"{{ … }}"}</code> puts in data when the block runs: an earlier block's output, the trigger, the run, the project, a secret.
                </p>
                <p>
                  <code>{"{branch}"}</code>, <code>{"{project}"}</code> and the other saved-prompt variables are filled in when the block starts.
                </p>
                {PROMPT_SECRET_GUIDE !== undefined ? (
                  <p>
                    <GuideText text={PROMPT_SECRET_GUIDE} />
                  </p>
                ) : null}
              </>
            }
            aside={
              <span className="flex items-center">
                <InsertDataButton editor={textEditor} />
                <ExpandButton onClick={() => setExpanded(true)} label={readOnly ? "View larger" : phoneLayout ? "Full screen" : "Expand"} />
              </span>
            }
          >
            <TemplateEditor
              ref={textEditor}
              value={prompt.text}
              onChange={setText}
              scope={promptScope}
              multiline
              minHeight={phoneLayout ? 120 : 140}
              maxHeight={phoneLayout ? 232 : 420}
              placeholder="Describe the task. The agent works alone — say what done looks like."
              ariaLabel="Agent prompt"
              invalid={textMessages.error !== null}
            />
          </ConfigField>
          <PromptEditorModal open={expanded} onClose={() => setExpanded(false)} value={prompt.text} onChange={setText} title={`${node.name} — prompt`} />
        </>
      ) : (
        <>
          {saved.status !== "loading" && sortedPrompts.length === 0 ? (
            <Callout
              tone="info"
              title="You have no saved prompts yet"
              action={
                <SmallButton onClick={() => setConfig({ prompt: { kind: "text", text: "" } }, "prompt-kind")}>Write it here instead</SmallButton>
              }
            >
              Save one from the Saved prompts panel in the side panel, then pick it here.
            </Callout>
          ) : null}
          <FieldAnchor field="config.prompt.promptId" className="space-y-2">
            <Field label="Saved prompt" error={promptIdMessages.error} warning={promptIdMessages.warning}>
              <SelectInput
                value={prompt.promptId}
                onValue={(promptId) =>
                  setConfig((current) => ({ ...current, prompt: { ...(current.prompt as { kind: "saved"; append?: string }), kind: "saved", promptId } }), "prompt-saved")
                }
              >
                {!savedPrompt ? (
                  <option value={prompt.promptId}>{saved.status === "loading" ? "Loading…" : unpicked ? "Pick a saved prompt" : "A deleted saved prompt"}</option>
                ) : null}
                {sortedPrompts.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.pinned ? "★ " : ""}
                    {candidate.title}
                    {candidate.projectPath ? " · this project" : ""}
                  </option>
                ))}
              </SelectInput>
            </Field>
            {savedPrompt ? (
              <div className="space-y-1">
                {savedPrompt.description ? <p className="text-[11px] leading-4 text-neutral-500">{savedPrompt.description}</p> : null}
                <div
                  className="wf-cm max-h-44 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-neutral-800 bg-neutral-950/50 px-3 py-2 text-[12px] leading-5 text-neutral-400"
                  aria-label={`What “${savedPrompt.title}” says`}
                >
                  <SavedPromptBody body={savedPrompt.body} />
                </div>
                <p className="text-[11px] leading-4 text-neutral-500">
                  Edit it in the Saved prompts panel. Variables like <span className="wf-cm"><span className="cm-wf-var">{"{branch}"}</span></span> are filled in when the block starts.
                </p>
              </div>
            ) : null}
          </FieldAnchor>
          <ConfigField
            path="config.prompt.append"
            label="Add to it"
            optional
            hint="Sent after the saved prompt — a good place for data from earlier blocks."
            aside={<InsertDataButton editor={appendEditor} />}
          >
            <TemplateEditor
              ref={appendEditor}
              value={prompt.append ?? ""}
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
              ariaLabel="Text added after the saved prompt"
            />
          </ConfigField>
        </>
      )}
    </InspectorSection>
  );
};

const ChatSection: React.FC<{ config: AgentBlockConfig }> = ({ config }) => {
  const { node, workflow, promptScope } = useInspector();
  const setConfig = useConfigSetter<AgentBlockConfig>();
  const titleEditor = useRef<TemplateEditorHandle | null>(null);
  const upstreamAgents = useMemo(() => {
    const upstream = upstreamOf(workflow, node.id);
    return workflow.nodes.filter((candidate) => candidate.type === "agent" && upstream.has(candidate.id));
  }, [workflow, node.id]);
  const session = config.session;
  // The daemon's own default when no title is set (`sessionTitle`).
  const defaultTitle = `${workflow.name} · ${node.name}`;
  const fromKnown = session.kind === "continue" && upstreamAgents.some((agent) => agent.name === session.fromNode);

  const summary =
    session.kind === "new"
      ? session.title
        ? `New chat · “${session.title}”`
        : "New chat"
      : session.fromNode
        ? `Continues ${session.fromNode}'s chat`
        : "Continues an earlier chat";

  return (
    <InspectorSection title="Chat" anchors={["config.session"]} summary={summary} sticky>
      <RootMessages field="config.session" />
      <RadioCards<"new" | "continue">
        ariaLabel="Chat"
        value={session.kind}
        onValue={(kind) => {
          if (kind === session.kind) return;
          setConfig({ session: kind === "new" ? { kind: "new" } : { kind: "continue", fromNode: upstreamAgents[0]?.name ?? "" } }, "session-kind");
        }}
        options={[
          {
            value: "new",
            label: "Start a new chat",
            description: "Opens a fresh agent chat for this run.",
            children: (
              <ConfigField
                path="config.session.title"
                label="Chat title"
                optional
                hint="Shown on the chat's tab. Data from earlier blocks works here; a secret shows as «secret:NAME», never its value."
                defaultNote={defaultTitle}
                aside={<InsertDataButton editor={titleEditor} />}
              >
                <TemplateEditor
                  ref={titleEditor}
                  value={session.kind === "new" ? (session.title ?? "") : ""}
                  onChange={(title) => setConfig((current) => withChatTitle(current, title), "session-title")}
                  scope={promptScope}
                  placeholder={defaultTitle}
                  ariaLabel="Chat title"
                />
              </ConfigField>
            )
          },
          {
            value: "continue",
            label: "Continue an earlier agent's chat",
            description: "Sends this prompt as a follow-up in the chat an earlier agent block opened in this run, so the agent keeps what it already knows.",
            disabled: upstreamAgents.length === 0 && session.kind !== "continue",
            disabledReason: "No agent block runs before this one.",
            children:
              session.kind === "continue" ? (
                <ConfigField path="config.session.fromNode" label="Whose chat" hint="If that block didn't succeed in this run, this one fails.">
                  <SelectInput value={session.fromNode} onValue={(fromNode) => setConfig((current) => withContinueFrom(current, fromNode), "session-from")}>
                    {!fromKnown ? <option value={session.fromNode}>{session.fromNode ? `${session.fromNode} (not an earlier agent block)` : "Pick a block"}</option> : null}
                    {upstreamAgents.map((agent) => (
                      <option key={agent.id} value={agent.name}>
                        {agent.name}
                      </option>
                    ))}
                  </SelectInput>
                </ConfigField>
              ) : null
          }
        ]}
      />
    </InspectorSection>
  );
};

const WhoRunsSection: React.FC<{ config: AgentBlockConfig }> = ({ config }) => {
  const { projectPath } = useInspector();
  const setConfig = useConfigSetter<AgentBlockConfig>();
  const agents = useAppStore((state) => state.registry.agents);
  const providers = useProviderSnapshots();
  const first = config.chain[0];
  const agentLabel = (id: string): string => agents.find((agent) => agent.id === id)?.name || defaultAgentLabel(id);
  const modelLabel = (agent: string, slug: string): string => {
    const model = providerForRefId(providers, agent)?.models.find((candidate) => candidate.slug === slug);
    return model ? (model.shortName ?? model.name) : defaultModelLabel(slug);
  };
  const fallbacks = config.chain.length - 1;
  const summary = first
    ? `${agentLabel(first.agent)} · ${modelLabel(first.agent, first.model)}${fallbacks > 0 ? ` + ${fallbacks} fallback${fallbacks === 1 ? "" : "s"}` : ""}`
    : "No agent chosen";
  return (
    <InspectorSection
      title="Who runs it"
      anchors={["config.chain"]}
      summary={summary}
      description="It runs on the first choice with an account that can run now. If that account hits a usage limit mid-task, it moves to another account of the same choice in the same chat; when none is left, the next choice takes over in a new chat."
      defaultOpen
      sticky
    >
      {config.session.kind === "continue" ? (
        <Callout tone="info">
          While it continues {config.session.fromNode ? `${config.session.fromNode}'s` : "an earlier"} chat, it runs on that chat's agent, model and account, and
          on a usage limit it falls back along {config.session.fromNode ? `${config.session.fromNode}'s` : "that block's"} choices — not these.
        </Callout>
      ) : null}
      <FieldAnchor field="config.chain">
        <ChainEditor chain={config.chain} onChange={(chain: AgentChainEntry[]) => setConfig({ chain }, "chain")} projectPath={projectPath} />
      </FieldAnchor>
    </InspectorSection>
  );
};

const UnattendedSection: React.FC<{ config: AgentBlockConfig }> = ({ config }) => {
  const setConfig = useConfigSetter<AgentBlockConfig>();
  const maxMinutesMessages = useFieldMessages("config.maxMinutes");
  const burnt = config.whenAllBurnt;

  const summary = [
    config.autonomyNote ? "Told no one will reply" : "Not told it's alone",
    `stops after ${formatMinutes(config.maxMinutes)}`,
    burnt.kind === "fail" ? "fails when out of quota" : `waits up to ${formatMinutes(burnt.maxWaitHours * 60)} for quota`,
    ...(config.whenOnlyWatchLoopsRemain === "wait" ? ["waits for leftover processes"] : [])
  ].join(" · ");

  return (
    <InspectorSection
      title="When no one is watching"
      anchors={["config.autonomyNote", "config.whenOnlyWatchLoopsRemain", "config.whenAllBurnt", "config.maxMinutes"]}
      summary={summary}
      sticky
    >
      <FieldAnchor field="config.autonomyNote" className="space-y-1">
        <ToggleRow
          checked={config.autonomyNote}
          onChange={(autonomyNote) => setConfig({ autonomyNote }, "autonomy")}
          label="Tell the agent no one will reply"
          description="Adds a line to the prompt: no one will answer, so it should decide on its own and finish the task. Questions it asks anyway get an automatic answer: the recommended (or first) option, or “choose yourself”."
        />
        <RootMessages field="config.autonomyNote" />
      </FieldAnchor>

      <ConfigField path="config.whenOnlyWatchLoopsRemain" label="If it finishes but leaves a process running">
        <Segmented
          label="If it finishes but leaves a process running"
          size="sm"
          wrap
          value={config.whenOnlyWatchLoopsRemain}
          onChange={(whenOnlyWatchLoopsRemain) => setConfig({ whenOnlyWatchLoopsRemain }, "watch")}
          options={[
            {
              id: "finish",
              label: "Treat it as done",
              description: "When only background processes are left — a dev server, a --watch build — it counts as done after a minute."
            },
            { id: "wait", label: "Keep waiting", description: "It waits until they end, or until “Stop after” runs out." }
          ]}
        />
      </ConfigField>

      <ConfigField path="config.whenAllBurnt" label="If every account is out of quota">
        <RadioCards<"fail" | "wait-for-reset">
          ariaLabel="If every account is out of quota"
          value={burnt.kind}
          onValue={(kind) => {
            if (kind === burnt.kind) return;
            setConfig({ whenAllBurnt: kind === "fail" ? { kind: "fail" } : { kind: "wait-for-reset", maxWaitHours: 6 } }, "burnt");
          }}
          options={[
            { value: "fail", label: "Fail this block", description: "It fails at once, listing every account it tried and why each was passed over." },
            {
              value: "wait-for-reset",
              label: "Wait for quota to refill",
              description: "It waits for the first account to free up, then carries on. Waiting doesn't count toward “Stop after”.",
              children:
                burnt.kind === "wait-for-reset" ? (
                  <FieldAnchor field="config.whenAllBurnt.maxWaitHours">
                    <Field label="Wait at most" hint="Counted from its first wait. It fails if no account frees up by then, or when no reset time is known.">
                      <DurationInput
                        value={burnt.maxWaitHours}
                        unit="hours"
                        units={["hours", "days"]}
                        min={1}
                        max={168}
                        ariaLabel="Wait at most"
                        onValue={(hours) => {
                          if (hours !== undefined) setConfig((current) => withMaxWaitHours(current, hours), "burnt-hours");
                        }}
                      />
                    </Field>
                  </FieldAnchor>
                ) : null
            }
          ]}
        />
      </ConfigField>

      <ConfigField
        path="config.maxMinutes"
        label="Stop after"
        help={
          <>
            <p>Counted from when the block starts; time spent waiting for quota to refill doesn't count.</p>
            <p>When it runs out, the agent is stopped and the block fails.</p>
          </>
        }
        defaultNote={formatMinutes(WORKFLOW_LIMITS.agentMaxMinutes.default)}
      >
        <DurationInput
          value={config.maxMinutes}
          unit="minutes"
          units={["minutes", "hours"]}
          min={1}
          max={WORKFLOW_LIMITS.agentMaxMinutes.max}
          ariaLabel="Stop after"
          invalid={maxMinutesMessages.error !== null}
          onValue={(minutes) => {
            if (minutes !== undefined) setConfig({ maxMinutes: Math.max(1, Math.round(minutes)) }, "max-minutes");
          }}
        />
      </ConfigField>
    </InspectorSection>
  );
};

export const AgentSettings: React.FC = () => {
  const { node } = useInspector();
  const config = node.config as AgentBlockConfig;
  return (
    <>
      <PromptSection config={config} />
      <ChatSection config={config} />
      <WhoRunsSection config={config} />
      <UnattendedSection config={config} />
    </>
  );
};
