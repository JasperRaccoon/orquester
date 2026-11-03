# Lending agent accounts to VMs

Status: approved direction (owner, 2026-11-03). Extends `2026-10-19-ephemeral-ai-vms-design.md` §7 and §13. "VM" is the product word; the code says "box". "Lend" is the code and product word for this feature.

## 1. Intent

Repos like `JasperEditor` and `orquester` have paid MCP evals that launch real `claude` and `codex exec` chats on accounts the owner manages in Orquester. Agents working on a VM cannot run them. The account folders on a VM hold no login, and a VM has no `agent-accounts.json`, so the eval stops. Agents are right not to copy credentials, because a refresh in a copy breaks the real login.

With this feature, an agent on a VM asks for the accounts it needs, the owner approves on a card, and the eval runs there with no change to the eval.

The owner's first requirement is that nothing happens to the real logins: no refresh done wrongly, no overwrite, no expiry caused by this feature.

## 2. Goals, non-goals, anti-goals

### Goals

1. **Claude and Codex, both in the first version.**
2. An agent in a VM chat, or a chat with a temporary box, can get logins for named managed accounts through one tool and one approval.
3. Existing evals work with only `--appdir` or `ORQUESTER_APPDIR` set: `<appdir>/daemon/agent-accounts.json` and `<appdir>/daemon/agent-accounts/<agent>/<id>/home/{.credentials.json|auth.json}` exist at their usual relative paths, as regular files.
4. A lent login stays valid for the whole run without anything running on the VM asking for it, including when the host renews the account mid-run.
5. The owner can see every lent login, its state and its end time, and can end it, from the chat and from Settings.
6. Fix the existing non-atomic save of a Claude login.

### Non-goals

- Grok and OpenCode lending. No eval needs them, and refused with a clear error.
- A person starting a lend from the UI. Agents ask and people approve. A person can end any lend.
- Revoking a token when a lend ends. A forced refresh is the very operation the owner wants less of.
- Making Orquester's own tool-use eval run on Codex. That is a separate limit in its README.

### Anti-goals (a failure even if everything else works)

- A refresh token, id token or other long-lived secret reaching a VM.
- Anything on a VM being able to cause a refresh of a lent account, or get a token for it by asking.
- A VM writing any credential back to the host.
- A second refresher: a lend adds no process that spends a refresh token, and does not count as a live holder of the account.
- A lend affecting a chat on the same VM that uses the same account.
- A real login or account index destroyed or overwritten, on a bring-your-own machine or this same host (§5).
- A token value in a log, API response, tool result, approval card, process argument or persisted record.

## 3. The guarantees and how each is enforced

| # | Guarantee | Enforced by |
|---|---|---|
| G1 | The VM cannot refresh | The file holds no refresh token (Claude: field absent. Codex: `""`). Claude returns `no_refresh_token` before any network call (spike (a)). Codex posts an empty refresh token, which the provider refuses and which consumes nothing (verified offline, see §5). |
| G2 | The VM cannot overwrite a real login | `.credentials.json` and `auth.json` are on the hard deny list of box config sync in both directions (`boxes/sync/rules.ts`). A test must keep this true for lent homes. |
| G3 | The VM cannot request tokens for lent accounts | `token.get` from the box link goes through `boxUsesAccount` and is not extended. Only the host-side keeper can get a lent token (`getLentToken`). |
| G4 | The VM cannot force a renewal of a lent account | Same as G3. `getLentToken` has no `rejectedAccessToken` parameter. |
| G5 | One refresher | The keeper only calls the broker, which uses the existing `refreshOnce` and `mayRefreshHeld` rules. A lend is not in `hostLocalAccountIds` or `liveAccountIds`. |
| G6 | A renewal never strands the VM | The keeper watches the host's login file and pushes the new token at once (a renewal revokes the old Claude token immediately). |
| G7 | A crash cannot destroy a Claude login | The Claude refresh writes with `writeFileAtomic`, as Codex and Grok do. |
| G8 | A lend always ends | Earliest of: return, time limit, chat closed, box destroyed. Enforced on the host, so it survives a daemon restart and an offline VM. |

