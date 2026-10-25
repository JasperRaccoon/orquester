# Shared UI components test cleanup

Scope: all 70 assigned component/hook/icon test files were inspected alongside their direct contracts and production owners. The baseline inventory contains 547 named test declarations and 134 standalone check assertions (a loop/template declaration is one ledger row, not an invented runtime-test count). The rows below record every declaration/check. B1–B6 refer to the user’s independent contract, regression detection, independent oracle, stable seam, refactor resistance and unique protection requirements.

The report separates test declarations from standalone assertions; Node’s runtime test counts may expand parameterized cases. Exact documentation/API and historical-contract sources are given per subsystem. Fixed expected examples in each row are test-authored or protocol/schema values, rather than expected results computed by the implementation.

## packages/ui/src/components/attention/agent-sessions.test.ts

Contract source, production consumer seam and six-bar reasoning: **attention** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| the Knowledge Graph indexer's worker chats are no project's agents: no row, no count, no waiting dot (line 13) | **KEEP** | Fixed regression oracle: entries.map((entry) => entry.session.id) deepEqual ["user-chat", "workflow-chat"] |

## packages/ui/src/components/boxes/location/runs-on-row.dom.test.ts

Contract source, production consumer seam and six-bar reasoning: **boxes** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| is hidden while the plugin is off (line 198) | **KEEP** | Fixed regression oracle: text().includes("Runs on") equal false ; document.querySelector('[role="radio"]') equal null |
| shows this host, one card per kind and Set up more…, unavailable kinds disabled with their reason (line 204) | **KEEP** | Fixed regression oracle: assert.ok(text().includes("Runs on")) ; assert.ok([...document.querySelectorAll("button")].some((b) => b.textContent === "Set up more…Opens plugin settings")) |
| a box choice loads its offers and the Empty tab creates in a new VM (line 219) | **KEEP** | Fixed regression oracle: offerReads deepEqual ["hetzner:linux"] ; closed equal 1 |
| macOS warns with the daily cost and its time limit, and sends the lifetime (line 244) | **KEEP** | Fixed regression oracle: select("Region") equal null ; created[0].location deepEqual { kind: "box", boxKind: "macos", provider: "blacksmith", size: "m4-6", region: "gha", image: "macos-15", lifetimeMinutes: 1440 } |
| without an account, a clone into a box goes server-side instead of being typed (line 268) | **KEEP** | Fixed regression oracle: assert.ok(buttonNamed("Review"), "the host path reviews the typed clone") ; created[0].location?.kind equal "box" |
| the preset dialog asks under the Name field and clones into a new VM (line 283) | **REWRITE** | Keep clone preset-to-VM payload, drop sibling document-position geometry unrelated to request semantics. Current independent oracle: created deepEqual [ { source: "clone", url: PRESET.url, name: "Shader optimization", location: { kind: "box", boxKind: "linux", provider: "hetzner", size: "cx22", region: "fsn1" } } ] |
| can't submit until the offers are in; back to this host submits as before (line 301) | **KEEP** | Fixed regression oracle: buttonNamed("Create in a new VM")?.disabled equal true ; created deepEqual [{ source: "empty", name: "later" }] |
| Set up more… closes the dialog and opens Settings → Plugins (line 325) | **KEEP** | Fixed regression oracle: settingsOpened deepEqual ["plugins"] ; closed equal 1 |

## packages/ui/src/components/boxes/location/runs-on.logic.test.ts

