/**
 * A test double of the `ApprovalPort` (Task 1's contract; Task 3 ships the real one in
 * `agent-tools/approval-port.ts`): records every card and grant query, answers cards with a
 * scripted outcome, and honours grants by `@orquester/config`'s real `findGrant` rules over an
 * in-memory `agent-tools.json`. For the executor's tests and every family task's.
 */

import { createDefaultAgentToolsFile, findGrant, type AgentToolsFile } from "@orquester/config";

import type { ApprovalOutcome, ApprovalPort, ApprovalRequest, Grant, GrantQuery } from "./contract.ts";

export type CardAnswer = ApprovalOutcome | ((card: ApprovalRequest, signal: AbortSignal) => ApprovalOutcome | Promise<ApprovalOutcome>);

export class FakeApprovalPort implements ApprovalPort {
  /** Every card opened, in order. */
  readonly cards: ApprovalRequest[] = [];
  /** Every grant query, in order. */
  readonly grantQueries: GrantQuery[] = [];
  /** Every `recordWorkflowInGrant` call. */
  readonly recorded: { threadId: string; callerProjectPath: string; workflowId: string; grantId: string }[] = [];
  /** The grants `findGrant` honours (config's rules). */
  file: AgentToolsFile = createDefaultAgentToolsFile();
  private answer: CardAnswer;
  private nextId = 0;

  constructor(answer: CardAnswer = { outcome: "approved", approvalId: "" }) {
    this.answer = answer;
  }

  /** Answer every later card with `answer`. */
  answerWith(answer: CardAnswer): this {
    this.answer = answer;
    return this;
  }

  /** Add a grant record (config shape) the port will honour where the rules allow. */
  grant(grant: Partial<Grant> & Pick<Grant, "family" | "scope" | "projectPath">): this {
    this.file = { ...this.file, grants: [...this.file.grants, { id: `g_${this.file.grants.length + 1}`, createdAt: "2026-10-15T00:00:00.000Z", ...grant } as Grant] };
    return this;
  }

  async findGrant(query: GrantQuery): Promise<Grant | null> {
    this.grantQueries.push(structuredClone(query));
    return findGrant(this.file, query);
  }

  async request(card: ApprovalRequest, signal: AbortSignal): Promise<ApprovalOutcome> {
    this.cards.push(card);
    const approvalId = `a_${(this.nextId += 1)}`;
    if (signal.aborted) return { outcome: "cancelled", approvalId };
    const outcome = typeof this.answer === "function" ? await this.answer(card, signal) : this.answer;
    return { ...outcome, approvalId: outcome.approvalId || approvalId } as ApprovalOutcome;
  }

  async recordWorkflowInGrant(input: { threadId: string; callerProjectPath: string; workflowId: string; grantId: string }): Promise<void> {
    this.recorded.push(input);
  }
}