### What is not guaranteed, and must be stated honestly

- A token copied off the VM keeps working until it expires. Deleting the file cannot stop it. It can spend quota, not take over the login. Claude tokens last hours; Codex tokens last about 10 days, so the card shows each token's real expiry.
- A provider can end any login at any time, and a daemon crash between a provider's refresh response and the save loses the rotated token, requiring a new login. Both exist today, and a lend adds no new path to them.

## 4. Lifecycle

**Ask.** The agent calls `box_lend_accounts`. The daemon resolves names to accounts and validates everything before any card appears (§8).

**Approve.** A `spend` card in every permission mode, never grantable, refused while planning. Same rules as `create_box`, because it spends subscription quota and exposes tokens. Unanswered, it is denied after 30 minutes.

**Install.** All or nothing per call, one call at a time per VM:

0. Check the VM's index and each login path (§5, `LEND_APPDIR_IN_USE`). The preview runs the same check.
1. Persist the lend records (`StoredBox.accountLends`) before touching the VM.
2. `agent.ensurePaths` for each home and the index's directory.
3. For each account: `getLentToken`, then write the login file (mode 0600).
4. Write the index (§5).
5. Start the keeper for each lend.

On any failure, end every lend of the call (normal cleanup) and return an error naming the account.

**Keep.** §6.

**End.** Set `endedAt` and `endReason` and persist, stop the keeper, then clean up on the VM: rewrite the index, or remove it when no active lend remains, and remove the login file unless one of these holds:

- Another active lend of that account is on this VM. The record is deleted; that lend's end decides.
- A live Claude chat running in this project box uses that account, because its CLI reads that same file. That means an open `agent-chat` tab of `claude` whose session status is not `idle`, `stopped` or `error`. The record stays too, and cleanup runs again when sessions change and on reconnect.

Nothing else keeps it: a temporary box's owning chat runs on the host, a Codex chat never reads `auth.json`, and an exited terminal or a tab with no CLI running reads nothing. If the session index failed to load, no lend ends for its chat and no file is removed, because nothing is known about any chat.

If the VM is offline, the record stays with `endedAt` set and cleanup runs when it reconnects. Delete the record once cleaned. When the box is destroyed, drop its records with no cleanup. When a bring-your-own machine is released, end its lends normally: it stays up.

Calling `box_lend_accounts` again for an account already lent to that VM asks again and, once approved, replaces the end time. Tokens are unchanged.

**Restart.** At daemon start the service loads every record. It ends those past their time limit or whose chat is gone, and resumes keepers for the rest. Reconnects go through `hub.onConnectionChange`. A lend entry that does not parse, or whose ids are not UUIDs, is ignored and written back unchanged; its box is unaffected. A lend in flight when the daemon stops writes nothing more: its records are marked ended, and the next start cleans up.

## 5. Files on the VM

Paths are the host's mapped by `hostToBoxPath(connection.paths, …)`, using `agentAccountsFile(baseDir)` and `agentAccountsDir(baseDir)`.

**Claude:** `<home>/.credentials.json` = `claudeBoxCredentials(grant, now)`. Move that function to `boxes/broker/credentials.ts` and import it from the adapter.

**Codex:** `<home>/auth.json`, built on the host from the grant, replaced whole on every renewal:

```json
{
  "OPENAI_API_KEY": null,
  "auth_mode": "chatgpt",
  "tokens": { "id_token": "<synthetic>", "access_token": "<grant>", "refresh_token": "", "account_id": "<grant.extra.chatgptAccountId>" },
  "last_refresh": "<now ISO>"
}
```

- `id_token` must parse, or Codex treats the login as signed out (an empty string fails, verified). It is **synthetic**: `base64url({"alg":"none"}).base64url(claims).sig`, with claims copied from the access token JWT (`https://api.openai.com/profile.email` to `email`, and `https://api.openai.com/auth`). The real id token never leaves the host, and `grantFromCredentials` still does not read it.
- `refresh_token` is `""` because Codex needs the field to parse the file.
- `last_refresh` is the write time, so Codex's age-based refresh does not fire during a lend (the maximum lend is 24 h).

