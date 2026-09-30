/**
 * Reading the shared workflow guide (`@orquester/api` guide.ts) in the editor:
 * its texts mark code with `backticks`, and a block's inspector help shows the
 * guide sections about what the block outputs.
 */

import { WORKFLOW_BLOCK_GUIDES, type WorkflowGuideItem, type WorkflowGuideSection, type WorkflowNodeType } from "@orquester/api";

/** A run of guide text: plain, or code (it was between backticks). */
export interface GuideSpan {
  code: boolean;
  text: string;
}

/**
 * Split a guide text at its backticks: `a \`b\` c` → plain "a ", code "b",
 * plain " c". A backtick without a partner stays in the text as written.
 */
export function splitGuideText(text: string): GuideSpan[] {
  const spans: GuideSpan[] = [];
  const push = (code: boolean, value: string): void => {
    if (value.length === 0) return;
    const last = spans[spans.length - 1];
    if (last !== undefined && last.code === code) last.text += value;
    else spans.push({ code, text: value });
  };
  let rest = text;
  for (;;) {
    const open = rest.indexOf("`");
    const close = open < 0 ? -1 : rest.indexOf("`", open + 1);
    if (close < 0) {
      push(false, rest);
      return spans;
    }
    push(false, rest.slice(0, open));
    push(true, rest.slice(open + 1, close));
    rest = rest.slice(close + 1);
  }
}

/** The text of the guide item called `term`, if the list has one. */
export function guideItemText(items: readonly WorkflowGuideItem[], term: string): string | undefined {
  return items.find((item) => item.term === term)?.text;
}

/** The sections of a block type's guide that say what it outputs (its input, result, response…). */
const BLOCK_OUTPUT_GUIDE_TITLES: Partial<Record<WorkflowNodeType, readonly string[]>> = {
  "trigger.manual": ["Input"],
  agent: ["Output"],
  code: ["Result"],
  shell: ["Result"],
  http: ["Response"],
  if: ["Branching"],
  switch: ["Routing"],
  merge: ["Joining"],
  stop: ["Ending"],
  wait: ["Waiting"],
  workflow: ["Child run"]
};

/** The guide sections about what a block of `type` outputs (none for a type the guide has nothing on). */
export function blockOutputGuide(type: WorkflowNodeType): readonly WorkflowGuideSection[] {
  const titles = BLOCK_OUTPUT_GUIDE_TITLES[type] ?? [];
  return WORKFLOW_BLOCK_GUIDES[type].filter((section) => titles.includes(section.title));
}

/** One section of a block type's guide, by title. */
export function blockGuideSection(type: WorkflowNodeType, title: string): WorkflowGuideSection | undefined {
  return WORKFLOW_BLOCK_GUIDES[type].find((section) => section.title === title);
}

/** The sections of a block type's guide with these titles, in the order asked. */
export function blockGuideSections(type: WorkflowNodeType, ...titles: string[]): WorkflowGuideSection[] {
  return titles.flatMap((title) => blockGuideSection(type, title) ?? []);
}
