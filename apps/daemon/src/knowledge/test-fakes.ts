/** Test doubles for the knowledge service: the plugin record it follows and the runtime it reads. */

import { EventEmitter } from "node:events";
import { KNOWLEDGE_GRAPH_PLUGIN_ID, type PluginInfo, type PluginsResponse } from "@orquester/api";

import type { KnowledgeRuntime, KnowledgeRuntimePort } from "./ports.ts";
import type { KnowledgeEmbedderSource } from "./search/embedder.ts";
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

/**
 * An embedder factory over fake embedders, following the runtime it is given the way the ONNX
 * source does: an embedder while the runtime reads as installed (one made per opening), none —
 * the model released — while it reads as none (the service's gated runtime: the plugin is off).
 */
export function fakeEmbedders(): {
  factory: (runtime: KnowledgeRuntimePort) => KnowledgeEmbedderSource & { dispose(): Promise<void> };
  made: FakeEmbedder[];
  released: number;
  disposed: number;
} {
  const state = {
    made: [] as FakeEmbedder[],
    released: 0,
    disposed: 0,
    factory: (runtime: KnowledgeRuntimePort) => {
      const embedder = new FakeEmbedder();
      state.made.push(embedder);
      const source = new FakeEmbedderSource(embedder);
      let live = true;
      return {
        current: () => {
          const now = runtime.current() !== null;
          if (live && !now) state.released += 1;
          live = now;
          return now ? source.current() : null;
        },
        onChange: (listener: () => void) => runtime.onChange(() => listener()),
        dispose: async () => {
          state.disposed += 1;
        }
      };
    }
  };
  return state;
}
