/**
 * The forms of the blocks that run something (workflows spec §4, §5.6, §7.2):
 * Code (a JavaScript module in the sandbox), Shell (a script, with values
 * passed only through environment variables) and HTTP (a request, templates
 * and secrets welcome). Each section says what it holds while collapsed, and
 * every field validation can point at is anchored, so picking a problem opens
 * and focuses it.
 */

import React, { useId, useRef, useState } from "react";
import { KeyRound, Maximize2 } from "lucide-react";

import {
  hasTemplate,
  WORKFLOW_CODE_ARGUMENT_NAMES,
  WORKFLOW_CODE_ARGUMENTS,
  WORKFLOW_CODE_SIGNATURE,
  WORKFLOW_LIMITS,
  type CodeBlockConfig,
  type HttpBlockConfig,
  type ShellBlockConfig
} from "@orquester/api";
import { HTTP_METHODS } from "@orquester/config";

import { cn } from "../../../lib/cn";
import { nodeSummary } from "../../../lib/workflows/catalog-ui";
import { formatMinutes, formatSeconds } from "../../../lib/workflows/durations";
import { blockGuideSection, blockGuideSections, guideItemText } from "../../../lib/workflows/guide-text";
import {
  codeLimitsSummary,
  ENV_NAME_PATTERN,
  envRowProblem,
  formatMemoryMb,
  httpBodySummary,
  httpConfigWithBodyKind,
  httpRequestSummary,
  httpResponseSummary,
  httpTimeout,
  jsonBodyProblem,
  methodSendsBody,
  parseStatusList,
  planShellEnvVariables,
  processTimeout,
  requestRowProblem,
  shellLimitsSummary,
  statusListProblem,
  statusListText,
  successStatusesForMode,
  type HttpBodyKind
} from "../../../lib/workflows/process-settings";
import { Editor } from "../../files/Editor";
import { Dropdown, DropdownEmpty, DropdownItem, DropdownLabel, DropdownSeparator } from "../../ui/dropdown";
import { Modal, ModalCloseButton } from "../../ui/modal";
import { FullScreenEditor } from "../phone/FullScreenEditor";
import { usePhoneLayout } from "../phone/phone-context";
import {
  Callout,
  CopyChip,
  Disclosure,
  DurationInput,
  Field,
  KeyValueTable,
  NumberInput,
  ProblemBadge,
  Segmented,
  SelectInput,
  SmallButton,
  TextInput,
  FOCUS_RING,
  ToggleRow,
  useReadOnly,
  ViewButton,
  type KeyValueRow
} from "../ui/controls";
import { GuideItems, GuideSections, GuideText } from "../ui/GuideText";
import {
  ConfigField,
  fieldMessages,
  FieldAnchor,
  InspectorSection,
  useConfigSetter,
  useFieldMessages,
  useInspector,
  useRevealOpen,
  useSectionProblems
} from "./inspector-context";
import { TemplateEditor } from "./TemplateEditor";

/** Insert `{{ secrets.NAME }}` into a field: a small menu of the workflow's secret names. */
const SecretPicker: React.FC<{ onPick: (reference: string) => void }> = ({ onPick }) => {
  const { secretNames, openSecrets } = useInspector();
  return (
    <Dropdown
      align="right"
      width="w-56"
      ariaLabel="Insert a secret"
      triggerClassName="rounded-md"
      trigger={
        <span className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100">
          <KeyRound size={11} />
          Secret
        </span>
      }
    >
      <DropdownLabel>Insert a secret</DropdownLabel>
      {secretNames.length === 0 ? <DropdownEmpty>No secrets yet</DropdownEmpty> : null}
      {secretNames.map((name) => (
        <DropdownItem key={name} onClick={() => onPick(`{{ secrets.${name} }}`)}>
          <span className="font-mono text-[12px]">{name}</span>
        </DropdownItem>
      ))}
      <DropdownSeparator />
      <DropdownItem icon={<KeyRound size={13} />} onClick={openSecrets}>
        Manage secrets…
      </DropdownItem>
    </Dropdown>
  );
};

const CodeModal: React.FC<{
  open: boolean;
  onClose: () => void;
  title: string;
  filename: string;
  subtitle: string;
  value: string;
  onChange: (value: string) => void;
}> = ({ open, onClose, title, filename, subtitle, value, onChange }) => {
  const phone = usePhoneLayout();
  const readOnly = useReadOnly();
  if (phone) {
    return (
      <FullScreenEditor open={open} onClose={onClose} title={title} subtitle={subtitle} templates={false}>
        {() => <Editor filename={filename} value={value} onChange={onChange} readOnly={readOnly} />}
      </FullScreenEditor>
    );
  }
  return (
    <Modal open={open} onClose={onClose} className="h-[86vh] max-w-5xl flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 px-4">
        <div className="text-sm font-medium text-neutral-100">{title}</div>
        <ModalCloseButton onClose={onClose} />
      </div>
      <div className="min-h-0 flex-1" data-keyboard-surface="" onKeyDown={(event) => event.stopPropagation()}>
        <Editor filename={filename} value={value} onChange={onChange} readOnly={readOnly} />
      </div>
    </Modal>
  );
};

