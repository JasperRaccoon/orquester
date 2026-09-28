/**
 * The forms of the blocks that run something (workflows spec §4, §5.6, §7.2):
 * Code (a JavaScript module in the sandbox), Shell (a script, with values
 * passed only through environment variables) and HTTP (a request, templates
 * and secrets welcome).
 */

import React, { useState } from "react";
import { KeyRound, Maximize2 } from "lucide-react";

import {
  hasTemplate,
  WORKFLOW_LIMITS,
  type CodeBlockConfig,
  type HttpBlockConfig,
  type ShellBlockConfig
} from "@orquester/api";
import { HTTP_METHODS } from "@orquester/config";

import { Editor } from "../../files/Editor";
import { Dropdown, DropdownEmpty, DropdownItem, DropdownLabel, DropdownSeparator } from "../../ui/dropdown";
import { Modal, ModalCloseButton } from "../../ui/modal";
import { FullScreenEditor } from "../phone/FullScreenEditor";
import { usePhoneLayout } from "../phone/phone-context";
import {
  Field,
  KeyValueTable,
  NumberInput,
  Section,
  Segmented,
  SelectInput,
  SmallButton,
  TextInput,
  ToggleRow,
  type KeyValueRow
} from "../ui/controls";
import { FieldAnchor, useConfigSetter, useFieldMessages, useInspector } from "./inspector-context";
import { TemplateEditor } from "./TemplateEditor";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Insert `{{ secrets.NAME }}` into a field: a small menu of the workflow's secret names. */
export const SecretPicker: React.FC<{ onPick: (reference: string) => void }> = ({ onPick }) => {
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
  value: string;
  onChange: (value: string) => void;
}> = ({ open, onClose, title, filename, value, onChange }) => {
  const phone = usePhoneLayout();
  if (phone) {
    return (
      <FullScreenEditor open={open} onClose={onClose} title={title} subtitle={filename.endsWith(".sh") ? "bash" : "JavaScript module"} templates={false}>
        {() => <Editor filename={filename} value={value} onChange={onChange} />}
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
        <Editor filename={filename} value={value} onChange={onChange} />
      </div>
    </Modal>
  );
};

/** A bordered, fixed-height code editor with an Expand button. */
const CodeBox: React.FC<{
  filename: string;
  value: string;
  onChange: (value: string) => void;
  title: string;
  height?: number;
  invalid?: boolean;
}> = ({ filename, value, onChange, title, height = 260, invalid }) => {
  const [expanded, setExpanded] = useState(false);
  const phone = usePhoneLayout();
  if (phone) {
    // A phone edits code full screen, with the key bar; here, what it holds.
    const lines = value.split("\n");
    return (
      <div className="space-y-1.5">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label={`Edit ${title}`}
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
              <Maximize2 size={13} aria-hidden /> Edit
            </span>
          </span>
        </button>
        <CodeModal open={expanded} onClose={() => setExpanded(false)} title={title} filename={filename} value={value} onChange={onChange} />
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
        <Editor filename={filename} value={value} onChange={onChange} />
      </div>
      <div className="flex justify-end">
        <SmallButton variant="ghost" icon={<Maximize2 size={12} />} onClick={() => setExpanded(true)} className="h-6 px-1.5">
          Open larger
        </SmallButton>
      </div>
      <CodeModal open={expanded} onClose={() => setExpanded(false)} title={title} filename={filename} value={value} onChange={onChange} />
    </div>
  );
};

const ARGUMENTS: [string, string][] = [
  ["input", "the output of the block before this one"],
  ["nodes.<Name>.output", "any earlier block's output, by name"],
  ["trigger", "what started the run"],
  ["secrets.NAME", "a workflow secret"],
  ["log(…)", "write to this block's log"],
  ["stop(reason)", "end the run as stopped"]
];

export const CodeSettings: React.FC = () => {
  const { node } = useInspector();
  const setConfig = useConfigSetter<CodeBlockConfig>();
  const config = node.config as CodeBlockConfig;
  const source = useFieldMessages("config.source");
  const memory = useFieldMessages("config.memoryMb");
  return (
    <>
      <Section title="JavaScript">
        <FieldAnchor field="config.source" className="space-y-3">
          <Field label="Module" error={source.error} warning={source.warning} hint="The default export runs; its return value is the output. fetch is built in.">
            <CodeBox
              filename="block.mjs"
              title={`${node.name} — code`}
              value={config.source}
              onChange={(value) => setConfig({ source: value }, "source")}
              invalid={source.error !== null}
            />
          </Field>
          <div className="rounded-lg border border-neutral-800 bg-neutral-950/40 px-3 py-2.5">
            <div className="mb-1.5 text-[11px] font-medium text-neutral-400">The function receives</div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] leading-4">
              {ARGUMENTS.map(([name, text]) => (
                <React.Fragment key={name}>
                  <dt className="font-mono text-neutral-300">{name}</dt>
                  <dd className="text-neutral-500">{text}</dd>
                </React.Fragment>
              ))}
            </dl>
          </div>
        </FieldAnchor>
      </Section>
      <Section title="Limits" collapsible defaultOpen={false}>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Memory" error={memory.error}>
            <NumberInput
              value={config.memoryMb}
              onValue={(memoryMb) => setConfig({ memoryMb: memoryMb === undefined ? undefined : Math.round(memoryMb) }, "memory")}
              min={WORKFLOW_LIMITS.codeMemoryMb.min}
              max={WORKFLOW_LIMITS.codeMemoryMb.max}
              placeholder={String(WORKFLOW_LIMITS.codeMemoryMb.default)}
              suffix="MB"
              aria-label="Memory limit"
            />
          </Field>
          <Field label="Timeout">
            <NumberInput
              value={config.timeoutMinutes}
              onValue={(timeoutMinutes) => setConfig({ timeoutMinutes }, "timeout")}
              min={1}
              max={WORKFLOW_LIMITS.processTimeoutMinutes.max}
              placeholder={String(WORKFLOW_LIMITS.processTimeoutMinutes.default)}
              suffix="min"
              aria-label="Timeout"
            />
          </Field>
        </div>
      </Section>
    </>
  );
};

/** A single-line template value with a secret picker beside it. */
const TemplateValue: React.FC<{ value: string; onChange: (value: string) => void; ariaLabel: string; placeholder?: string }> = ({
  value,
  onChange,
  ariaLabel,
  placeholder
}) => {
  const { scope } = useInspector();
  return (
    <TemplateEditor value={value} onChange={onChange} scope={scope} ariaLabel={ariaLabel} placeholder={placeholder} monospace />
  );
};

export const ShellSettings: React.FC = () => {
  const { node } = useInspector();
  const setConfig = useConfigSetter<ShellBlockConfig>();
  const config = node.config as ShellBlockConfig;
  const scriptMessages = useFieldMessages("config.script");
  const templated = hasTemplate(config.script);
  const envRows: KeyValueRow[] = config.env;
  return (
    <>
      <Section title="Script" aside={<SelectInput value={config.shell} aria-label="Shell" onValue={(shell) => setConfig({ shell: shell as "bash" | "sh" }, "shell")} className="w-24"><option value="bash">bash</option><option value="sh">sh</option></SelectInput>}>
        <FieldAnchor field="config.script">
          <Field
            label="Runs in the project directory"
            error={
              templated
                ? "Scripts never contain {{ … }}. Map the value to an environment variable below and read \"$NAME\" instead."
                : scriptMessages.error
            }
            warning={scriptMessages.warning}
            hint="Exit code 0 is success. Output: { stdout, stderr, exitCode }."
          >
            <CodeBox
              filename="script.sh"
              title={`${node.name} — script`}
              value={config.script}
              onChange={(script) => setConfig({ script }, "script")}
              height={200}
              invalid={templated || scriptMessages.error !== null}
            />
          </Field>
        </FieldAnchor>
      </Section>
      <Section title="Environment" aside={<span className="text-[11px] text-neutral-500">the only way values reach the script</span>}>
        <FieldAnchor field="config.env">
          <KeyValueTable
            rows={envRows}
            onChange={(env) => setConfig({ env }, "env")}
            namePlaceholder="NAME"
            valuePlaceholder="{{ input.text }}"
            addLabel="Add a variable"
            emptyText="No variables yet."
            nameInvalid={(name) => (name && !ENV_NAME.test(name) ? "Letters, digits and _, not starting with a digit" : null)}
            renderValue={(row, index, update) => (
              <div className="flex items-start gap-1">
                <div className="min-w-0 flex-1">
                  <TemplateValue value={row.value} onChange={update} ariaLabel={`Value of ${row.name || `variable ${index + 1}`}`} />
                </div>
                <SecretPicker onPick={(reference) => update(row.value ? `${row.value}${reference}` : reference)} />
              </div>
            )}
          />
        </FieldAnchor>
      </Section>
      <Section title="Limits" collapsible defaultOpen={false}>
        <Field label="Timeout">
          <NumberInput
            value={config.timeoutMinutes}
            onValue={(timeoutMinutes) => setConfig({ timeoutMinutes }, "timeout")}
            min={1}
            max={WORKFLOW_LIMITS.processTimeoutMinutes.max}
            placeholder={String(WORKFLOW_LIMITS.processTimeoutMinutes.default)}
            suffix="min"
            className="w-32"
            aria-label="Timeout"
          />
        </Field>
      </Section>
    </>
  );
};

function statusesText(value: HttpBlockConfig["successStatuses"]): string {
  return value === "2xx" ? "" : value.join(", ");
}

function parseStatuses(text: string): number[] {
  return text
    .split(/[\s,]+/)
    .map((part) => Number(part))
    .filter((status) => Number.isInteger(status) && status >= 100 && status <= 599);
}

export const HttpSettings: React.FC = () => {
  const { node, scope } = useInspector();
  const setConfig = useConfigSetter<HttpBlockConfig>();
  const config = node.config as HttpBlockConfig;
  const url = useFieldMessages("config.url");
  const [statuses, setStatuses] = useState(() => statusesText(config.successStatuses));
  const bodyKind = config.body?.kind ?? "none";
  return (
    <>
      <Section title="Request">
        <FieldAnchor field="config.url">
          <Field label="URL" error={url.error} warning={url.warning} aside={<SecretPicker onPick={(reference) => setConfig({ url: `${config.url}${reference}` }, "url")} />}>
            <div className="flex items-start gap-1.5">
              <SelectInput value={config.method} aria-label="Method" onValue={(method) => setConfig({ method: method as HttpBlockConfig["method"] }, "method")} className="w-[92px] shrink-0">
                {HTTP_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {method}
                  </option>
                ))}
              </SelectInput>
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
          </Field>
        </FieldAnchor>
        <Field label="Query parameters">
          <KeyValueTable
            rows={config.query}
            onChange={(query) => setConfig({ query }, "query")}
            addLabel="Add a parameter"
            renderValue={(row, index, update) => <TemplateValue value={row.value} onChange={update} ariaLabel={`Value of ${row.name || `parameter ${index + 1}`}`} />}
          />
        </Field>
        <Field label="Headers">
          <KeyValueTable
            rows={config.headers}
            onChange={(headers) => setConfig({ headers }, "headers")}
            namePlaceholder="Header"
            addLabel="Add a header"
            renderValue={(row, index, update) => (
              <div className="flex items-start gap-1">
                <div className="min-w-0 flex-1">
                  <TemplateValue value={row.value} onChange={update} ariaLabel={`Value of ${row.name || `header ${index + 1}`}`} />
                </div>
                <SecretPicker onPick={(reference) => update(row.value ? `${row.value}${reference}` : reference)} />
              </div>
            )}
          />
        </Field>
      </Section>
      <Section title="Body">
        <FieldAnchor field="config.body" className="space-y-3">
          <Segmented
            label="Body"
            value={bodyKind}
            onChange={(kind) =>
              setConfig(
                (current) => {
                  const { body: _body, ...rest } = current;
                  if (kind === "none") return rest as HttpBlockConfig;
                  if (kind === "form") return { ...rest, body: { kind: "form", fields: [] } } as HttpBlockConfig;
                  const value = current.body && "value" in current.body ? current.body.value : "";
                  return { ...rest, body: kind === "json" ? { kind: "json", value: value || "{\n  \n}" } : { kind: "text", value } } as HttpBlockConfig;
                },
                "body-kind"
              )
            }
            options={[
              { id: "none", label: "None" },
              { id: "json", label: "JSON" },
              { id: "text", label: "Text" },
              { id: "form", label: "Form" }
            ]}
          />
          {config.body?.kind === "json" || config.body?.kind === "text" ? (
            <TemplateEditor
              value={config.body.value}
              onChange={(value) => setConfig((current) => ({ ...current, body: { ...(current.body as { kind: "json" | "text"; value: string }), value } }) as HttpBlockConfig, "body")}
              scope={scope}
              multiline
              monospace
              minHeight={120}
              ariaLabel="Request body"
              placeholder={config.body.kind === "json" ? '{ "text": {{ nodes.Review.output.text | json }} }' : ""}
            />
          ) : null}
          {config.body?.kind === "text" ? (
            <Field label="Content type">
              <TextInput
                value={config.body.contentType ?? ""}
                placeholder="text/plain"
                onValue={(contentType) =>
                  setConfig((current) => ({ ...current, body: { ...(current.body as { kind: "text"; value: string }), ...(contentType ? { contentType } : { contentType: undefined }) } }) as HttpBlockConfig, "content-type")
                }
              />
            </Field>
          ) : null}
          {config.body?.kind === "form" ? (
            <KeyValueTable
              rows={config.body.fields}
              onChange={(fields) => setConfig({ body: { kind: "form", fields } }, "form")}
              addLabel="Add a field"
              renderValue={(row, index, update) => <TemplateValue value={row.value} onChange={update} ariaLabel={`Value of ${row.name || `field ${index + 1}`}`} />}
            />
          ) : null}
        </FieldAnchor>
      </Section>
      <Section title="Response" collapsible defaultOpen={false}>
        <Field label="Succeeds on" hint="Any other status fails the block (its failure output runs, if wired).">
          <div className="space-y-2">
            <Segmented
              label="Success statuses"
              size="sm"
              value={config.successStatuses === "2xx" ? "2xx" : "list"}
              onChange={(kind) => {
                if (kind === "2xx") setConfig({ successStatuses: "2xx" }, "statuses");
                else {
                  const list = parseStatuses(statuses);
                  setConfig({ successStatuses: list.length > 0 ? list : [200] }, "statuses");
                  if (list.length === 0) setStatuses("200");
                }
              }}
              options={[
                { id: "2xx", label: "Any 2xx" },
                { id: "list", label: "These statuses" }
              ]}
            />
            {config.successStatuses !== "2xx" ? (
              <TextInput
                value={statuses}
                placeholder="200, 201, 404"
                aria-label="Success statuses"
                onValue={(text) => {
                  setStatuses(text);
                  const list = parseStatuses(text);
                  if (list.length > 0) setConfig({ successStatuses: list }, "statuses");
                }}
              />
            ) : null}
          </div>
        </Field>
        <ToggleRow checked={config.followRedirects} onChange={(followRedirects) => setConfig({ followRedirects }, "redirects")} label="Follow redirects" />
        <Field label="Timeout">
          <NumberInput
            value={config.timeoutSeconds}
            onValue={(timeoutSeconds) => setConfig({ timeoutSeconds }, "timeout")}
            min={1}
            max={WORKFLOW_LIMITS.httpTimeoutSeconds.max}
            placeholder={String(WORKFLOW_LIMITS.httpTimeoutSeconds.default)}
            suffix="s"
            className="w-32"
            aria-label="Timeout"
          />
        </Field>
      </Section>
    </>
  );
};