Verified offline with Codex 0.163.0 against a local fake backend, with fake tokens:

- The file loads and its bearer and `chatgpt-account-id` headers are sent.
- A token refused with 401 is followed by a reload, and the replacement token in the file is used.
- With under 5 minutes left it posts an empty refresh, which fails harmlessly. The keeper's margin keeps a run from reaching this.
- A chat in the same home logging in with `account/login/start` `chatgptAuthTokens` uses its own token, not the file's, and leaves the file untouched. So a Codex chat and a lent login of the same account coexist.

**Index:** `<appdir>/daemon/agent-accounts.json` must pass `parseAgentAccounts`, and lists only accounts lent to this VM:

```json
{ "accounts": [{ "id": "…", "agent": "claude", "label": "…", "email": null, "plan": null, "needsReauth": false, "createdAt": "…", "importedAt": "…" }], "defaults": { "claude": null, "codex": null, "grok": null }, "lentBy": "orquester" }
```

`needsReauth` follows the lend's `needs-login` state, so an eval refuses the account with its usual message. No other account's label appears on a VM.

Every write goes through `connection.writeFile` with mode 0600. It is an atomic replace on the VM (`orq-agent`: temp file, fsync, rename; a replaced file keeps its owner), because a CLI re-reads this file during a turn.

**A real login is never touched.** POSIX paths map to themselves, so on a bring-your-own machine, possibly this same host, the lend's paths may be a real install's. Before any write or removal the service reads what is there:

- An index without `"lentBy": "orquester"` is not ours.
- A login is not ours if it holds a non-empty refresh token anywhere in it or an `OPENAI_API_KEY`, or does not parse (ours are written whole).
- A symlink, a folder, an oversized or an unreadable file is not ours.

Something not ours refuses the preview and the install with `LEND_APPDIR_IN_USE`, and is never overwritten or removed. If it appears later, a keeper rewrite refuses too: status `renewal-failing` with the reason, no broker call and no timed retries, and only a host login change or a reconnect looks again. A return leaves it there and deletes the record. The check and the write are separate requests, so a process on the VM writing in between is not excluded; the VM has no compare-and-replace.

## 6. The keeper

One per active lend, on the host, in the daemon process (`boxes/lends/keeper.ts`). It is the chat logic of `BoxLaunch` without a chat, using the same constants and `BoxTokenTracker` from `agent-host/boxes/token-policy.ts`, keyed by lend id.

- **Short token:** a timer armed for `msUntilStale` (30-minute margin) asks `getLentToken` with `BOX_TOKEN_MIN_VALID_SECONDS` and rewrites the file. The delay is capped at `BOX_TOKEN_RENEW_MAX_DELAY_MS`.
- **Host renewal:** a shared watch on the host's login file per path (`CredentialFiles.watch`, which watches the directory, so rename-replace works). If the token differs from the one on the VM, fetch and rewrite right away.
- **Transient failure** (`TOKEN_UNAVAILABLE`, connection errors): keep the current token, status `renewal-failing`, retry with backoff per lend from `BOX_TOKEN_RENEW_RETRY_MS` (1 minute) doubling to 15 minutes, reset on success. A change to the host's login looks at once.
- **`TOKEN_NEEDS_REAUTH`, or an account the host already flags `needsReauth`:** status `needs-login` and no more attempts until the host's login file changes, so a restart posts nothing to the provider. Never loop on a refresh token the provider refused. Rewrite the index so `needsReauth` is true.
- **Unknown expiry:** the Claude file claims one hour, so it is rewritten with the same token every 30 minutes, with no broker call.
- **VM offline:** status `waiting-for-vm`, no attempts. On reconnect, compare and rewrite immediately. The VM's file may be stale, so always rewrite on reconnect.
- **401 on the VM:** the keeper does not hear about it and is not told. The host-change path covers revocation by renewal. A token refused for any other reason makes the eval's samples error out, and the agent reports it. Nothing on the VM can trigger a refresh.
- All of one lend's work is serialized and coalesced. Timers do not keep the process alive. `end()` aborts in-flight waits.

