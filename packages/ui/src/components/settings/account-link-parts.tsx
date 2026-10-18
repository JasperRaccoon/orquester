import React from "react";
import { ExternalLink } from "lucide-react";
import { ApiError } from "../../lib/api-client";

/** The pieces the account sign-in links (device code, Claude) share. */

export const formatStamp = (iso: string | null): string => {
  if (!iso) return "unknown";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
};

/** A failed request's message; a daemon refusal (409, 400, 502) carries its own reason. */
export const linkErrorMessage = (e: unknown): string =>
  e instanceof ApiError ? (e.serverMessage ?? e.message) : e instanceof Error ? e.message : String(e);

/** One numbered step of a sign-in. */
export const LinkStep: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <li className="min-w-0 space-y-2 rounded-lg border border-neutral-800 bg-neutral-950/60 p-3">
    <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">{title}</p>
    {children}
  </li>
);

/** The sign-in page to open, in a new tab. */
export const LinkOpenUrl: React.FC<{ url: string }> = ({ url }) => (
  <a
    href={url}
    target="_blank"
    rel="noreferrer"
    className="inline-flex max-w-full items-center gap-1.5 text-sm text-info hover:underline"
  >
    <ExternalLink size={13} className="shrink-0" />
    <span className="truncate">{url}</span>
  </a>
);
