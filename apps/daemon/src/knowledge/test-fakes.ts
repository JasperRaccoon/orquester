/** Test doubles for the knowledge service: the plugin record it follows and the runtime it reads. */

import { EventEmitter } from "node:events";
import { KNOWLEDGE_GRAPH_PLUGIN_ID, type PluginInfo, type PluginsResponse } from "@orquester/api";

import type { KnowledgeRuntime, KnowledgeRuntimePort } from "./ports.ts";
import { FakeEmbedder, FakeEmbedderSource } from "./search/test-fakes.ts";

/** The slice of `PluginsService` the service uses, with a switch the test flips. */
export class FakeKnowledgePlugins {
  readonly events = new EventEmitter();
  settings: Record<string, unknown> = {};

  constructor(public enabled = false) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  pluginSettings(): unknown {
    return this.settings;
  }

  async updatePluginSettings(_id: string, patch: Record<string, unknown>): Promise<unknown> {
    this.settings = { ...this.settings, ...patch };
    this.emit();
    return this.settings;
  }

  async get(): Promise<PluginInfo> {
    return { id: KNOWLEDGE_GRAPH_PLUGIN_ID, enabled: this.enabled, current: null } as unknown as PluginInfo;
  }

  /** Turn the plugin on or off, as `PUT /api/plugins/knowledge-graph` would. */
  set(enabled: boolean): void {
    this.enabled = enabled;
    this.emit();
  }

  private emit(): void {
    const response = { plugins: [{ id: KNOWLEDGE_GRAPH_PLUGIN_ID, enabled: this.enabled, current: null }] } as unknown as PluginsResponse;
    this.events.emit("changed", response);
  }
}

/** A runtime port whose runtime the test sets. */
export class FakeRuntime implements KnowledgeRuntimePort {
  private runtime: KnowledgeRuntime | null = null;
  private readonly listeners = new Set<(runtime: KnowledgeRuntime | null) => void>();

  current(): KnowledgeRuntime | null {
    return this.runtime;
  }

  set(runtime: KnowledgeRuntime | null): void {
    this.runtime = runtime;
    for (const listener of this.listeners) listener(runtime);
  }

  onChange(listener: (runtime: KnowledgeRuntime | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** An embedder factory over fake embedders: how many were made and released. */
export function fakeEmbedders(): {
  factory: () => FakeEmbedderSource & { dispose(): Promise<void> };
  made: FakeEmbedder[];
  disposed: number;
} {
  const state = {
    made: [] as FakeEmbedder[],
    disposed: 0,
    factory: () => {
      const embedder = new FakeEmbedder();
      state.made.push(embedder);
      return Object.assign(new FakeEmbedderSource(embedder), {
        dispose: async () => {
          state.disposed += 1;
        }
      });
    }
  };
  return state;
}
