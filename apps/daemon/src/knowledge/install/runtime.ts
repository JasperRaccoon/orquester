/**
 * {@link KnowledgeRuntimePort} over `PluginsService`: the active runtime is
 * the Knowledge Graph plugin's `current` version from plugins.json, once its
 * files are confirmed in place (the manifest the installer writes after the
 * smoke test, the mykg entry point, the venv's python, the model files). It
 * follows every `plugins.changed` (installs, rollbacks, removals) and tells
 * its listeners when the active runtime changes. Whether the plugin is on is
 * not its business (see `KnowledgeSettingsPort.enabled`).
 */
import { KNOWLEDGE_GRAPH_PLUGIN_ID, type PluginInfo, type PluginsResponse } from "@orquester/api";
import { knowledgeRuntimeDir } from "@orquester/config";
import type { EventEmitter } from "node:events";
import type { KnowledgeRuntime, KnowledgeRuntimePort } from "../ports.ts";
import { knowledgeRuntimeOf, knowledgeRuntimeReady } from "./installer.ts";
import { EMBEDDING_MODEL, type EmbeddingModelSpec } from "./pins.ts";

export interface KnowledgeRuntimeTrackerOptions {
  /** The appdir base (the runtime dir comes from `knowledgeRuntimeDir`). */
  baseDir: string;
  /** The plugins service: its state (`get`) and its `"changed"` events. */
  plugins: { get(id: typeof KNOWLEDGE_GRAPH_PLUGIN_ID): Promise<PluginInfo>; readonly events: EventEmitter };
  /** The embedding model the runtime must hold (the pinned one by default; tests pass a fixture). */
  model?: EmbeddingModelSpec;
  logger?: Pick<Console, "warn">;
}

export class KnowledgeRuntimeTracker implements KnowledgeRuntimePort {
  private readonly runtimeDir: string;
  private readonly logger: Pick<Console, "warn">;
  private readonly listeners = new Set<(runtime: KnowledgeRuntime | null) => void>();
  private active: KnowledgeRuntime | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly onPlugins = (response: PluginsResponse): void => {
    const info = response.plugins.find((plugin) => plugin.id === KNOWLEDGE_GRAPH_PLUGIN_ID);
    if (info) void this.refresh(info.current?.version ?? null);
  };
  private started = false;

  constructor(private readonly options: KnowledgeRuntimeTrackerOptions) {
    this.runtimeDir = knowledgeRuntimeDir(options.baseDir);
    this.logger = options.logger ?? console;
  }

  /** Follow the plugins service and settle the first state (call after `PluginsService.start`). */
  async start(): Promise<void> {
    if (!this.started) {
      this.started = true;
      this.options.plugins.events.on("changed", this.onPlugins);
    }
    const info = await this.options.plugins.get(KNOWLEDGE_GRAPH_PLUGIN_ID).catch((error) => {
      this.logger.warn("knowledge: could not read the plugin state; no runtime for now", error);
      return null;
    });
    await this.refresh(info?.current?.version ?? null);
  }

  stop(): void {
    this.options.plugins.events.off("changed", this.onPlugins);
    this.started = false;
  }

  current(): KnowledgeRuntime | null {
    return this.active ? { ...this.active } : null;
  }

  onChange(listener: (runtime: KnowledgeRuntime | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Every refresh queued so far has run (for tests). */
  settled(): Promise<void> {
    return this.queue;
  }

  /** Re-check `version` (the record's current, or null) and publish when the active runtime changed. Serialized. */
  private refresh(version: string | null): Promise<void> {
    const run = this.queue.then(async () => {
      const model = this.options.model ?? EMBEDDING_MODEL;
      const ready = version !== null && (await knowledgeRuntimeReady(this.runtimeDir, version, { model }));
      const next = ready ? knowledgeRuntimeOf(this.runtimeDir, version, model) : null;
      if (JSON.stringify(next) === JSON.stringify(this.active)) return;
      this.active = next;
      for (const listener of [...this.listeners]) {
        try {
          listener(this.current());
        } catch (error) {
          this.logger.warn("knowledge: a runtime listener failed", error);
        }
      }
    });
    this.queue = run.catch((error) => this.logger.warn("knowledge: runtime refresh failed", error));
    return this.queue;
  }
}
