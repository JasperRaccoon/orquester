/**
 * Agent chat — an Agent Profile chat's own `/` and `$` catalog (`GET …/catalog`,
 * `ThreadCatalogResponse`).
 *
 * The provider snapshot's commands and skills are the agent's GLOBAL ones (its machine probe and
 * per-cwd overlays). A profile chat must offer what ITS session loaded instead — the daemon
 * answers the live session's report, else the profile's own items — and never the Global list,
 * not even while that answer loads. A Global chat (and a profile that is gone: `source: "none"`)
 * keeps the provider's catalog exactly as before. No React import (the hook is
 * `use-thread-catalog.ts`).
 */

import type { ProviderSnapshot, Skill, SlashCommand, ThreadCatalogResponse } from "@orquester/api/agent-chat";

const SOURCES: ReadonlySet<string> = new Set(["session", "profile", "none"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

function slashCommand(value: unknown): SlashCommand | null {
  const row = record(value);
  const name = text(row?.name);
  if (row === null || name === undefined) return null;
  const description = text(row.description);
  const hint = text(record(row.input)?.hint);
  return { name, ...(description !== undefined ? { description } : {}), ...(hint !== undefined ? { input: { hint } } : {}) };
}

function skill(value: unknown): Skill | null {
  const row = record(value);
  const name = text(row?.name);
  const path = text(row?.path);
  if (row === null || name === undefined || path === undefined || typeof row.enabled !== "boolean") return null;
  const out: Skill = { name, path, enabled: row.enabled };
  for (const key of ["description", "shortDescription", "displayName", "scope"] as const) {
    const value = text(row[key]);
    if (value !== undefined) out[key] = value;
  }
  if (typeof row.userInvocationOnly === "boolean") out.userInvocationOnly = row.userInvocationOnly;
  if (typeof row.userInvocable === "boolean") out.userInvocable = row.userInvocable;
  return out;
}

/** The daemon's answer for `threadId`, rows that do not read left out; `null` when it is not one. */
export function parseThreadCatalogResponse(value: unknown, threadId: string): ThreadCatalogResponse | null {
  const body = record(value);
  if (body === null || body.threadId !== threadId || typeof body.source !== "string" || !SOURCES.has(body.source)) return null;
  if (!Array.isArray(body.slashCommands) || !Array.isArray(body.skills)) return null;
  return {
    threadId,
    source: body.source as ThreadCatalogResponse["source"],
    slashCommands: body.slashCommands.map(slashCommand).filter((row): row is SlashCommand => row !== null),
    skills: body.skills.map(skill).filter((row): row is Skill => row !== null)
  };
}

/**
 * The provider snapshot the composer reads, with a profile chat's catalog in place of the Global
 * one: its own commands and skills (empty until they load), no per-cwd overlay. Unchanged — the
 * same object — for a Global chat, or when the daemon answered `none`.
 */
export function withThreadCatalog<
  T extends Pick<ProviderSnapshot, "slashCommands" | "skills" | "workspaceSnapshots"> | null | undefined
>(provider: T, profileId: string | null | undefined, catalog: ThreadCatalogResponse | null): T {
  if (!profileId || provider === null || provider === undefined || catalog?.source === "none") return provider;
  const { workspaceSnapshots: _globalOverlays, ...rest } = provider;
  return { ...rest, slashCommands: catalog?.slashCommands ?? [], skills: catalog?.skills ?? [] } as T;
}