Status changes broadcast the box summary. Failures log the box id and account id, never a token.

## 7. Broker

Add to `AgentTokenBroker`:

```ts
getLentToken(request: { boxId: string; agent: BoxAgentId; accountId: string; minValidSeconds?: number }, signal: AbortSignal): Promise<AgentTokenGrant>;
```

It shares `getToken`'s loop. Authorization: box active, account exists and matches the agent, not the System account, and `deps.isAccountLent(boxId, accountId)`. `getToken`'s authorization is unchanged, so a lent-only account gets `TOKEN_FORBIDDEN` over `token.get` and over the internal route.

## 8. For agents

Both tools are chat-only, in the `boxes` family, and advertised only while the plugin can rent a box or the chat runs in a box.

### `box_lend_accounts`

Description (keep to this length): "Put short-lived logins of named managed accounts on this chat's VM, so a paid eval or CLI there can use them. Needs the owner's approval on a card (up to 30 min); if denied, don't retry: ask. Never copy logins yourself. Names from `list_agents`, quota from `get_usage`."

| Argument | Notes |
|---|---|
| `claude`, `codex` | Arrays of label, label part before `@`, or id prefix. At least one name across both, at most 6. |
| `purpose` | Required, shown on the card. |
| `minutes` | Default 240, 10 to 1440. Clamped to a temporary box's time limit. |
| `box_id` | Default: this chat's VM, or its only temporary box. |

Result:

```json
{
  "box_id": "…",
  "appdir": "/var/lib/orquester",
  "accounts": [{ "agent": "claude", "label": "…", "id": "…", "home": "…/home", "lent_until": "…", "token_expires_at": "…" }],
  "next": "Pass this appdir to the eval (--appdir or ORQUESTER_APPDIR). Logins renew by themselves until lent_until. Call box_return_accounts when the run ends."
}
```

Errors name the fix:

| Code | Message says |
|---|---|
| `LEND_NO_BOX` | This chat has no VM; `create_box` first, or pass `box_id` when it has several. |
| `BOX_NOT_READY` | The VM is not connected. |
| `ACCOUNT_NOT_FOUND` | The known labels for that agent. |
| `ACCOUNT_AMBIGUOUS` | Use more of the id, and the matches. |
| `ACCOUNT_NEEDS_LOGIN` | Owner must sign in again in Settings → Agent accounts. |
| `ACCOUNT_NOT_LENDABLE` | The System login is never lent. |
| `LEND_APPDIR_IN_USE` | That path on this machine is a real login or account index, so lending would overwrite it; lend to a VM without one. |

### `box_return_accounts`

`box_id` optional; `claude`, `codex` optional (omitted: everything this chat borrowed on that VM). No card. Returning is always safe.

### `list_boxes`

Gains a top-level `lent_accounts` listing this chat's active lends on every VM, with `status`, because project VMs are not rows there.

### Hint at the point of failure

In `apps/daemon/src/evals/tool-use/accounts.ts`, "no login" and a missing index name the fix when running on a box: "On a VM, ask for it with box_lend_accounts." Detect a VM by the env var box launches already set, if there is one; otherwise phrase it conditionally ("If this is a VM…").

Do not grow the `## Orquester` instruction block: the deferred tool's name and the eval's error carry it, unless a paid eval proves otherwise.

## 9. For people

### Approval card

Title: "Lend 2 accounts to a VM". Scope label: "Uses your subscription quota". Sections, in order:

1. **Purpose** (text).
2. **The VM** (fields): provider and size, or project name; time limit; ends at.
3. **Accounts** (fields), one row each: label as the row label, value such as "Claude · current token valid until 19:40" or "Codex · current token valid until Nov 13".
4. Unattended warning, when it applies (existing constant).
5. **Warning** (caution): "Anything running on this VM can read these logins and use their quota until each token expires, even after the lend ends. Their refresh tokens stay on this server, so nothing on the VM can renew them or change your login."

