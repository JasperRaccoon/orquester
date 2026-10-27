/**
 * Settings → Plugins → Ephemeral AI VMs: the Providers card (spec §11.3) — one
 * row per provider with its status, the inline credentials form and its
 * validation, the Windows prepared-image status, and the card's totals line.
 * Pure: the component renders what these return.
 */

import {
  BOX_KIND_LABELS,
  type BoxesTotals,
  type BoxProviderCredentialField,
  type BoxProviderId,
  type BoxProviderInfo,
  type BoxWindowsImageState
} from "@orquester/api";

import { formatHourlyRate, formatUsd } from "../../../lib/boxes/format";
import type { Tone } from "../../settings/primitives";

/** The two letters each provider's icon tile shows. */
export const PROVIDER_ABBREVIATIONS: Readonly<Record<BoxProviderId, string>> = {
  hetzner: "HZ",
  vultr: "VU",
  ionos: "IO",
  ovh: "OV",
  scaleway: "SW",
  digitalocean: "DO",
  exoscale: "EX",
  linode: "AK",
  fly: "FL",
  morph: "MO",
  civo: "CI",
  oracle: "OC",
  upcloud: "UC",
  vastai: "VA",
  runpod: "RP",
  hyperstack: "HS",
  thunder: "TC",
  cloudrift: "CR",
  massed: "MC",
  jarvislabs: "JL",
  tensordock: "TD",
  blacksmith: "BS",
  byo: "MY"
};

/** The provider whose setup is the Blacksmith checklist rather than an API key. */
export const BLACKSMITH_PROVIDER_ID: BoxProviderId = "blacksmith";

export function providerAbbreviation(provider: Pick<BoxProviderInfo, "id" | "label">): string {
  return PROVIDER_ABBREVIATIONS[provider.id] ?? provider.label.slice(0, 2).toUpperCase();
}

/** The owner's own machines: no credentials, their own card ("Your machines"). */
export const BYO_PROVIDER: BoxProviderId = "byo";

/** The providers that take credentials, in the daemon's order (Blacksmith has its own row; the owner's machines their own card). */
export function keyProviders(providers: readonly BoxProviderInfo[] | null): BoxProviderInfo[] {
  return (providers ?? []).filter((provider) => provider.id !== BLACKSMITH_PROVIDER_ID && provider.id !== BYO_PROVIDER);
}

/** The line under a provider's name: its key, the kinds it unlocks, a one-time account step. */
export function providerSubline(provider: BoxProviderInfo): string {
  return [
    provider.keyHint ? `Key …${provider.keyHint}` : null,
    provider.kinds.length > 0 ? provider.kinds.map((kind) => BOX_KIND_LABELS[kind]).join(", ") : null,
    provider.accountNote
  ]
    .filter((part) => part !== null && part !== "")
    .join(" · ");
}

export type ProviderStatusView =
  | { kind: "pill"; tone: Tone; label: string; title: string | null }
  | { kind: "add" };

/** Connected / Error / Checking… as a pill; not configured as the "Add API key" button. */
export function providerStatusView(provider: BoxProviderInfo): ProviderStatusView {
  switch (provider.status) {
    case "connected":
      return { kind: "pill", tone: "ok", label: "Connected", title: null };
    case "error":
      return { kind: "pill", tone: "danger", label: "Error", title: provider.error };
    case "checking":
      return { kind: "pill", tone: "info", label: "Checking…", title: null };
    case "not-configured":
      return { kind: "add" };
  }
}

/** Whether the provider holds credentials (the form then offers Remove, and asks for every field again). */
export function providerConfigured(provider: BoxProviderInfo): boolean {
  return provider.status !== "not-configured";
}

// ---------------------------------------------------------------------------
// The credentials form
// ---------------------------------------------------------------------------

/** What the form holds: field id → typed value. Never filled from the daemon (secrets are write-only). */
export type CredentialValues = Readonly<Record<string, string>>;

/**
 * A field that takes a PEM block (Oracle's API signing key): several lines, so
 * it gets a text area instead of a one-line input.
 */
export function credentialFieldMultiline(field: BoxProviderCredentialField): boolean {
  return /private[_-]?key|pem/i.test(field.id) || (field.placeholder ?? "").includes("-----BEGIN");
}

/**
 * Field id → why it cannot be saved. A required field must be filled; a
 * one-line field must stay on one line (a key pasted with a stray newline
 * fails at the provider in a way that is hard to see).
 */
export function credentialProblems(
  fields: readonly BoxProviderCredentialField[],
  values: CredentialValues
): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const field of fields) {
    const value = (values[field.id] ?? "").trim();
    if (!value) {
      if (!field.optional) problems[field.id] = `Enter the ${field.label}.`;
      continue;
    }
    if (!credentialFieldMultiline(field) && /[\r\n]/.test(value)) {
      problems[field.id] = `The ${field.label} must be on one line.`;
    }
  }
  return problems;
}

/**
 * The `SetBoxProviderCredentialsRequest.credentials` to send — trimmed, empty
 * optional fields left out, fields the provider does not list never sent — or
 * null while a problem remains.
 */
export function credentialsPayload(
  fields: readonly BoxProviderCredentialField[],
  values: CredentialValues
): Record<string, string> | null {
  if (fields.length === 0 || Object.keys(credentialProblems(fields, values)).length > 0) return null;
  const credentials: Record<string, string> = {};
  for (const field of fields) {
    const value = (values[field.id] ?? "").trim();
    if (value) credentials[field.id] = value;
  }
  return credentials;
}

// ---------------------------------------------------------------------------
// Windows prepared image
// ---------------------------------------------------------------------------

const WINDOWS_IMAGE_LABEL: Record<BoxWindowsImageState, { tone: Tone; label: string }> = {
  none: { tone: "neutral", label: "Not prepared" },
  preparing: { tone: "info", label: "Preparing…" },
  ready: { tone: "ok", label: "Ready" },
  failed: { tone: "danger", label: "Failed" }
};

export interface WindowsImageView {
  tone: Tone;
  label: string;
  message: string | null;
  /** "Prepare Windows image" is offered: the provider is connected and no image is ready or building. */
  canPrepare: boolean;
}

export function windowsImageView(provider: BoxProviderInfo): WindowsImageView | null {
  const image = provider.windowsImage;
  if (!image) return null;
  return {
    ...WINDOWS_IMAGE_LABEL[image.state],
    message: image.message,
    canPrepare: provider.status === "connected" && (image.state === "none" || image.state === "failed")
  };
}

// ---------------------------------------------------------------------------
// The card's header
// ---------------------------------------------------------------------------

/** "2 boxes running · $0.12/h · $14.20 this month" (estimates), or null before the boxes load. */
export function totalsLine(totals: BoxesTotals | null): string | null {
  if (!totals) return null;
  const count = `${totals.activeCount} ${totals.activeCount === 1 ? "box" : "boxes"} running`;
  return `${count} · ${formatHourlyRate(totals.hourlyUsd)} · ${formatUsd(totals.monthEstimatedUsd)} this month`;
}