/**
 * A bordered, fixed-height code editor with an Expand button. On a read-only
 * workflow the code can still be read (and opened larger), not edited.
 */
const CodeBox: React.FC<{
  filename: string;
  value: string;
  onChange: (value: string) => void;
  title: string;
  /** What the code is, under the title of the full-screen editor ("JavaScript module", "bash"). */
  subtitle: string;
  height?: number;
  invalid?: boolean;
}> = ({ filename, value, onChange, title, subtitle, height = 260, invalid }) => {
  const [expanded, setExpanded] = useState(false);
  const phone = usePhoneLayout();
  const readOnly = useReadOnly();
  if (phone) {
    // A phone edits code full screen, with the key bar; here, what it holds.
    const lines = value.split("\n");
    return (
      <div className="space-y-1.5">
        <ViewButton
          onClick={() => setExpanded(true)}
          aria-label={`${readOnly ? "View" : "Edit"} ${title}`}
          className={
            "group relative block w-full overflow-hidden rounded-xl border bg-neutral-950/60 text-left " +
            (invalid ? "border-danger/60" : "border-neutral-800 active:border-neutral-600")
          }
        >
          <pre className="max-h-[168px] overflow-hidden px-3 py-2.5 font-mono text-[12px] leading-5 text-neutral-300">
            {value.trim() ? lines.slice(0, 8).join("\n") : <span className="text-neutral-600">Empty</span>}
          </pre>
          <span className="absolute inset-x-0 bottom-0 flex items-end justify-between bg-gradient-to-t from-neutral-950 via-neutral-950/90 to-transparent px-3 pb-2 pt-6">
            <span className="text-[11.5px] text-neutral-500">{lines.length} {lines.length === 1 ? "line" : "lines"}</span>
            <span className="inline-flex h-9 items-center gap-1.5 rounded-full bg-neutral-100 px-3.5 text-[13px] font-semibold text-neutral-900">
              <Maximize2 size={13} aria-hidden /> {readOnly ? "View" : "Edit"}
            </span>
          </span>
        </ViewButton>
        <CodeModal open={expanded} onClose={() => setExpanded(false)} title={title} filename={filename} subtitle={subtitle} value={value} onChange={onChange} />
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <div
        className={
          invalid
            ? "overflow-hidden rounded-md border border-danger/60"
            : "overflow-hidden rounded-md border border-neutral-800 focus-within:border-neutral-600"
        }
        style={{ height }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <Editor filename={filename} value={value} onChange={onChange} readOnly={readOnly} />
      </div>
      <div className="flex justify-end">
        {/* Only a bigger view: it works on a read-only workflow too. */}
        <ViewButton
          onClick={() => setExpanded(true)}
          className={cn(
            "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs font-medium text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100",
            FOCUS_RING
          )}
        >
          <Maximize2 size={12} aria-hidden />
          Open larger
        </ViewButton>
      </div>
      <CodeModal open={expanded} onClose={() => setExpanded(false)} title={title} filename={filename} subtitle={subtitle} value={value} onChange={onChange} />
    </div>
  );
};


const CODE_EXAMPLE = "export default async function ({ input, nodes, log }) {\n  log(\"got\", input);\n  return { count: input.items.length };\n}";

const HELP_BOX = "rounded-lg border border-neutral-800 bg-neutral-950/40 px-3 py-2.5 text-[11px] leading-4 text-neutral-400";

/** What a Code block's default export is called with: the signature, each argument (the shared guide) and an example. */
const CodeArgumentsHelp: React.FC = () => (
  <div className={HELP_BOX}>
    <CopyChip text={WORKFLOW_CODE_SIGNATURE} label="Copy the function signature" className="text-[11px]" />
    <GuideItems
      className="mt-2.5"
      items={WORKFLOW_CODE_ARGUMENT_NAMES.map((name) => ({ term: name, text: WORKFLOW_CODE_ARGUMENTS[name] }))}
    />
    <p className="mt-2.5 text-neutral-500">For example:</p>
    <pre className="mt-1 overflow-x-auto whitespace-pre font-mono text-[11px] leading-4 text-neutral-300">{CODE_EXAMPLE}</pre>
  </div>
);

/** How a Code block runs, what its result becomes and its limits (the shared guide, minus the arguments). */
const CodeRuntimeHelp: React.FC = () => (
  <div className={HELP_BOX}>
    <GuideSections sections={blockGuideSections("code", "Runtime", "Result", "Limits")} />
  </div>
);

/** The timeout's default note: the block-wide timeout when that is what applies, else the type's default. */
function timeoutDefaultNote(source: "config" | "node" | "default", nodeMinutes: number | undefined, fallback: string): React.ReactNode {
  return source === "node" && nodeMinutes !== undefined
    ? `${formatMinutes(nodeMinutes)} (the block timeout set under Run behaviour)`
    : fallback;
}

export const CodeSettings: React.FC = () => {
  const { node } = useInspector();
  const setConfig = useConfigSetter<CodeBlockConfig>();
  const config = node.config as CodeBlockConfig;
  const source = useFieldMessages("config.source");
  const memory = useFieldMessages("config.memoryMb");
  const timeout = useFieldMessages("config.timeoutMinutes");
  const effective = processTimeout(config.timeoutMinutes, node.timeoutMinutes);
  return (
    <>
      <InspectorSection title="JavaScript" anchors={["config.source"]} defaultOpen summary={nodeSummary(node)}>
        <ConfigField
          path="config.source"
          label="Module"
          hint="Its default export runs; what it returns is this block's output. fetch is built in."
        >
          <CodeBox
            filename="block.mjs"
            title={`${node.name} — code`}
            subtitle="JavaScript module"
            value={config.source}
            onChange={(value) => setConfig({ source: value }, "source")}
            invalid={source.error !== null}
          />
        </ConfigField>
        <Disclosure label="What the function receives">
          <CodeArgumentsHelp />
        </Disclosure>
        <Disclosure label="How it runs, its result and limits">
          <CodeRuntimeHelp />
        </Disclosure>
      </InspectorSection>
      <InspectorSection title="Limits" anchors={["config.memoryMb", "config.timeoutMinutes"]} summary={codeLimitsSummary(config, node.timeoutMinutes)}>
        <ConfigField
          path="config.memoryMb"
          label="Memory"
          hint={`The most memory the code's JavaScript may use, ${formatMemoryMb(WORKFLOW_LIMITS.codeMemoryMb.min)} – ${formatMemoryMb(WORKFLOW_LIMITS.codeMemoryMb.max)}${config.memoryMb !== undefined && config.memoryMb >= 1024 ? ` (now ${formatMemoryMb(config.memoryMb)})` : ""}`}
          defaultNote={`${WORKFLOW_LIMITS.codeMemoryMb.default} MB (${formatMemoryMb(WORKFLOW_LIMITS.codeMemoryMb.default)})`}
        >
          <NumberInput
            value={config.memoryMb}
            onValue={(memoryMb) => setConfig({ memoryMb: memoryMb === undefined ? undefined : Math.round(memoryMb) }, "memory")}
            min={WORKFLOW_LIMITS.codeMemoryMb.min}
            max={WORKFLOW_LIMITS.codeMemoryMb.max}
            placeholder={String(WORKFLOW_LIMITS.codeMemoryMb.default)}
            suffix="MB"
            invalid={memory.error !== null}
            className="w-36"
            aria-label="Memory limit"
          />
        </ConfigField>
        <ConfigField
          path="config.timeoutMinutes"
          label="Timeout"
          hint="The block fails if the code runs longer"
          defaultNote={timeoutDefaultNote(effective.source, node.timeoutMinutes, formatMinutes(WORKFLOW_LIMITS.processTimeoutMinutes.default))}
        >
          <DurationInput
            value={config.timeoutMinutes}
            unit="minutes"
            units={["minutes", "hours"]}
            onValue={(timeoutMinutes) => setConfig({ timeoutMinutes }, "timeout")}
            min={1}
            max={WORKFLOW_LIMITS.processTimeoutMinutes.max}
            placeholder={String(WORKFLOW_LIMITS.processTimeoutMinutes.default)}
            invalid={timeout.error !== null}
            ariaLabel="Timeout"
          />
        </ConfigField>
      </InspectorSection>
    </>
  );
};

/** A single-line template value with a secret picker beside it. */
const TemplateValue: React.FC<{ value: string; onChange: (value: string) => void; ariaLabel: string; placeholder?: string; invalid?: boolean }> = ({
  value,
  onChange,
  ariaLabel,
  placeholder,
  invalid
}) => {
  const { scope } = useInspector();
  return (
    <TemplateEditor value={value} onChange={onChange} scope={scope} ariaLabel={ariaLabel} placeholder={placeholder} invalid={invalid} monospace />
  );
};

/** A template value and the Secret menu, side by side; anchored so a problem on the row focuses it. */
const SecretValue: React.FC<{ field: string; value: string; onChange: (value: string) => void; ariaLabel: string; placeholder?: string; invalid?: boolean }> = ({
  field,
  value,
  onChange,
  ariaLabel,
  placeholder,
  invalid
}) => (
  <FieldAnchor field={field} className="flex items-start gap-1">
    <div className="min-w-0 flex-1">
      <TemplateValue value={value} onChange={onChange} ariaLabel={ariaLabel} placeholder={placeholder} invalid={invalid} />
    </div>
    <SecretPicker onPick={(reference) => onChange(value ? `${value}${reference}` : reference)} />
  </FieldAnchor>
);

/** The Commands help: how the script runs and what it outputs (the shared guide). */
const SHELL_HELP = blockGuideSections("shell", "Script", "Result");

const SHELL_TEMPLATE_ERROR = 'Scripts never contain {{ … }}. Put the value in a variable under Environment and read it as "$NAME" instead.';

/**
 * The way out of a script that holds `{{ … }}`: add each value as a variable under Environment in
 * one click, then show what to write in the script instead. The script itself is never rewritten —
 * only its author can tell where a value is read as data — so the error stays until they replace
 * each `{{ … }}`. Nothing to offer on a read-only workflow.
 */
const ShellEnvHelper: React.FC<{ config: ShellBlockConfig; onAdd: () => void }> = ({ config, onAdd }) => {
  const readOnly = useReadOnly();
  if (readOnly) return null;
  const plan = planShellEnvVariables(config.script, config.env);
  const pending = plan.variables.filter((variable) => variable.added).map((variable) => variable.name);
  const incomplete = plan.incomplete ? (
    <p>
      One {"{{ … }}"} in the script isn&apos;t complete — finish it, or remove it from the script.
    </p>
  ) : null;
  if (plan.variables.length === 0) {
    return (
      <Callout tone="info" title="Pass values as environment variables">
        <div className="space-y-1.5">
          <p>
            Add a variable under Environment — e.g. <code className="font-mono">VALUE</code> = <code className="font-mono">{"{{ input.x }}"}</code> — and
            read it in the script as <code className="font-mono">&quot;$VALUE&quot;</code>.
          </p>
          {incomplete}
        </div>
      </Callout>
    );
  }
  return (
    <Callout
      tone="info"
      title={pending.length > 0 ? "Pass the values as environment variables" : "Now replace each {{ … }} in the script with the variable shown"}
      action={
        pending.length > 0 ? (
          <SmallButton variant="solid" onClick={onAdd}>
            Add as environment variables
          </SmallButton>
        ) : null
      }
    >
      <div className="space-y-2">
        {pending.length > 0 ? (
          <p>
            Adds <span className="font-mono">{pending.join(", ")}</span> under Environment, each holding its {"{{ … }}"}. The script isn&apos;t
            changed: then replace each {"{{ … }}"} in it with the variable shown.
          </p>
        ) : (
          <p>Each value is under Environment. The script can&apos;t run while it still holds a {"{{ … }}"}.</p>
        )}
        <ul className="space-y-1">
          {plan.variables.map((variable) => (
            <li key={variable.name} className="flex flex-wrap items-center gap-1.5">
              <code className="min-w-0 break-all font-mono text-[11.5px] text-neutral-400">{variable.expression}</code>
              <span aria-hidden className="text-neutral-500">
                →
              </span>
              <CopyChip text={`"$${variable.name}"`} label={`Copy "$${variable.name}"`} />
              {variable.added ? <span className="text-[10.5px] text-neutral-500">new</span> : null}
            </li>
          ))}
        </ul>
        <p className="text-neutral-400">
          Quote it: <code className="font-mono">&quot;$NAME&quot;</code>. Don&apos;t put it inside &apos;…&apos;, eval, sh -c, printf&apos;s first argument,
          or arithmetic — pass it as a separate argument instead.
        </p>
        {incomplete}
      </div>
    </Callout>
  );
};

export const ShellSettings: React.FC = () => {
  const { node, problems } = useInspector();
  const setConfig = useConfigSetter<ShellBlockConfig>();
  const config = node.config as ShellBlockConfig;
  const script = useFieldMessages("config.script");
  const timeout = useFieldMessages("config.timeoutMinutes");
  const templated = hasTemplate(config.script);
  const envRows: KeyValueRow[] = config.env;
  const effective = processTimeout(config.timeoutMinutes, node.timeoutMinutes);
  const named = config.env.map((row) => row.name).filter((name) => name.length > 0);
  return (
    <>
      <InspectorSection
        title="Script"
        anchors={["config.script", "config.shell"]}
        defaultOpen
        summary={`${config.shell} · ${nodeSummary(node)}`}
        aside={
          <FieldAnchor field="config.shell" className="flex items-center gap-1.5">
            <span className="text-[11px] text-neutral-500" aria-hidden>
              Shell
            </span>
            <Segmented
              label="Shell"
              size="sm"
              value={config.shell}
              onChange={(shell) => {
                if (shell !== config.shell) setConfig({ shell }, "shell");
              }}
              options={[
                { id: "bash", label: "bash", title: "Bash (the default)" },
                { id: "sh", label: "sh", title: "POSIX sh — no bash-only features" }
              ]}
              className="w-[88px]"
            />
          </FieldAnchor>
        }
      >
        <FieldAnchor field="config.script" className="space-y-3">
          <Field
            label="Commands"
            error={script.error ?? (templated ? SHELL_TEMPLATE_ERROR : null)}
            warning={script.warning}
            hint="Runs in the project folder. Exit code 0 means success. Output: stdout, stderr, exitCode."
            help={<GuideSections sections={SHELL_HELP} />}
          >
            <CodeBox
              filename="script.sh"
              title={`${node.name} — script`}
              subtitle={config.shell}
              value={config.script}
              onChange={(value) => setConfig({ script: value }, "script")}
              height={200}
              invalid={templated || script.error !== null}
            />
          </Field>
          {templated ? (
            <ShellEnvHelper
              config={config}
              onAdd={() =>
                // One undo step; the script is left exactly as written.
                setConfig((current) => {
                  const plan = planShellEnvVariables(current.script, current.env);
                  return plan.variables.some((variable) => variable.added) ? { ...current, env: plan.env } : current;
                }, "add-env")
              }
            />
          ) : null}
        </FieldAnchor>
      </InspectorSection>
      <InspectorSection
        title="Environment"
        anchors={["config.env"]}
        defaultOpen
        description={
          <>
            Pass data into the script here — {"{{ … }}"} isn't allowed inside the script itself. Read a variable as{" "}
            <code className="font-mono text-neutral-400">"$NAME"</code>.
          </>
        }
        summary={config.env.length === 0 ? "No variables" : `${config.env.length} ${config.env.length === 1 ? "variable" : "variables"}${named.length > 0 ? ` · ${named.join(", ")}` : ""}`}
      >
        <FieldAnchor field="config.env">
          <KeyValueTable
            rows={envRows}
            onChange={(env) => setConfig({ env }, "env")}
            namePlaceholder="NAME"
            valuePlaceholder="{{ input.text }}"
            addLabel="Add a variable"
            emptyText="No variables yet."
            nameInvalid={(name) => (name && !ENV_NAME_PATTERN.test(name) ? "Letters, digits and _, not starting with a digit" : null)}
            rowMessage={(index) => {
              const local = envRowProblem(config.env, index);
              const validation = fieldMessages(problems, `config.env.${index}`);
              return { error: local.error ?? validation.error, warning: local.warning ?? validation.warning };
            }}
            renderValue={(row, index, update) => (
              <SecretValue
                field={`config.env.${index}`}
                value={row.value}
                onChange={update}
                ariaLabel={`Value of ${row.name || `variable ${index + 1}`}`}
                invalid={fieldMessages(problems, `config.env.${index}`).error !== null}
              />
            )}
          />
        </FieldAnchor>
      </InspectorSection>
      <InspectorSection title="Limits" anchors={["config.timeoutMinutes"]} summary={shellLimitsSummary(config, node.timeoutMinutes)}>
        <ConfigField
          path="config.timeoutMinutes"
          label="Timeout"
          hint="The block fails if the script runs longer"
          help={<GuideSections sections={blockGuideSections("shell", "Limits")} />}
          defaultNote={timeoutDefaultNote(effective.source, node.timeoutMinutes, formatMinutes(WORKFLOW_LIMITS.processTimeoutMinutes.default))}
        >
          <DurationInput
            value={config.timeoutMinutes}
            unit="minutes"
            units={["minutes", "hours"]}
            onValue={(timeoutMinutes) => setConfig({ timeoutMinutes }, "timeout")}
            min={1}
            max={WORKFLOW_LIMITS.processTimeoutMinutes.max}
            placeholder={String(WORKFLOW_LIMITS.processTimeoutMinutes.default)}
            invalid={timeout.error !== null}
            ariaLabel="Timeout"
          />
        </ConfigField>
      </InspectorSection>
    </>
  );
};

/** "2 — page, limit" / "none": what a collapsed row list holds. */
function rowsSummary(rows: readonly KeyValueRow[]): string {
  if (rows.length === 0) return "none";
  const names = rows.map((row) => row.name).filter((name) => name.length > 0);
  return names.length > 0 ? `${rows.length} — ${names.join(", ")}` : String(rows.length);
}

/** Query parameters or headers: a Disclosure with the count, opened by a problem in it. */
const RequestRows: React.FC<{
  kind: "query" | "header";
  rows: readonly KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
}> = ({ kind, rows, onChange }) => {
  const { problems } = useInspector();
  const field = kind === "query" ? "config.query" : "config.headers";
  const [open, setOpen] = useRevealOpen([field], rows.length > 0);
  const counts = useSectionProblems([field]);
  const what = kind === "query" ? "parameter" : "header";
  return (
    <FieldAnchor field={field}>
      <Disclosure
        label={
          <span className="inline-flex items-center gap-1.5">
            {kind === "query" ? "Query parameters" : "Headers"}
            <ProblemBadge problems={counts} />
          </span>
        }
        summary={rowsSummary(rows)}
        open={open}
        onOpenChange={setOpen}
      >
        {kind === "header" ? (
          <p className="text-[11px] leading-4 text-neutral-500">
            Content-Type is set from the body unless you set it here. Use Secret to insert a token without writing it down.
          </p>
        ) : (
          <p className="text-[11px] leading-4 text-neutral-500">Added to the URL, encoded for you.</p>
        )}
        <KeyValueTable
          rows={rows}
          onChange={onChange}
          namePlaceholder={kind === "query" ? "Name" : "Header"}
          addLabel={`Add a ${what}`}
          rowMessage={(index) => {
            const local = requestRowProblem(rows, index, kind);
            const validation = fieldMessages(problems, `${field}.${index}`);
            return { error: local.error ?? validation.error, warning: local.warning ?? validation.warning };
          }}
          nameInvalid={(name) => requestRowProblem([{ name, value: "" }], 0, kind).error}
          renderValue={(row, index, update) =>
            kind === "header" ? (
              <SecretValue
                field={`${field}.${index}`}
                value={row.value}
                onChange={update}
                ariaLabel={`Value of ${row.name || `header ${index + 1}`}`}
                invalid={fieldMessages(problems, `${field}.${index}`).error !== null}
              />
            ) : (
              <FieldAnchor field={`${field}.${index}`}>
                <TemplateValue
                  value={row.value}
                  onChange={update}
                  ariaLabel={`Value of ${row.name || `parameter ${index + 1}`}`}
                  invalid={fieldMessages(problems, `${field}.${index}`).error !== null}
                />
              </FieldAnchor>
            )
          }
        />
      </Disclosure>
    </FieldAnchor>
  );
};

/** The HTTP guide's `body` fact (the Request section), for the JSON body's help. */
const HTTP_BODY_GUIDE = guideItemText(blockGuideSection("http", "Request")?.items ?? [], "body");

const JSON_BODY_HELP = (
  <>
    <p>Put a value in as {"{{ … | json }}"} (no quotes around it): the filter writes it as JSON, so text with quotes or line breaks can't break the body.</p>
    {HTTP_BODY_GUIDE !== undefined ? (
      <p>
        <GuideText text={HTTP_BODY_GUIDE} />
      </p>
    ) : null}
    <p>If the filled-in text isn't valid JSON, the block fails without sending.</p>
  </>
);

type BodyKind = HttpBodyKind;

const BODY_OPTIONS: { id: BodyKind; label: string; description: string }[] = [
  { id: "none", label: "None", description: "Nothing is sent." },
  { id: "json", label: "JSON", description: "Sent as application/json." },
  { id: "text", label: "Text", description: "Sent as written, with the content type below." },
  { id: "form", label: "Form", description: "Sent URL-encoded, like an HTML form (application/x-www-form-urlencoded)." }
];

/** The success-status list, typed freely: shows what was typed while it still stands for the stored list, else the stored list (undo, redo). */
const StatusList: React.FC<{ config: HttpBlockConfig; onStatuses: (statuses: number[]) => void }> = ({ config, onStatuses }) => {
  const stored = config.successStatuses === "2xx" ? "2xx" : statusListText(config.successStatuses);
  const [draft, setDraft] = useState<{ text: string; basis: string } | null>(null);
  const text = draft !== null && draft.basis === stored ? draft.text : stored === "2xx" ? "" : stored;
  const problem = statusListProblem(text);
  return (
    <Field label="Statuses" error={problem} hint="Separate them with commas, e.g. 200, 201, 404.">
      <TextInput
        value={text}
        placeholder="200, 201, 404"
        invalid={problem !== null}
        inputMode="numeric"
        onValue={(next) => {
          const { statuses } = parseStatusList(next);
          let basis = stored;
          if (statuses.length > 0 && statusListText(statuses) !== stored) {
            onStatuses(statuses);
            basis = statusListText(statuses);
          }
          setDraft({ text: next, basis });
        }}
      />
    </Field>
  );
};

export const HttpSettings: React.FC = () => {
  const { node, scope, problems } = useInspector();
  const setConfig = useConfigSetter<HttpBlockConfig>();
  const config = node.config as HttpBlockConfig;
  const url = useFieldMessages("config.url");
  const bodyValue = useFieldMessages("config.body.value");
  const timeout = useFieldMessages("config.timeoutSeconds");
  const statuses = useFieldMessages("config.successStatuses");
  const methodId = useId();
  // The latest explicit list, so switching to "Any 2xx" and back restores it.
  const lastList = useRef<number[]>([200]);
  if (config.successStatuses !== "2xx" && config.successStatuses.length > 0) lastList.current = config.successStatuses;
  const bodyKind: BodyKind = config.body?.kind ?? "none";
  const sends = methodSendsBody(config.method);
  const effectiveTimeout = httpTimeout(config.timeoutSeconds, node.timeoutMinutes);
  const jsonProblem = config.body?.kind === "json" && bodyValue.error === null ? jsonBodyProblem(config.body.value) : null;
  const httpNode = node as Extract<typeof node, { type: "http" }>;
  return (
    <>
      <InspectorSection
        title="Request"
        anchors={["config.method", "config.url", "config.query", "config.headers"]}
        defaultOpen
        summary={httpRequestSummary(httpNode)}
      >
        <ConfigField
          path="config.url"
          label="URL"
          hint="Starts with http:// or https://. {{ … }} and secrets work anywhere in it."
          help={<GuideItems items={(blockGuideSection("http", "Request")?.items ?? []).filter((item) => item.term !== "body")} />}
          aside={<SecretPicker onPick={(reference) => setConfig({ url: `${config.url}${reference}` }, "url")} />}
        >
          <div className="flex items-start gap-1.5">
            <FieldAnchor field="config.method" className="w-[92px] shrink-0">
              <SelectInput
                id={methodId}
                value={config.method}
                aria-label="Method"
                onValue={(method) => setConfig({ method: method as HttpBlockConfig["method"] }, "method")}
              >
                {HTTP_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {method}
                  </option>
                ))}
              </SelectInput>
            </FieldAnchor>
            <div className="min-w-0 flex-1">
              <TemplateEditor
                value={config.url}
                onChange={(value) => setConfig({ url: value }, "url")}
                scope={scope}
                placeholder="https://api.example.com/items"
                ariaLabel="URL"
                monospace
                invalid={url.error !== null}
              />
            </div>
          </div>
        </ConfigField>
        <RequestRows kind="query" rows={config.query} onChange={(query) => setConfig({ query }, "query")} />
        <RequestRows kind="header" rows={config.headers} onChange={(headers) => setConfig({ headers }, "headers")} />
      </InspectorSection>
      <InspectorSection title="Body" anchors={["config.body"]} defaultOpen={sends} summary={httpBodySummary(config)}>
        {!sends ? (
          <Callout tone={config.body ? "warn" : "info"}>
            {config.method} requests send no body{config.body ? ", so this one is ignored" : ""}. Switch the method to POST, PUT, PATCH or DELETE to send one.
          </Callout>
        ) : null}
        <FieldAnchor field="config.body" className="space-y-3">
          <Segmented
            label="Body"
            value={bodyKind}
            onChange={(kind) => {
              // Picking the kind already chosen changes nothing (it must not empty a form or drop a content type).
              if (kind !== bodyKind) setConfig((current) => httpConfigWithBodyKind(current, kind), "body-kind");
            }}
            options={BODY_OPTIONS}
          />
          {config.body?.kind === "json" || config.body?.kind === "text" ? (
            <FieldAnchor field="config.body.value">
              <Field
                label={config.body.kind === "json" ? "JSON" : "Text"}
                help={config.body.kind === "json" ? JSON_BODY_HELP : undefined}
                error={bodyValue.error}
                warning={bodyValue.warning ?? jsonProblem}
                hint={config.body.kind === "json" ? "Write values as {{ … | json }}." : undefined}
              >
                <TemplateEditor
                  value={config.body.value}
                  onChange={(value) => setConfig((current) => ({ ...current, body: { ...(current.body as { kind: "json" | "text"; value: string }), value } }) as HttpBlockConfig, "body")}
                  scope={scope}
                  multiline
                  monospace
                  minHeight={120}
                  ariaLabel="Request body"
                  invalid={bodyValue.error !== null}
                  placeholder={config.body.kind === "json" ? '{ "text": {{ nodes.Review.output.text | json }} }' : ""}
                />
              </Field>
            </FieldAnchor>
          ) : null}
          {config.body?.kind === "text" ? (
            <Field label="Content type" optional defaultNote="text/plain; charset=utf-8" hint="A Content-Type header wins over this">
              <TextInput
                value={config.body.contentType ?? ""}
                placeholder="text/plain"
                onValue={(contentType) =>
                  setConfig((current) => {
                    const { contentType: _previous, ...body } = current.body as { kind: "text"; value: string; contentType?: string };
                    return { ...current, body: contentType ? { ...body, contentType } : body } as HttpBlockConfig;
                  }, "content-type")
                }
              />
            </Field>
          ) : null}
          {config.body?.kind === "form" ? (
            <FieldAnchor field="config.body.fields">
              <Field label="Fields">
                <KeyValueTable
                  rows={config.body.fields}
                  onChange={(fields) =>
                    setConfig((current) => ({ ...current, body: { ...(current.body as { kind: "form"; fields: KeyValueRow[] }), fields } }) as HttpBlockConfig, "form")
                  }
                  addLabel="Add a field"
                  emptyText="No fields yet."
                  rowMessage={(index) => {
                    const fields = (config.body as { fields: KeyValueRow[] }).fields;
                    const local = requestRowProblem(fields, index, "query");
                    const validation = fieldMessages(problems, `config.body.fields.${index}`);
                    return { error: local.error ?? validation.error, warning: local.warning ?? validation.warning };
                  }}
                  renderValue={(row, index, update) => (
                    <FieldAnchor field={`config.body.fields.${index}`}>
                      <TemplateValue
                        value={row.value}
                        onChange={update}
                        ariaLabel={`Value of ${row.name || `field ${index + 1}`}`}
                        invalid={fieldMessages(problems, `config.body.fields.${index}`).error !== null}
                      />
                    </FieldAnchor>
                  )}
                />
              </Field>
            </FieldAnchor>
          ) : null}
        </FieldAnchor>
      </InspectorSection>
      <InspectorSection
        title="Response"
        anchors={["config.successStatuses", "config.followRedirects", "config.timeoutSeconds"]}
        summary={httpResponseSummary(config, node.timeoutMinutes)}
      >
        <FieldAnchor field="config.successStatuses" className="space-y-3">
          <Field
            label="Succeeds on"
            error={statuses.error}
            warning={statuses.warning}
            hint="Any other status fails the block; its failure output still gets the response."
            help={<GuideSections sections={blockGuideSections("http", "Response")} />}
          >
            <Segmented
              label="Success statuses"
              size="sm"
              value={config.successStatuses === "2xx" ? "2xx" : "list"}
              onChange={(kind) => {
                // Picking the option already chosen changes nothing (it must not reset an edited list).
                const next = successStatusesForMode(config.successStatuses, kind, lastList.current);
                if (next !== config.successStatuses) setConfig({ successStatuses: next }, "statuses");
              }}
              options={[
                { id: "2xx", label: "Any 2xx" },
                { id: "list", label: "Only these statuses" }
              ]}
            />
          </Field>
          {config.successStatuses !== "2xx" ? <StatusList config={config} onStatuses={(statuses) => setConfig({ successStatuses: statuses }, "statuses")} /> : null}
        </FieldAnchor>
        <FieldAnchor field="config.followRedirects">
          <ToggleRow
            checked={config.followRedirects}
            onChange={(followRedirects) => setConfig({ followRedirects }, "redirects")}
            label="Follow redirects"
            description={
              config.followRedirects
                ? "A redirect (3xx) is followed; the final answer is the response."
                : "A redirect (3xx) is the response itself — it fails the block unless its status is listed above."
            }
          />
        </FieldAnchor>
        <ConfigField
          path="config.timeoutSeconds"
          label="Timeout"
          hint="The block fails if the answer takes longer"
          help={<GuideSections sections={blockGuideSections("http", "Limits")} />}
          defaultNote={
            effectiveTimeout.source === "node" && node.timeoutMinutes !== undefined
              ? `${formatSeconds(effectiveTimeout.seconds)} (the block timeout set under Run behaviour)`
              : formatSeconds(WORKFLOW_LIMITS.httpTimeoutSeconds.default)
          }
        >
          <DurationInput
            value={config.timeoutSeconds}
            unit="seconds"
            units={["seconds", "minutes"]}
            onValue={(timeoutSeconds) => setConfig({ timeoutSeconds }, "timeout")}
            min={1}
            max={WORKFLOW_LIMITS.httpTimeoutSeconds.max}
            placeholder={String(WORKFLOW_LIMITS.httpTimeoutSeconds.default)}
            invalid={timeout.error !== null}
            ariaLabel="Timeout"
          />
        </ConfigField>
      </InspectorSection>
    </>
  );
};
