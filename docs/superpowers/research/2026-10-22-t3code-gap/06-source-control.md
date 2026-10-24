# 06: Source control, diffs, and pull requests (T3 Code vs Orquester)

Date: 2026-10-22. T3 at `ed9b7ca9` (range `e8d87689..ed9b7ca9` = "(new)"). Orquester at `dcab9eed`.
Paths: `T3/` = `t3code_codebase/`; Orquester paths are repo-relative.

## Summary

T3 is a review tool for pull requests that also runs agents. It has a host-neutral source-control
layer covering 7 hosts, a full PR page (list, detail, code, timeline, AI review guide, stacks,
merge), per-thread git worktrees, one-click commit/push/PR with AI-written messages, and a diff
engine (`@pierre/diffs`) with workers, highlighting, split view, and line comments.

Orquester's git support is a single-repo **GitHub-Desktop-style Git tab**: status, stage, commit,
discard, stash, history graph, fetch/pull/push, checkout. It adds per-turn checkpoint diffs,
workflow git triggers, GitHub link previews, and per-workspace git identities for GitHub and
Bitbucket Cloud/Server. It has **no PR creation or review, no worktrees, and a plain-text diff
renderer**. Two real bugs in that renderer surfaced during this comparison (see §2.1).

---

## 1. They have, we don't

