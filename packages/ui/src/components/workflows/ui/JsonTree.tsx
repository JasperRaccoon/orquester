/**
 * A collapsible JSON tree (the inspector's Data tab, the run inspector): keys,
 * typed values, item counts on collapsed branches, long strings clipped with
 * "show all", and a copy button for the whole value.
 */

import React, { useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";

import { cn } from "../../../lib/cn";

const STRING_CLIP = 280;

function Scalar({ value }: { value: unknown }): React.ReactElement {
  const [all, setAll] = useState(false);
  if (value === null) return <span className="text-neutral-500">null</span>;
  if (typeof value === "string") {
    const clipped = !all && value.length > STRING_CLIP;
    return (
      <span className="whitespace-pre-wrap break-words text-[rgb(var(--wf-http))]">
        "{clipped ? value.slice(0, STRING_CLIP) : value}"
        {clipped ? (
          <button type="button" onClick={() => setAll(true)} className="ml-1 font-sans text-[10.5px] text-neutral-500 underline-offset-2 hover:text-neutral-200 hover:underline">
            show all {value.length.toLocaleString()} characters
          </button>
        ) : null}
      </span>
    );
  }
  if (typeof value === "number") return <span className="text-[rgb(var(--wf-code))]">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="text-[rgb(var(--wf-agent))]">{String(value)}</span>;
  return <span className="text-neutral-400">{String(value)}</span>;
}

function Branch({ name, value, depth, defaultDepth }: { name: string | null; value: unknown; depth: number; defaultDepth: number }): React.ReactElement {
  const isArray = Array.isArray(value);
  const isObject = value !== null && typeof value === "object";
  const [open, setOpen] = useState(depth < defaultDepth);
  const key = name !== null ? <span className="text-neutral-300">{name}</span> : null;
  if (!isObject) {
    return (
      <div className="flex gap-1 py-px pl-[18px]">
        {key}
        {key ? <span className="text-neutral-600">:</span> : null}
        <Scalar value={value} />
      </div>
    );
  }
  const entries: [string, unknown][] = isArray
    ? (value as unknown[]).map((item, index) => [String(index), item])
    : Object.entries(value as Record<string, unknown>);
  const count = entries.length;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1 rounded py-px text-left hover:bg-neutral-800/40"
      >
        {open ? <ChevronDown size={12} className="shrink-0 text-neutral-500" /> : <ChevronRight size={12} className="shrink-0 text-neutral-500" />}
        {key}
        {key ? <span className="text-neutral-600">:</span> : null}
        <span className="text-neutral-500">
          {isArray ? "[" : "{"}
          {open ? "" : ` ${count} ${isArray ? (count === 1 ? "item" : "items") : count === 1 ? "key" : "keys"} `}
          {open ? "" : isArray ? "]" : "}"}
        </span>
      </button>
      {open ? (
        <div className="ml-[5px] border-l border-neutral-800 pl-2">
          {entries.length === 0 ? <div className="py-px pl-[18px] text-neutral-600">empty</div> : null}
          {entries.map(([childName, child]) => (
            <Branch key={childName} name={childName} value={child} depth={depth + 1} defaultDepth={defaultDepth} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export const JsonTree: React.FC<{ value: unknown; defaultDepth?: number; className?: string; label?: string }> = ({
  value,
  defaultDepth = 2,
  className,
  label
}) => {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    void navigator.clipboard
      ?.writeText(text ?? "")
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => undefined);
  };
  return (
    <div className={cn("relative rounded-lg border border-neutral-800 bg-neutral-950/50", className)}>
      <div className="flex h-8 items-center justify-between border-b border-neutral-800/80 pl-3 pr-1">
        <span className="text-[11px] font-medium text-neutral-400">{label ?? "JSON"}</span>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy as JSON"
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100"
        >
          {copied ? <Check size={11} className="text-ok" /> : <Copy size={11} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="max-h-[360px] overflow-auto px-2 py-2 font-mono text-[11.5px] leading-[18px]">
        <Branch name={null} value={value} depth={0} defaultDepth={defaultDepth} />
      </div>
    </div>
  );
};
