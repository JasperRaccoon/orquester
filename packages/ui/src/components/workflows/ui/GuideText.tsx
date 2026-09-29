/**
 * The shared workflow guide (`@orquester/api` guide.ts) in the inspector's
 * help: a text with its `backtick` spans as <code>, a list of facts (a term
 * and what it means), titled sections of them, and a block type's
 * description with the guide's sections on what it outputs.
 */

import React from "react";

import { WORKFLOW_BLOCK_CATALOG, type WorkflowGuideItem, type WorkflowGuideSection, type WorkflowNodeType } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { blockOutputGuide, splitGuideText } from "../../../lib/workflows/guide-text";

const CODE_CLASS = "rounded bg-neutral-800/70 px-1 font-mono text-[0.95em] text-neutral-200";

/** One guide text, its `backtick` spans as code. */
export const GuideText: React.FC<{ text: string }> = ({ text }) => (
  <>
    {splitGuideText(text).map((span, index) =>
      span.code ? (
        <code key={index} className={CODE_CLASS}>
          {span.text}
        </code>
      ) : (
        <React.Fragment key={index}>{span.text}</React.Fragment>
      )
    )}
  </>
);

/**
 * Facts as a two-column list: the term (monospace) beside its text; a fact
 * without a term spans both columns. `termLabel` shows a term as the form
 * names it (an operator's label, a field's name).
 */
export const GuideItems: React.FC<{
  items: readonly WorkflowGuideItem[];
  termLabel?: (term: string) => React.ReactNode;
  className?: string;
}> = ({ items, termLabel, className }) => (
  <div className={cn("grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1", className)}>
    {items.map((item, index) =>
      item.term !== undefined ? (
        <React.Fragment key={index}>
          <div className="whitespace-nowrap font-mono text-neutral-200">{termLabel ? termLabel(item.term) : item.term}</div>
          <div className="min-w-0 break-words">
            <GuideText text={item.text} />
          </div>
        </React.Fragment>
      ) : (
        <div key={index} className="col-span-2 min-w-0 break-words">
          <GuideText text={item.text} />
        </div>
      )
    )}
  </div>
);

/** Titled groups of facts, each title a small heading over its list. */
export const GuideSections: React.FC<{
  sections: readonly WorkflowGuideSection[];
  termLabel?: (term: string) => React.ReactNode;
  className?: string;
}> = ({ sections, termLabel, className }) => (
  <div className={cn("space-y-2.5", className)}>
    {sections.map((section) => (
      <section key={section.title} className="space-y-1">
        <h4 className="text-[10.5px] font-semibold uppercase tracking-wide text-neutral-500">{section.title}</h4>
        <GuideItems items={section.items} termLabel={termLabel} />
      </section>
    ))}
  </div>
);

/**
 * What a block type is and what it outputs: its catalogue entry, then the
 * shared guide's sections on its output (the Inspector header's help).
 */
export const BlockGuide: React.FC<{ type: WorkflowNodeType }> = ({ type }) => {
  const entry = WORKFLOW_BLOCK_CATALOG[type];
  const sections = blockOutputGuide(type);
  return (
    <>
      <p>
        <GuideText text={entry.description} />
      </p>
      {type !== "note" ? (
        <p>
          <span className="font-medium text-neutral-100">What it outputs: </span>
          <GuideText text={entry.output} />
        </p>
      ) : null}
      {sections.length > 0 ? <GuideSections sections={sections} className="pt-1" /> : null}
    </>
  );
};
