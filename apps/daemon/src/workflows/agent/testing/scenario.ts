// One agent-block test scenario: a fake clock, a fake chat host, the shared readers and a way to run
// (and restart) the executor the way the engine does. Nothing sleeps: `clock.drive` jumps from one
// timer to the next whenever everything else is waiting.

import type { AgentAccount, UsageResponse } from "@orquester/api";
import type { AccountsReader, NodeResult, PromptRenderer, WaitingOn } from "../../contracts.ts";
import { createAgentExecutor } from "../executor.ts";
import { FakeChatHost, type FakeAgent, type FakeBehaviour } from "./fake-chat-host.ts";
import { FakeClock } from "./fake-clock.ts";
import { createFakeContext, fakePrompts, MemoryCooldowns, silentLogger, SimulatedCrash, staticAccounts, staticUsage, type FakeContext, type FakeContextOptions } from "./fake-context.ts";

export interface ScenarioOptions {
  accounts?: AgentAccount[];
  agents?: FakeAgent[];
  behaviour?: FakeBehaviour;
  usage?: UsageResponse;
  prompts?: PromptRenderer;
  start?: string;
  /** What selection reads (default: the host's own accounts). */
  accountsReader?: AccountsReader;
}

export type RunOptions = Omit<FakeContextOptions, "host" | "clock" | "workflow" | "nodeId">;

export class Scenario {
  readonly clock: FakeClock;
  readonly host: FakeChatHost;
  readonly cooldowns: MemoryCooldowns;
  readonly usage: ReturnType<typeof staticUsage>;
  readonly prompts: PromptRenderer;
  private ids = 0;
  constructor(private readonly opts: ScenarioOptions = {}) {
    this.clock = new FakeClock(opts.start);
    this.host = new FakeChatHost({ clock: this.clock, ...(opts.accounts ? { accounts: opts.accounts } : {}), ...(opts.agents ? { agents: opts.agents } : {}), ...(opts.behaviour ? { behaviour: opts.behaviour } : {}) });
    this.cooldowns = new MemoryCooldowns(this.clock);
    this.usage = staticUsage(opts.usage);
    this.prompts = opts.prompts ?? fakePrompts();
  }

  mintId = (): string => `cmd-${++this.ids}`;

  executor() {
    return createAgentExecutor({
      usage: this.usage,
      accounts: this.opts.accountsReader ?? staticAccounts(this.host),
      cooldowns: this.cooldowns,
      prompts: this.prompts,
      clock: this.clock,
      mintId: this.mintId,
      logger: silentLogger,
    });
  }

  context(workflow: FakeContextOptions["workflow"], nodeId: string, extra: RunOptions = {}): FakeContext {
    return createFakeContext({ host: this.host, clock: this.clock, workflow, nodeId, ...extra });
  }

  /** Run a block to its end. */
  async run(workflow: FakeContextOptions["workflow"], nodeId: string, extra: RunOptions = {}): Promise<{ result: NodeResult; fc: FakeContext }> {
    const fc = this.context(workflow, nodeId, extra);
    const result = await this.clock.drive(this.executor().execute(fc.ctx));
    return { result, fc };
  }

  /**
   * Run with a crash after a persist, then resume with a NEW executor from `resumeFrom(persisted)` —
   * by default the value the crashed run persisted last (the engine's behaviour). Returns the resumed
   * run's result, or the first run's when it never crashed.
   */
  async runWithRestart(
    workflow: FakeContextOptions["workflow"],
    nodeId: string,
    crashAt: NonNullable<FakeContextOptions["crashAt"]>,
    opts: { extra?: RunOptions; pickResume?: (persisted: (WaitingOn | undefined)[], crashedAt: WaitingOn | undefined) => WaitingOn | undefined } = {}
  ): Promise<{ result: NodeResult; crashed: boolean; first: FakeContext; second?: FakeContext }> {
    const first = this.context(workflow, nodeId, { ...opts.extra, crashAt });
    try {
      const result = await this.clock.drive(this.executor().execute(first.ctx));
      return { result, crashed: false, first };
    } catch (error) {
      if (!(error instanceof SimulatedCrash)) throw error;
      const resumeFrom = opts.pickResume ? opts.pickResume(first.persisted, error.waitingOn) : error.waitingOn;
      const second = this.context(workflow, nodeId, { ...opts.extra, ...(resumeFrom ? { resumeFrom } : {}) });
      const result = await this.clock.drive(this.executor().execute(second.ctx));
      return { result, crashed: true, first, second };
    }
  }
}