Contract source, production consumer seam and six-bar reasoning: **boxes** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| this host is the default and always ready (line 40) | **KEEP** | Fixed regression oracle: RUNS_ON_INITIAL.choice equal "host" ; runsOnSummary(RUNS_ON_INITIAL) equal null |
| choosing a kind picks its cheapest provider and asks for its offers (line 48) | **KEEP** | Fixed regression oracle: state.choice equal "linux" ; runsInBox(state) equal true |
| an unavailable kind cannot be chosen (line 58) | **REWRITE** | Assert independently expected selected host/provider, request and ready-size state instead of reducer object identity; a behavior-preserving allocation refactor must survive, and an in-place wrong mutation must fail. Current independent oracle: run({ type: "kind", availability: kind({ providers: [] }) }).choice equal "host" ; run({ type: "kind", availability: kind({ unavailableReason: "Tailscale is not set up on this deskto… equal "host" |
| offers fill in the cheapest size, its first region, the first image (line 66) | **KEEP** | Fixed regression oracle: state.offers.status equal "ready" ; runsOnReady(state) equal true |
| an answer for a provider or kind no longer asked for is ignored (line 78) | **REWRITE** | Assert independently expected selected host/provider, request and ready-size state instead of reducer object identity; a behavior-preserving allocation refactor must survive, and an in-place wrong mutation must fail. Current independent oracle: offersRequest(stale) deepEqual { provider: "vultr", kind: "linux" } ; duplicate.size equal "cx22" |
| a failed offers read can be retried (line 91) | **KEEP** | Fixed regression oracle: failed.offers deepEqual { status: "error", provider: "hetzner", kind: "linux", message: "Rate limited" } ; offersRequest(retried) deepEqual { provider: "hetzner", kind: "linux" } |
| changing the provider starts over on its offers (line 102) | **KEEP** | Fixed regression oracle: state.size equal null ; offersRequest(state) deepEqual { provider: "vultr", kind: "linux" } |
| a size keeps the region when it is rented there, else takes its first (line 113) | **REWRITE** | Keep the real placement/lifetime request contract and fixed selections; remove object-identity no-op checks for impossible select IDs/NaN, which are private defensive branches rather than user workflows. Current independent oracle: runsOnReducer(ready, { type: "size", id: "cx32" }).region equal "fsn1" ; ccx.region equal "ash" |
| a region the size is not rented in switches to the cheapest size that is (line 122) | **REWRITE** | Keep the real placement/lifetime request contract and fixed selections; remove object-identity no-op checks for impossible select IDs/NaN, which are private defensive branches rather than user workflows. Current independent oracle: ash.region equal "ash" ; runsOnReducer(ready, { type: "region", id: "nbg1" }).size equal "cx22" |
| macOS shows the OS version instead of a single region, with its lifetime (line 132) | **REWRITE** | Keep the real placement/lifetime request contract and fixed selections; remove object-identity no-op checks for impossible select IDs/NaN, which are private defensive branches rather than user workflows. Current independent oracle: placementSelects(state) deepEqual { region: false, image: true } ; runsOnLocation(older)?.image equal "macos-14" |
| regions and images both show when both are a choice; neither images → region only (line 151) | **KEEP** | Fixed regression oracle: placementSelects(both) deepEqual { region: true, image: true } ; placementSelects(linux) deepEqual { region: true, image: false } |
| the lifetime is clamped to the provider maximum and offered in steps (line 161) | **REWRITE** | Keep the real placement/lifetime request contract and fixed selections; remove object-identity no-op checks for impossible select IDs/NaN, which are private defensive branches rather than user workflows. Current independent oracle: runsOnReducer(state, { type: "lifetime", minutes: 99_999 }).lifetimeMinutes equal 7200 ; runsOnLocation(runsOnReducer(linux, { type: "lifetime", minutes: 600 }))?.lifetimeMinutes equal undefined |
| the summary states the price, the monthly cost and what the box does (line 175) | **KEEP** | Fixed regression oracle: runsOnSummary(linux) deepEqual { tone: "info", text: "≈ $0.0119/h, ~$8.69 a month. The box runs until you delete this project. Setup clones the repo and installs its toolchain." } ; runsOnSummary(unpriced)!.text match /^The price for this size is unknown\./ |
| a kind that goes away sends the choice back to this host; a removed provider to the next (line 196) | **REWRITE** | Assert independently expected selected host/provider, request and ready-size state instead of reducer object identity; a behavior-preserving allocation refactor must survive, and an in-place wrong mutation must fail. Current independent oracle: runsOnReducer(ready, { type: "kinds", kinds: [] }).choice equal "host" ; offersRequest(moved) deepEqual { provider: "vultr", kind: "linux" } |
| host and reset start over (line 207) | **REWRITE** | Assert independently expected selected host/provider, request and ready-size state instead of reducer object identity; a behavior-preserving allocation refactor must survive, and an in-place wrong mutation must fail. Current independent oracle: reset.choice equal "host" ; runsOnReady(reset) equal true |
| a location is only built once the choice is complete (line 213) | **KEEP** | Fixed regression oracle: runsOnLocation(loading) equal null ; runsOnReady(noSizes) equal false |
| cards: one per kind with a provider or a reason, priced, with the reason as tooltip (line 221) | **KEEP** | Fixed regression oracle: cards deepEqual [ { kind: "linux", label: "Linux VM", providers: "Hetzner, Vultr", price: "from $0.0119/h", disabled: false, reason: null }, { kind: "windows", label: "Windows", providers: "", price: nul… ; kindCards(null, null) deepEqual [] |
| size options read label and price (line 246) | **DELETE** | Exact option copy duplicated by runs-on DOM size selection and pricing summary (B1/B6). |

## packages/ui/src/components/boxes/settings/boxes-settings.dom.test.ts

Contract source, production consumer seam and six-bar reasoning: **boxes** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| shows the totals, each provider's status and the Windows image row (line 173) | **DELETE** | Static text/status inventory repeats fake server data and provider formatting; the meaningful unavailable-image preparation guard has a stronger owner in windowsImageView. Remaining mounted credential/check/setup/destroy actions exercise real behavior (B4/B6). |
| asks for the key in a masked field, refuses an empty one, and saves through the daemon (line 183) | **KEEP** | Fixed regression oracle: input?.type equal "password" ; keyInput()?.value equal "" |
| shows the daemon's reason when the provider refuses the key (line 207) | **KEEP** | Fixed regression oracle: assert.ok(text().includes("Vultr says: invalid API key")) ; assert.ok(keyInput(), "the form stays open") |
| Remove asks first, then forgets the credentials (line 219) | **KEEP** | Fixed regression oracle: assert.ok(text().includes("Remove the Hetzner credentials?")) ; assert.ok(text().includes("Add API key")) |
| the connection check shows reachability; Save sends only what changed (line 230) | **KEEP** | Fixed regression oracle: assert.ok(text().includes("Not checked")) ; connectionPuts deepEqual [{ publicUrl: "https://new.example.com" }] |
| Tailscale mode shows the policy snippet to copy (line 244) | **KEEP** | Fixed regression oracle: document.querySelector<HTMLInputElement>("#box-ts-token")?.type equal "password" ; assert.ok(document.querySelector('[aria-label="Copy the policy snippet"]')) |
| shows the status line, fills the suggested URL, and sets up serving (line 278) | **KEEP** | Fixed regression oracle: assert.ok(text().includes("Tailscale on this machine: my-pc.tail1234.ts.net · not serving Orquester yet")) ; assert.ok(text().includes("Reachable")) |
| without permission, shows the daemon's message and the commands to copy (line 311) | **KEEP** | Fixed regression oracle: assert.ok(text().includes("Tailscale doesn't let this server's user (orq) change what it serves.")) ; assert.ok(buttonNamed("Set up for me"), "can try again") |
| says when Tailscale isn't running, with nothing to set up (line 329) | **KEEP** | Fixed regression oracle: assert.ok(text().includes("Tailscale isn't running on this machine.")) ; buttonNamed("Set up for me") equal undefined |
| Tailscale mode keeps the public URL for macOS boxes and saves it (line 337) | **KEEP** | Fixed regression oracle: assert.ok(text().includes("Public URL (also used by macOS boxes)")) ; connectionPuts deepEqual [ { mode: "tailscale", tailscaleDaemonUrl: "https://pc.tail1234.ts.net:10000", publicUrl: "https://mac.example.com", tailscaleApiToken: "tskey-api-abc" } ] |
| a stopped control repo step offers Retry, which re-runs the automatic steps (line 354) | **KEEP** | Fixed regression oracle: assert.ok(text().includes(message)) ; assert.ok(text().includes("Org/orquester-macos-boxes")) |
| marks every secret field new-password so Chrome does not fill a saved login into the page (line 394) | **KEEP** | Fixed regression oracle: secretAutocomplete() deepEqual [ ["box-provider-vultr-key", "new-password"], ["box-ts-token", "new-password"] ] ; secretAutocomplete() deepEqual [ ["box-provider-vultr-key", "new-password"], ["box-ts-client-secret", "new-password"] ] |
| lists the boxes and destroys a temporary one after confirming (line 415) | **KEEP** | Fixed regression oracle: assert.ok(text().includes("jaspersito / JasperEngine")) ; assert.ok(text().includes("Destroying…")) |
| still lists the boxes that are running, with a notice, and destroys a temporary one (line 453) | **KEEP** | Fixed regression oracle: assert.ok(text().includes("Ephemeral AI VMs is off, but these boxes are still running and billing.")) ; assert.ok(text().includes("Destroying…")) |
| shows no notice when nothing is running (line 474) | **KEEP** | Fixed regression oracle: text().includes("still running and billing") equal false ; text().includes("JasperEngine") equal false |

## packages/ui/src/components/boxes/settings/settings.logic.test.ts

Contract source, production consumer seam and six-bar reasoning: **boxes** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| provider rows: Blacksmith has its own row, each tile its abbreviation (line 61) | **KEEP** | Fixed regression oracle: keyProviders(list).map((entry) => entry.id) deepEqual ["hetzner", "vultr"] ; providerAbbreviation(provider({ id: "digitalocean", label: "DigitalOcean" })) equal "DO" |
| the sub-line shows the key hint, the kinds it unlocks and the account step (line 69) | **DELETE** | Exact presentation copy duplicated in boxes-settings DOM provider rendering (B1/B6). |
| status: a pill when configured, the Add API key button when not (line 78) | **KEEP** | Fixed regression oracle: providerStatusView(provider()) deepEqual { kind: "pill", tone: "ok", label: "Connected", title: null } ; providerStatusView(provider({ status: "not-configured" })) deepEqual { kind: "add" } |
| the form needs every required field, one line each, and sends only what is filled (line 90) | **KEEP** | Fixed regression oracle: credentialProblems(OVH_FIELDS, {}) deepEqual { applicationKey: "Enter the Application key.", applicationSecret: "Enter the Application secret.", consumerKey: "Enter the Consumer key." } ; credentialsPayload([], {}) equal null |
| a PEM key field takes several lines (line 106) | **KEEP** | Fixed regression oracle: credentialFieldMultiline(pem) equal true ; credentialsPayload([pem], { privateKey: value }) deepEqual { privateKey: value.trim() } |
| the Windows image row offers Prepare only while connected without an image (line 115) | **KEEP** | Fixed regression oracle: windowsImageView(provider()) equal null ; windowsImageView(provider({ windowsImage: { state: "ready", message: null, updatedAt: null } }))?.l… equal "Ready" |
| the card header totals (line 126) | **DELETE** | Exact totals formatting duplicated in boxes-settings DOM (B1/B6). |
| URLs boxes dial must be plain https origins (line 145) | **KEEP** | Fixed regression oracle: httpsUrlProblem("https://orquester.example.com", "public URL") equal null ; httpsUrlProblem("https://o.example.com/?a=1", "public URL")! match /query/ |
| the draft starts from the settings and an unchanged draft saves nothing (line 155) | **KEEP** | Fixed regression oracle: draft.publicUrl equal "https://orquester.example.com" ; connectionDraft(null).mode equal "public-url" |
| Tailscale needs credentials unless they are stored, and an address (line 166) | **KEEP** | Fixed regression oracle: connectionProblems(draft, SETTINGS) deepEqual { daemonUrl: "Enter the tailnet address.", apiToken: "Enter a Tailscale API access token." } ; connectionProblems({ ...kept, apiToken: "has space" }, stored) deepEqual { apiToken: "The token must not contain spaces." } |
| Tailscale mode also saves the public URL (macOS boxes) and the federated identity (line 200) | **KEEP** | Fixed regression oracle: draft.publicUrl equal "https://orquester.example.com" ; connectionRequest({ ...kept, workloadClientId: "", workloadAudience: "" }, withIdentity) deepEqual { tailscaleWorkloadClientId: null, tailscaleWorkloadAudience: null } |
| the reachability pill (line 224) | **DELETE** | Mirrors private pill tone/label projection; boxes-settings DOM connection check verifies actual status transition (B4/B6). |
| Tailscale on this machine: status line, suggested URL and Set up for me (line 250) | **KEEP** | Fixed regression oracle: tailscaleLocalView(withLocal(undefined), "") deepEqual { status: null, tone: "neutral", suggestion: null, canSetUp: false } ; tailscaleLocalView(withLocal({ dnsName: null, suggestedUrl: null }), "").status equal "Tailscale on this machine: 100.64.0.7 · not serving Orquester yet" |
| a Set up for me refusal keeps the daemon's message and its commands (line 281) | **KEEP** | Fixed regression oracle: tailscaleSetupFailure(refusal) deepEqual { message: "Tailscale doesn't let this server's user (orq) change what it serves.", commands: ["sudo tailscale set --operator=orq", "sudo tailscale serve --bg --https=10000 http://127.0.0.1:47831"] } ; tailscaleSetupFailure(other) deepEqual { message: "Tailscale isn't running.", commands: [] } |
| Blacksmith uses connected GitHub accounts and their orgs (line 315) | **KEEP** | Fixed regression oracle: blacksmithAccounts(accounts).map((account) => account.id) deepEqual ["a1"] ; blacksmithOrgs(null) deepEqual [] |
| the Blacksmith row status follows its steps (line 331) | **KEEP** | Fixed regression oracle: blacksmithStatus(null) deepEqual { kind: "setup" } ; blacksmithStatus(setup(["ok"])) deepEqual { kind: "pill", tone: "neutral", label: "In progress" } |
| Blacksmith steps unlock in order (line 341) | **KEEP** | Fixed regression oracle: blacksmithCanPickOrg(setup(["ok"])) equal true ; blacksmithBusy(null) equal false |
| a stopped control repo step offers Retry (line 352) | **KEEP** | Fixed regression oracle: blacksmithCanRetry(step("repo", "action-needed")) equal true ; blacksmithCanRetry(step("test", "failed")) equal false |
| a running setup is re-read on a growing delay until the deadline (line 361) | **KEEP** | Fixed regression oracle: nextBlacksmithPoll(null, start, start) equal BLACKSMITH_POLL.firstMs ; nextBlacksmithPoll(15_000, start, start + BLACKSMITH_POLL.deadlineMs - 10_000) equal null |
| the list shows live boxes, newest first, then the recently destroyed (line 375) | **KEEP** | Fixed regression oracle: listedBoxes([ancient, recent, older, newer], NOW).map((entry) => entry.id) deepEqual ["newer", "older", "recent"] |
| rows: title, owner, cost, state and countdown (line 383) | **KEEP** | Fixed regression oracle: boxTitle(box()) equal "Linux VM · Hetzner · CX22 · Falkenstein" ; boxCountdown(box(), NOW) equal null |
| setup progress counts done and skipped steps and names the current one (line 406) | **KEEP** | Fixed regression oracle: progress.done equal 1 ; setupProgress(box({ setup: [] })).complete equal false |
| only temporary boxes that still exist offer Destroy (line 425) | **KEEP** | Fixed regression oracle: canDestroyBox(box()) equal false ; canDestroyBox(box({ purpose: "temporary", state: "destroyed" })) equal false |

## packages/ui/src/components/boxes/surfaces/box-surfaces.dom.test.ts

Contract source, production consumer seam and six-bar reasoning: **boxes** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| strikes a destroyed box project's name and says Destroyed, with the reason on hover (line 179) | **KEEP** | Fixed regression oracle: name?.className ?? "" match /line-through/ ; badge?.title ?? "" match /outside Orquester \(gone in the Vultr dashboard\)/ |
| shows a destroyed box chat's banner and the composer lock (line 195) | **DELETE** | Passes a prebuilt read-only string directly to an isolated lock, then proves no textarea that was never mounted (B2/B3); boxChatGate tests own all actual send-blocking states. |
| keeps an Opened agents card's destroyed banner to two lines, the whole message as its tooltip (line 216) | **DELETE** | Tailwind clamp class and exact tooltip geometry are private presentation (B1/B4/B5); destroyed reason/read-only contracts remain at boxChatGate and project badge. |
| lists the chat's temporary box with Watch and Destroy, and its pending config change (line 224) | **KEEP** | Fixed regression oracle: document.querySelector("[data-box-chat-panel]") equal null ; document.querySelector('[data-box-config-change="cc-1"]') equal null |

## packages/ui/src/components/boxes/surfaces/box-surfaces.logic.test.ts

Contract source, production consumer seam and six-bar reasoning: **boxes** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| formats dollars and hourly prices (line 118) | **KEEP** | Fixed regression oracle: formatUsd(1.234) equal "$1.23" ; formatHourly(0) equal "$0.00/h" |
| counts down in days and hours, then hours and minutes, then under an hour (line 127) | **KEEP** | Fixed regression oracle: formatBoxCountdown(at(4 * DAY + 6 * HOUR + 59 * MIN), NOW) deepEqual { text: "4d 6h left", urgency: "normal" } ; formatBoxCountdown("not a date", NOW) equal null |
| moves the cost on with the clock while the box is up (line 138) | **KEEP** | Fixed regression oracle: boxCostSoFar(box({ estimatedCostUsd: 0.5 }), NOW) equal 1.2 ; boxCostSoFar(box({ hourlyUsd: null, estimatedCostUsd: 0 }), NOW) equal 0 |
| names the provider and price of a running box (line 147) | **KEEP** | Fixed regression oracle: badge.text equal "Hetzner · $0.34/h" ; projectBoxBadge(info({ hourlyUsd: null }), NOW).text equal "Hetzner" |
| counts a macOS box down in the warning colour, under an hour in the destructive one (line 156) | **KEEP** | Fixed regression oracle: [projectBoxBadge(mac, NOW).text, projectBoxBadge(mac, NOW).tone] deepEqual ["macOS · 4d 6h left", "warn"] ; [soon.text, soon.tone] deepEqual ["macOS · <1 h left", "danger"] |
| says Provisioning with the setup step, Unreachable, Destroyed (line 166) | **KEEP** | Fixed regression oracle: [provisioning.text, provisioning.detail, provisioning.tone] deepEqual ["Provisioning…", "Cloning the repository", "info"] ; failed.title match /Hetzner answered 500[\s\S]*Retry destroy/ |
| gives Opened agents cards the short form (line 185) | **KEEP** | Fixed regression oracle: agentCardBoxBadge(info(), NOW).text equal "VM" ; agentCardBoxBadge(info({ state: "unreachable" }), NOW).text equal "VM unreachable" |
| notes an archived box project still bills, until its box is gone (line 193) | **KEEP** | Fixed regression oracle: archivedBoxNote(info()) equal "still billing" ; archivedBoxNote(undefined) equal null |
| picks the step setup is on (line 200) | **KEEP** | Fixed regression oracle: currentSetupStep([step("create", "done"), step("connect", "running"), step("clone", "pending")])?.id equal "connect" ; currentSetupStep([step("create", "done")]) equal null |
| shows a running step's progress next to its label, and only a running step's (line 215) | **KEEP** | Fixed regression oracle: setupStepText({ ...base, state: "running", message: "Claude account 2 of 5 · 1,240 of 2,000 files" … equal "Sync agent configuration (Claude account 2 of 5 · 1,240 of 2,000 files)" ; projectBoxBadge(info({ state: "provisioning" }), 0, setupStepText({ ...base, state: "running", mess… match /Setting up: Sync agent configuration \(Codex account 1 of 1 · comparing files\)/ |
| says outside Orquester for the dashboard, a provider error and the time limit (line 229) | **KEEP** | Fixed regression oracle: boxDestroyedMessage(info({ destroyedReason: "provider-gone", stateReason: "gone in the Vultr dashbo… equal "The VM was destroyed outside Orquester (gone in the Vultr dashboard). The transcript stays readable; you can't send new messages. Unpushed changes are lost." ; boxDestroyedMessage(info({ destroyedReason: "provider-error" })) match /outside Orquester \(Hetzner reported an error\)/ |
| says by Orquester otherwise, and names a failed setup (line 238) | **KEEP** | Fixed regression oracle: boxDestroyedMessage(info({ destroyedReason: "agent" })) match /^The VM was destroyed by Orquester \(the agent destroyed it\)\./ ; boxDestroyedMessage(info({ destroyedReason: null })) match /^The VM was destroyed\. The transcript stays readable/ |
| offers Retry destroy only after a failed destroy, and Delete always (line 247) | **KEEP** | Fixed regression oracle: boxProjectMenu(info({ state: "destroy-failed" })).retryDestroy equal true ; boxProjectMenu(undefined) deepEqual { retryDestroy: false, deleteNote: null } |
| says in the Delete confirmation what happens to the VM (line 254) | **KEEP** | Fixed regression oracle: boxProjectMenu(info())?.deleteNote ?? "" match /destroys its VM at Hetzner/ ; boxProjectMenu(info({ state: "destroyed" })).deleteNote ?? "" match /already gone/ |
| lets a running box chat send with no notice (line 261) | **KEEP** | Fixed regression oracle: boxChatGate(info()) deepEqual { blockedReason: null, notice: null } ; boxChatGate(null) deepEqual { blockedReason: null, notice: null } |
| keeps sending through a reconnect, with a non-blocking notice (line 266) | **KEEP** | Fixed regression oracle: gate.blockedReason equal null ; gate.notice?.tone equal "warn" |
| holds sends while setup runs, naming the step (line 273) | **KEEP** | Fixed regression oracle: assert.ok(gate.blockedReason) ; boxChatGate(info({ state: "provisioning" })).notice?.title equal "Setting up the VM" |
| makes a destroyed box's chat read-only with the destroyed banner (line 280) | **KEEP** | Fixed regression oracle: gate.blockedReason ?? "" match /read-only/ ; gate.notice?.text ?? "" match /outside Orquester[\s\S]*Unpushed changes are lost\./ |
| holds sends while the box is being destroyed or its destroy failed (line 287) | **KEEP** | Fixed regression oracle: assert.ok(boxChatGate(info({ state: "destroying" })).blockedReason) ; failed.notice?.text ?? "" match /may still be billing/ |
| names the box in the header chip (line 294) | **KEEP** | Fixed regression oracle: boxChatChip(info(), NOW).text equal "Linux VM · Hetzner · $0.34/h" ; boxChatChip(info({ state: "destroyed" }), NOW).tone equal "danger" |
| offers desktops in a Linux VM (they run inside it); a macOS or Windows VM, or a gone one, says why not (line 304) | **KEEP** | Fixed regression oracle: newTabMenuGates(null) deepEqual { showDesktops: true, desktopsInVm: false, desktopsUnavailable: null } ; newTabMenuGates(info({ state: "destroyed" })) deepEqual { showDesktops: false, desktopsInVm: false, desktopsUnavailable: "Desktops — not available: the VM is gone" } |
| says what opening a VM desktop does when its packages are missing (line 319) | **KEEP** | Fixed regression oracle: vmDesktopNote(null) equal null ; vmDesktopNote("error") ?? "" match /Could not check/ |
| offers the shells of the box's OS family, else all (line 335) | **KEEP** | Fixed regression oracle: boxShellChoices(shells, "linux").map((s) => s.id) deepEqual ["bash", "zsh"] ; boxShellRefId(box()) equal "bash" |
| drops the System account in a box (line 345) | **KEEP** | Fixed regression oracle: boxAccountOptions(options, true).map((o) => o.id) deepEqual ["acc-1"] ; boxAccountOptions(options, false).map((o) => o.id) deepEqual [SYSTEM_ACCOUNT_ID, "acc-1"] |
| launches a box chat with a managed account, or not at all (line 351) | **KEEP** | Fixed regression oracle: launchAccountFor([{ id: "acc-1" }, { id: "acc-2" }], "acc-2", true) equal "acc-2" ; launchAccountFor([{ id: SYSTEM_ACCOUNT_ID }], "gone", false) equal SYSTEM_ACCOUNT_ID |
| shows kind and purpose, provider, cost so far, countdown and what can be done (line 360) | **KEEP** | Fixed regression oracle: card.title equal "macOS — build the engine on macOS" ; card.canDestroy equal true |
| offers Watch only while the box is up and connected, and nothing once destroyed (line 371) | **KEEP** | Fixed regression oracle: temporaryBoxCard(box({ connected: false }), NOW).canWatch equal false ; temporaryBoxCard(box({ state: "destroying" }), NOW).canDestroy equal false |
| sanitises the agent's purpose (line 380) | **KEEP** | Fixed regression oracle: temporaryBoxCard(box({ purposeNote: "a‮b\nc" }), NOW).title equal "macOS — ab c" ; boxTerminalTitle(box()) equal "VM · build the engine on macOS" |
| lists the chat's own temporary boxes, live first, newest first (line 386) | **KEEP** | Fixed regression oracle: list.map((b) => b.id) deepEqual ["new", "old", "gone"] |
| leaves out rentals the provider refused, which never existed or cost anything (line 400) | **KEEP** | Fixed regression oracle: list.map((b) => b.id) deepEqual ["live", "found", "setup-failed"] |
| sums up the folded panel (line 420) | **DELETE** | Exact folded-panel summary wording; live box/config list ownership is tested elsewhere (B1/B5). |
| keeps the list between one card and 70% of the view (line 427) | **DELETE** | Private panel pixel geometry has no independent visual regression requirement (B1/B4/B5). |
| trusts only a stored whole number of pixels (line 434) | **KEEP** | Fixed regression oracle: parseBoxPanelHeight("240") equal 240 ; parseBoxPanelHeight(raw) equal null |
| picks a chat's pending sets, and the project row's no-turn sets of its box (line 441) | **KEEP** | Fixed regression oracle: chatPendingConfigChanges(sets, "thread-1").map((c) => c.id) deepEqual ["cc-1"] ; configChangesIndicator(0) equal null |
| lists every file with its change, flags executables and notes truncation (line 456) | **KEEP** | Fixed regression oracle: model.summary equal "2 files · 1 executable" ; model.outcome equal null |
| never counts a deleted file as executable, even one an older daemon flagged (line 471) | **KEEP** | Fixed regression oracle: model.executableCount equal 1 ; model.rows[2]!.executable equal false |
| shows no diff for a binary or empty file, and makes hidden characters visible (line 480) | **KEEP** | Fixed regression oracle: [configChangeFileRow({ ...base, diff: "", binary: true }).diff, configChangeFileRow({ ...base, diff… deepEqual [null, "Binary file — no diff to show."] ; configChangeFileRow({ ...base, path: "/p\nq", diff: "", binary: false }).path equal "/p q" |
| closes the buttons while an answer is in flight and once decided (line 491) | **KEEP** | Fixed regression oracle: configChangeCard(change(), true).canDecide equal false ; configChangeCard(change({ state: "stale" }), false).outcome ?? "" match /^Stale/ |
| keeps a decided set on screen until dismissed, and drops one the daemon no longer has (line 500) | **KEEP** | Fixed regression oracle: nextShownChangeIds([], ["a", "b"], known, none) deepEqual ["a", "b"] ; nextShownChangeIds([], ["a"], known, new Set(["a"])) deepEqual [] |
| says why a decision was refused (line 512) | **KEEP** | Fixed regression oracle: configChangeDecisionFailure(404) match /decided elsewhere/ ; configChangeDecisionFailure(500) match /\(500\)/ |

## packages/ui/src/components/browser/browser-tab.logic.test.ts

Contract source, production consumer seam and six-bar reasoning: **browser** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| only Linux boxes run the Browser tab's Chromium (line 7) | **DELETE** | Direct internal predicate duplicates the browserMenuEntry caller contract (B6); the retained menu case tests Linux/GPU opening and unsupported OS refusal. |
| the + menu offers Browser for a Linux box project without host Chromium, never without a channel (line 16) | **KEEP** | Fixed regression oracle: browserMenuEntry({ hasChannel: true, hostChromium: false, boxKind: "linux" }) deepEqual { kind: "open" } ; browserMenuEntry({ hasChannel: true, hostChromium: true, boxKind: null }) deepEqual { kind: "open" } |
| a VM tab that is starting shows the launch's step; host tabs and other states show none (line 27) | **REWRITE** | Keep progress passthrough, nonempty VM startup status and host/old-daemon suppression; remove exact invented fallback copy, so wording-only refactors survive. Current independent oracle: assert.ok(vmStartingText({ status: "starting", runsIn: "box" })?.trim()) ; vmStartingText({ status: "starting" }) equal null |
| a VM tab's DevTools panel explains why it stays empty; host tabs load DevTools (line 39) | **KEEP** | Fixed regression oracle: vmDevtoolsNote({ runsIn: "box" }) ?? "" match /not available for a browser that runs in the VM/ ; vmDevtoolsNote({}) equal null |
| the no-sandbox warning says where Chromium runs (line 45) | **DELETE** | Exact tooltip copy with no independent byte/wording contract (B1/B5); BrowserView still renders the warning and browser isolation/security coverage remains server-side. |

## packages/ui/src/components/command-palette/command-palette.logic.test.ts

Contract source, production consumer seam and six-bar reasoning: **command-palette** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| ranks whole, start, word-start and mid-word matches (line 44) | **CONSOLIDATE** | Numeric helper scores are private; visible ranking remains in orders exact, prefix, word-start, mid-word. |
| ignores case and accents (line 54) | **CONSOLIDATE** | Preserve accent/case matching through paletteResults in the existing field-matching case, removing helper-only score coupling. |
| finds words spread over fields, ranked below a match within one (line 59) | **CONSOLIDATE** | Preserve cross-field matching and ranking at paletteResults in existing field-matching case. |
| a word-start match in any field beats a mid-word match; then the earlier field wins (line 67) | **CONSOLIDATE** | Preserve title/project priority and word-start ordering at paletteResults in existing field-matching case. |
| orders exact, prefix, word-start, mid-word (line 79) | **KEEP** | Fixed regression oracle: titles(results("fix", rows).sessions) deepEqual ["fix", "Fix login", "Quick fix", "prefix trees"] |
| breaks ties by recency, then by the tab order (line 84) | **KEEP** | Fixed regression oracle: titles(results("fix", rows, [], { "Fix B": 5, "Fix C": 9 }).sessions) deepEqual ["Fix C", "Fix B", "Fix A"] ; titles(results("fix", rows).sessions) deepEqual ["Fix A", "Fix B", "Fix C"] |
| recency never lifts a weaker match over a stronger one (line 90) | **KEEP** | Fixed regression oracle: titles(results("fix", rows, [], { "Quick fix": 100 }).sessions) deepEqual ["Fix login", "Quick fix"] |
| matches session titles, project names and workspace names; projects by name and workspace (line 95) | **REWRITE** | Existing paletteResults owner absorbs accent/case, cross-field and title/project priority oracles from four internal score tests. Fixed expected visible title sequences detect wrong ranking without depending on score numbers. Current independent oracle: titles(results("tools", rows).sessions) deepEqual ["Docs"] ; titles(results("app", [session("Other", app), session("App setup", api)]).sessions) deepEqual ["App setup", "Other"] |
| lists delegated and forked chats like any other tab (line 102) | **KEEP** | Fixed regression oracle: titles(results("auth", [child]).sessions) deepEqual ["Auth: write tests"] |
| the group with the best match leads (line 108) | **KEEP** | Fixed regression oracle: results("map", rows, projects).projectsFirst equal true ; results("map", [], projects).projectsFirst equal true |
| an empty query lists the most recent first, and the active projects (line 117) | **KEEP** | Fixed regression oracle: titles(out.sessions) deepEqual ["New", "Mid", "Old"] ; none.projectsLabel equal "Projects" |
| a session's latest turn, this client's visit, else its creation (line 131) | **KEEP** | Fixed regression oracle: sessionRecency({ createdAt: created, latestTurn: null }, undefined) equal Date.parse(created) ; sessionRecency({ createdAt: "garbage", latestTurn: undefined }, "nope") equal 0 |
| marks each word, preferring a word start, merged where they touch (line 146) | **KEEP** | Fixed regression oracle: matchRanges("prefix fix", "fix") deepEqual [[7, 10]] ; matchRanges("abc", "zz") deepEqual [] |
| a row keeps the stamp it was first ranked with while the palette is open (line 156) | **KEEP** | Fixed regression oracle: rank() deepEqual ["Fix B", "Fix A"] ; reopened.get(rows[0]!.session.id, () => live["Fix A"]!) equal 99 |
| asks for a key's live stamp once (line 178) | **DELETE** | Read-count implementation assertion duplicates the observable frozen-ranking behavior in a row keeps the stamp it was first ranked with while the palette is open (B4/B6). |

## packages/ui/src/components/command-palette/conversation-search.test.ts

Contract source, production consumer seam and six-bar reasoning: **command-palette** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| switches to search when &#96;?&#96; is typed first, and keeps the rest as the query (line 40) | **KEEP** | Fixed regression oracle: paletteInputChange("go", "?format") deepEqual { mode: "search", query: "format" } ; paletteInputChange("go", "?") deepEqual { mode: "search", query: "" } |
| leaves an ordinary query alone (line 45) | **KEEP** | Fixed regression oracle: paletteInputChange("go", "orq") deepEqual { mode: "go", query: "orq" } ; paletteInputChange("go", "a?b") deepEqual { mode: "go", query: "a?b" } |
| treats a &#96;?&#96; typed inside the mode as text (line 50) | **KEEP** | Fixed regression oracle: paletteInputChange("search", "?why") deepEqual { mode: "search", query: "?why" } |
| trims, and sends nothing for blank input (line 56) | **KEEP** | Fixed regression oracle: conversationSearchQuery(" format bytes ") equal "format bytes" ; conversationSearchQuery(" ") equal "" |
| never sends more than the host would read (line 61) | **KEEP** | Fixed regression oracle: conversationSearchQuery("x".repeat(260)).length equal 200 |
| splits a snippet on its «marks» (line 67) | **KEEP** | Fixed regression oracle: snippetSegments("rename «formatBytes» here") deepEqual [ { text: "rename ", match: false }, { text: "formatBytes", match: true }, { text: " here", match: false } ] ; snippetSegments("«a» and «b»") deepEqual [ { text: "a", match: true }, { text: " and ", match: false }, { text: "b", match: true } ] |
| keeps a snippet without marks, or with an unclosed one, as plain text (line 80) | **KEEP** | Fixed regression oracle: snippetSegments("no marks here") deepEqual [{ text: "no marks here", match: false }] ; snippetSegments("open « only") deepEqual [{ text: "open « only", match: false }] |
| says the index is unavailable only when the host answers &#96;indexed: false&#96; (line 90) | **KEEP** | Fixed regression oracle: notice({ status: "done", query: "x", response: response({ indexed: false, hits: [] }) }) equal "unavailable" |
| never reads an HTTP error as an unavailable index — it is a failure worth retrying (line 97) | **KEEP** | Fixed regression oracle: shown?.kind equal "error" |
| says there are no matches, rather than showing nothing (line 108) | **KEEP** | Fixed regression oracle: notice({ status: "done", query: "x", response: response({ hits: [] }) }) equal "empty" ; notice({ status: "done", query: "x", response: response() }, 1) equal null |
| shows the previous results while the next search runs (line 118) | **KEEP** | Fixed regression oracle: shownSearchResponse(loading) deepEqual previous ; notice({ status: "loading", query: "fo", previous: null }) equal "loading" |
| surfaces any other failure in words (line 126) | **KEEP** | Fixed regression oracle: failed.status equal "error" ; failed.message equal "the host answered garbage" |
| says when more matched than it shows (line 135) | **KEEP** | Fixed regression oracle: conversationSearchNotice(truncated, 1)?.kind equal "truncated" |

## packages/ui/src/components/desktop/desktop-keys.test.ts

Contract source, production consumer seam and six-bar reasoning: **desktop** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| Latin-1 characters are their own keysym (line 6) | **KEEP** | Fixed regression oracle: keysymForCodePoint("a".codePointAt(0)!) equal 0x61 ; keysymForCodePoint("é".codePointAt(0)!) equal 0xe9 |
| other code points use the Unicode keysym range (line 13) | **KEEP** | Fixed regression oracle: keysymForCodePoint("€".codePointAt(0)!) equal 0x010020ac ; keysymForCodePoint("😀".codePointAt(0)!) equal 0x0101f600 |
| newline and tab map to Return and Tab; other controls are dropped (line 18) | **KEEP** | Fixed regression oracle: keysymForCodePoint(0x0a) equal 0xff0d ; keysymForCodePoint(0x85) equal null |
| text splits by code point, not UTF-16 unit (line 25) | **KEEP** | Fixed regression oracle: keysymsForText("a😀\n") deepEqual [0x61, 0x0101f600, 0xff0d] |
| a paste chord replays as Ctrl+V, keeping Shift with an uppercase keysym (line 29) | **REWRITE** | Retain fixed X11 key-byte/down-up sequence oracles for plain and Shift paste. Remove one default-chord equality whose expected value was calculated by calling the implementation again. Current independent oracle: keysyms(pasteKeystroke(null, false)) deepEqual [[0xffe3, true], [0x76, true], [0x76, false], [0xffe3, false]] ; keysyms(pasteKeystroke({ shift: true, alt: false, meta: false }, false)) deepEqual [[0xffe3, true], [0x56, true], [0x56, false], [0xffe3, false]] |
| Cmd+V on a Mac releases what noVNC sent for either Cmd key before Ctrl+V (line 37) | **KEEP** | Fixed regression oracle: steps.slice(0, 2) deepEqual [ { keysym: 0xffe9, code: "MetaLeft", down: false }, { keysym: 0xffeb, code: "MetaRight", down: false } ] ; pasteKeystroke({ shift: false, alt: false, meta: true }, false).slice(0, 2) deepEqual [ { keysym: 0xffeb, code: "MetaLeft", down: false }, { keysym: 0xffec, code: "MetaRight", down: false } ] |
| a paste chord with Option/Alt releases both sides of it (line 50) | **KEEP** | Fixed regression oracle: pasteKeystroke({ shift: false, alt: true, meta: false }, true).slice(0, 2) deepEqual [ { keysym: 0xff7e, code: "AltLeft", down: false }, { keysym: 0xfe03, code: "AltRight", down: false } ] ; pasteKeystroke({ shift: false, alt: true, meta: false }, false).slice(0, 2) deepEqual [ { keysym: 0xffe9, code: "AltLeft", down: false }, { keysym: 0xffea, code: "AltRight", down: false } ] |
| named keys (line 61) | **KEEP** | Fixed regression oracle: keysymForNamedKey("Backspace") equal 0xff08 ; keysymForNamedKey("a") equal null |

## packages/ui/src/components/desktop/desktop-pointer.test.ts

Contract source, production consumer seam and six-bar reasoning: **desktop** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| a mouse leaving over an edge parks the pointer on that edge's last pixel (line 8) | **KEEP** | Fixed regression oracle: exitPoint(rect, 400, 20) deepEqual { x: 400, y: 50 } ; exitPoint(rect, 950, 700) deepEqual { x: 899, y: 649 } |
| a point already inside stays put (line 14) | **KEEP** | Fixed regression oracle: exitPoint(rect, 500, 400) deepEqual { x: 500, y: 400 } |
| a degenerate rect never yields a point outside its origin (line 18) | **DELETE** | Defensive zero-area geometry combination has no independently specified remote-pointer requirement or realistic visible canvas seam (B1/B2); real-edge and in-bounds coordinates remain. |

## packages/ui/src/components/desktop/launch-dialog-model.test.ts

Contract source, production consumer seam and six-bar reasoning: **desktop** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| suggestions list recents, then .desktop entries by name, then executables as ./path (line 32) | **KEEP** | Fixed regression oracle: items.map((i) => [i.kind, i.label, i.insert]) deepEqual [ ["recent", "./run.sh --dev", "./run.sh --dev"], ["entry", "XTerm", "xterm"], ["entry", "Mousepad", "mousepad"], ["entry", "GIMP", "gimp-2.10"], ["executable", "build/linux/bin/jasperengin… ; suggestionItems(null) deepEqual [] |
| an executable path keeps an explicit prefix (line 49) | **KEEP** | Fixed regression oracle: executableCommand("bin/app") equal "./bin/app" ; executableCommand("/usr/bin/xterm") equal "/usr/bin/xterm" |
| empty input lists the first suggestions; typing fuzzy-matches name and command (line 55) | **KEEP** | Fixed regression oracle: rankSuggestions(items, "", 3).length equal 3 ; rankSuggestions(items, "zzzz") deepEqual [] |
| an input that already is a suggestion's command lists nothing (line 68) | **KEEP** | Fixed regression oracle: rankSuggestions(suggestionItems(response), "xterm") deepEqual [] |
| the command must be one non-empty line within the limit (line 72) | **KEEP** | Fixed regression oracle: commandError("xterm") equal null ; commandError("a".repeat(DESKTOP_MAX_COMMAND_LENGTH)) equal null |
| env rows: blanks ignored, keys validated, duplicates refused (line 80) | **KEEP** | Fixed regression oracle: env deepEqual { DEBUG: "1", _OK2: "" } ; Object.keys(errors).sort() deepEqual ["c", "d", "e"] |
| rows round-trip a recent launch's env (line 93) | **KEEP** | Fixed regression oracle: envFromRows(rows).env deepEqual { A: "1", B: "two" } |
| the launch request trims, and omits an empty cwd and env (line 99) | **KEEP** | Fixed regression oracle: buildLaunchRequest({ command: " xterm ", cwd: " ", envRows: [] }) deepEqual { ok: true, request: { command: "xterm" } } ; assert.ok(bad.envErrors.a) |
| a new desktop sends size and render threads only when not the defaults (line 116) | **KEEP** | Fixed regression oracle: buildCreateRequest("/w/p", app, { sizeId: "fit", renderThreads: 4 }) deepEqual { projectPath: "/w/p", app } ; clampRenderThreads(Number.NaN) equal 4 |
| daemon errors show their message and a 409's install hint (line 133) | **KEEP** | Fixed regression oracle: assert.ok(message.includes("Xvnc is missing")) ; describeLaunchError({ serverMessage: null, message: "x", body: { hint: "x" } }) equal "x" |
| while a new desktop starts, the dialog follows its detail; older and other projects' desktops are not it (line 146) | **KEEP** | Fixed regression oracle: startingDesktopDetail([], "/w/p", known) equal null ; startingDesktopDetail([{ ...base, id: "new", statusDetail: " Unpacking openbox (3.6.1) ... " }], "/… equal "Unpacking openbox (3.6.1) ..." |

## packages/ui/src/components/git/DiffFilesView.render.test.ts

Contract source, production consumer seam and six-bar reasoning: **git** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| each file is its own section, named, with its markers and counts (line 37) | **KEEP** | Fixed regression oracle: html match /4 changed files/ ; html match /Code: 2 files, \+1 −1; Generated: 1 file, \+1 −1; Docs: 1 file/ |
| a whole binary turn still lists its files, and an empty one says so (line 54) | **KEEP** | Fixed regression oracle: binaryOnly match /aria-label="a.png"/ ; empty match /Nothing here\./ |
| a cut patch keeps what arrived and says it was cut (line 65) | **KEEP** | Fixed regression oracle: html match /kept/ ; html match /cut at its size limit/ |
| the split stays quiet for an all-code change and counts files in files mode (line 73) | **DELETE** | Duplicates shouldShowChangeKindSplit/changeKindRows at stronger lower seam and adds markup/copy coupling (B5/B6). |

## packages/ui/src/components/git/change-kinds.test.ts

Contract source, production consumer seam and six-bar reasoning: **git** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| lists only the kinds a change touches, in display order (line 7) | **KEEP** | Fixed regression oracle: rows deepEqual [ { kind: "code", label: "Code", files: 2, additions: 8, deletions: 3 }, { kind: "tests", label: "Tests", files: 1, additions: 5, deletions: 1 }, { kind: "docs", label: "Docs", files: 1, additions: 2, … |
| counts files without line counts (a working-tree status list) (line 21) | **KEEP** | Fixed regression oracle: rows.map((r) => [r.kind, r.files, r.additions]) deepEqual [ ["code", 1, 0], ["generated", 1, 0] ] |
| is empty for no files (line 32) | **DELETE** | Empty input already exercised through shouldShowChangeKindSplit's empty-change case (B6). |
| stays quiet when the change is all code or empty (line 38) | **KEEP** | Fixed regression oracle: shouldShowChangeKindSplit(changeKindRows([])) equal false ; shouldShowChangeKindSplit(changeKindRows([{ path: "a.ts" }, { path: "b.ts" }])) equal false |
| shows a mix, or a change that is all one non-code kind (line 43) | **KEEP** | Fixed regression oracle: shouldShowChangeKindSplit(changeKindRows([{ path: "a.ts" }, { path: "a.test.ts" }])) equal true ; shouldShowChangeKindSplit(changeKindRows([{ path: "docs/a.md" }])) equal true |
| describes each kind with its lines (line 56) | **DELETE** | Exact English title formatting lacks a byte contract and rendering already exercises the visible aggregated counts (B1/B6). |
| describes files only when asked (line 60) | **DELETE** | Exact English title formatting lacks an independent wording contract; numeric aggregation stays in changeKindRows (B1/B5). |

## packages/ui/src/components/git/diff-files.test.ts

Contract source, production consumer seam and six-bar reasoning: **git** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| marks added, deleted, renamed and copied files (line 21) | **KEEP** | Fixed regression oracle: diffFileBadges(added) deepEqual [{ label: "Added", tone: "added" }] ; diffFileBadges(copied) deepEqual [{ label: "Copied", tone: "renamed" }] |
| marks a mode change and a binary file, and nothing for a plain edit (line 32) | **KEEP** | Fixed regression oracle: diffFileBadges(mode) deepEqual [{ label: "Mode 100644 → 100755", tone: "neutral" }] ; diffFileBadges(plain) deepEqual [] |
| says why a section has no rows (line 43) | **DELETE** | Exact empty-section copy tests formatting branches; parser tests own binary/mode/empty-file semantics and DiffFilesView's mixed patch proves files remain visible (B1/B6). |
| collapses generated files and very long files, and opens the rest (line 56) | **KEEP** | Fixed regression oracle: collapsedByDefault(lock) equal true ; collapsedByDefault(long) equal true |
| strips the daemon's cut marker and says so (line 74) | **KEEP** | Fixed regression oracle: splitTruncationMarker("+a\n\n[truncated]") deepEqual { text: "+a", truncated: true } ; splitTruncationMarker("+a\n") deepEqual { text: "+a\n", truncated: false } |
| tells apart two sections for the same path (line 81) | **KEEP** | Fixed regression oracle: files.length equal 2 ; diffFileKey(files[0]!, 0) notEqual diffFileKey(files[1]!, 1) |

## packages/ui/src/components/git/git-diff.test.ts

Contract source, production consumer seam and six-bar reasoning: **git** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| splits a multi-file patch into one section per file, with names and counts (line 50) | **KEEP** | Fixed regression oracle: files.map((f) => [f.path, f.change, f.additions, f.deletions]) deepEqual [ ["src/a.ts", "modified", 1, 1], ["docs/new.md", "added", 2, 0], ["src/gone.ts", "deleted", 0, 1] ] ; files[2]?.oldPath equal "src/gone.ts" |
| reads a rename's old and new paths and similarity, with or without content changes (line 78) | **KEEP** | Fixed regression oracle: first?.change equal "renamed" ; [second?.additions, second?.deletions] deepEqual [1, 1] |
| flags a binary file on its own and keeps the text files beside it (line 111) | **KEEP** | Fixed regression oracle: files.map((f) => [f.path, f.binary]) deepEqual [ ["src/a.ts", false], ["assets/logo.png", true], ["docs/new.md", false] ] ; files[0]?.hunks.length equal 1 |
| treats a GIT binary patch body as one binary file, not as hunks (line 125) | **KEEP** | Fixed regression oracle: files.map((f) => [f.path, f.binary, f.change, f.hunks.length]) deepEqual [ ["a.bin", true, "added", 0], ["src/a.ts", false, "modified", 1] ] |
| marks the row a 'No newline at end of file' follows and counts nothing for it (line 149) | **KEEP** | Fixed regression oracle: rows.map((r) => [r.type, r.text, r.noNewline ?? false]) deepEqual [ ["hunk", "@@ -1,2 +1,2 @@", false], ["context", "keep", false], ["del", "old", true], ["add", "new", true] ] ; [file?.additions, file?.deletions] deepEqual [1, 1] |
| reads a mode-only change as a file with modes and no hunks (line 176) | **KEEP** | Fixed regression oracle: file?.path equal "run.sh" ; file?.binary equal false |
| reads an empty added file (line 186) | **KEEP** | Fixed regression oracle: file?.change equal "added" ; file?.hunks.length equal 0 |
| is no files for an empty or whitespace diff (line 193) | **KEEP** | Fixed regression oracle: parseDiffFiles("") deepEqual [] ; parseDiffFiles("\n\n") deepEqual [] |
| reads a removed line that starts with '-- ' as a deletion, not a file header (line 198) | **KEEP** | Fixed regression oracle: file?.path equal "q.sql" ; file?.hunks[0]?.rows.slice(1).map((r) => [r.type, r.text]) deepEqual [ ["del", "-- a comment"], ["add", "++ not a header"], ["context", "select 1;"] ] |
| decodes quoted, tab-terminated and non-ASCII paths (line 221) | **KEEP** | Fixed regression oracle: files.map((f) => f.path) deepEqual ["my dir/a b.ts", "café.txt"] |
| names a binary file whose header has spaces from the symmetric header (line 245) | **KEEP** | Fixed regression oracle: file?.path equal "my img.png" ; file?.binary equal true |
| reads a bare patch with no &#96;diff --git&#96; preamble, and skips a &#96;git show&#96; header (line 253) | **KEEP** | Fixed regression oracle: files.length equal 1 ; [files[0]?.additions, files[0]?.deletions] deepEqual [1, 1] |
| keeps the lines of a hunk whose counts are understated (line 262) | **KEEP** | Fixed regression oracle: file?.hunks[0]?.rows.slice(1).map((r) => [r.type, r.text]) deepEqual [ ["del", "a"], ["add", "b"], ["add", "c"], ["context", "d"] ] ; [file?.additions, file?.deletions] deepEqual [2, 1] |
| keeps what a truncated patch got through (line 276) | **KEEP** | Fixed regression oracle: files.length equal 1 ; files[0]?.additions equal 1 |
| reads paths, changes, modes and binary markers without the CR (line 286) | **KEEP** | Fixed regression oracle: files.map((f) => [f.path, f.oldPath, f.change, f.binary]) deepEqual [ ["src/a.ts", "src/a.ts", "modified", false], ["assets/logo.png", "assets/logo.png", "modified", true], ["run.sh", "run.sh", "modified", false], ["y.ts", "x.ts", "renamed", false], … ; classifyChangedFile(files[4]!.path) equal "generated" |
| keeps hunk headers clean and the rows' line numbers and counts right (line 320) | **KEEP** | Fixed regression oracle: file?.hunks[0]?.header equal "@@ -1,3 +1,3 @@" ; [file?.additions, file?.deletions] deepEqual [1, 1] |
| keeps a content row's CR, as &#96;git apply&#96; does, and reads the markers around it (line 337) | **KEEP** | Fixed regression oracle: rows.slice(1).map((r) => [r.type, r.text, r.noNewline ?? false]) deepEqual [ ["del", "old\r", true], ["add", "new\r", false], ["context", "", false], ["context", "tail\r", false] ] |
| tells a CRLF line ending from a CR that is the change itself (line 365) | **KEEP** | Fixed regression oracle: file?.hunks[0]?.rows.slice(1).map((r) => r.text) deepEqual ["x", "x\r"] |
| is binary only when every file is (line 376) | **KEEP** | Fixed regression oracle: parseUnifiedDiff(BINARY).binary equal true ; mixed.hunks.length equal 1 |
| does not read a text line mentioning the marker as binary (line 383) | **KEEP** | Fixed regression oracle: parsed.binary equal false ; parsed.hunks[0]?.rows[1]?.text equal "Binary files a and b differ" |
| is no hunks for an empty diff (line 391) | **KEEP** | Fixed regression oracle: parseUnifiedDiff("") deepEqual { hunks: [], binary: false } |

## packages/ui/src/components/knowledge/graph-layout.test.ts

Contract source, production consumer seam and six-bar reasoning: **knowledge** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| places every concept, at distinct points, ignoring edges it cannot draw (line 7) | **REWRITE** | Keep concept completeness and finite drawable positions at the actual layout engine boundary (Knowledge Graph spec: canvas shows concepts); drop arbitrary distinct-rounded-coordinate geometry. Worker tests do not exercise actual concept retention. Current independent oracle: Object.keys(positions).sort() deepEqual ["a", "b", "c"] ; assert.ok(Number.isFinite(x) && Number.isFinite(y)) |
| lays out an empty graph (line 26) | **DELETE** | Empty third-party geometry restatement has no unique contract beyond an empty graph UI state (B1/B6). |
| scales a crowded layout about its centre and leaves a roomy one alone (line 32) | **DELETE** | Asserts private packing geometry and object identity without independent visual regression requirements (B1/B4/B5). |
| new data terminates a worker still arranging the old graph, so the new one does not wait behind it (line 66) | **REWRITE** | Keep termination of obsolete active work and dropped stale response/current response delivery; remove the unrelated idle-worker reuse/call-count assertions, which pin a private allocation policy. Worker answers now carry independently chosen coordinates, rather than deriving expected coordinates from the production request counter. Current independent oracle: assert.fail("no failure") ; done deepEqual [17] |
| cancel stops a busy worker; dispose terminates the worker (line 90) | **REWRITE** | Observe that responses arriving after cancel or dispose deliver nothing, alongside worker termination; the old test only counted terminate calls and never challenged cancelled callbacks. Current independent oracle: assert.fail("cancelled") ; done deepEqual [] |
| a worker that crashes fails its request and is replaced for the next one (line 106) | **REWRITE** | Preserve the failure callback and termination; verify a subsequent request actually receives its result rather than only counting a replacement factory call. Recovery uses a fixed independently authored coordinate, not an assumed internal request sequence. Current independent oracle: assert.fail("it crashed") ; recovered deepEqual [29] |
| fits a shown graph at once (line 129) | **DELETE** | Private Cytoscape fit-call count is a collaborator-shape check, not an observed user-visible result (B4/B5). |
| waits while the tab is hidden (no size), then fits once it has a size again (line 135) | **DELETE** | Uses a fake viewport implementing the fit observation and only counts private calls; does not prove visible graph zoom (B2/B4/B5). |

## packages/ui/src/components/knowledge/graph.logic.test.ts

Contract source, production consumer seam and six-bar reasoning: **knowledge** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| asks for the overview, filtered, or a neighbourhood (line 29) | **KEEP** | Fixed regression oracle: graphQueryOf({ collections: [], focus: null }) deepEqual {} ; graphScopeKey({ collections: ["b", "a"], focus: null }) equal graphScopeKey({ collections: ["a", "b"], focus: null }) |
| keeps the canvas when the concept is on it (line 41) | **KEEP** | Fixed regression oracle: focusFor({ kind: "concept", id: "a" }, partial, null) equal null ; focusFor({ kind: "concept", id: "a" }, partial, "x") equal "x" |
| shows the neighbourhood of a concept that is not on it (line 46) | **KEEP** | Fixed regression oracle: focusFor({ kind: "concept", id: "b" }, partial, null) equal "b" ; focusFor({ kind: "concept", id: "b" }, full, null) equal "b" |
| keeps a complete overview for an entry, and focuses it on a truncated one (line 51) | **KEEP** | Fixed regression oracle: focusFor({ kind: "entry", id: "ke_1" }, full, null) equal null ; focusFor({ kind: "entry", id: "ke_1" }, full, "a") equal "ke_1" |
| changes nothing before the graph has loaded (line 57) | **KEEP** | Fixed regression oracle: focusFor({ kind: "concept", id: "b" }, null, null) equal null |
| says when the canvas holds part of the graph (line 61) | **KEEP** | Fixed regression oracle: truncationNote({ truncated: false, nodes: [], totals: { nodes: 0, edges: 0 } }, false) equal null ; truncationNote({ truncated: true, nodes: [node()], totals: { nodes: 4000, edges: 1 } }, true) ?? "" match /neighbourhood: 1 of 4,000/ |
| colours by the concept's collections, once per colour, within the filter (line 69) | **KEEP** | Fixed regression oracle: nodeColors(node({ collections: ["kc_ads", "kc_seo", "kc_saas"] }), colorOf, []) deepEqual ["chart-2", "chart-1"] ; nodeColors(node({ collections: ["kc_unknown"] }), colorOf, []) deepEqual [] |
| sizes by degree within the bounds (line 75) | **DELETE** | Expected min/max imported from implementation and geometry not specified independently (B1/B3). |
| labels every concept of a small graph and the most connected of a big one (line 82) | **DELETE** | MAX_LABELS imported from implementation; cap and degree-label policy are builder choices, not independent contracts (B1/B3). |
| builds the canvas nodes (line 92) | **DELETE** | Mirrors private canvas projection and imports expected size from implementation (B3/B4/B6); collection-color contract remains in nodeColors. |
| names entry hits, which have no node to mark, and concept hits not on the canvas (line 102) | **KEEP** | Fixed regression oracle: searchSummary([], new Set()) equal null ; searchSummary([conceptHit("b")], new Set(["a"])) equal "Matches: 1 concept (not on the canvas)." |

## packages/ui/src/components/knowledge/knowledge-plugin-section.dom.test.ts

Contract source, production consumer seam and six-bar reasoning: **knowledge** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| while the plugin is off shows no activity, but the indexing settings to prepare it (line 208) | **KEEP** | Fixed regression oracle: text() doesNotMatch /Activity&#124;Rebuild graph/ ; puts deepEqual [{ accountId: "c2" }] |
| shows the activity and follows knowledge.status events (line 218) | **KEEP** | Fixed regression oracle: text() match /2 entries · 3 concepts · 2 collections/ ; text() match /myKG exited with 1/ |
| opens a live worker's transcript read-only in place, never its folder as a project; a closed one offers its id (line 258) | **KEEP** | Fixed regression oracle: rows.length equal 2 ; [...doc().querySelectorAll("[role=dialog]")].some((d) => /Worker transcript/.test(d.textContent ?? … equal false |
| confirms a rebuild with the estimate, then posts it (line 311) | **KEEP** | Fixed regression oracle: assert.ok(calls.includes("estimate")) ; assert.ok(calls.includes("rebuild")) |
| shows the estimate of the latest confirmation, not one an earlier open asked for (line 322) | **KEEP** | Fixed regression oracle: answers.length equal 2 ; text() doesNotMatch /about 5 tasks/ |
| shows a refused rebuild's message (line 343) | **KEEP** | Fixed regression oracle: text() match /A run is already going\./ |
| opens the Knowledge tab and closes Settings (line 358) | **KEEP** | Fixed regression oracle: useAppStore.getState().settingsOpen equal false ; useAppStore.getState().knowledgeTabsByProject[PROJECT.path]?.length equal 1 |
| lists automatic and the Claude accounts, and saves only what changed (line 365) | **KEEP** | Fixed regression oracle: [...account.options].map((o) => o.textContent) deepEqual ["Automatic (with failover)", "me", "Work"] ; puts[1] deepEqual { accountId: null, model: "opus" } |
| refuses concurrency out of bounds before sending (line 387) | **KEEP** | Fixed regression oracle: text() match /Concurrency is a whole number from 1 to 8\./ ; puts deepEqual [] |
| shows the daemon's refusal and keeps the edit (line 395) | **KEEP** | Fixed regression oracle: puts.length equal 1 ; field<HTMLInputElement>("Concurrency").value equal "2" |

## packages/ui/src/components/knowledge/knowledge-plugin.logic.test.ts

Contract source, production consumer seam and six-bar reasoning: **knowledge** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| reads the daemon's settings field by field, defaulting bad fields (line 22) | **KEEP** | Fixed regression oracle: readKnowledgeSettings({ accountId: "acc1", model: "opus", concurrency: 2, extra: true }) deepEqual { accountId: "acc1", model: "opus", concurrency: 2 } ; readKnowledgeSettings({ concurrency: 1.5 }) deepEqual SAVED |
| shows null model as empty and concurrency as text (line 33) | **DELETE** | Trivial form projection duplicated by settings save/clear behavior and plugin DOM form, with no unique failure (B6). |
| refuses concurrency outside 1..8 or not whole (line 37) | **KEEP** | Fixed regression oracle: knowledgeSettingsProblem({ accountId: null, model: "", concurrency }) ?? "" match /whole number from 1 to 8/ ; knowledgeSettingsProblem({ accountId: null, model: "x".repeat(201), concurrency: "4" }) ?? "" match /at most 200/ |
| sends only what changed; an empty model is null (the default) (line 47) | **KEEP** | Fixed regression oracle: knowledgeSettingsPatch(SAVED, { accountId: null, model: " ", concurrency: "4" }) deepEqual { patch: {} } ; assert.ok("error" in knowledgeSettingsPatch(SAVED, { accountId: null, model: "", concurrency: "12" })) |
| lists automatic, then Claude accounts only (line 73) | **KEEP** | Fixed regression oracle: options deepEqual [ { value: "", label: KNOWLEDGE_AUTOMATIC_ACCOUNT_LABEL }, { value: "c1", label: "me" }, { value: "c2", label: "Work (needs sign-in)" } ] |
| keeps a chosen account the list lacks as its own option (line 85) | **KEEP** | Fixed regression oracle: knowledgeAccountOptions([account({ id: "c1" })], "gone").at(-1) deepEqual { value: "gone", label: "Unknown account (gone)" } ; knowledgeAccountOptions(undefined, "c9").at(-1) deepEqual { value: "c9", label: "c9" } |
| formats tokens compactly (line 108) | **DELETE** | Exact formatting output duplicated by activity DOM assertions with the same token examples (B1/B6). |
| describes the last run: when, how long, tasks and tokens (line 113) | **KEEP** | Fixed regression oracle: knowledgeRunLine(run(), () => "2h ago") deepEqual { title: "Update · finished", when: "2h ago", took: "4m", detail: "3 entries · 48 tasks · 1.2M in · 34k out", failed: false } ; knowledgeRunLine(run({ outcome: "failed" }), () => "").failed equal true |
| lists running workers first, then the newest, at most five (line 131) | **KEEP** | Fixed regression oracle: shown deepEqual ["live", "new", "old", "w4", "w5"] ; knowledgeWorkerText({ state: "failed", tasks: 3 }) equal "Failed · 3 tasks" |
| puts the estimate in the rebuild confirmation (line 154) | **DELETE** | Exact helper copy duplicates the DOM rebuild estimate, stale-answer and refusal scenarios (B6). |

## packages/ui/src/components/knowledge/knowledge-view.dom.test.ts

Contract source, production consumer seam and six-bar reasoning: **knowledge** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| says the plugin is off, and offers its settings (line 191) | **KEEP** | Fixed regression oracle: text() match /Knowledge Graph is off/ ; useAppStore.getState().settingsSection equal "plugins" |
| says how to add the first entry when there is none (line 199) | **DELETE** | Empty-state instructions only exact copy; failure-versus-empty behavior is independently protected by the immediately following failed-open case (B1/B6). |
| a knowledge base that cannot be opened (its counts read 0) shows the error, not "No entries yet" (line 205) | **KEEP** | Fixed regression oracle: text() match /The knowledge base could not be opened \(EACCES\)/ ; text() doesNotMatch /No entries yet/ |
| says how many entries could not be linked instead of calling an idle linking complete (line 219) | **DELETE** | Duplicates linkingView's more complete failed-entry state contract at a slower DOM seam (B6). |
| opens on the graph; a concept opens its panel, and an entry in it opens the entry, with Back (line 229) | **KEEP** | Fixed regression oracle: assert.ok(doc().querySelector('[data-testid="canvas"]'), "the graph view is first") ; panel() equal null |
| toggles to the list: collections with counts and profiles, entry cards that open the entry (line 255) | **KEEP** | Fixed regression oracle: doc().querySelector('[data-testid="canvas"]') equal null ; doc().querySelector("aside")?.getAttribute("aria-label") equal "Entry details" |
| edits a collection and refetches the list; a taken name is refused before sending (line 274) | **KEEP** | Fixed regression oracle: assert.ok(doc().querySelector('form[aria-label="Edit collection"]')) ; calls.filter((c) => c === "collections").length equal before + 1 |
| deleting a collection asks first and says what happens to its entries (line 294) | **KEEP** | Fixed regression oracle: text() match /an entry with no other collection becomes Unfiled/ ; assert.ok(calls.includes("delete-collection:kc_seo")) |
| deleting the collection the list is filtered to falls back to All before anything refetches (line 306) | **KEEP** | Fixed regression oracle: assert.ok(calls.includes("entries:kc_seo")) ; text() doesNotMatch /no longer exists&#124;No collection kc_seo/ |
| a focus request selects its entry; editing it sends only what changed (line 352) | **KEEP** | Fixed regression oracle: panel.getAttribute("aria-label") equal "Entry details" ; doc().querySelector('form[aria-label="Edit entry"]') equal null |
| deleting an entry asks first, then closes the panel (line 366) | **KEEP** | Fixed regression oracle: text() match /Delete this entry\?/ ; doc().querySelector("aside") equal null |
| keeps the pages loaded with Load more when entries change (line 379) | **KEEP** | Fixed regression oracle: text() match /First page entry.*Second page entry/ ; assert.ok(buttonNamed("Load more"), "and it can still page on") |
| keeps a search's entry hits in sight after its results close (line 403) | **KEEP** | Fixed regression oracle: assert.ok(doc().querySelector('[role="listbox"][aria-label="Search results"]')) ; doc().querySelector('[role="listbox"]')!.textContent! match /Competitor pages/ |
| a concept asked for before the graph loaded gets its neighbourhood once it does (line 427) | **KEEP** | Fixed regression oracle: calls.filter((c) => c.startsWith("graph:")) deepEqual ["graph:", "graph:tactic-far"] |
| a collection's edit button can take keyboard focus (it is faded, never hidden) (line 432) | **DELETE** | Asserts Tailwind class names rather than browser focus behavior (B2/B4/B5). |
| when the item the canvas centred on is gone, it returns to the overview instead of an error (line 440) | **KEEP** | Fixed regression oracle: calls.filter((c) => c.startsWith("graph:")) deepEqual ["graph:", "graph:ke_aaaaaaaaaaaa", "graph:"] ; text() match /Showing the 2 most connected of 5,000 concepts/ |

## packages/ui/src/components/knowledge/knowledge.logic.test.ts

Contract source, production consumer seam and six-bar reasoning: **knowledge** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| map palette keys to the theme's lane colours (line 25) | **DELETE** | Exact CSS variable mapping tests appearance/private theme token structure, without independent visual requirement (B1/B4/B5). |
| give a new collection the first unused colour, then go round (line 29) | **KEEP** | Fixed regression oracle: nextKnowledgeColor([{ color: "chart-1" }, { color: "chart-3" }], KNOWLEDGE_COLORS) equal "chart-2" ; nextKnowledgeColor([...all, { color: "chart-1" }], KNOWLEDGE_COLORS) equal "chart-2" |
| show the daemon's message, else a text for its code, else the error (line 39) | **KEEP** | Fixed regression oracle: knowledgeErrorText(refused({ code: "KNOWLEDGE_COLLECTION_EXISTS", message: "“SEO” already exists." … equal "“SEO” already exists." ; knowledgeErrorCode(refused({ code: "OTHER" })) equal null |
| counts with singular and plural (line 50) | **DELETE** | Exact status-bar punctuation/pluralization; activity DOM tests own actual counts rendering (B1/B6). |
| describes each linking state (line 54) | **KEEP** | Fixed regression oracle: linkingView({ state: "idle" }).label equal "Linking idle" ; paused.detail equal "Resets soon." |
| does not call idle linking complete while some entries failed (line 79) | **KEEP** | Fixed regression oracle: allLinked.tone equal "idle" ; linkingView({ state: "idle" }, [], now, 1).label equal "1 entry could not be linked" |
| needs a unique name within the limits and a one-line description (line 100) | **KEEP** | Fixed regression oracle: collectionFormError({ name: " ", description: "" }, existing, null) equal "Give the collection a name." ; collectionFormError({ name: "Mobile apps", description: "" }, existing, null) equal null |
| explains what deleting does to the entries (line 110) | **DELETE** | Exact confirmation copy duplicates KnowledgeView DOM delete confirmation and public deletion semantics (B1/B6). |
| shows who and when (line 117) | **DELETE** | Exact byline/date presentation choices without independent byte requirement; KnowledgeView list/panel tests retain entry provenance data (B1/B5). |
| offers only http(s) links as the original post (line 125) | **KEEP** | Fixed regression oracle: entryPostUrl({ url: "https://x.com/a/status/1" }) equal "https://x.com/a/status/1" ; entryPostUrl({ url: null }) equal null |
| patches only what changed (line 133) | **KEEP** | Fixed regression oracle: entryFormPatch(original, form) deepEqual { patch: { title: "Alternatives pages (v2)" } } ; entryFormPatch(original, entryFormOf(original)) deepEqual { patch: {} } |
| clears an emptied optional field and sorts the collections (line 140) | **KEEP** | Fixed regression oracle: result deepEqual { patch: { author: null, url: null, collections: ["kc_ads", "kc_seo"] } } |
| refuses an empty text, a bad URL and a bad date (line 146) | **KEEP** | Fixed regression oracle: entryFormPatch(original, { ...entryFormOf(original), body: " " }) deepEqual { error: "The text cannot be empty." } ; assert.ok("error" in badDate) |
| refuses before sending what the daemon refuses: an empty title, a date that is not ISO (line 156) | **KEEP** | Fixed regression oracle: entryFormPatch(original, { ...entryFormOf(original), title: " " }) deepEqual { error: "Give the entry a title." } ; entryFormPatch(original, { ...entryFormOf(original), postedAt }) deepEqual { patch: { postedAt } } |
| knows a relabel alone does not re-link (line 167) | **KEEP** | Fixed regression oracle: patchNeedsLinking({ collections: ["kc_ads"] }) equal false ; patchNeedsLinking({ url: null, title: "New title" }) equal true |

## packages/ui/src/components/repo/RepoIconDialog.dom.test.ts

Contract source, production consumer seam and six-bar reasoning: **repo** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| titles itself with the repo and refuses more than one emoji (line 146) | **KEEP** | Fixed regression oracle: document.querySelector("h2")?.textContent ?? "" match /Repo icon — JasperRaccoon\/JasperEngine/ ; document.querySelector('[role="alert"]')?.textContent equal "Enter exactly one emoji." |
| sets an emoji, applies it and closes (line 155) | **KEEP** | Fixed regression oracle: api.calls[0].args deepEqual [{ repoKey: KEY, emoji: "🦝" }] ; closes equal 1 |
| shows a website failure inline in friendly words (line 168) | **KEEP** | Fixed regression oracle: button("Fetch icon")?.disabled equal true ; button("Fetch icon")?.disabled equal false |
| closed mid-request, still applies the late answer to the store (line 182) | **KEEP** | Fixed regression oracle: document.querySelector('[role="dialog"]') equal null ; store.getRepoIdentity(KEY)?.icon deepEqual icon |

## packages/ui/src/components/right-rail/agent-profile/daemon-pointing.logic.test.ts

Contract source, production consumer seam and six-bar reasoning: **right-rail** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| daemonPointingReasonFor: only the agent's own user-scope MCP server of that name (line 13) | **KEEP** | Fixed regression oracle: daemonPointingReasonFor({ kind: "mcp", name: "orquester_remote" }, "claude", servers) equal "bearer" ; daemonPointingReasonFor({ kind: "mcp", name: "orquester" }, "codex", servers) equal "name" |
| daemonPointingTitle: names why and what Orquester does about it (line 23) | **DELETE** | Exact tooltip text duplicates the rendered flagged-row contract (B1/B6). |

## packages/ui/src/components/right-rail/agent-profile/daemon-pointing.render.test.ts

Contract source, production consumer seam and six-bar reasoning: **right-rail** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| the panel flags only the row whose server reaches this Orquester, from the detection route's answer (line 44) | **REWRITE** | Keep malformed server rejection, flagged row marker and unflagged unrelated row; drop markup assertions for duplicated exact tooltip wording. Current independent oracle: servers?.length equal 2 ; plain doesNotMatch /data-daemon-pointing/ |
| without the route's answer (an older daemon, a failed read) no row is flagged (line 61) | **KEEP** | Fixed regression oracle: parseDaemonMcpServers({ error: { code: "NOT_FOUND" } }) equal null ; render([item("mcp", "orquester")]) doesNotMatch /Disabled inside Orquester chats/ |

## packages/ui/src/components/right-rail/agent-profile/default-agent.test.ts

Contract source, production consumer seam and six-bar reasoning: **right-rail** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| is the provider serving the tab's refId (line 19) | **KEEP** | Fixed regression oracle: agentForRefId("claude-chat", PROVIDERS, REGISTRY_AGENTS) equal "claude" ; agentForRefId("codex", PROVIDERS, REGISTRY_AGENTS) equal "codex" |
| falls back to the registry's chat adapter while the providers have not loaded (line 24) | **KEEP** | Fixed regression oracle: agentForRefId("opencode-chat", [], REGISTRY_AGENTS) equal "opencode" ; agentForRefId("grok", [], REGISTRY_AGENTS) equal "grok" |
| is none for no tab, or an agent this panel has no profile for (line 29) | **KEEP** | Fixed regression oracle: agentForRefId(null, PROVIDERS, REGISTRY_AGENTS) equal null ; agentForRefId("bash", PROVIDERS, REGISTRY_AGENTS) equal null |
| is the visible chat tab's agent first (line 41) | **KEEP** | Fixed regression oracle: defaultAgentProfileAgent({ chatAgent: "codex", remembered: "grok", installed: all }) equal "codex" |
| else the one last picked (line 45) | **KEEP** | Fixed regression oracle: defaultAgentProfileAgent({ chatAgent: null, remembered: "grok", installed: all }) equal "grok" ; defaultAgentProfileAgent({ chatAgent: null, remembered: "grok", installed: unknown }) equal "grok" |
| passes over an agent known not to be installed (line 50) | **KEEP** | Fixed regression oracle: defaultAgentProfileAgent({ chatAgent: "codex", remembered: null, installed }) equal "claude" ; defaultAgentProfileAgent({ chatAgent: "codex", remembered: "opencode", installed }) equal "opencode" |

## packages/ui/src/components/right-rail/agent-profile/editor/markdown.logic.test.ts

Contract source, production consumer seam and six-bar reasoning: **right-rail** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| a new skill's switches start at the CLI's defaults and send nothing until changed (line 11) | **KEEP** | Fixed regression oracle: form.values["user-invocable"] equal true ; markdownDraftFromForm("skill", model, form).frontmatter deepEqual { name: "review-pr", description: "Reviews a PR.", "disable-model-invocation": true, "user-invocable": false } |
| editing keeps unknown keys and type-mismatched keys untouched, and removes a cleared key (line 28) | **KEEP** | Fixed regression oracle: model.keptKeys deepEqual ["allowed-tools", "metadata"] ; "metadata" in draft.frontmatter equal false |
| a command carries no frontmatter name and keeps a name key found on disk (line 63) | **KEEP** | Fixed regression oracle: model.keptKeys deepEqual ["name"] ; markdownDraftFromForm("command", model, form).frontmatter deepEqual { description: "Review", subtask: true } |
| names: Grok's commands are flat files — a folder is refused before the daemon does (line 72) | **KEEP** | Fixed regression oracle: validateMarkdownForm("command", grok, form).valid equal false ; validateMarkdownForm("command", grok, form).valid equal true |
| validation: a skill needs its description and a body; a command's description is optional (line 81) | **KEEP** | Fixed regression oracle: result.valid equal false ; result.valid equal true |

## packages/ui/src/components/right-rail/agent-profile/editor/mcp.logic.test.ts

Contract source, production consumer seam and six-bar reasoning: **right-rail** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| splitCommandLine splits like a shell: quotes, escapes, continuations, no expansion (line 29) | **KEEP** | Fixed regression oracle: parsePastedCommandLine(line) deepEqual { command, args, env: [] } |
| a pasted command line becomes command + args, with leading assignments as env (line 42) | **KEEP** | Fixed regression oracle: parsePastedCommandLine("npx -y @acme/jira-mcp --stdio") deepEqual { command: "npx", args: ["-y", "@acme/jira-mcp", "--stdio"], env: [] } ; parsePastedCommandLine("FOO=1") equal null |
| secret drafts: untouched rows keep, replaced and new rows send a value, removed rows are absent (line 61) | **KEEP** | Fixed regression oracle: mcpDraftFromForm("claude", { ...initialMcpForm("claude", STDIO), env: rows }, mcpFormOrigin(STDIO))… deepEqual [ { key: "JIRA_TOKEN", keep: true }, { key: "JIRA_URL", value: "https://new" }, { key: "NEW_ONE", value: "v" } ] |
| secret rows: bad keys, duplicates (headers case-insensitively) and an empty replacement are refused (line 75) | **KEEP** | Fixed regression oracle: Object.keys(env).sort() deepEqual ["1", "3", "4", "5"] ; Object.keys(headers).sort() deepEqual ["2", "3"] |
| the stdio draft carries command, args, cwd and env; the http draft url and headers only (line 93) | **KEEP** | Fixed regression oracle: draft deepEqual { name: "jira-cloud", transport: "stdio", command: "npx", args: ["-y", "@acme/jira-mcp"], cwd: "/srv/jira", env: [ { key: "JIRA_TOKEN", keep: true }, { key: "EXTRA", value: "1" } … ; mcpDraftFromForm("claude", http, mcpFormOrigin()) deepEqual { name: "docs", transport: "http", url: "https://mcp.example.com/mcp", headers: [{ key: "Authorization", value: "Bearer x" }] } |
| advanced fields are coerced by type; unknown keys on disk pass through; blanks are left out (line 126) | **KEEP** | Fixed regression oracle: mcpDraftFromForm("codex", { ...initialMcpForm("codex"), advanced: values }, origin).advanced deepEqual { experimental_x: "kept", startup_timeout_sec: 30, enabled_tools: ["search", "get", "list"], bearer_token_env_var: "TOKEN_VAR", required: true } ; mcpDraftFromForm("codex", { ...initialMcpForm("codex"), advanced: { required: false } }, { name: "x… equal false |
| validation: stdio needs a command, http a real http(s) URL, numbers must parse (line 155) | **KEEP** | Fixed regression oracle: result.valid equal false ; validateMcpForm("codex", form).valid equal true |
| editing an SSE server preserves its transport in the saved draft (line 175) | **KEEP** | Fixed regression oracle: mcpDraftFromForm("grok", initialMcpForm("grok", view), mcpFormOrigin(view)) deepEqual view |
| saveGlobalRunInBox writes only what moved, under the name the server was saved as (line 181) | **KEEP** | Fixed regression oracle: writes deepEqual [] ; writes.splice(0) deepEqual [{ agent: "claude", name: "linear-2", runInBox: true }] |
| saveGlobalRunInBox keeps the save when the switch can't be written, and says so (line 209) | **KEEP** | Fixed regression oracle: answer.itemIds[0] equal "mcp:jira" ; answer.notes[1] ?? "" match /"Run in box" setting was not saved \(offline\)/ |

## packages/ui/src/components/right-rail/agent-profile/editor/saved.test.ts

Contract source, production consumer seam and six-bar reasoning: **right-rail** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| a save puts the answer's snapshot in the store and tells the panel what changed (line 16) | **KEEP** | Fixed regression oracle: entry.snapshot?.revision equal "r2" ; heard deepEqual [{ agent: "grok", itemIds: ["mcp:docs"], notes: ["Saved — applies to new sessions"] }] |
| an answer without a usable snapshot still tells the panel, and leaves the store alone (line 52) | **KEEP** | Fixed regression oracle: agentProfileStore.getState().agents.codex.snapshot equal null ; heard deepEqual [{ agent: "codex", itemIds: [], notes: [] }] |

## packages/ui/src/components/right-rail/agent-profile/editor/small-editors.logic.test.ts

Contract source, production consumer seam and six-bar reasoning: **right-rail** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| hook: the matcher is left out for events that ignore it, and when blank (line 36) | **KEEP** | Fixed regression oracle: hookDraftFromForm(form) deepEqual { event: "PreToolUse", matcher: "Edit&#124;Write", command: "./check.sh", timeoutSec: 30 } ; eventTakesMatcher("PostToolUse") equal true |
| hook: a multi-line command keeps its inner lines (line 45) | **KEEP** | Fixed regression oracle: draft.command equal "set -e\nnpm test" |
| hook: the agent's events, an unlisted event on disk kept selectable, validation (line 50) | **KEEP** | Fixed regression oracle: Object.keys(bad.errors).sort() deepEqual ["command", "event", "timeout"] ; validateHookForm("claude", { ...edit, event: "Custom" }, "Custom").valid equal true |
| plugin: marketplaces from the snapshot, filtering, OpenCode specs (line 84) | **KEEP** | Fixed regression oracle: marketplaceNames(snap) deepEqual ["official"] ; specPluginDraft(" pkg ") deepEqual { spec: "pkg" } |
| marketplace: GitHub repos (URLs normalised), git URLs, paths; ref only where it applies (line 110) | **KEEP** | Fixed regression oracle: validateMarketplaceForm(form).valid equal true ; validateMarketplaceForm({ ...form, repo: "owner/repo" }).valid equal true |
| import: new candidates start ticked; collisions among the picks ask first (line 137) | **KEEP** | Fixed regression oracle: picks deepEqual ["skills/a", "commands/c.md"] ; toggleAllPicks(CANDIDATES, ["skills/a", "skills/b", "commands/c.md"]) deepEqual [] |
| import: git URLs, upload names, upload progress (line 148) | **KEEP** | Fixed regression oracle: gitUrlError("https://github.com/acme/skills/tree/main/skills/x") equal undefined ; assert.ok(uploadFileError("skills.tar.gz")) |
| copy: every other agent; only the source agent's own items of the kind (line 158) | **KEEP** | Fixed regression oracle: copySourceAgents("grok") deepEqual ["claude", "codex", "opencode"] ; copyableItems(null, "skill") deepEqual [] |
| instructions: overwrite re-reads for the fresh revision, then writes mine (line 176) | **KEEP** | Fixed regression oracle: calls deepEqual ["read", "write codex fresh mine"] |
| errors: the daemon's nested code and message; placement by code (line 198) | **KEEP** | Fixed regression oracle: info deepEqual { code: "ITEM_EXISTS", message: "An MCP server named jira already exists" } ; isAbort(new Error("x")) equal false |

## packages/ui/src/components/right-rail/agent-profile/list.logic.test.ts

Contract source, production consumer seam and six-bar reasoning: **right-rail** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| a kind the agent should not have (another daemon version) gets a tab while it has items, after the rest (line 59) | **REWRITE** | Remove sorting of the observed results in the assertion; compare directly with fixed API-specified kind/name order so an ordering regression actually fails. Current independent oracle: profileKindTabs("opencode", [item({ id: "hook:x", kind: "hook" }), item({ id: "mcp:a" }), item({ id… deepEqual [ ["mcp", 2], ["hook", 1] ] |
| shows the remembered tab when it is one of the agent's, else the agent's first (line 69) | **KEEP** | Fixed regression oracle: effectiveKindTab(opencode, "skill") equal "skill" ; assert.ok(tabs.some((tab) => tab.id === effectiveKindTab(tabs, junk)), String(junk)) |
| reads a saved item's kind off its id (line 85) | **KEEP** | Fixed regression oracle: profileItemKindOfId("mcp:jira-cloud") equal "mcp" ; profileItemKindOfId(id) equal null |
| the search matches every word in the name, description, source or meta, any case (line 94) | **KEEP** | Fixed regression oracle: ids("JIRA cloud") deepEqual ["mcp:jira"] ; ids("bash") deepEqual ["hook:PreToolUse:abc"] |
| shows the tab's kind; a search looks across every kind, whatever the tab (line 102) | **KEEP** | Fixed regression oracle: filterProfileItems(ITEMS, { kind: "mcp", query: "" }).map((entry) => entry.id) deepEqual ["mcp:jira", "mcp:Atlas"] ; filterProfileItems(ITEMS, { kind: "skill", query: "zzz" }) deepEqual [] |
| groups in the agent's kind order, each sorted by name, empty kinds left out (line 115) | **REWRITE** | Remove sorting of the observed results in the assertion; compare directly with fixed API-specified kind/name order so an ordering regression actually fails. Current independent oracle: groups.map((group) => [group.kind, group.items.map((entry) => entry.name)]) deepEqual [ ["mcp", ["Atlas", "jira"]], ["skill", ["review"]], ["plugin", ["superpowers"]], ["hook", ["PreToolUse"]], ["command", ["pr"]] ] |
| a kind the agent should not have (another daemon version) still shows, after the rest (line 129) | **REWRITE** | Remove sorting of the observed results in the assertion; compare directly with fixed API-specified kind/name order so an ordering regression actually fails. Current independent oracle: groups.map((group) => group.kind) deepEqual ["mcp", "hook"] |
| not installed wins over everything (line 147) | **KEEP** | Fixed regression oracle: agentProfileEmptyState({ ...base, notInstalled: true }) deepEqual { kind: "not-installed", agent: "claude" } |
| loading, then an error with its message, while there is no snapshot (line 151) | **KEEP** | Fixed regression oracle: agentProfileEmptyState({ ...base, snapshot: null, status: "loading" }) deepEqual { kind: "loading" } ; agentProfileEmptyState({ ...base, snapshot: null, status: "error", error: "boom" }) deepEqual { kind: "error", message: "boom" } |
| no matches while searching, else the empty tab's own state (line 160) | **KEEP** | Fixed regression oracle: agentProfileEmptyState({ ...base, shown: 0, query: " jira " }) deepEqual { kind: "no-matches", query: "jira" } ; agentProfileEmptyState({ ...base, shown: 0, snapshot: snapshot({ items: [] }) }) deepEqual { kind: "empty-kind", itemKind: "skill" } |
| knows an agent is not installed from its snapshot, its refusal, or the overview (line 170) | **KEEP** | Fixed regression oracle: isAgentNotInstalled({ snapshot: snapshot({ installed: false }), errorCode: null, overviewInstalled:… equal true ; isAgentNotInstalled({ snapshot: null, errorCode: null, overviewInstalled: null }) equal false |
| its tooltip carries the adapter's off-switch caveat while on (line 180) | **KEEP** | Fixed regression oracle: assert.ok(switchTitle(item({ id: "mcp:jira", meta: { offNote } })).includes(offNote)) ; assert.ok(!switchTitle(item({ id: "mcp:jira", enabled: false, meta: { offNote } })).includes(offNote)) |
| copies only copyable kinds, to the other installed agents that have the kind (line 186) | **KEEP** | Fixed regression oracle: copyTargets({ kind: "mcp" }, "claude", installed) deepEqual ["codex"] ; copyTargets({ kind: "hook" }, "claude", () => true) deepEqual [] |
| names where an inherited item is managed (line 194) | **KEEP** | Fixed regression oracle: manageInAgent(item({ id: "s", source: { type: "inherited", label: "From Claude", ownerAgent: "claud… equal "claude" ; manageInAgent(ITEMS[0]!) equal null |
| lists the four agents, installed as the snapshot, else the overview, says (line 202) | **KEEP** | Fixed regression oracle: options.map((option) => [option.id, option.installed]) deepEqual [ ["claude", true], ["codex", null], ["grok", false], ["opencode", null] ] ; options[0]?.version equal "2.1" |

## packages/ui/src/components/right-rail/dock-keyboard.test.ts

Contract source, production consumer seam and six-bar reasoning: **right-rail** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| an Escape nothing inside the dock handled leaves the dock (line 15) | **KEEP** | Fixed regression oracle: dockKeyAction(escape) equal "leave" |
| an Escape the panel consumed (the search field clearing itself) stays the panel's (line 19) | **KEEP** | Fixed regression oracle: dockKeyAction({ ...escape, defaultPrevented: true }) equal "ignore" |
| an Escape an open dropdown, menu or dialog of the panel closes is that layer's alone (line 23) | **KEEP** | Fixed regression oracle: dockKeyAction({ ...escape, otherLayerOpen: () => true }) equal "ignore" |
| an IME composition's Escape cancels the composition, nothing else (line 27) | **KEEP** | Fixed regression oracle: dockKeyAction({ ...escape, isComposing: true }) equal "ignore" |
| a held Escape leaves once: its auto-repeat is not another press (line 31) | **KEEP** | Fixed regression oracle: dockKeyAction({ ...escape, repeat: true }) equal "ignore" |
| keys from a portaled child (a dropdown the panel opened) are never the dock's (line 37) | **KEEP** | Fixed regression oracle: dockKeyAction({ ...escape, targetInsideDock: false }) equal "ignore" ; dockKeyAction({ ...escape, key: "1", targetInsideDock: false }) equal "ignore" |
| every other key typed in the dock is contained there (line 43) | **KEEP** | Fixed regression oracle: dockKeyAction({ ...escape, key }) equal "contain" ; dockKeyAction({ ...escape, key: "Process", isComposing: true }) equal "contain" |

## packages/ui/src/components/right-rail/history/history-format.test.ts

Contract source, production consumer seam and six-bar reasoning: **right-rail** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| never ends on half a surrogate pair (line 8) | **KEEP** | Fixed regression oracle: assert.ok(preview.startsWith("a".repeat(499)), "the preview retains the original text") ; preview doesNotMatch /[\uD800-\uDBFF](?![\uDC00-\uDFFF])&#124;(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u |

## packages/ui/src/components/right-rail/right-rail-state.test.ts

Contract source, production consumer seam and six-bar reasoning: **right-rail** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| a well-formed payload round-trips (line 49) | **KEEP** | Fixed regression oracle: await persistRail("history", 412) deepEqual { v: 1, open: "history", width: 412 } ; await loadStoredRail('{"v":1,"open":"history","width":412}') deepEqual { open: "history", width: 412 } |
| each field is validated on its own: one bad field never costs the others (line 58) | **KEEP** | Fixed regression oracle: await loadStoredRail('{"v":1,"open":"files","width":400}') deepEqual { open: null, width: 400 } ; (await loadStoredRail(&#96;{"open":${open}}&#96;)).open equal null |
| workflows (now in the left sidebar) and the agent profile (now Settings → Agent config) no longer open the dock (line 71) | **KEEP** | Fixed regression oracle: await loadStoredRail('{"v":1,"open":"workflows","width":360}') deepEqual { open: null, width: 360 } ; await persistRail("prompts", 360) deepEqual { v: 1, open: "prompts", width: 360 } |
| malformed stored widths fall back without losing the panel (line 77) | **KEEP** | Fixed regression oracle: parsed.open equal "history" ; assert.ok(Number.isFinite(parsed.width) && parsed.width > 0) |
| a payload written by another version is still read field by field (line 85) | **KEEP** | Fixed regression oracle: await loadStoredRail('{"v":2,"open":"history","width":480,"extra":{"a":1}}') deepEqual { open: "history", width: 480 } ; (await loadStoredRail('{"v":"one","open":"prompts"}')).open equal "prompts" |
| load and save swallow storage errors and missing storage (line 90) | **KEEP** | Fixed regression oracle: await loadStoredRail('{"v":1,"open":"prompts","width":350}') deepEqual { open: "prompts", width: 350 } ; assert.doesNotThrow(() => missing.setRightRailOpen("history")) |
| toggling opens, switches and closes the dock — and persists every change (line 102) | **KEEP** | Fixed regression oracle: rightRailState().open equal expected ; JSON.parse(stored.get(key)!).open equal "prompts" |
| a live drag updates the state only; the release persists it (line 112) | **KEEP** | Fixed regression oracle: rightRailState().width equal 420 ; JSON.parse(stored.get(key)!).width equal 420 |
| subscribers hear real changes only, and can unsubscribe (line 121) | **KEEP** | Fixed regression oracle: rightRailState() equal snapshot ; seen.length equal 1 |
| a storage that throws never breaks the store (line 137) | **KEEP** | Fixed regression oracle: rightRailState() deepEqual { open: "history", width: 480 } |

## packages/ui/src/components/right-rail/saved-prompts/deliver.test.ts

Contract source, production consumer seam and six-bar reasoning: **right-rail** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| renders for the chat captured at the click, delivers there, and counts the use (line 64) | **KEEP** | Fixed regression oracle: outcome.status equal "delivered" ; calls.used deepEqual ["p1"] |
| refuses when another chat is on screen once the prompt is rendered — nothing lands, nothing counted (line 76) | **KEEP** | Fixed regression oracle: (await pending).status equal "refused" ; calls.used deepEqual [] |
| with no chat at the click, refuses at once and renders nothing (line 90) | **KEEP** | Fixed regression oracle: (await createSavedPromptDeliverer(deps).deliver(PROMPT, "insert", null)).status equal "refused" ; calls.resolved deepEqual [] |
| a click supersedes the one still resolving: the first lands nowhere, its git reads stop (line 96) | **KEEP** | Fixed regression oracle: calls.resolved[0]?.signal.aborted equal true ; calls.used deepEqual ["fast"] |
| dispose (the panel going away) stops the delivery in flight (line 119) | **KEEP** | Fixed regression oracle: await pending deepEqual { status: "superseded" } ; calls.used deepEqual [] |
| counts the use only when the chat took it (line 131) | **KEEP** | Fixed regression oracle: await createSavedPromptDeliverer(refusedRender.deps).deliver(PROMPT, "insert", "chat-1") deepEqual { status: "refused", reason: "Couldn't read the git diff: x" } ; threw.calls.used deepEqual [] |

## packages/ui/src/components/right-rail/saved-prompts/editor-save.test.ts

Contract source, production consumer seam and six-bar reasoning: **right-rail** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| an edit that changes nothing sends nothing, and closes (line 77) | **KEEP** | Fixed regression oracle: await createSavedPromptSaver(deps).save(editing, initialDraft(editing)) deepEqual { status: "unchanged" } ; calls.updated deepEqual [] |
| an invalid draft is not sent (line 86) | **KEEP** | Fixed regression oracle: await createSavedPromptSaver(deps).save(CREATE, initialDraft(CREATE)) deepEqual { status: "invalid" } ; calls.created deepEqual [] |
| one save at a time: a second while the first is in flight is not sent (line 92) | **KEEP** | Fixed regression oracle: saver.saving equal true ; calls.created.length equal 1 |
| closed while saving: a success still lands and is revealed (line 105) | **KEEP** | Fixed regression oracle: (await pending).status equal "saved" ; calls.lateFailures deepEqual [] |
| closed while saving: a failure becomes the panel's notice (line 118) | **KEEP** | Fixed regression oracle: (await pending).status equal "failed" ; calls.lateFailures deepEqual ["Saved prompts are full"] |
| a request that throws is a failure, and the guard is released (line 129) | **KEEP** | Fixed regression oracle: await saver.save(CREATE, draftOf(CREATE)) deepEqual { status: "failed", error: "socket closed" } ; saver.saving equal false |

## packages/ui/src/components/right-rail/saved-prompts/editor.logic.test.ts

Contract source, production consumer seam and six-bar reasoning: **right-rail** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| a title and a body are required — as missing, not as errors (line 46) | **KEEP** | Fixed regression oracle: empty.valid equal false ; validateSavedPromptDraft(draft()).valid equal true |
| mirrors every limit (line 54) | **KEEP** | Fixed regression oracle: over.valid equal false ; atLimits.valid equal true |
| a create: the whole record, normalised; This project = the open project (line 76) | **KEEP** | Fixed regression oracle: createRequestFromDraft( draft({ title: " Fix tests ", description: " F… deepEqual { title: "Fix tests", description: "Find the root cause", tags: ["tests", "fix", "code review"], projectPath: PROJECT, pinned: true, body: " Run {changedFiles} " } ; createRequestFromDraft(draft({ scope: "project" }), null).projectPath equal null |
| an edit: only the fields that changed (line 101) | **KEEP** | Fixed regression oracle: updatePatchFromDraft(original, initialDraft({ mode: "edit", projectPath: PROJECT, prompt: original … deepEqual {} ; updatePatchFromDraft( original, { ...initialDraft({ mode: "edit", projectPath: PROJ… deepEqual { title: "Renamed", tags: ["Review", "QA"], pinned: false } |
| an edit moves a prompt only when its scope changes — and to the open project (line 114) | **KEEP** | Fixed regression oracle: updatePatchFromDraft(global, { ...base(global), scope: "project" }, PROJECT) deepEqual { projectPath: PROJECT } ; updatePatchFromDraft(projectPrompt, base(projectPrompt), "/w/acme/elsewhere") deepEqual {} |
| never cuts an emoji in half (line 133) | **KEEP** | Fixed regression oracle: request.mode equal "create" ; assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(title), "no lone high surrogate") |
| inserts at the caret, or over the selection, and puts the caret after it (line 145) | **KEEP** | Fixed regression oracle: insertAtSelection("Review now", 7, 7, "{diff}") deepEqual { text: "Review {diff} now", caret: 13 } ; insertAtSelection("Review THIS", 7, 11, "{diff}") deepEqual { text: "Review {diff}", caret: 13 } |

## packages/ui/src/components/right-rail/saved-prompts/saved-prompt-creator.render.test.ts

Contract source, production consumer seam and six-bar reasoning: **right-rail** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| the badge names the agent and, in its title, the chat (line 54) | **REWRITE** | Keep distinct author provenance label and unknown-agent fallback, retain chat identity; avoid exact prose/punctuation of the tooltip. Current independent oracle: promptCreatorBadge(byAgent)?.label deepEqual "by Codex" ; promptCreatorBadge(prompt({ createdBy: { kind: "agent", agent: "future" } }))?.label equal "by an agent" |
| an agent's prompt shows its badge collapsed and open, and has no one-click pin (line 62) | **KEEP** | Fixed regression oracle: render(byAgent, false) match /data-created-by="agent"[^>]*>.*by Codex/ ; open match /open Edit to read it/ |
| an already pinned agent prompt can still be unpinned; the user's prompts pin as before (line 70) | **KEEP** | Fixed regression oracle: render({ ...byAgent, pinned: true }, true) match /<button\b[^>]*aria-pressed="true"(?![^>]*disabled="")[^>]*data-agent-pin="unpin"/ ; mine doesNotMatch /<button\b[^>]*aria-pressed="false"[^>]*disabled=""/ |

## packages/ui/src/components/right-rail/session-profiles/profile-knowledge.dom.test.ts

Contract source, production consumer seam and six-bar reasoning: **right-rail** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| ticks and unticks, keeping the ids of deleted collections (line 80) | **DELETE** | Duplicates the later DOM round-trip's stronger checkbox-to-patch contract; no duplicate ids can arise from actual checkbox state (B6). |
| drops deleted ids first when the list would pass its cap (line 87) | **KEEP** | Fixed regression oracle: next.length equal 100 ; assert.ok(next.includes("kc_new")) |
| sends the list only when the ticked set changed (line 95) | **KEEP** | Fixed regression oracle: dialog.updatePatchFromForm(stored, form) deepEqual {} ; dialog.updatePatchFromForm(profile(), dialog.profileSettingsForm(profile())) deepEqual {} |
| a new profile carries its ticked collections, and nothing when none are (line 107) | **KEEP** | Fixed regression oracle: "knowledgeCollections" in (dialog.createRequestFromForm({ ...form, name: "A" }).settings ?? {}) equal false ; dialog.createRequestFromForm(ticked).settings?.knowledgeCollections deepEqual ["kc_seo"] |
| is absent while the plugin is off (line 174) | **KEEP** | Fixed regression oracle: doc().querySelector('fieldset[aria-label="Knowledge"]') equal null |
| lists every collection with its description and the visibility line (line 179) | **KEEP** | Fixed regression oracle: assert.ok(section) ; box("kc_gone") equal null |
| reads the collections when they never loaded, and offers a retry when the read fails (line 190) | **KEEP** | Fixed regression oracle: knowledgeStore.getState().collections equal null ; box("kc_seo")?.checked equal true |
| round-trips: ticking and unticking reach the patch, a deleted collection's id stays (line 232) | **KEEP** | Fixed regression oracle: submitted.length equal 1 ; dialog.updatePatchFromForm(stored, submitted[0]!) deepEqual { settings: { knowledgeCollections: ["kc_gone", "kc_ads"] } } |

## packages/ui/src/components/right-rail/session-profiles/session-profile-imports.dom.test.ts

Contract source, production consumer seam and six-bar reasoning: **right-rail** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| shows the quick actions, and the Plugins tab's Add plugin (line 257) | **DELETE** | Button inventory/change detector; remaining import/copy/plugin tests click and verify each useful action through API requests (B4/B6). |
| Import from Global: unavailable rows are disabled, an existing pick asks first, the revision is sent (line 269) | **REWRITE** | Keep disabled unavailable picks, confirmation and exact revisioned import body; compare only the first two source-read arguments instead of deriving an expected argument from the actual call itself. Current independent oracle: assert.ok(dialog(), "the dialog opened") ; assert.ok(document.querySelector('[data-session-profile-item="n1"]'), "the new item is listed") |
| a stale revision reloads the profile and says so; the retry carries the fresh one (line 289) | **KEEP** | Fixed regression oracle: assert.ok(server.gets > before, "the profile was read again") ; last.onConflict equal "fail" |
| Git: scans, then takes the picks with the chosen scope (line 304) | **KEEP** | Fixed regression oracle: calls("scanGit")[0]!.args deepEqual ["p1", { url: "https://github.com/acme/repo" }] ; calls("take")[0]!.args deepEqual ["p1", "imp1", { revision: "1", picks: ["commands/ship.md"], agents: "all", onConflict: "fail" }] |
| Copy from profile: picks another profile's items (line 315) | **KEEP** | Fixed regression oracle: calls("copy")[0]!.args deepEqual ["p1", { revision: "1", fromProfileId: "p2", itemIds: ["x1"], onConflict: "fail" }] |
| Add plugin: a marketplace's plugin into the profile (line 323) | **KEEP** | Fixed regression oracle: calls("addPlugin")[0]!.args deepEqual [ "p1", { revision: "1", agent: "claude", source: { type: "marketplace", marketplace: "acme", plugin: "superpowers" }, onConflict: "fail" } ] |
| ⋯ → Export downloads the profile's zip (line 335) | **KEEP** | Fixed regression oracle: calls("export")[0]!.args.slice(0, 1) deepEqual ["p1"] ; notice() match /Exported Developer/ |
| the library's + New → Import profile from file uploads the zip and opens the new profile (line 356) | **KEEP** | Fixed regression oracle: calls("importProfile")[0]!.args[0] equal "editor.agent-profile.zip" ; notice() match /Imported Editor\. Secret values are never exported/ |

## packages/ui/src/components/right-rail/session-profiles/session-profiles.dom.test.ts

Contract source, production consumer seam and six-bar reasoning: **right-rail** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| lists Global first, then each profile with its counts and status pill (line 262) | **KEEP** | Fixed regression oracle: cards deepEqual ["global", "p1", "p2"] ; shown deepEqual ["p2"] |
| drills into a profile, switches kinds on the bar, and goes back (line 289) | **KEEP** | Fixed regression oracle: document.querySelector("[data-profile-card]") equal null ; assert.ok(document.querySelector('[data-profile-card="p1"]')) |
| a toggle sends the profile's revision; a stale one reloads and says so (line 311) | **KEEP** | Fixed regression oracle: server.toggles deepEqual [{ itemId: "m1", revision: "1", enabled: false }] ; server.toggles.at(-1)?.revision equal "9" |
| the readiness line follows prepare-status events, the reason on hover (line 327) | **KEEP** | Fixed regression oracle: codex().getAttribute("data-state") equal "preparing" ; codex().getAttribute("title") ?? "" match /did not start/ |
| the MCP editor shows a secret only as set, and keeps it unless replaced (line 345) | **KEEP** | Fixed regression oracle: assert.ok(dialog, "the editor opened") ; "runInBox" in (body.draft.mcp as object) equal false |
| the MCP editor offers Run in box with the plugin on, and sends the switch with the item (line 373) | **KEEP** | Fixed regression oracle: assert.ok(row, "the switch is offered") ; body.draft.mcp.runInBox equal true |
| a new item carries the revision held when it is sent; after a 409 the draft stays and the next save carries the reloaded one (line 438) | **KEEP** | Fixed regression oracle: server.creates.map((create) => (create.body as { revision: string }).revision) deepEqual ["2"] ; document.querySelector('[role="dialog"]') equal null |
| an edit survives a change to another item, but not a change to the item it edits (line 463) | **KEEP** | Fixed regression oracle: (server.updates.at(-1)?.body as { revision: string }).revision equal "2" ; assert.ok(buttonByText("Reload (discard my changes)")) |
| profile settings send only what the dialog changed, never undoing a change made elsewhere while it was open (line 485) | **KEEP** | Fixed regression oracle: assert.ok(document.querySelector('form[aria-label="Profile settings"]'), "the settings dialog opened") ; server.profileUpdates deepEqual [{ name: "Developer 2", revision: "2" }] |
| delete guard (§5.5): the confirmation lists the workflows using the profile, and their ids ride the delete (line 507) | **KEEP** | Fixed regression oracle: line?.getAttribute("data-profile-delete-workflows") equal "used" ; document.querySelector("[data-profile-delete-workflows]") equal null |
| delete guard: no workflow says so and sends an empty expectation; a change meanwhile reopens the confirmation with the new list (line 519) | **KEEP** | Fixed regression oracle: document.querySelector("[data-profile-delete-workflows]")?.getAttribute("data-profile-delete-workfl… equal "none" ; server.deletes[1] deepEqual { revision: "1", options: { expectWorkflowUses: ["wf_1", "wf_2"] } } |

## packages/ui/src/components/secret-files/SecretFilesDialog.dom.test.ts

Contract source, production consumer seam and six-bar reasoning: **secret-files** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| sets up: conventional files ticked, newest copy pre-selected, merge with a primary, unticked ones excluded (line 243) | **KEEP** | Fixed regression oracle: checkbox("MatsSmileBack/.env")?.checked equal true ; text() match /Missing folder/ |
| validates a hand-added path before scanning it, then adds it ticked (line 279) | **KEEP** | Fixed regression oracle: api.calls.filter((entry) => entry.name === "scan").length equal 1 ; checkbox("deploy/targets.conf")?.checked equal true |
| shows a daemon refusal inline and keeps the dialog usable (line 309) | **KEEP** | Fixed regression oracle: document.querySelector('[role="alert"]')?.textContent equal "MatsSmile2's copy is tracked by git." ; button("Set up")?.disabled equal false |
| closed mid-setup, still applies the late answer to the store (line 321) | **KEEP** | Fixed regression oracle: document.querySelector('[role="dialog"]') equal null ; assert.ok(store.getSecretVault(WS, KEY)) |
| manages: push asks first, naming the clones that will be overwritten (line 330) | **KEEP** | Fixed regression oracle: text() match /Files in the vault/ ; api.last("push").args[0] deepEqual { workspace: WS, repoKey: KEY, projectPath: B, files: ["MatsSmileBack/.env"] } |
| manages: Push sends the content token shown; a CONTENT_CHANGED refusal asks to review again and refreshes (line 349) | **KEEP** | Fixed regression oracle: api.last("push").args[0] deepEqual { workspace: WS, repoKey: KEY, projectPath: B, files: ["MatsSmileBack/.env"], expect: { "MatsSmileBack/.env": "tB" } } ; gets() equal before + 1 |

## packages/ui/src/components/secret-files/drift.logic.test.ts

Contract source, production consumer seam and six-bar reasoning: **secret-files** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| labels every state, and a refused file with its reason (line 65) | **DELETE** | Exact text mapping duplicates the meaningful badge and bar cases; labels themselves are not byte contracts (B1/B6). |
| is hidden while the plugin is off or the project is in no vault (line 78) | **KEEP** | Fixed regression oracle: projectSecretBadge(false, flagged) equal null ; projectSecretBadge(true, undefined) equal null |
| is hidden while every file is synced or being synced (line 83) | **KEEP** | Fixed regression oracle: projectSecretBadge(true, clone("A", [file(".env", "synced"), file("b/.env", "outdated"), file("c/.e… equal null ; projectSecretBadge(true, clone("A", [])) equal null |
| names each file needing attention with its state (line 88) | **KEEP** | Fixed regression oracle: projectSecretBadge(true, flagged) deepEqual { title: [ "Secret files need attention:", "api/.env — changed here", "deploy/targets.conf — can't be synced here: it or a folder above it is a symlink" ].join("\n") } ; projectSecretBadge(true, clone("A", [file(".env", "deleted")])) deepEqual { title: "A secret file needs attention:\n.env — deleted here" } |
| is null while the plugin is off, without a vault, or with nothing to look at (line 103) | **KEEP** | Fixed regression oracle: repoSecretCount(false, { clonesNeedingAttention: 2, newCandidates: 1 }) equal null ; repoSecretCount(true, { clonesNeedingAttention: 0, newCandidates: 0 }) equal null |
| adds clones needing attention and new candidates, and explains both (line 109) | **KEEP** | Fixed regression oracle: repoSecretCount(true, { clonesNeedingAttention: 2, newCandidates: 0 }) deepEqual { count: 2, title: '2 clones have secret files that need attention. Open "Secret files…" to review.' } ; both?.title equal '1 clone has secret files that need attention; 3 new secret files were found and can be added. Open "Secret files…" to review.' |
| ignores a negative or fractional count from a bad payload (line 126) | **DELETE** | Defensive impossible schema values with no credible public payload contract; repo count aggregation remains (B1/B2). |
| counts key changes and keeps only the differing names, in order (line 142) | **KEEP** | Fixed regression oracle: countKeyChanges(keys) deepEqual { added: 1, removed: 1, changed: 2, same: 2 } ; differingKeys(keys).map((k) => k.key) deepEqual ["A", "C", "D", "E"] |
| summarizes env, line and missing compares (line 150) | **KEEP** | Fixed regression oracle: compareSummaryText({ format: "env", keys }) equal "1 added, 1 removed, 2 changed" ; compareSummaryText({ format: "missing", side: "right" }) equal "missing in the vault" |
| compares the given path, else every file of the clone that isn't synced (line 161) | **KEEP** | Fixed regression oracle: compareTargets(c, ".env") deepEqual [".env"] ; compareTargets(undefined, undefined) deepEqual [] |
| has no bar for a project in no vault or with nothing flagged (line 170) | **KEEP** | Fixed regression oracle: projectBarModel(undefined) equal null ; projectBarModel(clone("A", [file(".env", "synced"), file("b/.env", "outdated")])) equal null |
| shows one modified file with its compare summary once loaded (line 175) | **KEEP** | Fixed regression oracle: model deepEqual { kind: "drift", files: [file("MatsSmileBack/.env", "modified")], pushPaths: ["MatsSmileBack/.env"], resetPaths: ["MatsSmileBack/.env"], comparePath: "MatsSmileBack/.env" } ; projectBarMessage(model!, "1 added, 2 changed") deepEqual { path: "MatsSmileBack/.env", text: " differs from the vault: 1 added, 2 changed" } |
| never pushes a deletion, and says the file was deleted (line 191) | **KEEP** | Fixed regression oracle: model?.kind equal "drift" ; projectBarMessage(model) deepEqual { path: ".env", text: " was deleted in this project; the vault still has it" } |
| counts several drifted files and skips the compare (line 201) | **KEEP** | Fixed regression oracle: model?.kind equal "drift" ; projectBarMessage(model, "ignored") deepEqual { path: null, text: "3 secret files differ from the vault" } |
| falls back to an informational bar for missing-dir and refused files (line 213) | **KEEP** | Fixed regression oracle: one deepEqual { kind: "info", files: [file("api/.env", "missing-dir")] } ; projectBarMessage(several!) deepEqual { path: null, text: "2 secret files can't be synced to this project" } |
| names the clones the push overwrites and the ones that stay flagged (line 238) | **KEEP** | Fixed regression oracle: pushConfirmText(v, me.projectPath, [".env"]) equal "This makes this project's .env the vault's version. It overwrites the copy in Synced, Behind, Fresh. Diverged has its own changes and stays flagged." |
| says when no other clone is overwritten (line 245) | **KEEP** | Fixed regression oracle: pushConfirmText(alone, me.projectPath, [".env", "b/.env"]) equal "This makes this project's 2 changed secret files the vault's version. No other clone is overwritten. Other1, Other2 have their own changes and stay flagged." |
| judges each pushed file on its own: a clone with mixed states is named in both, a missing copy receives it (line 253) | **KEEP** | Fixed regression oracle: pushConfirmText(mixed, mine.projectPath, [".env", "b/.env"]) equal "This makes this project's 2 changed secret files the vault's version. It overwrites the copy in Mixed, Missing. Mixed has its own changes and stays flagged." ; pushConfirmText(mixed, mine.projectPath, ["b/.env"]) equal "This makes this project's b/.env the vault's version. It overwrites the copy in Mixed." |
| expects the content tokens shown, null for a copy the clone doesn't have (line 271) | **KEEP** | Fixed regression oracle: expectedContent(files, [".env", "b/.env", "c/.env"]) deepEqual { ".env": "t1", "b/.env": null } ; expectedContent(files, ["c/.env", "nope"]) deepEqual undefined |
| warns that a reset discards this project's changes (line 282) | **KEEP** | Fixed regression oracle: resetConfirmText([".env"]) equal "This replaces .env in this project with the vault's version. This project's changes to it are discarded." ; resetConfirmText([".env", "b/.env"]) equal "This replaces 2 secret files in this project with the vault's version. This project's changes to them are discarded." |
| covers the project, each flagged file's path and state, and the vault version (line 300) | **KEEP** | Fixed regression oracle: assert.ok(dismissed(stored, projectBarDismissal("/w/ws/A", [file(".env", "modified")], v))) ; assert.ok( !dismissed(stored, projectBarDismissal("/w/ws/A", [file(".env", "modified"), file("b/.env", "modified")], v)) ) |
| covers each flagged file's content token within one daemon boot: a further edit brings the bar back (line 311) | **KEEP** | Fixed regression oracle: assert.ok(dismissed(stored, projectBarDismissal("/w/ws/A", [file(".env", "modified", { contentToken: "t1" })], at("b1")))) ; assert.ok(!dismissed(plain, projectBarDismissal("/w/ws/A", [file(".env", "modified", { contentToken: "t2" })], v))) |
| survives a daemon restart: under another boot the (re-keyed) tokens are not compared (line 321) | **KEEP** | Fixed regression oracle: assert.ok(dismissed(stored, afterRestart)) ; parseBarDismissals(JSON.stringify(restamped)) deepEqual restamped |
| does not depend on the files' order (line 344) | **KEEP** | Fixed regression oracle: projectBarDismissal("/p", [file(".env", "modified", { contentToken: "a" }), file("b/.env", "deleted… deepEqual projectBarDismissal("/p", [file("b/.env", "deleted"), file(".env", "modified", { contentToken: "a" })], v) |
| parses stored dismissals tolerantly and keeps them bounded (line 351) | **REWRITE** | Retain tolerant stored-record parsing and refresh/replacement ordering through fixed records. Drop assertions parameterized by the same imported implementation capacity and its oversized fixture, and narrow that test-only capacity export. Current independent oracle: parseBarDismissals(null) deepEqual [] ; addBarDismissal([d("a"), d("b")], { key: "a", tokens: "t", boot: "b1" }) deepEqual [d("b"), { key: "a", tokens: "t", boot: "b1" }] |

## packages/ui/src/components/secret-files/secret-files-dialog.logic.test.ts

Contract source, production consumer seam and six-bar reasoning: **secret-files** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| pre-selects the daemon's newest copy, else the latest modifiedAt (line 72) | **KEEP** | Fixed regression oracle: newestVariant(candidate())?.variantId equal "new" ; defaultSourceChoice(candidate({ variants: [] })) equal null |
| asks for a source only when copies differ; merges only env files (line 81) | **KEEP** | Fixed regression oracle: needsSourceChoice(candidate()) equal true ; canMerge(single()) equal false |
| merge's primary defaults to the newest copy's first clone, and may be any holder (line 89) | **KEEP** | Fixed regression oracle: defaultMergePrimary(candidate()) equal A ; mergePrimaryOptions(candidate()) deepEqual [B, C, A] |
| maps a choice to the wire source (line 94) | **KEEP** | Fixed regression oracle: sourceFor(candidate(), null) deepEqual { projectPath: A } ; sourceFor(candidate({ variants: [] }), null) equal null |
| a single copy always comes from its first clone, whatever was chosen (line 104) | **KEEP** | Fixed regression oracle: sourceFor(single(), null) deepEqual { projectPath: B } ; sourceFor(single(), { kind: "merge", primary: A }) deepEqual { projectPath: B } |
| ticks conventional candidates by default; excluded, hand-added and unusable ones start unticked (line 111) | **KEEP** | Fixed regression oracle: defaultTicked(candidate()) equal true ; isTicked(candidate({ variants: [] }), { ticked: { "MatsSmileBack/.env": true }, sources: {} }) equal false |
| sends ticked files with their sources and excludes unticked conventional ones (line 123) | **KEEP** | Fixed regression oracle: plan deepEqual { ok: true, request: { workspace: WS, repoKey: KEY, files: [ { path: "MatsSmileBack/.env", source: { merge: true, primary: B } }, { path: "MatsSmileFront/.env", so… |
| an unticked hand-added file is simply not sent; an excluded one stays excluded (line 145) | **KEEP** | Fixed regression oracle: assert.ok(plan.ok) ; plan.request.excluded deepEqual ["MatsSmileBack/.env"] |
| does not exclude a conventional candidate nobody could tick (no clone holds a usable copy) (line 153) | **KEEP** | Fixed regression oracle: assert.ok(plan.ok) ; plan.request.excluded deepEqual [] |
| refuses an empty selection, an invalid source and too many files (line 165) | **KEEP** | Fixed regression oracle: buildSetupRequest(WS, KEY, [candidate()], { ticked: { "MatsSmileBack/.env": false }, sources: {} }) deepEqual { ok: false, problem: "Select at least one file to keep in the vault." } ; tooMany.ok ? "" : tooMany.problem match /at most 50/ |
| builds an add request, refusing a candidate no clone holds (line 181) | **KEEP** | Fixed regression oracle: buildAddRequest(WS, KEY, candidate(), { kind: "variant", variantId: "old" }) deepEqual { ok: true, request: { workspace: WS, repoKey: KEY, add: [{ path: "MatsSmileBack/.env", source: { projectPath: B } }] } } ; none.ok ? "" : none.problem match /No clone has a usable/ |
| a hand-typed path's scan replaces the same path or is appended (line 191) | **KEEP** | Fixed regression oracle: replaced.length equal 2 ; mergeCandidate(list, single({ path: "x.conf" })).length equal 3 |
| relabels value classes A, B… per row in copy order and marks disagreement (line 201) | **KEEP** | Fixed regression oracle: keyTable(candidate()) deepEqual [ { key: "DATABASE_URL", cells: [ { variantId: "old", present: true, letter: "A" }, { variantId: "new", present: true, letter: "A" } ], agree: true }, … |
| has no rows for a file without keys (line 230) | **KEEP** | Fixed regression oracle: keyTable(candidate({ format: "lines", keys: undefined })) deepEqual [] |
| describes each copy's size (line 234) | **DELETE** | Exact singular/plural copy; source selection and key tables retain semantic file data contracts (B1/B5). |
| labels every state in words (line 244) | **DELETE** | Enumerates the implementation's presentation mapping without independent wording contract; real drift action gating and DOM states survive (B1/B4). |
| tones: synced ok, attention states flagged, the rest pending (line 259) | **DELETE** | Pure appearance/style tone mapping has no independently specified visual regression requirement (B1/B4). |
| push needs a changed file; reset and compare a changed or deleted one (line 276) | **KEEP** | Fixed regression oracle: pushableFiles(changed) deepEqual [".env"] ; canCompare(fine) equal false |
| a push overwrites in-sync clones and leaves changed ones flagged (line 291) | **KEEP** | Fixed regression oracle: impact.overwritten.map((entry) => entry.projectName) deepEqual ["MatsSmile2", "MatsSmile4"] ; impact.keptFlagged.map((entry) => entry.projectName) deepEqual ["MatsSmile3"] |
| judges a push per file: a clone missing a file receives it, a mixed one is in both lists (line 307) | **KEEP** | Fixed regression oracle: impact.overwritten.map((entry) => entry.projectName) deepEqual ["MatsSmile2", "MatsSmile3"] ; onlyFirst.keptFlagged.map((entry) => entry.projectName) deepEqual ["MatsSmile2"] |
| shows the daemon's message first, then the code's text, then the status (line 328) | **KEEP** | Fixed regression oracle: secretFilesErrorText({ serverMessage: "Nope.", body: { code: "NOTHING_TO_PUSH" } }) equal "Nope." ; secretFilesErrorText(undefined) equal "Something went wrong." |
| a CONTENT_CHANGED refusal always asks to review again (line 337) | **KEEP** | Fixed regression oracle: secretFilesErrorText({ serverMessage: "content mismatch", status: 409, body: { code: "CONTENT_CHANG… equal text ; secretFilesErrorText({ status: 409, body: { code: "CONTENT_CHANGED" } }) equal text |
| names clones and lists (line 343) | **DELETE** | Path-tail and English list formatting tests private presentation details; pushImpact and DOM confirmation tests retain actual clone identities (B1/B5/B6). |

## packages/ui/src/components/secret-files/secret-files-project-bar.dom.test.ts

Contract source, production consumer seam and six-bar reasoning: **secret-files** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| stays hidden while the plugin is off or the project is in sync (line 240) | **REWRITE** | Preserve this case's existing visible state/request oracle; isolate every project with a fresh path instead of resetting module-global dismissals through a test-only production export. Each case now uses the same public component/store seam as real projects. Current independent oracle: bar() equal null ; bar() equal null |
| says how the one modified file differs, and Push asks first naming the clones it overwrites (line 253) | **REWRITE** | Preserve this case's existing visible state/request oracle; isolate every project with a fresh path instead of resetting module-global dismissals through a test-only production export. Each case now uses the same public component/store seam as real projects. Current independent oracle: compares deepEqual ["MatsSmileBack/.env"] ; bar() equal null |
| stays dismissed until a flagged file's state or vault version changes (line 276) | **REWRITE** | Preserve this case's existing visible state/request oracle; isolate every project with a fresh path instead of resetting module-global dismissals through a test-only production export. Each case now uses the same public component/store seam as real projects. Current independent oracle: bar() equal null ; assert.ok(bar()) |
| a further edit of the flagged file refreshes the counts and brings a dismissed bar back (line 293) | **REWRITE** | Preserve this case's existing visible state/request oracle; isolate every project with a fresh path instead of resetting module-global dismissals through a test-only production export. Each case now uses the same public component/store seam as real projects. Current independent oracle: compares.length equal 1 ; compares.length equal 3 |
| a dismissal survives a daemon restart (new tokens), and a further edit after it still brings the bar back (line 312) | **REWRITE** | Preserve this case's existing visible state/request oracle; isolate every project with a fresh path instead of resetting module-global dismissals through a test-only production export. Each case now uses the same public component/store seam as real projects. Current independent oracle: bar() equal null ; assert.ok(bar(), "the dismissed bar is back") |
| Push and Reset send the content tokens the bar showed (line 338) | **REWRITE** | Preserve this case's existing visible state/request oracle; isolate every project with a fresh path instead of resetting module-global dismissals through a test-only production export. Each case now uses the same public component/store seam as real projects. Current independent oracle: pushes deepEqual [ { workspace: "ws", repoKey: KEY, projectPath: MINE, files: ["MatsSmileBack/.env"], expect: { "MatsSmileBack/.env": "t1" } } ] ; resets deepEqual [ { workspace: "ws", repoKey: KEY, projectPath: MINE, files: ["MatsSmileBack/.env", "web/.env"], expect: { "MatsSmileBack/.env": "t5", "web/.env": null } } ] |
| a push refused because the file changed says so and refreshes the vault (line 378) | **REWRITE** | Preserve this case's existing visible state/request oracle; isolate every project with a fresh path instead of resetting module-global dismissals through a test-only production export. Each case now uses the same public component/store seam as real projects. Current independent oracle: pushes.length equal 1 ; compares.length equal 2 |
| counts several files, without Push when only deletions are flagged (line 394) | **REWRITE** | Preserve this case's existing visible state/request oracle; isolate every project with a fresh path instead of resetting module-global dismissals through a test-only production export. Each case now uses the same public component/store seam as real projects. Current independent oracle: compares deepEqual [] ; assert.ok(button("Reset to vault")) |
| shows an informational variant for a file whose folder is missing (line 410) | **REWRITE** | Preserve this case's existing visible state/request oracle; isolate every project with a fresh path instead of resetting module-global dismissals through a test-only production export. Each case now uses the same public component/store seam as real projects. Current independent oracle: bar()?.textContent ?? "" match /MatsSmileBack\/\.env can't be copied here: its folder doesn't exist/ ; button("Reset to vault") equal undefined |
| Compare lists variable names with their change, never values (line 419) | **REWRITE** | Preserve this case's existing visible state/request oracle; isolate every project with a fresh path instead of resetting module-global dismissals through a test-only production export. Each case now uses the same public component/store seam as real projects. Current independent oracle: assert.ok(dialog, "the compare modal") ; assert.ok( [...dialog.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Open file"), "the open project's file can be opened" ) |

## packages/ui/src/components/settings/account-login.test.ts

Contract source, production consumer seam and six-bar reasoning: **settings** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| a historical quota card shows the readings, observation time and expired-login warning (line 30) | **REWRITE** | Keep observed quota values, stale-data distinction and expired-login warning; drop exact Tailwind warning class (appearance implementation). Current independent oracle: html match /Last known usage/ ; html doesNotMatch /No reading yet&#124;Resets now/ |
| usage settings, account settings and the selected composer account carry the warning (line 44) | **KEEP** | Fixed regression oracle: settings match /Login expired, please re-login/ ; composer match /Login expired, please re-login/ |

## packages/ui/src/components/settings/agent-config-settings.dom.test.ts

Contract source, production consumer seam and six-bar reasoning: **settings** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| &#96;opens on Agent config for "${section}", with the editor's list in it&#96; (line 132) | **REWRITE** | Keep legacy settings-section aliases, active navigation and actual MCP/search controls; drop production intro constant asserted against the same rendered constant and narrow its unused export. Current independent oracle: heading?.textContent equal "Agent config" ; assert.ok(document.querySelector('input[aria-label="Search Claude\'s config"]'), "the search names the config") |
| is listed under Agents and found by a search for skills or MCP (line 143) | **KEEP** | Fixed regression oracle: assert.ok(navButton("Agent config"), "in the nav") ; assert.ok(navButton("Agent config"), &#96;"${query}" finds it&#96;) |
| opens the editor over Settings; Escape closes the editor and leaves Settings open (line 157) | **KEEP** | Fixed regression oracle: opened equal true ; useAppStore.getState().settingsOpen equal true |

## packages/ui/src/components/settings/agent-tools-settings.logic.test.ts

Contract source, production consumer seam and six-bar reasoning: **settings** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| grants read as what, where and how far (line 15) | **KEEP** | Fixed regression oracle: describeGrant(chat, titleOf) deepEqual { id: "g1", what: "Workflow changes", where: "Chat “Plan the API”", detail: "2 workflows", scope: "chat" } ; describeGrant({ ...project, family: "future-thing" }, titleOf).what equal "future-thing" |
| the page says every tool is available and lists the grants; no switch, no matrix (line 28) | **KEEP** | Fixed regression oracle: html match /Every Orquester tool is available in every agent chat/ ; html match />Revoke all</ |
| no grants: an empty state, and no Revoke all (line 46) | **KEEP** | Fixed regression oracle: html match /No grants/ ; html doesNotMatch />Revoke all</ |
| an older daemon without the routes says so (line 55) | **KEEP** | Fixed regression oracle: renderToStaticMarkup(createElement(AgentToolsSettings)) match /predates agent tool grants/ |

## packages/ui/src/components/settings/plugins-settings.dom.test.ts

Contract source, production consumer seam and six-bar reasoning: **settings** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| turning tsc-rs on asks first, then turns it on for the whole server (line 126) | **REWRITE** | Keep no request before confirmation, confirm action and resulting server-wide enabled state; remove assertion that DOM contains the production constant used to render it (tautology). Current independent oracle: calls deepEqual [] ; useAppStore.getState().plugins?.[0]?.enabled equal true |
| cancelling the confirmation sends nothing (line 139) | **KEEP** | Fixed regression oracle: calls deepEqual [] |
| turning tsc-rs off goes ahead without asking (line 146) | **KEEP** | Fixed regression oracle: button("Confirm") equal undefined ; calls deepEqual [["ts-rust", false]] |
| choosing the other engine sends it at once; the active one sends nothing (line 153) | **KEEP** | Fixed regression oracle: calls deepEqual [] ; radio("tsc-rs").getAttribute("aria-checked") equal "true" |
| a bundled plugin is switched at once (line 175) | **KEEP** | Fixed regression oracle: calls deepEqual [["excalidraw", true]] |

## packages/ui/src/components/settings/plugins-settings.test.ts

Contract source, production consumer seam and six-bar reasoning: **settings** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Only invalid/duplicate cases were present; meaningful subsystem owners remain.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| an installed plugin shows its list row, detail and server-wide toggles (line 49) | **DELETE** | SSR markup/label inventories duplicate pluginControls/pluginEngineOptions plus PluginsSettings DOM interactions; those preserve request guards, platform compatibility, engine choices and server-wide toggles at stable behavior seams (B4/B5/B6). |
| without an install, no rollback is offered and the version reads as not installed (line 84) | **DELETE** | SSR markup/label inventories duplicate pluginControls/pluginEngineOptions plus PluginsSettings DOM interactions; those preserve request guards, platform compatibility, engine choices and server-wide toggles at stable behavior seams (B4/B5/B6). |
| an unsupported platform shows the plugin as unavailable with its toggles disabled (line 93) | **DELETE** | SSR markup/label inventories duplicate pluginControls/pluginEngineOptions plus PluginsSettings DOM interactions; those preserve request guards, platform compatibility, engine choices and server-wide toggles at stable behavior seams (B4/B5/B6). |
| without workspaces a plugin can still be turned on (line 99) | **DELETE** | SSR markup/label inventories duplicate pluginControls/pluginEngineOptions plus PluginsSettings DOM interactions; those preserve request guards, platform compatibility, engine choices and server-wide toggles at stable behavior seams (B4/B5/B6). |
| a global plugin has one server-wide switch and no version controls, even without workspaces (line 105) | **DELETE** | SSR markup/label inventories duplicate pluginControls/pluginEngineOptions plus PluginsSettings DOM interactions; those preserve request guards, platform compatibility, engine choices and server-wide toggles at stable behavior seams (B4/B5/B6). |
| before the first load the section shows it is loading (line 132) | **DELETE** | SSR markup/label inventories duplicate pluginControls/pluginEngineOptions plus PluginsSettings DOM interactions; those preserve request guards, platform compatibility, engine choices and server-wide toggles at stable behavior seams (B4/B5/B6). |
| the engine control shows both engines, the active one checked, one with no build here disabled (line 154) | **DELETE** | SSR markup/label inventories duplicate pluginControls/pluginEngineOptions plus PluginsSettings DOM interactions; those preserve request guards, platform compatibility, engine choices and server-wide toggles at stable behavior seams (B4/B5/B6). |
| a daemon from before the engine choice shows no engine control (line 179) | **DELETE** | SSR markup/label inventories duplicate pluginControls/pluginEngineOptions plus PluginsSettings DOM interactions; those preserve request guards, platform compatibility, engine choices and server-wide toggles at stable behavior seams (B4/B5/B6). |

## packages/ui/src/components/settings/plugins.logic.test.ts

Contract source, production consumer seam and six-bar reasoning: **settings** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| search matches name and description, case-insensitively (line 48) | **KEEP** | Fixed regression oracle: filterPlugins([ts], "") deepEqual [ts] ; filterPlugins([ts], "eslint") deepEqual [] |
| the detail panel shows the selected plugin while listed, else the first (line 58) | **KEEP** | Fixed regression oracle: selectedPlugin([ts], "ts-rust") equal ts ; selectedPlugin([], "ts-rust") equal null |
| turning tsc-rs on asks first; turning it off, or another plugin on, goes ahead (line 65) | **KEEP** | Fixed regression oracle: pluginToggleDecision(plugin(), true) equal "confirm" ; pluginToggleDecision(plugin({ platform: "unsupported", enabled: true }), false) equal "apply" |
| a bundled plugin: no confirmation, no version actions (line 73) | **KEEP** | Fixed regression oracle: pluginToggleDecision({ ...whiteboard, enabled: false }, true) equal "apply" ; pluginControls(whiteboard, true).toggle equal false |
| the first-enable confirmation says what the owner approved (line 87) | **DELETE** | Constant asserted against its own string literal is a tautology/change detector (B1/B2/B3); DOM confirmation gate preserves approval-before-enable behavior. |
| an idle, installed, unused plugin allows every action (line 94) | **KEEP** | Fixed regression oracle: pluginControls(plugin({ current: installed, previous: older }), false) deepEqual { toggle: true, checkForUpdates: true, showRollback: true, rollback: true, removeDownloads: true } |
| roll back is shown only with a previous version (line 104) | **KEEP** | Fixed regression oracle: controls.showRollback equal false ; controls.rollback equal false |
| remove downloads needs a download and the plugin off (line 110) | **KEEP** | Fixed regression oracle: pluginControls(plugin(), false).removeDownloads equal false ; pluginControls(plugin({ current: installed }), false).removeDownloads equal true |
| a running job blocks the version actions but not the toggle (line 116) | **KEEP** | Fixed regression oracle: controls deepEqual { toggle: true, checkForUpdates: false, showRollback: true, rollback: false, removeDownloads: false } |
| a request in flight blocks every control (line 129) | **KEEP** | Fixed regression oracle: pluginControls(plugin({ current: installed, previous: older }), true) deepEqual { toggle: false, checkForUpdates: false, showRollback: true, rollback: false, removeDownloads: false } |
| an unsupported platform disables the toggle unless the plugin is on (line 139) | **KEEP** | Fixed regression oracle: unsupported.toggle equal false ; pluginControls(plugin({ platform: "unsupported", enabled: true }), false).toggle equal true |
| job labels and the last error read as the panel shows them (line 147) | **DELETE** | Exact label joining repeats private formatting choices, not independently specified words (B1/B5). |
| the source link renders only for a web address (line 157) | **KEEP** | Fixed regression oracle: pluginSourceHref("https://github.com/pingdotgg/ts-rust") equal "https://github.com/pingdotgg/ts-rust" ; pluginSourceHref("not a url") equal null |
| the engine control lists each engine, the active one selected, and switches only to another usable one (line 182) | **KEEP** | Fixed regression oracle: pluginEngineOptions(ts, false).map((o) => [o.id, o.selected, o.disabled, o.hint]) deepEqual [ ["tsrs", true, false, null], ["tsc-rs", false, false, null] ] ; assert.ok(pluginEngineOptions(ts, true).every((o) => o.disabled)) |
| an engine with no build here is disabled with a hint (line 198) | **KEEP** | Fixed regression oracle: tsrs?.disabled equal true ; pluginEngineChange(intelMac, "tsrs", false) equal false |
| a plugin without engines, or from a daemon before the choice, has no engine control (line 210) | **KEEP** | Fixed regression oracle: pluginEngineOptions(plugin(), false) deepEqual [] ; pluginEngineChange(plugin(), "tsrs", false) equal false |
| secretVaultRows: labels each vault by its custom label or key, ordered by workspace then label (line 217) | **KEEP** | Fixed regression oracle: rows.map((r) => [r.workspace, r.label, r.clonesNeedingAttention]) deepEqual [ ["home", "o/repo9", 0], ["home", "o/repo10", 1], ["work", "Aardvark", 0], ["work", "o/alpha", 0] ] ; secretVaultRows([vault("w", "nohost")], new Map()).map((r) => r.label) deepEqual ["nohost"] |
| pluginBoxIssues lists the failed and unsupported boxes, labelled from the boxes held (line 251) | **KEEP** | Fixed regression oracle: issues deepEqual [ { boxId: "b1", label: &#96;ws / app · ${BOX_KIND_LABELS.linux} on Hetzner&#96;, state: "failed", message: "smoke test: tsrs exited 1" }, { boxId: "b2", label: "Box b2", state: "unsupported", me… ; pluginBoxIssues(plugin(), [held]) deepEqual [] |

## packages/ui/src/components/sidebar/activity-bar.dom.test.ts

Contract source, production consumer seam and six-bar reasoning: **sidebar** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Only invalid/duplicate cases were present; meaningful subsystem owners remain.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| is not lit by a worker chat that waits (line 99) | **DELETE** | Dot presence is inferred from any nested span, a private markup shape (B4/B5), and worker filtering is already verified at deriveAgentSessions in attention/agent-sessions.test.ts; no independent UI state is observed. |
| is not lit by a worker chat that has exited (line 104) | **DELETE** | Dot presence is inferred from any nested span, a private markup shape (B4/B5), and worker filtering is already verified at deriveAgentSessions in attention/agent-sessions.test.ts; no independent UI state is observed. |
| is lit by a project's chat that waits, beside a waiting worker (line 109) | **DELETE** | Dot presence is inferred from any nested span, a private markup shape (B4/B5), and worker filtering is already verified at deriveAgentSessions in attention/agent-sessions.test.ts; no independent UI state is observed. |

## packages/ui/src/components/sidebar/new-project-preset.dom.test.ts

Contract source, production consumer seam and six-bar reasoning: **sidebar** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| fixes the repo: titled after it, no mode tabs, URL or picker, the name empty and focused (line 143) | **KEEP** | Fixed regression oracle: assert.ok(document.body.textContent?.includes("New clone of JasperRaccoon/JasperEngine")) ; listed equal 0 |
| flags a name the workspace already has, archived ones included, before submit (line 154) | **KEEP** | Fixed regression oracle: document.body.textContent ?? "" match /already has a project called\s*Old/ ; buttonNamed("Clone")?.disabled equal true |
| clones server-side with the typed name when the workspace's account can (line 163) | **KEEP** | Fixed regression oracle: created deepEqual [{ source: "clone", url: URL_, name: "Shader optimization" }] ; typed deepEqual [] |
| without an account, reviews and types &#96;git clone&#96; into the typed folder (line 171) | **KEEP** | Fixed regression oracle: assert.ok(document.body.textContent?.includes(&#96;git clone '${URL_}' .&#96;)) ; created deepEqual [] |
| a server-side clone the account cannot do offers the typed clone, same URL and name (line 186) | **KEEP** | Fixed regression oracle: text() match /Repository not found/ ; created.length equal 1 |
| a taken name is not offered the typed clone (line 203) | **KEEP** | Fixed regression oracle: text() match /Folder exists/ ; buttonNamed("Clone in a terminal instead") equal undefined |
| types any daemon-supplied URL form, the scp form without a user included (line 212) | **KEEP** | Fixed regression oracle: assert.ok(text().includes(&#96;git clone '${scp}' .&#96;)) ; typed deepEqual [[{ source: "empty", name: "Multiplayer" }, &#96;git clone '${scp}' .&#96;, { followClone: true }]] |
| &#96;refuses to type a preset URL with ${what}&#96; (line 228) | **KEEP** | Fixed regression oracle: text() match /cannot be typed into a terminal safely/ ; typed deepEqual [] |
| opens as before without a preset (line 238) | **KEEP** | Fixed regression oracle: assert.ok(document.body.textContent?.includes("New project")) ; nameInput() equal null |

## packages/ui/src/components/sidebar/repo-group-section.dom.test.ts

Contract source, production consumer seam and six-bar reasoning: **sidebar** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| shows its label, count and rows, and its '+' asks for a fresh clone (line 153) | **KEEP** | Fixed regression oracle: header.getAttribute("aria-expanded") equal "true" ; clones equal 1 |
| hides its rows when collapsed and saves the toggle (line 164) | **KEEP** | Fixed regression oracle: document.querySelectorAll("[data-row]").length equal 0 ; JSON.parse(localStorage.getItem("orquester:collapsed-repo-groups") ?? "[]") deepEqual [KEY] |
| offers Reset label only while a custom label is set (line 172) | **REWRITE** | Assert only the relevant menu action's presence or absence and its real effect, replacing full menu-label inventories; unrelated actions may change without breaking this behavior. Current independent oracle: assert.ok(!menuLabels().includes("Reset label")) ; labels deepEqual [{ repoKey: KEY, label: null }] |
| renames inline: a new label is saved, a blank one resets to the default (line 185) | **KEEP** | Fixed regression oracle: input?.value equal "JasperRaccoon/JasperEngine" ; labels.at(-1) deepEqual { repoKey: KEY, label: null } |
| keeps a bad label open with the reason, and Escape leaves it unsaved (line 202) | **KEEP** | Fixed regression oracle: labels deepEqual [] ; labels deepEqual [] |
| hides its menu item and count while the plugin is off (line 262) | **REWRITE** | Assert only the relevant menu action's presence or absence and its real effect, replacing full menu-label inventories; unrelated actions may change without breaking this behavior. Current independent oracle: pill() equal null ; assert.ok(!menuLabels().includes("Secret files…")) |
| offers Secret files… while the plugin is on, even before the repo has a vault (line 271) | **REWRITE** | Assert only the relevant menu action's presence or absence and its real effect, replacing full menu-label inventories; unrelated actions may change without breaking this behavior. Current independent oracle: pill() equal null ; assert.ok(menuLabels().includes("Secret files…")) |
| closes Secret files… when the plugin turns off, and doesn't reopen it when it turns back on (line 279) | **KEEP** | Fixed regression oracle: dialog() equal null ; dialog() equal null |
| counts clones needing attention plus new candidates, for this workspace's vault only (line 293) | **KEEP** | Fixed regression oracle: pill() equal null ; pill() equal null |

## packages/ui/src/components/sidebar/sidebar-view.test.ts

Contract source, production consumer seam and six-bar reasoning: **sidebar** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| only a known panel id is a sidebar view; anything else is the projects tree (line 6) | **KEEP** | Fixed regression oracle: parseSidebarView("workflows") equal "workflows" ; parseSidebarView(bad) equal "projects" |

## packages/ui/src/components/status/connection-diagnosis.dom.test.ts

Contract source, production consumer seam and six-bar reasoning: **status** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| names the failure, retries, and copies a redacted report with the live checks (line 119) | **OPTIMIZE** | Deliver the fake WebSocket close on a controlled microtask and await React act; remove five arbitrary 5ms sleeps while keeping all failure, retry, authenticated URL and copied/rendered credential-redaction assertions. Current independent oracle: text() match /vps refused the connection/ ; text() match /Copied/ |
| a refused sign-in offers Sign in, which opens the sign-in prompt (line 158) | **KEEP** | Fixed regression oracle: text() match /Sign in to vps again/ ; useAppStore.getState().authPrompt deepEqual { connectionId: "vps" } |
| stays hidden while connected and healthy, and behind the sign-in prompt (line 167) | **KEEP** | Fixed regression oracle: text() equal "" ; text() equal "" |

## packages/ui/src/components/system/agent-host-restart.dom.test.ts

Contract source, production consumer seam and six-bar reasoning: **system** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| shows what the pending restart waits on, and stops one shell alone (line 120) | **KEEP** | Fixed regression oracle: assert.ok(text().includes("A restart is pending"), text()) ; calls deepEqual ["stop-task t1 b1"] |
| restarts now only after a confirmation that lists what it stops (line 132) | **KEEP** | Fixed regression oracle: calls deepEqual [] ; calls deepEqual ["restart"] |
| no pending restart: no blocker list, the restart button still there (line 141) | **KEEP** | Fixed regression oracle: text().includes("A restart is pending") equal false ; assert.ok(button("Restart agent host now")) |

## packages/ui/src/components/system/agent-host-restart.test.ts

Contract source, production consumer seam and six-bar reasoning: **system** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| blockers group by thread, named by the tab's title (line 35) | **KEEP** | Fixed regression oracle: groups.map((group) => [group.label, group.blockers.map((blocker) => blocker.kind)]) deepEqual [ ["Auth fixes", ["background", "agent"]], ["t2", ["turn"]], ["t3", ["wake"]] ] |
| each blocker offers the stop it can take: the task alone, the session, or none (line 47) | **KEEP** | Fixed regression oracle: blockerStopAction(shell!) equal "task" ; blockerAgeSeconds(turn!, 0) equal null |
| the restart-now confirmation lists everything it stops (line 58) | **KEEP** | Fixed regression oracle: restartNowConsequences(status) deepEqual [ "Auth fixes: Background shell — Run the suite", "Auth fixes: Subagent — Review", "t2: Turn running", "t3: About to continue with a finished background task" ] ; shortCodeStamp(null) equal "unknown" |

## packages/ui/src/components/system/process-icons.check.ts

Contract source, production consumer seam and six-bar reasoning: **system** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Only invalid/duplicate cases were present; meaningful subsystem owners remain.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| Standalone check at line 7: assert.deepEqual(kind("node", "node node_modules/.bin/../vite/bin/vite.js --config vite.config.ts"), { brand: "vite" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 8: assert.deepEqual(kind("node", "node /repo/node_modules/vitest/vitest.mjs run"), { brand: "vitest" }, "vitest is not vite") | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 10: assert.deepEqual(kind("node", "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"), { app: "claude" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 11: assert.deepEqual(kind("claude", "claude --output-format stream-json"), { app: "claude" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 12: assert.deepEqual(kind("node", "node /usr/lib/node_modules/@openai/codex/bin/codex.js app-server"), { app: "codex" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 13: assert.deepEqual(kind("codex", "/usr/lib/node_modules/@openai/codex/vendor/codex app-server"), { app: "codex" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 14: assert.deepEqual(kind("node", "node /usr/lib/node_modules/@xai-official/grok/bin/grok.js --yolo"), { app: "grok" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 15: assert.deepEqual(kind("grok", "grok --yolo"), { app: "grok" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 16: assert.deepEqual(kind("opencode", "opencode serve --port 4096"), { app: "opencode" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 17: assert.deepEqual(kind("node", "node /usr/lib/node_modules/opencode-ai/bin/opencode"), { app: "opencode" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 18: assert.deepEqual(kind("deepseek"), { app: "deepseek" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 19: assert.deepEqual(kind("node", "node /repo/node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/bin/esbuild"), { brand: "esbuild" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 20: assert.deepEqual(kind("node", "node /usr/bin/pnpm test"), { brand: "pnpm" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 21: assert.deepEqual(kind("node", "node /repo/node_modules/next/dist/server/next-server.js"), { brand: "nextdotjs" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 22: assert.deepEqual(kind("node", "node --import tsx apps/daemon/src/cli.ts"), { brand: "typescript" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 23: assert.deepEqual(kind("node", "node server.js"), { brand: "nodedotjs" }, "an unrecognised script is plain Node") | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 24: assert.deepEqual(kind("python3.12", "python3.12 -m http.server"), { brand: "python" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 26: assert.deepEqual(kind("bash", "/bin/bash -c pnpm exec vite"), { app: "bash" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 29: assert.deepEqual(kind("dockerd"), { brand: "docker" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 30: assert.deepEqual(kind("containerd"), { brand: "containerd" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 31: assert.deepEqual(kind("postgres", "postgres: 16/main: checkpointer"), { brand: "postgresql" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 32: assert.deepEqual(kind("redis-server"), { brand: "redis" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 33: assert.deepEqual(kind("tmux: server"), { brand: "tmux" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 34: assert.deepEqual(kind("php-fpm8.2"), { brand: "php" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 35: assert.deepEqual(kind("chrome", "/opt/google/chrome/chrome --type=renderer"), { app: "chrome" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 36: assert.deepEqual(kind("chromium-browse"), { app: "chromium" }, "comm names are cut at 15 chars") | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 37: assert.deepEqual(kind("code", "/usr/share/code/code --type=renderer"), { app: "vscode" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 38: assert.deepEqual(kind("zsh", "-zsh"), { app: "zsh" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 41: assert.deepEqual(kind("nano", "nano notes.txt"), { category: "editor" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 42: assert.deepEqual(kind("systemd", "/sbin/init"), { category: "system" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 43: assert.deepEqual(kind("sshd"), { category: "key" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 44: assert.deepEqual(kind("aider"), { category: "agent" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 45: assert.deepEqual(kind("containerd-shim"), { category: "container" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 46: assert.deepEqual(kind("sh"), { category: "shell" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 47: assert.deepEqual(kind("svgbench", "/build/htmlui-bench"), { category: "generic" }) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 50: assert.equal(isDarkBrandColor("000000"), true) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 51: assert.equal(isDarkBrandColor("242424"), true) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 52: assert.equal(isDarkBrandColor("575757"), true) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 53: assert.equal(isDarkBrandColor("2496ED"), false) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 54: assert.equal(isDarkBrandColor("5FA04E"), false) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |
| Standalone check at line 55: assert.equal(isDarkBrandColor("not-a-colour"), true) | **DELETE** | Brand/category/logo colour selections restate the process icon catalog and visual mapping without an independently specified visual requirement (B1/B4/B5); process-table checks retain stop/filter/tree behavior. |

## packages/ui/src/components/system/process-table.check.ts

Contract source, production consumer seam and six-bar reasoning: **system** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| Standalone check at line 49: assert.deepEqual(filterProcesses(host, { ...everyone, scope: "orquester" }).map((p) => p.pid), [10, 11, 12]) | **KEEP** | Observable check/oracle: assert.deepEqual(filterProcesses(host, { ...everyone, scope: "orquester" }).map((p) => p.pid), [10, 11, 12]). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 50: assert.deepEqual(filterProcesses(host, { ...everyone, query: "VITE" }).map((p) => p.pid), [11], "matches the command line, any case") | **KEEP** | Observable check/oracle: assert.deepEqual(filterProcesses(host, { ...everyone, query: "VITE" }).map((p) => p.pid), [11], "matches the command line, any case"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 51: assert.deepEqual(filterProcesses(host, { ...everyone, query: "20" }).map((p) => p.pid), [20], "a bare number matches the exact pid") | **KEEP** | Observable check/oracle: assert.deepEqual(filterProcesses(host, { ...everyone, query: "20" }).map((p) => p.pid), [20], "a bare number matches the exact pid"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 52: assert.deepEqual(filterProcesses(host, { ...everyone, user: "root" }).map((p) => p.pid), [1, 20]) | **KEEP** | Observable check/oracle: assert.deepEqual(filterProcesses(host, { ...everyone, user: "root" }).map((p) => p.pid), [1, 20]). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 53: assert.deepEqual(filterProcesses(host, { ...everyone, state: "running" }).map((p) => p.pid), [11]) | **KEEP** | Observable check/oracle: assert.deepEqual(filterProcesses(host, { ...everyone, state: "running" }).map((p) => p.pid), [11]). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 54: assert.deepEqual(processUsers(host), ["orquester", "root"]) | **KEEP** | Observable check/oracle: assert.deepEqual(processUsers(host), ["orquester", "root"]). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 56: assert.equal(filterProcesses([{ pid: 5, ppid: 1, name: "x", cmdline: "x", rssBytes: 0 }], { ...everyone, scope: "orquester" }).length, 1) | **KEEP** | Observable check/oracle: assert.equal(filterProcesses([{ pid: 5, ppid: 1, name: "x", cmdline: "x", rssBytes: 0 }], { ...everyone, scope: "orquester" }).length, 1). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 59: assert.equal(canStop(host[2], 10), true) | **KEEP** | Observable check/oracle: assert.equal(canStop(host[2], 10), true). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 60: assert.equal(canStop(host[1], 10), false, "the daemon is never offered") | **KEEP** | Observable check/oracle: assert.equal(canStop(host[1], 10), false, "the daemon is never offered"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 61: assert.equal(canStop(host[0], 10), false, "nothing outside our tree is offered") | **KEEP** | Observable check/oracle: assert.equal(canStop(host[0], 10), false, "nothing outside our tree is offered"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 62: assert.equal(canStop(proc(30, 1, { role: "agent-host" }), 10), false, "nor is the agent host") | **KEEP** | Observable check/oracle: assert.equal(canStop(proc(30, 1, { role: "agent-host" }), 10), false, "nor is the agent host"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 65: assert.equal(canStop(proc(31, 1, { managed: false, stoppable: true }), 10), true, "our user's own, outside the tree") | **KEEP** | Observable check/oracle: assert.equal(canStop(proc(31, 1, { managed: false, stoppable: true }), 10), true, "our user's own, outside the tree"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 66: assert.equal(canStop(proc(32, 1, { managed: true, stoppable: false }), 10), false, "the daemon's say wins") | **KEEP** | Observable check/oracle: assert.equal(canStop(proc(32, 1, { managed: true, stoppable: false }), 10), false, "the daemon's say wins"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 71: assert.deepEqual(pids(flat), [11, 20, 1, 10, 12]) | **KEEP** | Observable check/oracle: assert.deepEqual(pids(flat), [11, 20, 1, 10, 12]). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 72: assert.deepEqual(pids(buildRows(host, "none", { key: "cpu", direction: "asc" }, new Set())), [1, 10, 20, 11, 12]) | **KEEP** | Observable check/oracle: assert.deepEqual(pids(buildRows(host, "none", { key: "cpu", direction: "asc" }, new Set())), [1, 10, 20, 11, 12]). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 73: assert.deepEqual(pids(buildRows(host, "none", { key: "name", direction: "asc" }, new Set())), [12, 20, 10, 11, 1]) | **KEEP** | Observable check/oracle: assert.deepEqual(pids(buildRows(host, "none", { key: "name", direction: "asc" }, new Set())), [12, 20, 10, 11, 1]). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 76: assert.ok(compareRows(older, newer, "uptime", "desc") < 0, "longest uptime first when descending") | **KEEP** | Observable check/oracle: assert.ok(compareRows(older, newer, "uptime", "desc") < 0, "longest uptime first when descending"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 77: assert.ok(compareRows(older, newer, "uptime", "asc") > 0) | **KEEP** | Observable check/oracle: assert.ok(compareRows(older, newer, "uptime", "asc") > 0). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 81: assert.deepEqual(pids(tree), [1, 20, 10, 11, 12], "siblings sorted by the active column, children follow their parent") | **KEEP** | Observable check/oracle: assert.deepEqual(pids(tree), [1, 20, 10, 11, 12], "siblings sorted by the active column, children follow their parent"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 82: assert.deepEqual( tree.map((row) => (row.kind === "process" ? row.depth : -1)), [0, 1, 1, 2, 2] ) | **KEEP** | Observable check/oracle: assert.deepEqual( tree.map((row) => (row.kind === "process" ? row.depth : -1)), [0, 1, 1, 2, 2] ). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 87: assert.deepEqual(pids(collapsed), [1, 20, 10], "a toggled parent hides its children") | **KEEP** | Observable check/oracle: assert.deepEqual(pids(collapsed), [1, 20, 10], "a toggled parent hides its children"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 89: assert.ok(daemonRow.kind === "process" && daemonRow.childCount === 2 && !daemonRow.expanded) | **KEEP** | Observable check/oracle: assert.ok(daemonRow.kind === "process" && daemonRow.childCount === 2 && !daemonRow.expanded). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 91: assert.deepEqual(pids(buildRows([host[2], host[3]], "tree", { key: "pid", direction: "asc" }, new Set())), [11, 12]) | **KEEP** | Observable check/oracle: assert.deepEqual(pids(buildRows([host[2], host[3]], "tree", { key: "pid", direction: "asc" }, new Set())), [11, 12]). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 92: assert.equal(buildRows([proc(40, 41), proc(41, 40)], "tree", { key: "pid", direction: "asc" }, new Set()).length, 2) | **KEEP** | Observable check/oracle: assert.equal(buildRows([proc(40, 41), proc(41, 40)], "tree", { key: "pid", direction: "asc" }, new Set()).length, 2). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 96: assert.deepEqual(pids(grouped), [groupRowKey("node"), 20, 1, 12], "the node pair folds into one group, sorted by its total") | **KEEP** | Observable check/oracle: assert.deepEqual(pids(grouped), [groupRowKey("node"), 20, 1, 12], "the node pair folds into one group, sorted by its total"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 98: assert.ok(group.kind === "group" && !group.expanded && group.procs.length === 2) | **KEEP** | Observable check/oracle: assert.ok(group.kind === "group" && !group.expanded && group.procs.length === 2). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 99: assert.equal(group.kind === "group" && group.metrics.cpuPercent, 30) | **KEEP** | Observable check/oracle: assert.equal(group.kind === "group" && group.metrics.cpuPercent, 30). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 100: assert.equal(group.kind === "group" && group.metrics.rssBytes, 6000) | **KEEP** | Observable check/oracle: assert.equal(group.kind === "group" && group.metrics.rssBytes, 6000). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 102: assert.deepEqual(pids(opened).slice(0, 3), [groupRowKey("node"), 11, 10]) | **KEEP** | Observable check/oracle: assert.deepEqual(pids(opened).slice(0, 3), [groupRowKey("node"), 11, 10]). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 107: assert.equal(mixed.user, undefined, "a group of different users names none") | **KEEP** | Observable check/oracle: assert.equal(mixed.user, undefined, "a group of different users names none"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 108: assert.equal(mixed.state, "running", "the busiest state represents the group") | **KEEP** | Observable check/oracle: assert.equal(mixed.state, "running", "the busiest state represents the group"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 109: assert.equal(mixed.cpuPercent, null, "no measured member means an unknown total, not 0") | **KEEP** | Observable check/oracle: assert.equal(mixed.cpuPercent, null, "no measured member means an unknown total, not 0"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 110: assert.equal(mixed.startedAt, 10) | **KEEP** | Observable check/oracle: assert.equal(mixed.startedAt, 10). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 113: assert.equal(descendantCount(host, 10), 2) | **KEEP** | Observable check/oracle: assert.equal(descendantCount(host, 10), 2). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 114: assert.equal(descendantCount(host, 1), 4) | **KEEP** | Observable check/oracle: assert.equal(descendantCount(host, 1), 4). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 115: assert.equal(descendantCount([proc(5, 5)], 5), 0, "a self-parented pid is not its own child") | **KEEP** | Observable check/oracle: assert.equal(descendantCount([proc(5, 5)], 5), 0, "a self-parented pid is not its own child"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 117: assert.deepEqual(daemonTree.children.map((p) => p.pid), [11, 12], "direct children, busiest first; unknown CPU last") | **KEEP** | Observable check/oracle: assert.deepEqual(daemonTree.children.map((p) => p.pid), [11, 12], "direct children, busiest first; unknown CPU last"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 118: assert.equal(daemonTree.descendants, 2) | **KEEP** | Observable check/oracle: assert.equal(daemonTree.descendants, 2). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 119: assert.equal(daemonTree.cpuPercent, 30, "the subtree total counts the process itself and skips unknowns") | **KEEP** | Observable check/oracle: assert.equal(daemonTree.cpuPercent, 30, "the subtree total counts the process itself and skips unknowns"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 120: assert.equal(daemonTree.rssBytes, 7000) | **KEEP** | Observable check/oracle: assert.equal(daemonTree.rssBytes, 7000). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 122: assert.deepEqual(initTree.children.map((p) => p.pid), [20, 10], "grandchildren are counted, not listed") | **KEEP** | Observable check/oracle: assert.deepEqual(initTree.children.map((p) => p.pid), [20, 10], "grandchildren are counted, not listed"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 123: assert.equal(initTree.descendants, 4) | **KEEP** | Observable check/oracle: assert.equal(initTree.descendants, 4). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 124: assert.equal(subtreeSummary(host, 12).cpuPercent, null, "nothing measured is unknown, not 0%") | **KEEP** | Observable check/oracle: assert.equal(subtreeSummary(host, 12).cpuPercent, null, "nothing measured is unknown, not 0%"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 125: assert.deepEqual(ancestorsOf(host, 11).map((p) => p.pid), [1, 10], "outermost first") | **KEEP** | Observable check/oracle: assert.deepEqual(ancestorsOf(host, 11).map((p) => p.pid), [1, 10], "outermost first"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 126: assert.deepEqual(ancestorsOf(host, 1), [], "a parent outside the list ends the chain") | **KEEP** | Observable check/oracle: assert.deepEqual(ancestorsOf(host, 1), [], "a parent outside the list ends the chain"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 127: assert.deepEqual(ancestorsOf([proc(40, 41), proc(41, 40)], 40).map((p) => p.pid), [41], "a ppid cycle terminates") | **KEEP** | Observable check/oracle: assert.deepEqual(ancestorsOf([proc(40, 41), proc(41, 40)], 40).map((p) => p.pid), [41], "a ppid cycle terminates"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 129: assert.equal(core.daemon?.pid, 10) | **KEEP** | Observable check/oracle: assert.equal(core.daemon?.pid, 10). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 130: assert.equal(core["agent-host"]?.pid, 30) | **KEEP** | Observable check/oracle: assert.equal(core["agent-host"]?.pid, 30). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 131: assert.equal(coreProcesses([proc(7, 1)], 7).daemon?.pid, 7, "an untagged daemon is found by its pid") | **KEEP** | Observable check/oracle: assert.equal(coreProcesses([proc(7, 1)], 7).daemon?.pid, 7, "an untagged daemon is found by its pid"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 132: assert.deepEqual(managedTotals(host), { count: 3, cpuPercent: 30, rssBytes: 7000 }) | **KEEP** | Observable check/oracle: assert.deepEqual(managedTotals(host), { count: 3, cpuPercent: 30, rssBytes: 7000 }). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 135: assert.deepEqual(parseColumns(null), DEFAULT_COLUMNS) | **KEEP** | Observable check/oracle: assert.deepEqual(parseColumns(null), DEFAULT_COLUMNS). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 136: assert.deepEqual(parseColumns("not json"), DEFAULT_COLUMNS) | **KEEP** | Observable check/oracle: assert.deepEqual(parseColumns("not json"), DEFAULT_COLUMNS). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 137: assert.deepEqual(parseColumns('{"cpu":true}'), DEFAULT_COLUMNS) | **KEEP** | Observable check/oracle: assert.deepEqual(parseColumns('{"cpu":true}'), DEFAULT_COLUMNS). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 138: assert.deepEqual(parseColumns('["uptime","cpu","bogus","cpu",3]'), ["cpu", "uptime"], "known names, canonical order, once") | **KEEP** | Observable check/oracle: assert.deepEqual(parseColumns('["uptime","cpu","bogus","cpu",3]'), ["cpu", "uptime"], "known names, canonical order, once"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 139: assert.deepEqual(parseColumns("[]"), [], "every column hidden is a valid choice") | **KEEP** | Observable check/oracle: assert.deepEqual(parseColumns("[]"), [], "every column hidden is a valid choice"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 142: assert.equal(formatBitRate(10_912_500), "87.3 Mbps") | **KEEP** | Observable check/oracle: assert.equal(formatBitRate(10_912_500), "87.3 Mbps"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 143: assert.equal(formatBitRate(125), "1.0 Kbps") | **KEEP** | Observable check/oracle: assert.equal(formatBitRate(125), "1.0 Kbps"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 144: assert.equal(formatBitRate(null), "—") | **KEEP** | Observable check/oracle: assert.equal(formatBitRate(null), "—"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 145: assert.equal(formatCpu(62.44), "62.4%") | **KEEP** | Observable check/oracle: assert.equal(formatCpu(62.44), "62.4%"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 146: assert.equal(formatCpu(null), "—") | **KEEP** | Observable check/oracle: assert.equal(formatCpu(null), "—"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 147: assert.equal(formatDuration(45), "45s") | **KEEP** | Observable check/oracle: assert.equal(formatDuration(45), "45s"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 148: assert.equal(formatDuration(2 * 3600 + 14 * 60 + 9), "2h 14m") | **KEEP** | Observable check/oracle: assert.equal(formatDuration(2 * 3600 + 14 * 60 + 9), "2h 14m"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 149: assert.equal(formatDuration(5 * 86_400 + 3 * 3600), "5d 3h") | **KEEP** | Observable check/oracle: assert.equal(formatDuration(5 * 86_400 + 3 * 3600), "5d 3h"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |

## packages/ui/src/components/system/session-owner.check.ts

Contract source, production consumer seam and six-bar reasoning: **system** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| Standalone check at line 36: assert.deepEqual(resolveSessionOwner("live", sessions, workspaces, projects), { title: "claude", kind: "agent", project: projects[0] }) | **KEEP** | Observable check/oracle: assert.deepEqual(resolveSessionOwner("live", sessions, workspaces, projects), { title: "claude", kind: "agent", project: projects[0] }). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 45: assert.equal(resolveSessionOwner(id, sessions, workspaces, projects), null, &#96;${id} must not resolve&#96;) | **KEEP** | Observable check/oracle: assert.equal(resolveSessionOwner(id, sessions, workspaces, projects), null, &#96;${id} must not resolve&#96;). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 50: assert.equal(owner?.project.workspace, "ws") | **KEEP** | Observable check/oracle: assert.equal(owner?.project.workspace, "ws"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 51: assert.equal(owner?.project.name, "proj") | **KEEP** | Observable check/oracle: assert.equal(owner?.project.name, "proj"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |

## packages/ui/src/components/system/system-format.check.ts

Contract source, production consumer seam and six-bar reasoning: **system** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| Standalone check at line 5: assert.equal(killErrorCode({ body: { code: "PROCESS_PROTECTED" } }), "PROCESS_PROTECTED") | **KEEP** | Observable check/oracle: assert.equal(killErrorCode({ body: { code: "PROCESS_PROTECTED" } }), "PROCESS_PROTECTED"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 6: assert.equal(killErrorCode({ body: { code: "PROCESS_NOT_MANAGED" } }), "PROCESS_NOT_MANAGED") | **KEEP** | Observable check/oracle: assert.equal(killErrorCode({ body: { code: "PROCESS_NOT_MANAGED" } }), "PROCESS_NOT_MANAGED"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 7: assert.equal(killErrorCode({ body: { code: "INVALID_PID" } }), "INVALID_PID") | **KEEP** | Observable check/oracle: assert.equal(killErrorCode({ body: { code: "INVALID_PID" } }), "INVALID_PID"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 8: assert.equal(killErrorCode({ body: { code: "INVALID_SIGNAL" } }), "INVALID_SIGNAL") | **KEEP** | Observable check/oracle: assert.equal(killErrorCode({ body: { code: "INVALID_SIGNAL" } }), "INVALID_SIGNAL"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 9: assert.equal(killErrorCode({ body: { code: "UNSUPPORTED_PLATFORM" } }), "UNSUPPORTED_PLATFORM") | **KEEP** | Observable check/oracle: assert.equal(killErrorCode({ body: { code: "UNSUPPORTED_PLATFORM" } }), "UNSUPPORTED_PLATFORM"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 10: assert.equal(killErrorCode({ body: { code: "SOMETHING_ELSE" } }), null) | **KEEP** | Observable check/oracle: assert.equal(killErrorCode({ body: { code: "SOMETHING_ELSE" } }), null). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 11: assert.equal(killErrorCode(new Error("network down")), null) | **KEEP** | Observable check/oracle: assert.equal(killErrorCode(new Error("network down")), null). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 12: assert.equal(killErrorCode(null), null) | **KEEP** | Observable check/oracle: assert.equal(killErrorCode(null), null). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 13: assert.equal(killErrorCode(undefined), null) | **KEEP** | Observable check/oracle: assert.equal(killErrorCode(undefined), null). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |

## packages/ui/src/components/topbar/usage-format.check.ts

Contract source, production consumer seam and six-bar reasoning: **topbar** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| Standalone check at line 8: assert.equal(pickDriver([claude, codex], "busiest")?.id, "codex") | **KEEP** | Observable check/oracle: assert.equal(pickDriver([claude, codex], "busiest")?.id, "codex"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 9: assert.equal(pickDriver([claude, codex], "claude")?.id, "claude") | **KEEP** | Observable check/oracle: assert.equal(pickDriver([claude, codex], "claude")?.id, "claude"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 10: assert.equal(pickDriver([codex], "claude")?.id, "codex") | **KEEP** | Observable check/oracle: assert.equal(pickDriver([codex], "claude")?.id, "codex"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 11: assert.equal(pickDriver([], "busiest"), null) | **KEEP** | Observable check/oracle: assert.equal(pickDriver([], "busiest"), null). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 14: assert.deepEqual(missingUsageAgents(freshPrefs, []), ["claude", "codex", "grok"]) | **KEEP** | Observable check/oracle: assert.deepEqual(missingUsageAgents(freshPrefs, []), ["claude", "codex", "grok"]). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 15: assert.deepEqual(missingUsageAgents(freshPrefs, ["claude"]), ["codex", "grok"]) | **KEEP** | Observable check/oracle: assert.deepEqual(missingUsageAgents(freshPrefs, ["claude"]), ["codex", "grok"]). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 16: assert.deepEqual(missingUsageAgents(usagePrefsSchema.parse({ agents: { codex: false } }), []), ["claude", "grok"]) | **KEEP** | Observable check/oracle: assert.deepEqual(missingUsageAgents(usagePrefsSchema.parse({ agents: { codex: false } }), []), ["claude", "grok"]). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 17: assert.deepEqual(missingUsageAgents(usagePrefsSchema.parse({ enabled: false }), []), []) | **KEEP** | Observable check/oracle: assert.deepEqual(missingUsageAgents(usagePrefsSchema.parse({ enabled: false }), []), []). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 19: assert.deepEqual(normalizeUsageWindows("claude", { session: null, weekly: null }), []) | **KEEP** | Observable check/oracle: assert.deepEqual(normalizeUsageWindows("claude", { session: null, weekly: null }), []). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 25: assert.deepEqual(scoped.map((window) => window.percent), [10, 96, 100]) | **KEEP** | Observable check/oracle: assert.deepEqual(scoped.map((window) => window.percent), [10, 96, 100]). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 26: assert.equal(scoped[2].resetsAt, "2026-08-17T03:00:00Z") | **KEEP** | Observable check/oracle: assert.equal(scoped[2].resetsAt, "2026-08-17T03:00:00Z"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 27: assert.deepEqual( normalizeUsageWindows("claude", { session: null, weekly: null, scopedWindows: [{ label: "Fable", percent: 40 }] }).map((window) => window.p… | **KEEP** | Observable check/oracle: assert.deepEqual( normalizeUsageWindows("claude", { session: null, weekly: null, scopedWindows: [{ label: "Fable", percent: 40 }] }).map((window) => window.percent), [40] ). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 35: assert.equal(capped.unit, "credits") | **KEEP** | Observable check/oracle: assert.equal(capped.unit, "credits"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 36: assert.equal(capped.used, 700) | **KEEP** | Observable check/oracle: assert.equal(capped.used, 700). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 37: assert.equal(capped.limit, 1000) | **KEEP** | Observable check/oracle: assert.equal(capped.limit, 1000). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 38: assert.equal(capped.remaining, 300) | **KEEP** | Observable check/oracle: assert.equal(capped.remaining, 300). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |
| Standalone check at line 39: assert.equal(capped.resetsAt, "2026-07-07T10:00:00Z") | **KEEP** | Observable check/oracle: assert.equal(capped.resetsAt, "2026-07-07T10:00:00Z"). Fixed input/output verifies the named process/owner/error/usage contract through the public function boundary; other checks use different ownership, tree, measurement, persisted-field or wire states. |

## packages/ui/src/components/topbar/usage-format.test.ts

Contract source, production consumer seam and six-bar reasoning: **topbar** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| a sparse update replaces only the windows it names (line 15) | **KEEP** | Fixed regression oracle: merged.map((w) => [w.id, w.usedPercent]) deepEqual [ ["5h", 55], // Omitted means unchanged, NEVER cleared — a provider that reports only // its 5h pool on one turn must not erase the weekly bar. ["week", 80] ] |
| a window the daemon's own poll already covers is dropped, not printed twice (line 29) | **KEEP** | Fixed regression oracle: rows.map((r) => r.id) deepEqual ["provider:other"] |

## packages/ui/src/components/ui/lazy.dom.test.ts

Contract source, production consumer seam and six-bar reasoning: **ui** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| a lazy dialog loads with its first opening and stays mounted across a close (line 83) | **REWRITE** | Replace a private mount-effect count with actual child state changed before close and observed after reopen. Keep first-load laziness, loading state and one module load; a state-reset regression fails through visible content. Current independent oracle: loads equal 0 ; loads equal 1 |
| a chunk that fails to load leaves a Reload card in place of the view (line 122) | **KEEP** | Fixed regression oracle: assert.ok(document.querySelector('[role="alert"]')) ; host.textContent ?? "" match /sibling/ |
| any other error in a lazy view still reaches the boundary above (line 140) | **KEEP** | Fixed regression oracle: host.textContent equal "outer caught" |

## packages/ui/src/components/ui/modal.dom.test.ts

Contract source, production consumer seam and six-bar reasoning: **ui** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| closes the modal while it is the newest layer (line 77) | **KEEP** | Fixed regression oracle: closes equal 1 |
| leaves the Escape to a newer layer drawn over it (line 82) | **KEEP** | Fixed regression oracle: closes equal 0 ; closes equal 1 |
| stays open when the newer layer lets go of its layer on the same key (line 91) | **KEEP** | Fixed regression oracle: closes equal 0 |

## packages/ui/src/hooks/use-back-close.dom.test.ts

Contract source, production consumer seam and six-bar reasoning: **hooks** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| Back closes the overlay; a refused close holds a fresh entry; a UI close gives it back (line 80) | **KEEP** | Fixed regression oracle: depth() equal 1 ; api.closes equal 2 |

## packages/ui/src/hooks/use-long-press.dom.test.ts

Contract source, production consumer seam and six-bar reasoning: **hooks** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| a resting finger opens it once, where it rests, and the click that follows is swallowed (line 96) | **KEEP** | Fixed regression oracle: presses deepEqual [] ; clicks equal 1 |
| a tap stays a click (line 112) | **KEEP** | Fixed regression oracle: presses deepEqual [] ; clicks equal 1 |
| a finger that moves (or that the browser takes for a scroll) is not a press (line 122) | **KEEP** | Fixed regression oracle: presses deepEqual [] |
| a mouse never starts the timer; its right click opens the menu (line 133) | **KEEP** | Fixed regression oracle: presses deepEqual [] ; presses deepEqual [{ x: 5, y: 6 }] |
| Android's long-press contextmenu and the timer open it once between them (line 142) | **KEEP** | Fixed regression oracle: presses.length equal 1 ; presses.length equal 2 |
| a mouse event the touch still emits does not reach the menu's outside-click listener (line 159) | **KEEP** | Fixed regression oracle: outside equal 0 ; outside equal 1 |
| a row unmounted mid-press opens nothing (line 176) | **KEEP** | Fixed regression oracle: presses deepEqual [] |

## packages/ui/src/icons/registry-icons.test.ts

Contract source, production consumer seam and six-bar reasoning: **icons** in the shared rationale below. This file’s distinct regressions and independent fixed oracles are listed case by case; no other owner supersedes the retained input/state/operation indicated in each row. Relevant UI test/typecheck gates remain required.

| Baseline test/check (original name) | Disposition | Concrete failure, oracle and disposition evidence |
| --- | --- | --- |
| an id naming an Object.prototype member falls back to the generic icon instead of crashing (line 9) | **KEEP** | Fixed regression oracle: output notEqual "" |

## Shared six-bar rationale

### attention

- **B1 / independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md (background indexing workers), README.md attention signalling; SessionSummary.owner API.
- **B2/B3 / regression and independent oracle:** the case names identify recognizable failures and their rows show literal expected values, fixture-authored results or explicit browser states; mocks supply external responses, never the asserted production decisions.
- **B4 / stable seam and non-test callers:** deriveAgentSessions collection returned to sidebar, count and shortcut consumers. The live shared web/desktop components consume those outputs/events; deleted test-only exports are listed separately.
- **B5 / refactor resistance:** underlying implementation can change while those semantic outputs remain; incidental scores, CSS/geometry, allocation identity and copy-only assertions are removed or rewritten as shown.
- **B6 / uniqueness and surviving owners:** worker-owner exclusion is retained once at the list derivation; markup-only activity-bar duplicates are removed. The per-case fixed oracle supplies the additional input/state/operation not superseded by another remaining owner.
- **Risk/validation:** independent protocol/security/persistence and critical user-workflow protection remains; relevant focused UI tests, full UI tests and dependent typechecks must pass.

### boxes

- **B1 / independent source:** docs/superpowers/specs/2026-10-19-ephemeral-ai-vms-design.md §§6, 8.1, 8.3, 8.8–8.11, 9.3, 10, 11.2–11.3, 13.3 and packages/api/src/boxes.ts.
- **B2/B3 / regression and independent oracle:** the case names identify recognizable failures and their rows show literal expected values, fixture-authored results or explicit browser states; mocks supply external responses, never the asserted production decisions.
- **B4 / stable seam and non-test callers:** project-location request/reducer boundary, credentials/connection payload builders, box lifecycle/composer decisions, and mounted user-action-to-ApiClient boundary. The live shared web/desktop components consume those outputs/events; deleted test-only exports are listed separately.
- **B5 / refactor resistance:** underlying implementation can change while those semantic outputs remain; incidental scores, CSS/geometry, allocation identity and copy-only assertions are removed or rewritten as shown.
- **B6 / uniqueness and surviving owners:** pure tests own additional selection/compatibility/validation combinations; DOM cases own actual form wiring, confirmation gates, plugin changes, secrets masking, streamed updates and late requests. Exact-copy/geometry duplicates are removed. The per-case fixed oracle supplies the additional input/state/operation not superseded by another remaining owner.
- **Risk/validation:** independent protocol/security/persistence and critical user-workflow protection remains; relevant focused UI tests, full UI tests and dependent typechecks must pass.

### browser

- **B1 / independent source:** Ephemeral AI VMs spec VM browser requirements and packages/api/src/boxes.ts / BrowserSummary.runsIn compatibility.
- **B2/B3 / regression and independent oracle:** the case names identify recognizable failures and their rows show literal expected values, fixture-authored results or explicit browser states; mocks supply external responses, never the asserted production decisions.
- **B4 / stable seam and non-test callers:** Browser menu decision and browser progress/DevTools states used by BrowserView. The live shared web/desktop components consume those outputs/events; deleted test-only exports are listed separately.
- **B5 / refactor resistance:** underlying implementation can change while those semantic outputs remain; incidental scores, CSS/geometry, allocation identity and copy-only assertions are removed or rewritten as shown.
- **B6 / uniqueness and surviving owners:** menu permission-to-open and VM/host compatibility remain; internal OS predicate and exact tooltip copy are removed. The per-case fixed oracle supplies the additional input/state/operation not superseded by another remaining owner.
- **Risk/validation:** independent protocol/security/persistence and critical user-workflow protection remains; relevant focused UI tests, full UI tests and dependent typechecks must pass.

### command-palette

- **B1 / independent source:** commits dccb585d (whole/prefix/word-start ordering then recency) and 71752cd7 (freeze ranking while open); docs/superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md §C and packages/api/src/agent-chat search query/snippet protocol.
- **B2/B3 / regression and independent oracle:** the case names identify recognizable failures and their rows show literal expected values, fixture-authored results or explicit browser states; mocks supply external responses, never the asserted production decisions.
- **B4 / stable seam and non-test callers:** paletteResults returned rows/order, recency snapshot observable order, input-mode/query normalization, host snippet and response-state boundaries. The live shared web/desktop components consume those outputs/events; deleted test-only exports are listed separately.
- **B5 / refactor resistance:** underlying implementation can change while those semantic outputs remain; incidental scores, CSS/geometry, allocation identity and copy-only assertions are removed or rewritten as shown.
- **B6 / uniqueness and surviving owners:** visible ranking owns score semantics once, internal score tests consolidate into it; search protocol and frozen ranking are distinct; helper read counts are removed. The per-case fixed oracle supplies the additional input/state/operation not superseded by another remaining owner.
- **Risk/validation:** independent protocol/security/persistence and critical user-workflow protection remains; relevant focused UI tests, full UI tests and dependent typechecks must pass.

### desktop

- **B1 / independent source:** docs/superpowers/specs/2026-09-30-desktop-tab-design.md §10.2; packages/api/src/desktops.ts request limits/defaults; X11 keysym bytes and noVNC modifier conventions; desktop pointer historical tooltip regression documented beside the live owner.
- **B2/B3 / regression and independent oracle:** the case names identify recognizable failures and their rows show literal expected values, fixture-authored results or explicit browser states; mocks supply external responses, never the asserted production decisions.
- **B4 / stable seam and non-test callers:** RFB keysym/keystroke output and launch request/form/suggestion boundary; real display-edge pointer coordinate mapping. The live shared web/desktop components consume those outputs/events; deleted test-only exports are listed separately.
- **B5 / refactor resistance:** underlying implementation can change while those semantic outputs remain; incidental scores, CSS/geometry, allocation identity and copy-only assertions are removed or rewritten as shown.
- **B6 / uniqueness and surviving owners:** Unicode, control keys, OS modifier release, launch validation/default omission and new-desktop progress have distinct user-visible failures. Defensive zero-area geometry is removed. The per-case fixed oracle supplies the additional input/state/operation not superseded by another remaining owner.
- **Risk/validation:** independent protocol/security/persistence and critical user-workflow protection remains; relevant focused UI tests, full UI tests and dependent typechecks must pass.

### git

- **B1 / independent source:** Git unified/extended patch wire format, packages/api git contracts, and commit 8b490cef (per-file turn diff and change-kind split).
- **B2/B3 / regression and independent oracle:** the case names identify recognizable failures and their rows show literal expected values, fixture-authored results or explicit browser states; mocks supply external responses, never the asserted production decisions.
- **B4 / stable seam and non-test callers:** parseDiffFiles/parseUnifiedDiff protocol output, change-kind numeric aggregation, generated-file fold decisions, and DiffFilesView public rendered file content. The live shared web/desktop components consume those outputs/events; deleted test-only exports are listed separately.
- **B5 / refactor resistance:** underlying implementation can change while those semantic outputs remain; incidental scores, CSS/geometry, allocation identity and copy-only assertions are removed or rewritten as shown.
- **B6 / uniqueness and surviving owners:** Git headers, quoted paths, CRLF content, binary payloads and truncation each have credible parsing failures; render tests verify file data reaches the view. Duplicate titles/empty-copy and change-kind rendering are removed. The per-case fixed oracle supplies the additional input/state/operation not superseded by another remaining owner.
- **Risk/validation:** independent protocol/security/persistence and critical user-workflow protection remains; relevant focused UI tests, full UI tests and dependent typechecks must pass.

### knowledge

- **B1 / independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md (Knowledge tab, settings, worker transcripts, collection visibility, citations, index lifecycle); packages/api/src/knowledge.ts; commit 7bc1b376 (paging/search hits/early selection/stale layouts).
- **B2/B3 / regression and independent oracle:** the case names identify recognizable failures and their rows show literal expected values, fixture-authored results or explicit browser states; mocks supply external responses, never the asserted production decisions.
- **B4 / stable seam and non-test callers:** knowledge API request builders/state projections, actual layout result completeness and Worker lifecycle protocol, and mounted view-to-ApiClient actions and knowledge events. The live shared web/desktop components consume those outputs/events; deleted test-only exports are listed separately.
- **B5 / refactor resistance:** underlying implementation can change while those semantic outputs remain; incidental scores, CSS/geometry, allocation identity and copy-only assertions are removed or rewritten as shown.
- **B6 / uniqueness and surviving owners:** CRUD, optimistic settings patches, collection filtering, pagination refresh depth, stale estimates and late selections have separate failures; visual class/packing/label-size choices and exact-copy duplicates are removed. Worker fake only supplies wire messages; production decides cancellation and callbacks. The per-case fixed oracle supplies the additional input/state/operation not superseded by another remaining owner.
- **Risk/validation:** independent protocol/security/persistence and critical user-workflow protection remains; relevant focused UI tests, full UI tests and dependent typechecks must pass.

### repo

- **B1 / independent source:** docs/superpowers/specs/2026-10-18-repo-grouped-projects-design.md §3 (emoji, website icon and late result behavior), repo identity API.
- **B2/B3 / regression and independent oracle:** the case names identify recognizable failures and their rows show literal expected values, fixture-authored results or explicit browser states; mocks supply external responses, never the asserted production decisions.
- **B4 / stable seam and non-test callers:** RepoIconDialog DOM actions, recorded ApiClient requests, shared identity store and close callback. The live shared web/desktop components consume those outputs/events; deleted test-only exports are listed separately.
- **B5 / refactor resistance:** underlying implementation can change while those semantic outputs remain; incidental scores, CSS/geometry, allocation identity and copy-only assertions are removed or rewritten as shown.
- **B6 / uniqueness and surviving owners:** invalid emoji, save success, failed website retry and close-during-request each detect distinct visible outcomes; fakes supply pending server responses without implementing dialog behavior. The per-case fixed oracle supplies the additional input/state/operation not superseded by another remaining owner.
- **Risk/validation:** independent protocol/security/persistence and critical user-workflow protection remains; relevant focused UI tests, full UI tests and dependent typechecks must pass.

### right-rail

- **B1 / independent source:** docs/superpowers/specs/2026-09-28-agent-profile-design.md §§6–7; docs/superpowers/specs/2026-10-18-agent-profiles-design.md §§4–5; docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §12.1, §14.2.10; packages/api/src/{agent-profile,session-profiles,saved-prompts}.ts; AGENTS.md field-wise storage and bridge validation.
- **B2/B3 / regression and independent oracle:** the case names identify recognizable failures and their rows show literal expected values, fixture-authored results or explicit browser states; mocks supply external responses, never the asserted production decisions.
- **B4 / stable seam and non-test callers:** agent configuration draft/validation boundaries, profile revisioned ApiClient calls and event/state updates, browser storage public methods, saved-prompt request/delivery outcomes, keyboard event disposition. The live shared web/desktop components consume those outputs/events; deleted test-only exports are listed separately.
- **B5 / refactor resistance:** underlying implementation can change while those semantic outputs remain; incidental scores, CSS/geometry, allocation identity and copy-only assertions are removed or rewritten as shown.
- **B6 / uniqueness and surviving owners:** different agent formats, unknown fields, revision conflict races, secret keep semantics, workflow delete guards and prompt target/supersession rules are distinct contracts. Pure cases cover field combinations not replayed in DOM; DOM cases protect caller wiring and async lifecycle. Button inventories and repeated helper copies are removed. The per-case fixed oracle supplies the additional input/state/operation not superseded by another remaining owner.
- **Risk/validation:** independent protocol/security/persistence and critical user-workflow protection remains; relevant focused UI tests, full UI tests and dependent typechecks must pass.

### secret-files

- **B1 / independent source:** docs/superpowers/specs/2026-10-19-secret-files-plugin-design.md §§6–7; packages/api secret-files requests/content-token compare-and-set and restart-compatible revisions; AGENTS.md privacy/storage rules.
- **B2/B3 / regression and independent oracle:** the case names identify recognizable failures and their rows show literal expected values, fixture-authored results or explicit browser states; mocks supply external responses, never the asserted production decisions.
- **B4 / stable seam and non-test callers:** source/setup/push-impact request builders, drift model/dismissal serialization, and mounted dialog/project-bar actions crossing ApiClient/store/sessionStorage. The live shared web/desktop components consume those outputs/events; deleted test-only exports are listed separately.
- **B5 / refactor resistance:** underlying implementation can change while those semantic outputs remain; incidental scores, CSS/geometry, allocation identity and copy-only assertions are removed or rewritten as shown.
- **B6 / uniqueness and surviving owners:** safe source selection, no deletion push, content-token checks, clone impact, bounded tolerant dismissals and restart re-keying are meaningful distinct failure modes. UI cases own binding and refreshed compare data; exact labels/tones/list punctuation are removed. Per-case project paths isolate dismissals without a production reset hook. The per-case fixed oracle supplies the additional input/state/operation not superseded by another remaining owner.
- **Risk/validation:** independent protocol/security/persistence and critical user-workflow protection remains; relevant focused UI tests, full UI tests and dependent typechecks must pass.

### settings

- **B1 / independent source:** docs/superpowers/specs/2026-10-14-plugins-ts-rust-design.md §6; agent profile and unified MCP specs; packages/api/src/plugins.ts and account/usage login-expiry API; AGENTS.md secrets and tolerant compatibility.
- **B2/B3 / regression and independent oracle:** the case names identify recognizable failures and their rows show literal expected values, fixture-authored results or explicit browser states; mocks supply external responses, never the asserted production decisions.
- **B4 / stable seam and non-test callers:** plugin decisions/controls, safe source URLs, masked/global agent editor UI, login-expiry views and mounted plugin toggles sending real store actions to fake ApiClient. The live shared web/desktop components consume those outputs/events; deleted test-only exports are listed separately.
- **B5 / refactor resistance:** underlying implementation can change while those semantic outputs remain; incidental scores, CSS/geometry, allocation identity and copy-only assertions are removed or rewritten as shown.
- **B6 / uniqueness and surviving owners:** request gating, supported platform/engine changes, expiry warnings and editor-over-Settings Escape have distinct caller failures. SSR markup inventories/constant equality copies are removed; remaining DOM actions prove server-wide enable and confirmation behavior. The per-case fixed oracle supplies the additional input/state/operation not superseded by another remaining owner.
- **Risk/validation:** independent protocol/security/persistence and critical user-workflow protection remains; relevant focused UI tests, full UI tests and dependent typechecks must pass.

### sidebar

- **B1 / independent source:** docs/superpowers/specs/2026-10-18-repo-grouped-projects-design.md §§1, 3, 4; secret-files spec §7; AGENTS.md validated localStorage; NewProject API and safe terminal clone URL contract.
- **B2/B3 / regression and independent oracle:** the case names identify recognizable failures and their rows show literal expected values, fixture-authored results or explicit browser states; mocks supply external responses, never the asserted production decisions.
- **B4 / stable seam and non-test callers:** clone modal DOM-to-store/API requests, repo label API and localStorage, plugin-aware vault display, parseSidebarView persisted ID boundary. The live shared web/desktop components consume those outputs/events; deleted test-only exports are listed separately.
- **B5 / refactor resistance:** underlying implementation can change while those semantic outputs remain; incidental scores, CSS/geometry, allocation identity and copy-only assertions are removed or rewritten as shown.
- **B6 / uniqueness and surviving owners:** server versus terminal clone, shell-safe URL forms, account refusal fallback, label validation/reset and workspace-specific vault attention have distinct failures; UI action wiring is separate from daemon URL validation. Worker-dot markup duplication is removed. The per-case fixed oracle supplies the additional input/state/operation not superseded by another remaining owner.
- **Risk/validation:** independent protocol/security/persistence and critical user-workflow protection remains; relevant focused UI tests, full UI tests and dependent typechecks must pass.

### status

- **B1 / independent source:** README.md authenticated connection and diagnostics privacy contracts; connection failure enum/HTTP status and WebSocket protocol; component diagnostics behavior.
- **B2/B3 / regression and independent oracle:** the case names identify recognizable failures and their rows show literal expected values, fixture-authored results or explicit browser states; mocks supply external responses, never the asserted production decisions.
- **B4 / stable seam and non-test callers:** mounted Retry/Sign-in/Details/Copy actions, actual HTTP/WebSocket probe completion and copied report bytes. The live shared web/desktop components consume those outputs/events; deleted test-only exports are listed separately.
- **B5 / refactor resistance:** underlying implementation can change while those semantic outputs remain; incidental scores, CSS/geometry, allocation identity and copy-only assertions are removed or rewritten as shown.
- **B6 / uniqueness and surviving owners:** redaction in the actual rendered/copied diagnostics path differs from pure redaction helpers; sign-in and suppression paths are separate. Socket outcome is explicitly delivered; arbitrary elapsed-time settling is removed. The per-case fixed oracle supplies the additional input/state/operation not superseded by another remaining owner.
- **Risk/validation:** independent protocol/security/persistence and critical user-workflow protection remains; relevant focused UI tests, full UI tests and dependent typechecks must pass.

### system

- **B1 / independent source:** AgentHostStatusResponse / SystemProcessInfo API and commit e9c5bc00 (pending wake/shell restart blockers and confirmed controls); AGENTS.md archived-data/privacy and process ownership boundaries.
- **B2/B3 / regression and independent oracle:** the case names identify recognizable failures and their rows show literal expected values, fixture-authored results or explicit browser states; mocks supply external responses, never the asserted production decisions.
- **B4 / stable seam and non-test callers:** restart blocker actions/confirmation data and mounted ApiClient actions, process filtering/tree/grouping/sort/stop decisions, session owner resolution and typed kill error codes. The live shared web/desktop components consume those outputs/events; deleted test-only exports are listed separately.
- **B5 / refactor resistance:** underlying implementation can change while those semantic outputs remain; incidental scores, CSS/geometry, allocation identity and copy-only assertions are removed or rewritten as shown.
- **B6 / uniqueness and surviving owners:** task-only stop versus whole-session fallback, confirmation gating, restart blockers, protected process scope, unknown measurements and archived title concealment each have distinct failures. Icon/catalog appearance check is removed. The per-case fixed oracle supplies the additional input/state/operation not superseded by another remaining owner.
- **Risk/validation:** independent protocol/security/persistence and critical user-workflow protection remains; relevant focused UI tests, full UI tests and dependent typechecks must pass.

### topbar

- **B1 / independent source:** README.md usage widget and packages/api AgentUsage/ProviderUsageWindow sparse-update contracts; packages/config usage preferences.
- **B2/B3 / regression and independent oracle:** the case names identify recognizable failures and their rows show literal expected values, fixture-authored results or explicit browser states; mocks supply external responses, never the asserted production decisions.
- **B4 / stable seam and non-test callers:** normalized windows, sparse merge, driver selection and preferences-to-missing-agent decisions. The live shared web/desktop components consume those outputs/events; deleted test-only exports are listed separately.
- **B5 / refactor resistance:** underlying implementation can change while those semantic outputs remain; incidental scores, CSS/geometry, allocation identity and copy-only assertions are removed or rewritten as shown.
- **B6 / uniqueness and surviving owners:** provider-only updates must not erase weekly windows or duplicate polled windows; scoped/credit units and disabled preferences are independent compatibility failures. The per-case fixed oracle supplies the additional input/state/operation not superseded by another remaining owner.
- **Risk/validation:** independent protocol/security/persistence and critical user-workflow protection remains; relevant focused UI tests, full UI tests and dependent typechecks must pass.

### ui

- **B1 / independent source:** commit b7174fa7 (first paint code splitting); README.md PWA deployment behavior; DOM keyboard event ordering and tracked overlay contract.
- **B2/B3 / regression and independent oracle:** the case names identify recognizable failures and their rows show literal expected values, fixture-authored results or explicit browser states; mocks supply external responses, never the asserted production decisions.
- **B4 / stable seam and non-test callers:** mounted lazy dialog/boundary behavior and real bubbling Escape events with tracked layers. The live shared web/desktop components consume those outputs/events; deleted test-only exports are listed separately.
- **B5 / refactor resistance:** underlying implementation can change while those semantic outputs remain; incidental scores, CSS/geometry, allocation identity and copy-only assertions are removed or rewritten as shown.
- **B6 / uniqueness and surviving owners:** load-on-open/state retention, chunk rejection containment and ordinary error propagation differ; nested-layer Escape cannot close both menu/editor and underlying modal. Tests use controlled promises/clocks. The per-case fixed oracle supplies the additional input/state/operation not superseded by another remaining owner.
- **Risk/validation:** independent protocol/security/persistence and critical user-workflow protection remains; relevant focused UI tests, full UI tests and dependent typechecks must pass.

### hooks

- **B1 / independent source:** commit 3d2e5c85 (touch sidebar menus, iOS/Android races/unmount); browser History API and mobile Back-close workflow.
- **B2/B3 / regression and independent oracle:** the case names identify recognizable failures and their rows show literal expected values, fixture-authored results or explicit browser states; mocks supply external responses, never the asserted production decisions.
- **B4 / stable seam and non-test callers:** hooks mounted on real DOM event surfaces, public history popstate and externally recorded click/menu outcomes. The live shared web/desktop components consume those outputs/events; deleted test-only exports are listed separately.
- **B5 / refactor resistance:** underlying implementation can change while those semantic outputs remain; incidental scores, CSS/geometry, allocation identity and copy-only assertions are removed or rewritten as shown.
- **B6 / uniqueness and surviving owners:** tap/scroll/right-click/long-press race/trailing mouse/unmount and refused Back-close each produce different visible navigation or menu failures; virtual time avoids elapsed waits. The per-case fixed oracle supplies the additional input/state/operation not superseded by another remaining owner.
- **Risk/validation:** independent protocol/security/persistence and critical user-workflow protection remains; relevant focused UI tests, full UI tests and dependent typechecks must pass.

### icons

- **B1 / independent source:** runtime registry-icon lookup accepts unknown refId; Object.prototype-key historical crash regression.
- **B2/B3 / regression and independent oracle:** the case names identify recognizable failures and their rows show literal expected values, fixture-authored results or explicit browser states; mocks supply external responses, never the asserted production decisions.
- **B4 / stable seam and non-test callers:** getRegistryIcon rendered through ReactDOMServer. The live shared web/desktop components consume those outputs/events; deleted test-only exports are listed separately.
- **B5 / refactor resistance:** underlying implementation can change while those semantic outputs remain; incidental scores, CSS/geometry, allocation identity and copy-only assertions are removed or rewritten as shown.
- **B6 / uniqueness and surviving owners:** unknown IDs matching inherited properties must still render; ordinary icon catalog matching does not exercise prototype members. The per-case fixed oracle supplies the additional input/state/operation not superseded by another remaining owner.
- **Risk/validation:** independent protocol/security/persistence and critical user-workflow protection remains; relevant focused UI tests, full UI tests and dependent typechecks must pass.

## Scope totals and infrastructure

Named declarations: DELETE 57, REWRITE 40, OPTIMIZE 1, CONSOLIDATE 4, KEEP 445. Standalone check assertions: DELETE 41, KEEP 93. Test LOC: 12491 → 11688 (net -803). Counts classify original declarations; consolidation does not add new declarations.

Removed whole files: `sidebar/activity-bar.dom.test.ts`, `settings/plugins-settings.test.ts`, `system/process-icons.check.ts`. Their local DOM/stub/SSR fixtures disappear with them; no shared fixture, snapshot, mock package, dependency or runner configuration became unused. Production behavior and public API contracts are unchanged.

Removed `SecretFilesProjectBar.resetSecretFilesBarDismissals`, whose only caller was its test fixture, after a repository-wide non-test caller search. The fixture now uses independent project paths. Narrowed exports with only same-module runtime callers: browser `boxKindRunsBrowser`; palette `normalizeSearchText`, `rankField`, `rankFields`; graph layout `spread`; graph projection `NODE_MIN_SIZE`, `NODE_MAX_SIZE`, `MAX_LABELS`, `nodeSize`, `labelledNodes`; box panel `BOX_PANEL_MIN_HEIGHT_PX`; drift storage `MAX_BAR_DISMISSALS`; settings `AGENT_CONFIG_INTRO`. Actual component/protocol exports remain.

A pre-existing `KnowledgeView.Canvas` injection remains: the DOM suite’s substantial CRUD/navigation/race contracts need the non-canvas view boundary, while jsdom does not provide the real Cytoscape renderer. Removing it safely needs browser-backed equivalent protection. The stand-in never supplies CRUD, revision, pagination or request behavior; incidental stand-in geometry/selected-markup checks were not promoted as new contracts.

## Performance and validation

Connection diagnostics now receives its fake socket close through a microtask inside the awaited React `act` lifecycle. Five arbitrary 5ms waits and the timer-driven fake close are removed while HTTP/WebSocket failures, authenticated URL construction, retry and rendered/copied redaction assertions remain. Layout tests retain only node completeness/drawability and the real worker cancellation/stale-response/crash-recovery boundary; arbitrary geometry/fit-call checks are removed.

Largest matching baseline named-test times in this scope (reported named-test timings, not isolated execution or full file/process timings):

- 639.49ms — packages/ui/src/components/right-rail/session-profiles/session-profile-imports.dom.test.ts: shows the quick actions, and the Plugins tab's Add plugin.
- 555.58ms — packages/ui/src/components/right-rail/session-profiles/session-profiles.dom.test.ts: an edit survives a change to another item, but not a change to the item it edits.
- 555.37ms — packages/ui/src/components/settings/plugins-settings.dom.test.ts: turning tsc-rs on asks first, then turns it on for the whole server.
- 511.09ms — packages/ui/src/components/secret-files/SecretFilesDialog.dom.test.ts: sets up: conventional files ticked, newest copy pre-selected, merge with a primary, unticked ones excluded.
- 410.87ms — packages/ui/src/components/right-rail/session-profiles/session-profiles.dom.test.ts: a new item carries the revision held when it is sent; after a 409 the draft stays and the next save carries the reloaded one.
- 400.35ms — packages/ui/src/components/right-rail/session-profiles/session-profile-imports.dom.test.ts: Import from Global: unavailable rows are disabled, an existing pick asks first, the revision is sent.
- 369.35ms — packages/ui/src/components/right-rail/session-profiles/profile-knowledge.dom.test.ts: is absent while the plugin is off.
- 368.15ms — packages/ui/src/components/boxes/settings/boxes-settings.dom.test.ts: shows the totals, each provider's status and the Windows image row.

Measurements are owned by the root coordinator’s full-suite baseline/final runs with identical runner configuration. No isolated-body time is represented as suite/CI savings; process startup, cache state and machine contention can dominate these cases. Retained expensive DOM cases protect critical settings/clone/profile/secret-file/knowledge workflows and asynchronous state races.

Implementation is complete. Read-only TypeScript syntax parsing of modified test files reported no syntax diagnostics. `git diff --check -- packages/ui/src/components packages/ui/src/hooks packages/ui/src/icons docs/test-cleanup/2026-10/ui_components.md` passed. Repository-wide source searches confirmed no non-test importers of the narrowed exports and no remaining callers of the removed dismissal-reset hook.

Focused tests, package/full tests, typechecks and builds have not been run by this workstream: the coordinator is scheduling one test run per worktree after the isolated baseline. The coordinator records those gates and comparable whole-suite timings in the aggregate report. No performance speedup or CI-cost claim is made before those measurements.