Plus an extra caution section when a Codex account is included, stating the real expiry: "Codex tokens last about 10 days." `pins`: box id, account ids, minutes, so what was approved is what runs.

### In the chat

`BoxChatSurfaces` shows a **Lent logins** section on a temporary box's card and on a project VM's surface: one row per lend with the agent icon, label, status dot, "until 21:40" and an **End** button, plus **End all** when there are two or more. Ending has no confirm because it is the safe direction. Status words:

| Status | Shown as |
|---|---|
| `installing` | Installing |
| `active` | Active |
| `waiting-for-vm` | VM offline, will renew when it returns |
| `renewal-failing` | Could not renew yet, retrying |
| `needs-login` | Sign in again, linking to Settings → Agent accounts |

### In Settings

- `BoxesList`: the same rows on each box.
- `AgentsSettings`: an account lent anywhere shows a chip such as "Lent to 1 VM until 21:40".

Shared UI goes in `packages/ui`, so desktop and web both get it. Copy stays out of tests.

## 10. Contracts

In `packages/api` and `packages/config`, committed before the implementation streams start:

- `BOX_LEND_AGENTS`, `BOX_LEND_DEFAULT_MINUTES`, `BOX_LEND_MIN_MINUTES`, `BOX_LEND_MAX_MINUTES`, `BOX_LEND_MAX_ACCOUNTS`.
- `BoxLentAccount`, `BoxLentAccountStatus`, `BoxSummary.lentAccounts?`.
- `accountLendRoutes`, with the request and response types.
- `SpendFamily` gains `"accounts"`.
- `storedAccountLendSchema`, `StoredBox.accountLends`.

## 11. Module map

| Path | Owns |
|---|---|
| `apps/daemon/src/agent-accounts.ts` | The atomic Claude save. |
| `apps/daemon/src/boxes/broker/` | `getLentToken`, login-file builders. |
| `apps/daemon/src/boxes/lends/` | `service.ts` (records, lifecycle, resolve, preview, cleanup), `keeper.ts`, `routes.ts`, `index.ts`, `testing.ts`. |
| `apps/daemon/src/boxes/service/summary.ts` | `lentAccounts` in `BoxSummary`. |
| `apps/daemon/src/boxes/wiring.ts` | Construction, routes on both transports, shutdown. |
| `apps/daemon/src/mcp/tools/boxes.ts`, `mcp/gate/policy.ts` | The tools, the card, the family's reason. |
| `apps/daemon/src/evals/tool-use/` | Cases, the hint, a README section. |
| `packages/ui/src/components/boxes/` | Rows, sections, logic. |

## 12. Verification

Tests through stable seams, using `localBoxConnection()` and the broker's test world:

- An integration test on a real broker, real service and local connection: lend, renew the host's login mid-run, and the file on the "VM" changes without anything asking.
- Negative tests that fail if the guard is removed: `token.get` refused for a lent-only account; a file written to a VM never contains the refresh token or the real id token; ending a lend leaves the file when a chat on that VM uses the account; an account flagged `needs-login` stops asking.
- Lifecycle: time limit, chat close, restart resume, offline end then cleanup on reconnect, all-or-nothing install.
- The written Codex file parses with the same shape as the verified one; the index passes `parseAgentAccounts`.
- MCP: approval card pins are what runs; a call without approval is refused; `list_boxes` shows lends; schemas stay within the catalog's budget test.

No live run is possible in this repository's rules: agents must not drive the live daemon, and a real VM and real accounts cost money. After deploy, the owner-approved smoke test is: rent a cheap VM, lend one Claude and one Codex account, run one eval case each, renew the host login mid-run, then return.

## 13. Calls made in design (not owner-stated; check these)

- Default lend of 4 hours, maximum 24 hours.
- Lending is a `spend` card, never grantable, even in Full access.
- A lend ends when the chat that asked for it closes.
- No revocation at the end of a lend, and no person-initiated lend.
- The eval's cases and paid runs: cases are added and dry-run; running them is the owner's call because they bill a subscription.
