/**
 * A collapsible JSON tree for a block's input, output and error detail (spec
 * §7.3). Big values cost what is on screen: children render only when their
 * parent is open, 100 at a time ("Show 100 more of 5,000"), and a long string
 * shows its head until asked for all of it.
 *
 * Selection, not hover, carries the actions: tap (or click, or Enter) a row
 * and the bar under the tree names its path and offers **Copy value** and
 * **Copy path** (`nodes.Review.output.items[0]` — the `{{…}}` grammar, ready
 * to paste into a prompt). Nothing is hover-only, and every row is a real
 * button, 40 px tall on a phone.
 */

import React, { useCallback, useMemo, useState } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";

import { cn } from "../../../lib/cn";
import { copyProduced } from "../../../lib/copy-produced";
import {
  clipString,
  isJsonContainer,
  jsonChildCount,
  jsonChildren,
  jsonCopyText,
  jsonDefaultExpanded,
  jsonKind,
  jsonPreview,
  type JsonEntry
} from "../../../lib/workflows/json-tree";
import { FOCUS_RING, type RunsVariant } from "./shared";

export interface JsonTreeProps {
  value: unknown;
  /** The expression path of the root (`nodes.Review.output`); child paths extend it. */
  rootPath?: string;
  /** The root row's label (`output`, `input`). */
  rootLabel?: string;
  variant?: RunsVariant;
  /** Levels open by default below the root (small containers only). Default 1. */
  expandDepth?: number;
  className?: string;
}

const PAGE = 100;

/** A copy action with its own tick. */
export const CopyAction: React.FC<{
  label: string;
  value: () => string;
  sheet?: boolean;
  className?: string;
}> = ({ label, value, sheet, className }) => {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void (async () => {
      try {
        await copyProduced(
          value(),
          navigator.clipboard,
          typeof ClipboardItem === "function" ? ClipboardItem : undefined
        );
      } catch {
        return;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    })();
  }, [value]);
  return (
    <button
      type="button"
      onClick={copy}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-neutral-700/80 px-2 text-xs text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-100",
        FOCUS_RING,
        sheet ? "h-10 px-3" : "h-7",
        className
      )}
    >
      {copied ? <Check size={13} aria-hidden className="text-ok" /> : <Copy size={13} aria-hidden />}
      {copied ? "Copied" : label}
    </button>
  );
};

function valueClass(value: unknown): string {
  switch (jsonKind(value)) {
    case "string":
      return "text-neutral-200";
    case "number":
      return "text-info";
    case "boolean":
      return "text-warn";
    case "null":
    case "undefined":
      return "italic text-neutral-500";
    default:
      return "text-neutral-500";
  }
}

/** A string leaf that is worth opening: long, or several lines. */
function isLongString(value: unknown): value is string {
  return typeof value === "string" && (value.length > 80 || value.includes("\n"));
}

interface RowProps {
  entry: JsonEntry;
  depth: number;
  sheet: boolean;
  expandDepth: number;
  selectedPath: string | null;
  onSelect: (entry: JsonEntry) => void;
  toggled: ReadonlySet<string>;
  onToggle: (path: string) => void;
  pages: ReadonlyMap<string, number>;
  onMore: (path: string) => void;
  fullStrings: ReadonlySet<string>;
  onFullString: (path: string) => void;
}

