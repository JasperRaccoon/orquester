/**
 * An Orquester approval card's preview (unified MCP §7.1, §7.3): every section the daemon composed,
 * rendered as PLAIN TEXT — never markdown, never HTML. The sections reached here through
 * `parseToolApprovalSummary`, so titles and labels are single-line with bidi/control/zero-width
 * characters stripped, prose has them stripped, and code/diff text shows them as visible
 * `<U+202E>` escapes.
 *
 * **Complete, never silently cut (MUST 5).** A long section is clamped to a few lines with a
 * per-section "View all"; a section the summary had to cut (`partial`), or a card whose summary
 * left sections out (`fullPreview`), fetches the whole preview first — the caller does that and
 * hands the full sections back.
 */

import React from "react";
import { FileWarning, Minus, Pencil, Plus, ShieldAlert, TriangleAlert } from "lucide-react";
import type { ApprovalPreviewSection } from "@orquester/api/agent-chat";

import { cn } from "../../../lib/cn";
import { diffLineTone, type DiffLineTone } from "./approval-detail";

const DIFF_TONE: Record<DiffLineTone, string> = {
  added: "text-ok-300",
  removed: "text-danger-300",
  meta: "text-neutral-500",
  context: "text-neutral-300"
};

/** Lines (or rows) a section shows before it is clamped behind "View all". */
export const PREVIEW_INLINE_LINES = 10;
/** Characters a section shows before it is clamped, whatever its line count. */
export const PREVIEW_INLINE_CHARS = 900;

function lineCount(text: string): number {
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) lines += 1;
  return lines;
}

/**
 * Whether a section needs "View all": it was cut by the summary (`partial` — the rest is fetched),
 * or it is longer than the inline height. Flags (warnings, files) are never clamped.
 */
export function previewSectionIsLong(section: ApprovalPreviewSection): boolean {
  switch (section.kind) {
    case "text":
    case "code":
      return section.partial === true || lineCount(section.text) > PREVIEW_INLINE_LINES || section.text.length > PREVIEW_INLINE_CHARS;
    case "diff":
      return (
        section.partial === true ||
        lineCount(section.unifiedDiff) > PREVIEW_INLINE_LINES ||
        section.unifiedDiff.length > PREVIEW_INLINE_CHARS
      );
    case "fields":
      return section.rows.length > PREVIEW_INLINE_LINES;
    case "changes":
      return section.items.length > PREVIEW_INLINE_LINES;
    case "file":
    case "warning":
      return false;
  }
}

/** A section the summary cut: its rest exists only in the full preview. */
export function previewSectionIsPartial(section: ApprovalPreviewSection): boolean {
  return (section.kind === "text" || section.kind === "code" || section.kind === "diff") && section.partial === true;
}

/** `1 234 B`, `12.3 KiB`, `4.0 MiB`. */
export function formatPreviewBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

/** The sections that must be seen even when the rest of the preview is in a sheet (phones). */
export function previewFlagSections(sections: readonly ApprovalPreviewSection[]): ApprovalPreviewSection[] {
  return sections.filter((section) => section.kind === "warning" || (section.kind === "file" && section.flag !== undefined));
}

export interface ToolApprovalPreviewProps {
  sections: readonly ApprovalPreviewSection[];
  /** The whole preview is already here: "View all" only unclamps. */
  fullLoaded: boolean;
  /** The whole preview is being fetched. */
  loadingFull: boolean;
  /** The card's summary left sections out or cut them: fetch the whole preview. */
  onLoadFull: () => void;
  /** Every section starts unclamped (the phone's sheet, a fetched full preview). */
  expandAll?: boolean;
}

const BLOCK = "ac-scroll-thin w-full min-w-0 rounded-md bg-neutral-900/60 px-2 py-1.5 text-xs";
const CLAMPED = "max-h-40 overflow-hidden";
const OPEN = "max-h-[60vh] overflow-auto";

