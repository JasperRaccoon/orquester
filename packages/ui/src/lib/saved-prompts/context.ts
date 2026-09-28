/**
 * Saved prompts — the labels `{project}`, `{workspace}`, `{agent}` and
 * `{model}` render as, read off the live stores at the moment of an Insert or
 * a Send (never cached: the chat's model can change between two clicks).
 *
 * Kept apart from `variables.ts`, which stays pure and testable; this is the
 * one place that knows where each label lives.
 */

import { REGISTRY, type RegistryEntryDef } from "@orquester/registry";

import { useAppStore } from "../../store/app";
import { providerForRefId, providersStore } from "../agent-chat/providers";
import { peekThreadStore } from "../agent-chat/store";
import { normalizeProjectPath } from "./list.logic";
import { agentLabelFor, modelLabelFor, projectNamesFromPath } from "./variables";

export interface SavedPromptLabels {
  projectName: string;
  workspaceName: string;
  /** "" without a target chat. */
  agentLabel: string;
  /** "" without a target chat, or when the chat names no model yet. */
  modelLabel: string;
}

export function savedPromptLabels(projectPath: string, sessionId: string | null): SavedPromptLabels {
  const app = useAppStore.getState();
  const wanted = normalizeProjectPath(projectPath);
  const project =
    wanted.length === 0
      ? null
      : ([app.currentProject, ...app.projects].find(
          (candidate) => candidate !== null && normalizeProjectPath(candidate.path) === wanted
        ) ?? null);
  const fromPath = projectNamesFromPath(projectPath);
  const labels: SavedPromptLabels = {
    projectName: project?.name || fromPath.project,
    workspaceName: project?.workspace || fromPath.workspace,
    agentLabel: "",
    modelLabel: ""
  };
  if (sessionId === null) return labels;

  const session = app.sessions.find((candidate) => candidate.id === sessionId) ?? null;
  const refId = session?.refId ?? null;
  if (refId !== null) {
    // The runtime registry first (it is what the tab strip shows), the static
    // catalogue behind it for a registry that has not loaded yet.
    const catalogue: readonly RegistryEntryDef[] = REGISTRY.agents;
    labels.agentLabel = agentLabelFor(refId, [...app.registry.agents, ...catalogue]);
  }
  // The thread head's selection is the chat's current model (the composer's
  // chip reads the same).
  const selection = peekThreadStore(sessionId)?.getState().slice.head?.modelSelection ?? null;
  const slug = selection?.model ?? null;
  const provider = refId !== null ? providerForRefId(providersStore.getState().providers, refId) : null;
  labels.modelLabel = modelLabelFor(provider?.models, slug);
  return labels;
}
