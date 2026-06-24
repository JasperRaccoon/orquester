import React from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Download,
  GitBranch,
  RefreshCw,
  Upload
} from "lucide-react";
import type { GitBranchesResponse, GitStatusResponse } from "@orquester/api";
import { cn } from "../../lib/cn";
import { AdaptiveMenu, Button, DropdownEmpty, DropdownItem, DropdownLabel, IconButton } from "../ui";

export interface GitHeaderProps {
  repoName: string;
  status: GitStatusResponse | null;
  branches: GitBranchesResponse | null;
  /** e.g. "fetch" | "pull" | "push" | "checkout" while in-flight. */
  busy: string | null;
  onRefresh: () => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onCheckout: (branch: string) => void;
}

/** Coarse "Last fetched …" label from an ISO timestamp (no external dep). */
const lastFetchedLabel = (iso: string | null): string => {
  if (!iso) {
    return "Never fetched";
  }
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "Never fetched";
  }
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) {
    return "Last fetched just now";
  }
  if (mins < 60) {
    return `Last fetched ${mins}m ago`;
  }
  const hours = Math.round(mins / 60);
  if (hours < 24) {
    return `Last fetched ${hours}h ago`;
  }
  return `Last fetched ${Math.round(hours / 24)}d ago`;
};

/**
 * GitHub-Desktop-style repo header: repo name + current-branch dropdown on the
 * left, and a Fetch/Pull/Push cluster (with ahead/behind and last-fetched) plus
 * a manual refresh on the right. The primary sync action shifts to Pull when
 * behind, Push when ahead, otherwise Fetch.
 */
export const GitHeader: React.FC<GitHeaderProps> = ({
  repoName,
  status,
  branches,
  busy,
  onRefresh,
  onFetch,
  onPull,
  onPush,
  onCheckout
}) => {
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const branchLabel = status?.detached
    ? "detached HEAD"
    : status?.branch ?? branches?.current ?? "no branch";
  const locals = branches?.local ?? [];
  const isBusy = busy !== null;

  // Which sync action to emphasise (matches GitHub Desktop's single primary CTA).
  const primary = behind > 0 ? "pull" : ahead > 0 ? "push" : "fetch";

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-800 px-2">
      {/* Repo name */}
      <span className="hidden truncate text-xs font-medium text-neutral-300 sm:block" title={repoName}>
        {repoName}
      </span>
      <span className="hidden h-4 w-px shrink-0 bg-neutral-800 sm:block" />

      {/* Current-branch dropdown */}
      <AdaptiveMenu
        title="Switch branch"
        align="left"
        width="w-64"
        trigger={
          <span
            className={cn(
              "flex h-7 max-w-[14rem] items-center gap-1.5 rounded-md px-2 text-sm text-neutral-200",
              "transition-colors hover:bg-neutral-800 hover:text-neutral-100",
              isBusy && "pointer-events-none opacity-50"
            )}
          >
            <GitBranch size={14} className="shrink-0 text-neutral-500" />
            <span className="truncate" title={branchLabel}>
              {branchLabel}
            </span>
            <ChevronDown size={13} className="shrink-0 text-neutral-500" />
          </span>
        }
      >
        <DropdownLabel>Branches</DropdownLabel>
        {locals.length === 0 && <DropdownEmpty>No branches</DropdownEmpty>}
        {locals.map((branch) => (
          <DropdownItem
            key={branch.name}
            icon={branch.current ? <Check size={14} /> : <GitBranch size={14} />}
            onClick={() => onCheckout(branch.name)}
            disabled={branch.current || isBusy}
          >
            {branch.name}
          </DropdownItem>
        ))}
      </AdaptiveMenu>

      <div className="flex-1" />

      {/* Ahead/behind */}
      {(ahead > 0 || behind > 0) && (
        <span className="hidden items-center gap-2 text-xs text-neutral-400 sm:flex" title={`${ahead} ahead, ${behind} behind`}>
          {ahead > 0 && (
            <span className="flex items-center gap-0.5">
              <ArrowUp size={12} />
              {ahead}
            </span>
          )}
          {behind > 0 && (
            <span className="flex items-center gap-0.5">
              <ArrowDown size={12} />
              {behind}
            </span>
          )}
        </span>
      )}

      {/* Fetch / Pull / Push cluster */}
      <div className="flex items-center">
        <Button
          size="sm"
          variant={primary === "fetch" ? "default" : "ghost"}
          disabled={isBusy}
          onClick={onFetch}
          className="rounded-r-none"
          aria-label="Fetch"
          title={lastFetchedLabel(status?.lastFetched ?? null)}
        >
          <Download size={13} />
          <span className="hidden sm:inline">{busy === "fetch" ? "Fetching…" : "Fetch"}</span>
        </Button>
        <Button
          size="sm"
          variant={primary === "pull" ? "default" : "ghost"}
          disabled={isBusy}
          onClick={onPull}
          className="rounded-none border-x border-neutral-800"
          aria-label="Pull"
        >
          <ArrowDown size={13} />
          <span className="hidden sm:inline">{busy === "pull" ? "Pulling…" : "Pull"}</span>
          {behind > 0 && <span className="text-neutral-500">{behind}</span>}
        </Button>
        <Button
          size="sm"
          variant={primary === "push" ? "default" : "ghost"}
          disabled={isBusy}
          onClick={onPush}
          className="rounded-l-none"
          aria-label="Push"
        >
          <Upload size={13} />
          <span className="hidden sm:inline">{busy === "push" ? "Pushing…" : "Push"}</span>
          {ahead > 0 && <span className="text-neutral-500">{ahead}</span>}
        </Button>
      </div>

      <IconButton
        label="Refresh"
        onClick={onRefresh}
        disabled={isBusy}
        className={cn(busy === "checkout" && "animate-spin")}
      >
        <RefreshCw size={13} />
      </IconButton>
    </div>
  );
};