| Feature | T3 evidence (paths) | Orquester status (evidence) | User value | Port effort |
|---|---|---|---|---|
| **Source-control provider abstraction for PRs** (list/get/diff/comment/review/merge/labels/reviewers/reactions/resolve) over GitHub, GitLab, Bitbucket Cloud, Azure DevOps, Forgejo/Gitea, GitCafe | `T3/packages/source-control-core/src/server/PullRequestProvider.ts:260-560` (`PullRequestProviderApi`: `listChangeRequests`, `getDiff`, `getFileStats`, `runAction`, `comment`, `submitReview`, `setReviewerRequest`, `setLabels`, `replyToThread`, `setThreadResolution`…); one package per host `T3/packages/source-control-{github,gitlab,bitbucket,azure-devops,forgejo,gitcafe}` | **Partial.** `apps/daemon/src/providers/types.ts:204-251` `GitProvider` covers identity, SSH keys, repo list/create, clone URLs, and `listPullRequests` (read-only, used by workflow triggers). Hosts: GitHub and Bitbucket Cloud/Server only (`packages/api/src/index.ts:240`). No GitLab, Azure, or Forgejo. No PR write operations. | H | L |
| **Pull Requests page**: list grouped by scope, detail with Summary/Timeline/Code/Guide tabs, checks popover, reviewer and label pickers, title/body editing, review form, comment threads, reactions | `T3/apps/web/src/components/pullRequest/PullRequestsPage.tsx`, `PullRequestDetailPanel.tsx`, `PullRequestCodeTab.tsx`, `PullRequestTimelineTab.tsx`, `PullRequestReviewForm.tsx`, `PullRequestChecksPopover.tsx`; server `T3/apps/server/src/pullRequest/PullRequestService.ts` | **Missing.** The only PR surface is the chat link pill/hover card (`packages/ui/src/components/agent-chat/forge-links/ForgeLinkPill.tsx`, `apps/daemon/src/github-links/service.ts`), which is GitHub-only and read-only. | H | L |
| **PR +/- split into code / tests / mocks / generated / docs** (new) | Classifier `T3/packages/shared/src/changedFileKind.ts:1-76` (path-only regex/dir sets); aggregation `T3/apps/server/src/pullRequest/pullRequestChangeBreakdown.ts`; UI `T3/apps/web/src/components/pullRequest/PullRequestChangeBreakdownStat.tsx`; mobile filters `T3/apps/mobile/src/features/pull-requests/pullRequestFileFilters.ts` (commits 92a6f6d7, 962428df) | **Missing.** Turn changed-files card shows only +/- per file and total (`packages/ui/src/components/agent-chat/timeline/rows/ChangedFilesCard.tsx:27-40`, `timeline/diff-tree.ts`). | M | **S** |
| **Commit / push / create PR in one action**, with optional new feature branch and file subset | `T3/packages/contracts/src/git.ts:18-26,126-135` (`GitStackedAction`: `commit`, `push`, `create_pr`, `commit_push`, `commit_push_pr`; `featureBranch`, `filePaths`); `T3/apps/server/src/git/GitManager.ts:3097-3170`; UI `T3/apps/web/src/components/GitActionsControl.tsx` + `.logic.ts:149-332` | **Partial.** Separate commit and push only (`apps/daemon/src/git.ts:684,889`). Push never sets an upstream: `git push` fails on a new branch and the stderr is shown (`git.ts:886-895`). No branch creation (`checkout` only, `git.ts:897`). No PR creation. | H | M |
| **AI commit messages, PR titles/bodies, branch names** (style setting, "repository conventions", thread context in PR body (new, #18291)) | `T3/apps/server/src/textGeneration/TextGeneration.ts:31-70` (`generateCommitMessage`, `generatePrContent`, `generateBranchName`); call sites `GitManager.ts:2139,2338` | **Missing.** The commit box is manual. The only "suggestion" is a GitHub-Desktop "Update <file>" default (`packages/ui/src/components/git/ChangesPanel.tsx:31-45`). | H | M |
| **Per-thread git worktrees** (env mode local/worktree, base branch picker, start-from-origin, setup-script stages, cleanup on archive, Windows junction safety) | `T3/packages/contracts/src/environment.ts:51` (`ThreadEnvMode`); `T3/packages/contracts/src/worktreeSetup.ts` (stages fetch/checkout/submodules/setup-script/agent); `T3/apps/server/src/worktreesDirectory.ts`; `T3/apps/server/src/vcs/worktreeRemoval.ts`; UI `T3/apps/web/src/components/BranchToolbarEnvModeSelector.tsx`, `WorktreeBaseBranchPicker.tsx`, `chat/WorktreeSetupCard.tsx`, `worktreeCleanup.ts` | **Missing (deferred by design).** Spec `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md:53,5219` lists per-thread worktrees as a follow-up, and `packages/ui/src/lib/agent-chat/contracts.ts:455` dropped the `worktree-setup` row. Today's isolation alternatives are a sibling **clone** project in a repo group (`packages/ui/src/components/sidebar/NewProjectModal.tsx:921-925`; spec `2026-10-18-repo-grouped-projects-design.md:69`, "No git worktrees, branch creation or PR linking") or a box VM. | H | L |
| **Agent worktree MCP**: `t3_worktree_handoff` moves a running thread into a new worktree/branch and continues; `delegate_task isolation:"worktree"` for children | `T3/apps/server/src/mcp/toolkits/worktree/tools.ts:28-63`; `T3/packages/contracts/src/worktreeMcp.ts:11-40`; `T3/packages/contracts/src/orchestratorMcp.ts:168-173` | **Missing.** `create_session`/`fork_session` share the parent's checkout. | M | L (needs worktrees first) |
| **Thread diff MCP tool with branch-range vs merge base** (new, #15464) | `t3_thread_diff` in `T3/apps/server/src/mcp/toolkits/worktree/tools.ts` (working-tree **and** `branch-range` vs `baseRef` merge base, 500-file stats, char cap) | **Partial.** `get_git_state view:"diff"` gives the working tree vs HEAD only (`apps/daemon/src/mcp/tools/git.ts:56-110`). `get_turn_diff` gives one turn (`apps/daemon/src/mcp/tools/sessions.ts:406`). Nothing compares the branch with its base. | M | S |
| **Branch-vs-base diff in the UI** (pick base ref, local/remote toggle) | `T3/apps/web/src/components/DiffPanel.tsx:275-342,638-714` (scopes `unstaged` / `branch`, `buildBaseRefChoices`) | **Missing.** The Git tab shows only per-file working-tree diffs (`ChangesPanel.tsx:111-140`) and per-commit diffs (HistoryPanel). | M | S |
| **Diff-line comments sent to the agent** (select lines in any diff, annotate, inserted into composer as a fenced context block) | `T3/apps/web/src/components/diffs/AnnotatableCodeView.tsx`, `DiffCommentAnnotation.tsx`; `T3/apps/web/src/reviewCommentContext.ts:1-60` | **Missing for diffs.** The delivery mechanism exists: `packages/ui/src/lib/composer-inbox.ts` (used by the browser element picker). No diff surface uses it. | H | M |
| **Linked PRs per thread** (badge in sidebar/header, panel, `link_pull_request`, auto-link on create, auto-settle when merged) | `T3/apps/server/src/mcp/toolkits/pullRequests/tools.ts:273-315`; `T3/apps/web/src/components/pullRequest/ThreadPullRequestsPanel.tsx`, `chat/ThreadDetailsPrRow.tsx`; `T3/apps/server/src/git/linkCreatedPullRequest.ts` | **Missing.** PR URLs in a transcript render as pills only (`packages/api/src/forge-links.ts`). No session↔PR record. | M | M |
| **`watch_pull_request`**: wakes the agent on failed check, required checks passing, external review/comment, or conflict. ETag/conditional polling, stop rules | `T3/apps/server/src/mcp/toolkits/pullRequests/tools.ts:317-345`; `T3/apps/server/src/orchestration-v2/pullRequestWatch.ts`, `PullRequestWatchReactor.ts`; `T3/packages/source-control-github/src/server/gitHubConditionalChecks.ts` | **Partial.** Workflow git triggers fire on PR `opened/updated/merged/closed` (`apps/daemon/src/workflows/triggers/git-events.ts:218-275`) with conditional listing (`providers/types.ts:135-160`). Nothing fires on checks, reviews, comments, or mergeability, and nothing wakes the chat that opened the PR. | H | M |
| **Mark files viewed** with host revisions (GitHub native; server-kept for others; "Changed" after push) | `T3/docs/internals/pull-request-file-revisions.md`; `T3/apps/server/src/pullRequest/pullRequestViewedFiles.ts`; `T3/apps/server/src/persistence/PullRequestFilesViewed.ts`; `T3/packages/source-control-core/src/server/diffFileRevisions.ts` | **Missing** (no PR review). The idea also applies to turn diffs. | M | M |
| **AI review guides** (beta): ordered stops, "look closely" calls, ask-about-this-stop threads, MCP `write_pull_request_guides` / `read_pull_request_guide` | `T3/apps/server/src/pullRequest/PullRequestReviewGuideService.ts`; `T3/apps/web/src/components/pullRequest/guide/*`; `tools.ts:378-400` | **Missing.** | M | L |
| **Work on a PR** (prepare thread from a PR into local or worktree checkout; "Check out here" protects local work) | `T3/packages/contracts/src/git.ts:55,164-170` (`GitPreparePullRequestThreadInput`); `GitManager.ts:158` `preparePullRequestThread`; fix 23b550dd | **Partial.** A project can be cloned at a ref (`apps/daemon/src/project-clone-ref-route.test.ts`, spec §5.10), but nothing resolves a PR or creates a thread from one. | M | M |
| **Merge flows**: merge method memory, auto-merge, merge queue, revert PR, fork-workflow approval, GitHub stacks (merge/rebase stack), "remove agent credits" from merge messages (updated, new: b5a226e4) | `T3/packages/source-control-github/src/server/githubStackActions.ts`, `githubStackRebase.ts`; `T3/packages/source-control-core/src/server/mergeMessage.ts:14-40` (`removeAgentCredits`) | **Missing.** | M | L |
| **Turn diff that leaves out files Git brought in** (pull/merge/rebase during a turn excluded; conflict fixes kept via `--diff-merges=remerge`) | `T3/apps/server/src/vcs/GitVcsDriver.ts:1136` (checkpoint commit parented on HEAD), `:1333-1378` `listAuthoredPaths`; `T3/apps/server/src/checkpointing/Diffs.ts:38-47` `isGitImport` | **Missing.** Orquester checkpoint commits have no parent (`apps/daemon/src/agent-host/checkpoints/capture.ts:253`), so HEAD movement cannot be detected. A turn that ran `git pull` shows every pulled file as its own change. | M | S–M |
| **Restore files on checkpoint revert** | `T3/apps/server/src/checkpointing/CheckpointStore.ts:58,118-122` `restoreCheckpoint` | **Missing (by design so far).** `apps/daemon/src/agent-host/checkpoints/service.ts:1-10` says "there is no restore path at all". Spec lists "file restore on revert" as a follow-up (`2026-09-21-agent-chat-gui-design.md:5219`). | M | M |
| **Branch toolbar PR badge** (status stream carries the current branch's open PR) | `T3/packages/contracts/src/git.ts:251` (`pr` on VCS status); `T3/apps/server/src/vcs/VcsStatusBroadcaster.ts` | **Missing.** `GitHeader.tsx` shows branch and ahead/behind only. | L–M | S |
| **Mobile PR review** with offline cache, bounded native diff payloads | `T3/apps/mobile/src/features/pull-requests/*`; fix 6fc3c9ee | **Missing** (no PR review on any client). | L | L |

---

## 2. They do it better

### 2.1 Diff rendering (largest quality gap, plus two bugs on our side)

**T3:** `@pierre/diffs` code view (`T3/apps/web/src/components/DiffPanel.tsx:1-120, 1100-1145`):
- Split/stacked toggle (`:888-905`), word wrap, ignore-whitespace toggle, file tree sidebar
  (`components/diffs/DiffFileTree.tsx`), sticky file headers, collapse one or all files, and
  click-header-to-open-in-editor with a context menu.
- Shiki-class syntax highlighting runs in a **shared worker pool** (`components/DiffWorkerPoolProvider.tsx:21-60`):
  2–6 workers, an AST LRU of 240, `tokenizeMaxLineLength: 1000`, and a 30 s idle teardown.
- **Lazy per-file patch loading** (`components/diffs/useReviewFilePatches.ts`), expanded context
  from full file contents (`lib/diffFileContents.ts`), and a truncation banner.
- Collapsed files defer highlighting until opened (2c0a78a0, new).
- Server diff caps apply across all batches (87ae8d58, new), and status refreshes skip expensive
  diff minimization (370b9ae7, new).

**Orquester:** `packages/ui/src/components/git/DiffView.tsx` (76 lines) plus `git-diff.ts` (95 lines):
- Unified only, no syntax highlighting, no virtualization, no wrap toggle.
- Every row is a React `div`, so a large patch renders every line at once.

Two bugs verified by running `parseUnifiedDiff` against a sample patch:
1. **The turn diff loses file names.** `TurnDiffBody` (`packages/ui/src/components/agent-chat/timeline/TurnDiffModal.tsx:85-96`)
   passes the **whole multi-file** checkpoint patch to `DiffView`. `parseUnifiedDiff` drops every
   `diff --git`/`---`/`+++` line as meta (`git-diff.ts:27-36,78`). The modal and the right-rail
   `TurnDiffInline` therefore show hunks from several files with no file boundary or name.
2. **One binary file blanks the whole turn diff.** The checkpoint diff runs `git diff --patch`
   without `--binary` (`apps/daemon/src/agent-host/checkpoints/service.ts:606-623`), so a binary
   file appears as `Binary files … differ`. `BINARY_MARKER` (`git-diff.ts:46`, `/m` flag) is tested
   against the entire patch (`:50`). A turn that touches one PNG renders as "Binary file not shown"
   for all files.
   - Smaller issue: turn diffs always ignore whitespace. The transport defaults
     `ignoreWhitespace=1` (`packages/ui/src/lib/agent-chat/transport.ts:416-420`) and no UI toggle
     exists, so indentation-only changes (Python, YAML) are invisible.

   `InlineDiff.tsx` already splits by file with `splitUnifiedDiff`. The modal should do the same.

### 2.2 Per-turn diff navigation
- **T3:** the diff panel has a turn picker and a working-tree/branch scope selector in one place
  (`DiffPanel.tsx:275-302`). It also has a review-section id per turn, so comments attach to a turn.
- **Orquester:** turn diffs open in a modal from the changed-files card or right-rail history.
  There is no way to move between turns or compare a turn with the branch. The data layer is
  equivalent: both use hidden checkpoint refs, and ours was ported from T3 (`checkpoints/refs.ts`).

### 2.3 Git status freshness and PR context
- **T3:** `VcsStatusBroadcaster.ts` (768 lines) pushes local and remote status separately.
  - Passive observers get cached remote status without driving refresh (`git.ts:113-117` `includeRemote`).
  - Status carries the current branch's PR.
- **Orquester:** `GitView.tsx:21-40` polls status every 3 s, drops to a 30 s backstop once a
  `project.git.changed` push arrives, and runs a 60 s background fetch.
  - This is reasonable, but it is per-tab polling and has no PR context.

### 2.4 Commit flow ergonomics
- **T3:** `GitActionsControl.logic.ts:149-332` computes one primary action from state.
  - The action can be Commit, Commit & push, Push, Publish repository, Pull, or Sync ref.
  - Disabled-state hints explain why (for example "Commit or stash local changes before pushing", `GitActionsControl.tsx:257`).
  - There is a guard on actions that target the default branch (`pendingDefaultBranchAction`, `:1366`).
- **Orquester:** separate buttons. `push` with no upstream fails and shows git's stderr (`apps/daemon/src/git.ts:886-895`).

---

## 3. Worth copying (ranked by value/effort)

1. **Fix and upgrade the turn-diff viewer (S, H).**
   - In `packages/ui/src/components/agent-chat/timeline/TurnDiffModal.tsx`, render per file through
     `splitUnifiedDiff` (`timeline/unified-diff.ts:40`) as `InlineDiff` does, with a file header for each.
   - Move the binary check per file in `components/git/git-diff.ts` so it no longer runs on the whole patch.
   - Add an ignore-whitespace toggle that passes `{ ignoreWhitespace }` to `agentChatTurnDiff`.
   - Optionally add `--binary`-free stat rows for binary files from the checkpoint numstat.
   - No T3 code is needed. This is a bug fix.

2. **Change-kind breakdown (S, M) (new in T3).**
   - Copy `T3/packages/shared/src/changedFileKind.ts` verbatim with MIT attribution to
     `packages/api/src/changed-file-kind.ts`, so the daemon and UI share it.
   - Use it in three places:
     - (a) `ChangedFilesCard.tsx`, with a code/tests/docs split on the turn total (the numstat already gives per-file +/-);
     - (b) the Git tab file list header (`components/git/FileStatusList.tsx`);
     - (c) the GitHub PR hover card. For (c), extend `apps/daemon/src/github-links/service.ts`
       with a capped `GET /repos/{o}/{r}/pulls/{n}/files` read when the card opens. T3 does the same lazily, on hover intent (`PullRequestChangeBreakdownStat.tsx`).
   - Also use it to sort the turn file tree so code comes before tests and docs.

3. **Diff renderer swap to `@pierre/diffs` (M, H).**
   - Replace `components/git/DiffView.tsx` with a wrapper around `@pierre/diffs/react` (CodeView/FileDiff):
     - one shared `WorkerPoolManager` provider, cribbed from `T3/apps/web/src/components/DiffWorkerPoolProvider.tsx`;
     - split/unified and wrap preferences in the zustand app store (`packages/ui/src/store/app.ts`).
   - Crib file collapse and the "collapsed defers highlighting" behavior from
     `T3/apps/web/src/lib/diffCollapse.ts` and `components/diffs/DiffFileTree.tsx`.
   - Theme tokens map to the existing `--diff-add-*`/`--diff-del-*`.
   - Check both `apps/web` and `apps/desktop` bundling for the `?worker` import.
   - Check `@pierre/diffs`' own license before adding it; it is a third-party package, separate from T3's MIT code.

4. **Diff-line comments into the composer (M, H).**
   - Once (3) is in place, add line-range selection and a small annotation form, modelled on
     `T3/apps/web/src/components/diffs/AnnotatableCodeView.tsx`.
   - Deliver a fenced block (`formatReviewCommentFence`, `T3/apps/web/src/reviewCommentContext.ts:52-60`)
     through the existing `deliverToComposerDraft` (`packages/ui/src/lib/composer-inbox.ts`), which
     the browser picker already uses.
   - Works for turn diffs and Git tab diffs alike. This is the main "review the agent's work" loop T3 has and we lack.

5. **Commit & push & PR with generated text (M, H).**
   - Daemon:
     - add `pushPublish` (`git push -u origin HEAD`) and `createBranch` to `apps/daemon/src/git.ts`;
     - add `createPullRequest` to `GitProvider` (`apps/daemon/src/providers/types.ts`) for GitHub (`POST /repos/{o}/{r}/pulls`) and both Bitbucket variants, using the per-workspace account token the daemon already holds.
   - API contracts: `packages/api`.
   - UI: a primary-action button in `components/git/GitHeader.tsx`, with the state machine cribbed from `T3/apps/web/src/components/GitActionsControl.logic.ts`.
   - For messages, run a one-shot prompt through the agent host with a cheap model. Crib the prompts
     from `T3/apps/server/src/textGeneration/ClaudeTextGeneration.ts` and the input shaping from
     `GitManager.ts:2139,2338` (diff summary, recent commit subjects, AGENTS.md conventions, thread context).

6. **Branch-range diff for agents and UI (S, M) (T3 tool new).**
   - Add `view:"compare"` with `baseRef` (default: upstream default branch, `git merge-base`) to
     `get_git_state` in `apps/daemon/src/mcp/tools/git.ts`, backed by a new `/api/git/compare` route.
   - Add a "vs base" scope to the Git tab.
   - Crib the base-ref choice logic from `T3/apps/web/src/lib/baseRefChoices.ts` and the tool shape from `t3_thread_diff`.

7. **Authored-paths filter for turn diffs (S–M, M).**
   - Parent checkpoint commits on HEAD in `apps/daemon/src/agent-host/checkpoints/capture.ts:253`
     (`commit-tree … -p HEAD` when HEAD exists).
   - Port `listAuthoredPaths` (`T3/apps/server/src/vcs/GitVcsDriver.ts:1333-1378`) and `isGitImport`
     (`T3/apps/server/src/checkpointing/Diffs.ts:38-47`) into `checkpoints/service.ts` so the numstat
     and the card drop files that a pull, merge, or rebase brought in.
   - Existing parentless refs must keep working: when there is no parent, `listAuthoredPaths` returns `null`, so nothing is filtered.

8. **PR watch on the chat (M, H).**
   - Extend `apps/daemon/src/workflows/triggers/git-events.ts` and `providers/github.ts` with check-suite, review, and mergeability fingerprints (crib `T3/apps/server/src/orchestration-v2/pullRequestWatch.ts` and `gitHubConditionalChecks.ts`).
   - Expose `watch_pull_request` in the MCP catalog. Delivery should wake the session through the existing lineage delivery queue (`apps/daemon/src/agent-chat/lineage.ts`), not a new loop.
   - Copy T3's stop rules: merged/closed, 10 comment-only wakes, 8 failed reads.

Larger items to consider after these: per-thread worktrees (already a planned follow-up; crib
`T3/apps/server/src/vcs/worktreeRemoval.ts` and the `worktreeSetup` stage contract), and a PR
page. The PR page is the largest item. It is a product decision, not a port.

---

## 4. We do it better / they lack

- **Classic git client.** Orquester has stage/unstage per file, discard, a stash section, and a
  commit history with a **graph** and commit detail (`packages/ui/src/components/git/HistoryPanel.tsx`,
  `graph.ts`, `StashSection.tsx`, `apps/daemon/src/git.ts:466-830`). T3 has no repository history
  view, no stash UI, and no discard. Its git UI is centered on actions and PRs.
- **Git hardening.** Every daemon-run git pins `core.fsmonitor=false` and `core.hooksPath=/dev/null`
  for reads, and runs user hooks only for user-started commands (`apps/daemon/src/git.ts:940-980`).
  Working-diff output is pinned so user config cannot reshape it (`WORKING_DIFF_CONFIG`, `:910-925`).
  No equivalent was found in T3's `GitVcsDriverCore.ts`.
- **Workspace git identities.** Per-workspace accounts with generated SSH keys auto-uploaded to the
  host, `includeIf`-scoped gitconfig, and a credential file (`apps/daemon/src/accounts.ts`; spec
  `2026-08-03-bitbucket-support-design.md`). T3 relies on whatever `gh`/`glab`/`az`/`fj` login exists
  on the server.
- **Bitbucket Server / Data Center.** Supported (`apps/daemon/src/providers/bitbucket-server.ts`),
  including a per-account CA. T3's Bitbucket is Cloud-only
  (`T3/packages/source-control-bitbucket/src/server/BitbucketApi.ts:37`, `api.bitbucket.org/2.0`).
- **Git event automation.** Workflow triggers on push, tag, release, and PR transitions, with
  transition-keyed dedupe and crash-safe cursors (`apps/daemon/src/workflows/triggers/git-events.ts:1-30`,
  `git-poller.ts`). T3's PR watch is per-thread and agent-only.
- **Box-routed git.** Git and checkpoints run inside remote VMs through `BoxConnection`
  (`apps/daemon/src/boxes/remote/git-auth.ts`, `agent-host/checkpoints/box-git.ts`).
- **GitHub link previews in chat.** Hover cards for PRs, issues, commits, and blobs with checks
  summary and credential fallback (`apps/daemon/src/github-links/service.ts`, `packages/api/src/forge-links.ts`).
  T3's `PullRequestLinkPreview.tsx` covers PRs only.
- **External MCP git reads.** `get_git_state` (status/branches/log/diff) is available to external
  clients and to in-chat agents, with byte-fitted truncation (`apps/daemon/src/mcp/tools/git.ts`).
  T3's `t3_thread_diff` is scoped to a thread.
- **Mobile-aware Git tab.** Master/detail on narrow screens (`ChangesPanel.tsx:88-100`). T3 has the
  better mobile PR reviewer but no mobile git client.
