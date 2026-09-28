/**
 * The repository picker the New Project dialog uses, for workflows: pick one of the git account's
 * repositories (searchable), or paste a URL. With no account that has repository access, only the
 * URL field shows, with a note on why the list is missing.
 *
 * `WorkspaceRepoPicker` resolves the account from a workspace (the account a temporary project's
 * clone uses); `RepoPicker` takes the account directly (a git trigger's "Read it as").
 */

import React, { useEffect, useMemo, useState } from "react";
import { Check, FolderGit2, Loader2, Lock, Search } from "lucide-react";

import { cn } from "../../lib/cn";
import { useAppStore } from "../../store/app";
import type { AccountSummary, RepoSummary } from "../../types";
import { Dropdown, DropdownEmpty, DropdownItem } from "../ui/dropdown";
import { Input } from "../ui/input";

const URL_PLACEHOLDER: Record<string, string> = {
  github: "https://github.com/owner/repo, git@github.com:owner/repo.git, or owner/repo",
  "bitbucket-cloud": "https://bitbucket.org/workspace/repo, git@bitbucket.org:workspace/repo.git, or workspace/repo",
  "bitbucket-server": "https://host/scm/KEY/repo.git, ssh://git@host:7999/KEY/repo.git, or KEY/repo"
};

/** Repositories per account for this page's life: every picker of one account shares one load. */
const repoCache = new Map<string, Promise<RepoSummary[]>>();

