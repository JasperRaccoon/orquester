# Tool-use eval

Checks whether agents use Orquester's in-chat tools correctly: delegating to another agent, messaging and waiting on chats, boxes, visuals, secrets. Each `bad` case reproduces a real mistake from a chat or from this repo's history. Each `guard` protects a behaviour a change to the text could lose. Each `control` is ordinary work that must not pull in Orquester tools. The design follows T3 Code's `evals/mcp-tool-use`.

Run it when a change affects what a model sees from Orquester: the instruction block (`src/session-tools/instructions.ts`), tool descriptions or schemas (`src/mcp/tools/`), or tool results and their hints.

## How a sample runs

- A real Claude Code chat is launched through the SDK with `buildClaudeQueryOptions`, the same as a chat. It gets the thread's real manifest (tool list and `## Orquester` block) and the catalog's advertised schemas, all from this checkout. Nothing is copied into the eval.
- The `orquester` server is the host's own in-process server. Calls are answered by the case's `mocks`, or by a default shaped like the daemon's result, after the catalog's strict argument parse. A bad argument gets the daemon's own `INVALID_ARGUMENT` text. No daemon is involved.
- `setup.priorTurns` becomes a Claude Code transcript that the sample resumes, so the model reads it as its own history.
- The cwd is a throwaway git repo of the case's `files`, on `main` with one commit.
- Built-in tools never act outside the sample (`policy.ts`):
  - Bash prints the case's canned `shell` output when a regex matches.
  - A command that only reads inside the cwd (`ls`, `cat`, `grep`, `git status`…) runs there.
  - Any other command prints what a cheap model playing the machine says it would (`shell-sim.ts`, after T3's shell simulator), consistent with `setup.machine` and the sample's earlier commands.
  - File tools stay in the cwd.
  - A native subagent (`Agent`) runs as a Haiku stand-in that only returns `setup.agentReport`; the grader still sees the agent's own call.
  - Web tools and questions to the user are refused.
- The account's own `CLAUDE.md`, skills, plugins, hooks and MCP servers are not loaded (`settingSources: []`, strict MCP config). The transcript and cwd are removed afterwards.

## Accounts

A run uses one managed Claude account that you name with `--account`: a label, the part of the label before `@`, or an id prefix from `agent-accounts.json`. There is no default. The system login and the agent's default account are never picked for you. Pick an account with weekly quota left, since samples are billed to that subscription. The summary's dollar figure is the CLI's notional price.

## On a VM

A VM has no `agent-accounts.json` and its account folders hold no login, so a run there stops and says to pass a lent appdir, or to ask with `box_lend_accounts`. A VM is told by `ORQ_BOX_ID`, which the box agent sets on every process.

- Call `box_lend_accounts` with the account you want. The owner approves it on a card, and samples bill that subscription as usual.
- Pass the `appdir` it returns as `--appdir`. The login renews by itself until `lent_until`.
- Call `box_return_accounts` when the run ends.
- Never copy a login or use an API key instead: a refresh in a copy breaks the real login. If the card is denied, ask.

## Run

```sh
cd apps/daemon
pnpm eval:tool-use --dry-run                       # build every case, no model calls
pnpm eval:tool-use --context                       # what Orquester's text and tools weigh
pnpm eval:tool-use --account <label> --appdir <appdir> --case <id> --samples 1 --out /tmp/orqeval/check
pnpm eval:tool-use --account <label> --appdir <appdir> --out /tmp/orqeval/sonnet
pnpm eval:tool-use --account <label> --appdir <appdir> --out /tmp/orqeval/after --baseline /tmp/orqeval/sonnet/results.jsonl
```

Flags:
- `--model`: default `claude-sonnet-5-5`.
- `--effort`.
- `--case <ids>` (comma-separated), or `--cases <file.ndjson>`.
- `--samples <n>`: default 2, with a third sample when the first two disagree.
- `--concurrency`: default 3.
- `--max-turns`: default 30.
- `--baseline <results.jsonl>`: lists cases that passed every baseline sample and now fail, and cases now fixed.

`--appdir` defaults to `ORQUESTER_APPDIR`, else `~/.orquester`.

A case fails when half or more of its samples fail. Compare against a baseline on the same model, not against an absolute score.

## Add a case

Cases are JSON lines in `cases/`, one file per area. `case.ts` documents every field, and `grade.ts` documents the checks.

- Name the source (a chat and date, or a commit). Use synthetic data only: `acme/app`, `/home/user`, `sess-NNNN`.
- Give prior turns and mocks the daemon's real result shapes and wording (`src/mcp/tools/*.ts`), or the case tests something chats never see.
- Add the case before the fix. It must fail on the old text and pass on the new.
- Add controls with every fix, so an overcorrection shows.
- Check it builds with `--dry-run --case <id>`.

The graders and the sandbox are tested in `grade.test.ts` and `runtime.test.ts`, which run with the daemon's tests. The eval itself calls paid models, so CI never runs it.

## Limits

- Claude only. Codex needs its own launch, and a way to borrow an account home without letting a token refresh land in a copy.
- The simulated shell invents what `setup.machine` leaves out. A case whose decision turns on a command's output should pin that output in `shell`.
- Knowledge worker sessions, which get a different manifest, are not modelled.
- Never write a case that rewards routing work around a model's safety refusal. The source chats include one: there, work went to another agent after Claude's classifier blocked it. Cases taken from it keep the hand-off but give it an ordinary reason.