const VIEW_ALL_BUTTON =
  "ac-press mt-1 inline-flex h-6 items-center rounded-md px-1.5 text-[11px] text-info-300 hover:bg-neutral-800 " +
  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 disabled:opacity-50";

export function ToolApprovalPreview({
  sections,
  fullLoaded,
  loadingFull,
  onLoadFull,
  expandAll = false
}: ToolApprovalPreviewProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState<ReadonlySet<number>>(() => new Set());
  // New sections (a fetched full preview, another card): nothing stays expanded by index.
  React.useEffect(() => setExpanded(new Set()), [sections]);

  return (
    <div className="flex min-w-0 flex-col gap-2" data-approval-preview="">
      {sections.map((section, index) => {
        const long = previewSectionIsLong(section);
        const open = expandAll || !long || expanded.has(index);
        const needsFetch = !fullLoaded && previewSectionIsPartial(section);
        return (
          <div key={index} className="min-w-0" data-preview-section={section.kind}>
            <PreviewSection section={section} open={open} />
            {long && !open ? (
              <button
                type="button"
                className={VIEW_ALL_BUTTON}
                disabled={needsFetch && loadingFull}
                data-view-all=""
                onClick={() => {
                  if (needsFetch) onLoadFull();
                  setExpanded((current) => new Set(current).add(index));
                }}
              >
                {needsFetch && loadingFull ? "Loading the full preview…" : "View all"}
              </button>
            ) : null}
            {open && needsFetch ? (
              <p className="mt-1 text-[11px] text-warn-300">
                {loadingFull ? "Loading the rest of this section…" : "This section is cut here; the full preview has the rest."}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** A preview block's accessible name: what it is, and that it is cut short while clamped. */
export function previewBlockLabel(name: string, open: boolean): string {
  return open ? name : `${name} (shortened: View all shows the rest)`;
}

function SectionTitle({ children, extra }: { children: React.ReactNode; extra?: React.ReactNode }): React.ReactElement {
  return (
    <div className="mb-1 flex min-w-0 items-baseline gap-2 text-[11px]">
      <span className="min-w-0 truncate font-medium text-neutral-300">{children}</span>
      {extra}
    </div>
  );
}

function PreviewSection({ section, open }: { section: ApprovalPreviewSection; open: boolean }): React.ReactElement {
  switch (section.kind) {
    case "text":
      return (
        <div className="min-w-0">
          {section.title ? <SectionTitle>{section.title}</SectionTitle> : null}
          <div
            className={cn(BLOCK, "whitespace-pre-wrap break-words text-neutral-200", open ? OPEN : CLAMPED)}
            tabIndex={0}
            role="region"
            aria-label={previewBlockLabel(section.title ?? "Text", open)}
          >
            {section.text}
          </div>
        </div>
      );
    case "code":
      return (
        <div className="min-w-0">
          <SectionTitle
            extra={
              <>
                {section.language ? <span className="shrink-0 text-neutral-500">{section.language}</span> : null}
                {section.sha256 ? (
                  <span className="min-w-0 truncate font-mono text-neutral-600" title={`SHA-256 ${section.sha256}`}>
                    sha256 {section.sha256.slice(0, 12)}
                  </span>
                ) : null}
              </>
            }
          >
            {section.title}
          </SectionTitle>
          <pre
            className={cn(BLOCK, "whitespace-pre font-mono text-neutral-200", open ? OPEN : CLAMPED)}
            tabIndex={0}
            role="region"
            aria-label={previewBlockLabel(section.title, open)}
          >
            {section.text}
          </pre>
        </div>
      );
    case "diff":
      return (
        <div className="min-w-0">
          <SectionTitle>{section.title}</SectionTitle>
          <pre
            className={cn(BLOCK, "whitespace-pre font-mono", open ? OPEN : CLAMPED)}
            tabIndex={0}
            role="region"
            aria-label={previewBlockLabel(`Changes to ${section.title}`, open)}
          >
            {section.unifiedDiff.split("\n").map((line, index) => (
              <span key={index} className={cn("block", DIFF_TONE[diffLineTone(line)])}>
                {line === "" ? " " : line}
              </span>
            ))}
          </pre>
        </div>
      );
    case "fields":
      return (
        <div className="min-w-0">
          {section.title ? <SectionTitle>{section.title}</SectionTitle> : null}
          <dl
            className={cn(BLOCK, "grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1", open ? OPEN : CLAMPED)}
            aria-label={previewBlockLabel(section.title ?? "Settings", open)}
          >
            {section.rows.map((row, index) => (
              <React.Fragment key={index}>
                <dt className="min-w-0 truncate text-neutral-500" title={row.label}>
                  {row.label}
                </dt>
                <dd className="flex min-w-0 items-baseline gap-1.5" data-field-state={row.state}>
                  <span className={cn("min-w-0 whitespace-pre-wrap break-all font-mono", row.state === "flagged" ? "text-danger-300" : "text-neutral-200")}>
                    {row.value}
                  </span>
                  {row.state === "set" ? <span className="shrink-0 text-[10px] text-neutral-500">set</span> : null}
                  {row.state === "asked" ? <span className="shrink-0 text-[10px] text-info-300">you type it below</span> : null}
                  {row.state === "flagged" ? (
                    <span className="shrink-0 text-[10px] font-medium text-danger-300">looks like a secret, sent in plain text</span>
                  ) : null}
                </dd>
              </React.Fragment>
            ))}
          </dl>
        </div>
      );
    case "changes":
      return (
        <div className="min-w-0">
          <SectionTitle>{section.title}</SectionTitle>
          <ul className={cn(BLOCK, "flex flex-col gap-1", open ? OPEN : CLAMPED)} aria-label={previewBlockLabel(section.title, open)}>
            {section.items.map((item, index) => {
              const Icon = item.change === "added" ? Plus : item.change === "removed" ? Minus : Pencil;
              return (
                <li key={index} className="flex min-w-0 items-start gap-1.5" data-change={item.change}>
                  <Icon
                    size={11}
                    aria-label={item.change}
                    className={cn(
                      "mt-0.5 shrink-0",
                      item.change === "added" ? "text-ok-300" : item.change === "removed" ? "text-danger-300" : "text-info-300"
                    )}
                  />
                  <span className="min-w-0">
                    <span className="break-words text-neutral-200">{item.label}</span>
                    {item.detail ? <span className="block whitespace-pre-wrap break-words text-neutral-500">{item.detail}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      );
    case "file":
      return (
        <div
          className={cn(BLOCK, "flex min-w-0 items-start gap-2", section.flag ? "border border-danger-800/60 bg-danger-soft/20" : "")}
          data-file-flag={section.flag}
        >
          <FileWarning size={13} className={cn("mt-0.5 shrink-0", section.flag ? "text-danger-300" : "text-neutral-500")} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block break-all font-mono text-neutral-200">{section.path}</span>
            <span className="block text-[11px] text-neutral-500">
              {formatPreviewBytes(section.size)} · <span className="font-mono">sha256 {section.sha256}</span>
            </span>
          </span>
          {section.flag ? (
            <span className="shrink-0 rounded-full bg-danger-soft/50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-danger-300">
              {section.flag === "executable" ? "Executable" : "Binary"}
            </span>
          ) : null}
        </div>
      );
    case "warning": {
      const danger = section.level === "danger";
      const Icon = danger ? ShieldAlert : TriangleAlert;
      return (
        <div
          role={danger ? "alert" : undefined}
          className={cn(
            "flex min-w-0 items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs",
            danger ? "border-danger-800/60 bg-danger-soft/25 text-danger-200" : "border-warn-700/50 bg-warn-soft/20 text-neutral-200"
          )}
          data-warning={section.level}
        >
          <Icon size={13} className={cn("mt-0.5 shrink-0", danger ? "text-danger-300" : "text-warn-300")} aria-hidden />
          <span className="min-w-0 whitespace-pre-wrap break-words">{section.text}</span>
        </div>
      );
    }
  }
}