function useAccountRepos(account: AccountSummary | null): {
  repos: RepoSummary[] | null;
  loading: boolean;
  error: string | null;
} {
  const listRepos = useAppStore((s) => s.listRepos);
  const [state, setState] = useState<{ repos: RepoSummary[] | null; loading: boolean; error: string | null }>({
    repos: null,
    loading: false,
    error: null
  });
  const accountId = account?.repoAccess ? account.id : null;
  useEffect(() => {
    if (!accountId) {
      setState({ repos: null, loading: false, error: null });
      return;
    }
    let active = true;
    let pending = repoCache.get(accountId);
    if (!pending) {
      pending = listRepos(accountId);
      repoCache.set(accountId, pending);
      // A failed load is not cached: the next open tries again.
      pending.catch(() => repoCache.delete(accountId));
    }
    setState({ repos: null, loading: true, error: null });
    pending
      .then((repos) => {
        if (active) setState({ repos, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (active) {
          setState({ repos: null, loading: false, error: err instanceof Error ? err.message : "Could not load repositories." });
        }
      });
    return () => {
      active = false;
    };
  }, [accountId, listRepos]);
  return state;
}

/** The repo a URL names, when it is one of the listed repos' clone URLs. */
export function repoForUrl(repos: RepoSummary[] | null, url: string): RepoSummary | null {
  const value = url.trim();
  if (!repos || !value) return null;
  return repos.find((repo) => repo.sshUrl === value || repo.httpsUrl === value || repo.fullName === value) ?? null;
}

export interface RepoPickerProps {
  /** The git account whose repositories are listed (null: URL only). */
  account: AccountSummary | null;
  /** The clone URL (a picked repo is stored as its SSH URL, as New Project clones it). */
  value: string;
  onChange: (url: string, repo: RepoSummary | null) => void;
  /** Why there is no list, shown under the URL field when `account` cannot list repositories. */
  noAccountHint?: string;
  /** Larger touch targets (phones). */
  touch?: boolean;
  /** Label above the list. */
  label?: string;
  urlInputClassName?: string;
}

export const RepoPicker: React.FC<RepoPickerProps> = ({
  account,
  value,
  onChange,
  noAccountHint,
  touch = false,
  label = "Repository",
  urlInputClassName
}) => {
  const canList = !!account?.repoAccess;
  const { repos, loading, error } = useAccountRepos(account);
  const [query, setQuery] = useState("");
  const picked = repoForUrl(repos, value);
  const filtered = useMemo(() => {
    const list = repos ?? [];
    const q = query.trim().toLowerCase();
    return q ? list.filter((repo) => repo.fullName.toLowerCase().includes(q)) : list;
  }, [repos, query]);
  const typedUrl = picked ? "" : value;

  return (
    <div className="space-y-3">
      {canList ? (
        <div className="space-y-1.5">
          <div className="text-xs text-neutral-400">{label}</div>
          <Dropdown
            width="w-[min(26rem,calc(100vw-2rem))]"
            trigger={
              <span
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-md border border-neutral-700 bg-neutral-900 px-2.5 text-sm text-neutral-200",
                  touch ? "h-10" : "h-8"
                )}
              >
                <span className={cn("truncate", !picked && "text-neutral-400")}>
                  {picked ? picked.fullName : "Select a repository…"}
                </span>
                {loading ? <Loader2 size={13} aria-hidden className="shrink-0 animate-spin text-neutral-500" /> : null}
              </span>
            }
          >
            <div className="px-1 pb-1 pt-0.5">
              <div className="flex items-center gap-1.5 rounded border border-neutral-700 bg-neutral-900 px-2">
                <Search size={13} aria-hidden className="shrink-0 text-neutral-500" />
                <input
                  autoFocus
                  value={query}
                  placeholder="Search repositories…"
                  aria-label="Search repositories"
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-7 w-full bg-transparent text-sm text-neutral-100 placeholder:text-neutral-500 focus:outline-none"
                />
              </div>
            </div>
            {loading ? (
              <DropdownEmpty>
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin" /> Loading…
                </span>
              </DropdownEmpty>
            ) : null}
            {!loading && error ? <DropdownEmpty>{error}</DropdownEmpty> : null}
            {!loading && !error && filtered.length === 0 ? <DropdownEmpty>No repositories found</DropdownEmpty> : null}
            {!loading && !error
              ? filtered.map((repo) => (
                  <DropdownItem
                    key={repo.fullName}
                    icon={
                      picked?.fullName === repo.fullName ? (
                        <Check size={14} />
                      ) : repo.private ? (
                        <Lock size={12} />
                      ) : (
                        <FolderGit2 size={12} />
                      )
                    }
                    onClick={() => onChange(repo.sshUrl, repo)}
                  >
                    {repo.fullName}
                  </DropdownItem>
                ))
              : null}
          </Dropdown>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <div className="text-xs text-neutral-400">{canList ? "…or paste a URL" : label}</div>
        <Input
          value={typedUrl}
          spellCheck={false}
          autoCapitalize="off"
          aria-label={canList ? "Repository URL" : label}
          placeholder={URL_PLACEHOLDER[account?.provider ?? "github"] ?? URL_PLACEHOLDER.github}
          onChange={(event) => onChange(event.target.value, null)}
          className={cn(touch && "h-10", urlInputClassName)}
        />
        {!canList && noAccountHint ? <p className="text-[11px] leading-snug text-neutral-500">{noAccountHint}</p> : null}
      </div>
    </div>
  );
};

/** The git account a workspace is linked to (the one its clones use), or null. */
export function useWorkspaceGitAccount(workspace: string): AccountSummary | null {
  const workspaces = useAppStore((s) => s.workspaces);
  const accounts = useAppStore((s) => s.accounts);
  return useMemo(() => {
    const id = workspaces.find((ws) => ws.name === workspace)?.gitAccountId;
    return (id && accounts.find((account) => account.id === id)) || null;
  }, [workspaces, accounts, workspace]);
}

export interface WorkspaceRepoPickerProps extends Omit<RepoPickerProps, "account" | "noAccountHint"> {
  workspace: string;
}

/** A temporary project's clone: the repositories of the workspace's git account. */
export const WorkspaceRepoPicker: React.FC<WorkspaceRepoPickerProps> = ({ workspace, ...rest }) => {
  const account = useWorkspaceGitAccount(workspace);
  const hint = !workspace
    ? "Choose a workspace to list its git account's repositories."
    : !account
      ? "This workspace has no git account linked — link one (Settings → Git accounts) to pick a repository and to clone private ones."
      : "The workspace's git account has no repository access (no token) — add one in Settings to list its repositories.";
  return <RepoPicker account={account} noAccountHint={hint} {...rest} />;
};