const Row: React.FC<RowProps> = (props) => {
  const { entry, depth, sheet, expandDepth, selectedPath, toggled } = props;
  const container = isJsonContainer(entry.value);
  const longString = isLongString(entry.value);
  const openable = container || longString;
  const byDefault = container && jsonDefaultExpanded(depth, entry.value, expandDepth);
  const open = openable && (toggled.has(entry.path) ? !byDefault : byDefault);
  const selected = selectedPath === entry.path;
  const count = jsonChildCount(entry.value);
  const shown = Math.min(count, props.pages.get(entry.path) ?? PAGE);
  const indent = { paddingLeft: `${depth * 14 + 4}px` };

  return (
    <li role="treeitem" aria-expanded={openable ? open : undefined} aria-selected={selected}>
      <button
        type="button"
        onClick={() => {
          props.onSelect(entry);
          if (openable) props.onToggle(entry.path);
        }}
        style={indent}
        className={cn(
          "flex w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left font-mono text-[12px] leading-5 transition-colors",
          FOCUS_RING,
          sheet ? "min-h-10" : "min-h-[26px]",
          selected ? "bg-neutral-800 ring-1 ring-inset ring-neutral-700" : "hover:bg-neutral-800/50"
        )}
      >
        <ChevronRight
          size={12}
          aria-hidden
          className={cn(
            "shrink-0 text-neutral-500 transition-transform motion-reduce:transition-none",
            open && "rotate-90",
            !openable && "invisible"
          )}
        />
        <span className={cn("shrink-0", typeof entry.key === "number" ? "text-neutral-500" : "text-neutral-400")}>
          {typeof entry.key === "number" ? entry.key : entry.key === "" ? '""' : entry.key}
        </span>
        <span aria-hidden className="shrink-0 text-neutral-600">
          :
        </span>
        <span className={cn("min-w-0 truncate", valueClass(entry.value))}>
          {container && open ? (
            <span className="text-neutral-500">{Array.isArray(entry.value) ? `[${count}]` : `{${count}}`}</span>
          ) : (
            jsonPreview(entry.value, sheet ? 48 : 96)
          )}
        </span>
      </button>
      {open && container ? (
        <ul role="group">
          {jsonChildren(entry.value, entry.path, 0, shown).map((child) => (
            <Row key={child.path} {...props} entry={child} depth={depth + 1} />
          ))}
          {shown < count ? (
            <li>
              <button
                type="button"
                onClick={() => props.onMore(entry.path)}
                style={{ paddingLeft: `${(depth + 1) * 14 + 22}px` }}
                className={cn(
                  "w-full rounded-md text-left text-xs text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200",
                  FOCUS_RING,
                  sheet ? "min-h-10" : "min-h-7"
                )}
              >
                Show {Math.min(PAGE, count - shown).toLocaleString("en-US")} more of {count.toLocaleString("en-US")}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
      {open && longString ? (
        <LongString
          text={entry.value as string}
          full={props.fullStrings.has(entry.path)}
          onFull={() => props.onFullString(entry.path)}
          indent={depth * 14 + 22}
        />
      ) : null}
    </li>
  );
};

const LongString: React.FC<{ text: string; full: boolean; onFull: () => void; indent: number }> = ({
  text,
  full,
  onFull,
  indent
}) => {
  const clipped = full ? { text, clipped: false } : clipString(text);
  return (
    <div
      style={{ marginLeft: `${indent}px` }}
      className="my-1 mr-1 rounded-md border border-neutral-800 bg-neutral-950/60"
    >
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[12px] leading-5 text-neutral-200">
        {clipped.text}
      </pre>
      {clipped.clipped ? (
        <button
          type="button"
          onClick={onFull}
          className={cn(
            "w-full border-t border-neutral-800 px-2.5 py-1.5 text-left text-xs text-neutral-400 hover:text-neutral-200",
            FOCUS_RING
          )}
        >
          Show all {text.length.toLocaleString("en-US")} characters
        </button>
      ) : null}
    </div>
  );
};

export const JsonTree: React.FC<JsonTreeProps> = ({
  value,
  rootPath = "",
  rootLabel = "value",
  variant = "docked",
  expandDepth = 1,
  className
}) => {
  const sheet = variant === "sheet";
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const [pages, setPages] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [fullStrings, setFullStrings] = useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = useState<JsonEntry | null>(null);

  const onToggle = useCallback((path: string) => {
    setToggled((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const onMore = useCallback((path: string) => {
    setPages((current) => new Map(current).set(path, (current.get(path) ?? PAGE) + PAGE));
  }, []);
  const onFullString = useCallback((path: string) => {
    setFullStrings((current) => new Set(current).add(path));
  }, []);

  const root: JsonEntry = useMemo(() => ({ key: rootLabel, path: rootPath, value }), [rootLabel, rootPath, value]);
  const selectedEntry = selected && selected.value !== undefined ? selected : null;

  if (!isJsonContainer(value) && !isLongString(value)) {
    // A scalar: one line, with its own copy.
    return (
      <div
        className={cn(
          "flex min-w-0 items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-950/40 px-3 py-2",
          className
        )}
      >
        <span className={cn("min-w-0 flex-1 break-words font-mono text-[12px]", valueClass(value))}>
          {value === undefined ? "No value" : jsonPreview(value, 400)}
        </span>
        {value !== undefined ? <CopyAction label="Copy" value={() => jsonCopyText(value)} sheet={sheet} /> : null}
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-col rounded-lg border border-neutral-800 bg-neutral-950/40", className)}>
      <ul role="tree" aria-label={rootLabel} className="min-h-0 flex-1 overflow-auto p-1">
        <Row
          entry={root}
          depth={0}
          sheet={sheet}
          expandDepth={expandDepth}
          selectedPath={selectedEntry?.path ?? null}
          onSelect={setSelected}
          toggled={toggled}
          onToggle={onToggle}
          pages={pages}
          onMore={onMore}
          fullStrings={fullStrings}
          onFullString={onFullString}
        />
      </ul>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-t border-neutral-800 px-2 py-1.5">
        {selectedEntry ? (
          <>
            <code
              title={selectedEntry.path || rootLabel}
              className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-400"
            >
              {selectedEntry.path || rootLabel}
            </code>
            <CopyAction label="Copy value" value={() => jsonCopyText(selectedEntry.value)} sheet={sheet} />
            {selectedEntry.path ? (
              <CopyAction label="Copy path" value={() => selectedEntry.path} sheet={sheet} />
            ) : null}
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 text-[11px] text-neutral-500">Select a row to copy its value or path</span>
            <CopyAction label="Copy all" value={() => jsonCopyText(value)} sheet={sheet} />
          </>
        )}
      </div>
    </div>
  );
};
