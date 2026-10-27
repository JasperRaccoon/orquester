# Incoming Devices boxes audit

22 incoming test files including delegated UI box settings; 277 static source test identities in manifest, 79 bodies newly named/modified upstream. RegExp.test calls excluded. Parameterized runtime cases count once; helper-only and five tar runtime expansions are supplemental and not counted twice.

Disposition counts: {"KEEP": 25, "REWRITE": 43, "OPTIMIZE": 0, "CONSOLIDATE": 4, "DELETE": 7}. All six requirements are recorded per exact changed identity in [devices-boxes.json](devices-boxes.json). The manifest lists all original identities; unchanged tests reference the original boxes audit. Supplemental helper callers and runtime expansions are not new declarations.

Test LOC relative to incoming610d for these paths: -461; this includes prior cleanup preserved in overlapping files and must not be added to earlier metrics. Removed five orphan generated-script/AVD-helper fixtures (817 lines). No dependencies removed or added.

Only assigned conflict paths were staged. Native BusyBox sandbox safety, SSH signing artifacts, tolerant config-state retention, Codex trust ownership and native tar full-stream validation all survive integration. Incoming PassThrough drain/count supersedes the earlier extraction flag workaround.

## apps/daemon/src/boxes/bootstrap/bootstrap.test.ts

- **KEEP** — the POSIX scripts parse under dash, bash and busybox sh: Native dash/bash/BusyBox syntax now also checks both pairing OS variants, including hostile display-name input. This is the only available native parser check for a macOS-targeted program in this Linux environment.
- **REWRITE** — containerCommand takes its secrets from env, unsets them and stays in the foreground: Restore native BusyBox execution when installed: UID65534 fixture isolation prevents built-in id from escaping fake HOME/root layout. Syntax-only coverage cannot replace actual runtime env scrubbing/foreground/native download behavior.
- **REWRITE** — the pairing script installs orq-agent for the user and runs install-service with the token in a 0600 file: Retain actual user-local install-service/token0600/artifact/credential privacy. Replace private sudo argv and wording checks with a harmless attempted shell injection name and proof its file was never created.
- **KEEP** — a pairing script made for macOS refuses to run on Linux and leaves no token behind: Wrong target OS must refuse before downloading or storing a live bootstrap credential; literal nonzero exit/no requests/no token is independent of implementation.
- **REWRITE** — the pairing script refuses bad input and puts the macOS agent under Application Support: Keep invalid HTTPS/token/box ID refusals and literal macOS Application Support install path compatibility. Remove informational prose/source-name sanitizer checks; actual malicious-name non-execution lives in native Linux pairing owner.

## apps/daemon/src/boxes/github/blacksmith-setup.test.ts

- **REWRITE** — ensureControlRepo creates the private repo, commits the workflow, waits until GitHub lists it, and is idempotent: Observe real committed YAML os/prepare/request_id schema and unchanged-run no writes; remove whole production renderer equality and private indexing read count.
- **REWRITE** — ensureControlRepo over the tailnet commits the workflow that joins it with the federated identity: Retain specified tailnet identity fields, successful cache dispatch/status and native rendered Tailscale action/client bytes after re-commit; remove renderer-as-oracle and whole prior-output comparison.

## apps/daemon/src/boxes/github/control-repo.test.ts

- **CONSOLIDATE** — gitBlobSha is git's blob id: Remove helper-only export/matrix; public ensureWorkflowFile sha fast-path now uses independently fixed native Git blob IDs for hello, empty and UTF-8 bytes, with intentionally undecodable mismatched body.
- **REWRITE** — ensureControlWorkflows commits both workflows, then only the ones whose content hash changed: Keep required workflow paths, parsed literal new input schema, unchanged no commits, stale-only update and Tailscale option update. Remove exact commit copy/read sequence/renderer equality and private controlWorkflowFiles inventory.
- **REWRITE** — ensureWorkflowFile trusts a matching blob sha without decoding the content: Use independent Git-known SHA1 object IDs, including UTF-8 byte-length case, through public ensureWorkflowFile; wrong hash construction now causes a real unwanted content update. No producer helper expected value remains.
- **KEEP** — dispatchWorkflowRun starts a device-cache run and finds it by name when GitHub answers 204: Actual workflow_dispatch request must use cache workflow/inputs and recover the matching named run after204. Distinct from box-run lookup because request_id/run-name identity differs.
- **REWRITE** — a dispatch with inputs the committed workflow does not declare is retried until the deadline: Use fixed old YAML missing new OS/prepare inputs, not a regex-edited producer template. Protocol-shaped FakeGithub now parses YAML schema instead of requiring6-space indentation. Virtual deadline rejects the specific stale workflow without creating a run.

## apps/daemon/src/boxes/github/device-cache.test.ts

- **REWRITE** — the device tools install the pinned versions from the shipped lockfile without lifecycle scripts: Retain independently specified security bytes npm ci/--ignore-scripts on the emitted shell artifact; remove expected versions copied from the producer metadata. Native package installer tests own lock/staging/idempotency behavior.
- **CONSOLIDATE** — box paths live under /var/lib/orquester/devices, which the paths step hands to the runner user: Literal persisted cache paths now checked on delivered workflow YAML at the public GitHub boundary. Direct self-declarations/wrapper inventory is unnecessary; remove boxDeviceToolBin test-only export.
- **CONSOLIDATE** — cache keys: one per content, valid for actions/cache, per OS where it matters: Drop arbitrary hash-format/version/string-construction inventories. Delivered save/restore artifacts must agree for SDK/tools/Apple caches, differ by OS tools branch and depend on available Xcode build, at the owning workflow boundary.
- **REWRITE** — the Android cache holds the API 35 x86_64 image and the default Pixel profiles, from the box host's pinned cmdline-tools: Check independently specified native SDK package/image bytes in the emitted shell script; drop same-source CMDLINE_TOOLS/hash/profile-array expectations. Wrong Android ABI/API or missing emulator/platform-tools remains detectable.
- **DELETE** — `snapshot: ${name}`: Generated shell snapshot is a change detector with no independent oracle and fails refactor resistance. Native syntax/execution and explicit workflow/security/package contracts remain; remove two orphan snapshot files.
- **DELETE** — the AVD script is generated from the box host's own modules: hardware, config hash, flags, guest settings, GPU order: Expected calls/flags/hardware/hash come from the same modules generator uses, and embedded source equality freezes private layout. Fails independent oracle, stable seam and refactor resistance. Retain actual AVD config/golden/host acceptance owners under devices/android and devices/hosts/box.
- **DELETE** — the script's tuning (run by node as the workflow runs it) writes what the box host makes and trusts: Regex extracts private heredocs and compares native driver output to the same patchAvdConfig/profileHash helpers; helper movement can fail with unchanged public behavior. Real avd-config/golden and Android host marker/cache acceptance owners survive. Remove three now-unused avdmanager helper fixtures.
- **DELETE** — the script's cutout fix runs what golden.ts runs: rect and fill overlays, enable/disable, SystemUI restart: Extracts private shell functions and derives all expected commands/state from daemon golden.ts using the identical embedded module. The fake implements the expected UI state. Independent Android golden/cutout tests own actual ADB policy; delete parity illusion and its fake device.
- **REWRITE** — the KVM step installs the udev rule that opens /dev/kvm to every user: Execute the entire shipped KVM program against a safe sudo dependency, capture real tee stdin, and assert literal public udev rule bytes. No real /etc or udev mutation; no private script helper/quote inventory.
- **REWRITE** — the iOS runner build picks the newest iOS runtime and its newest iPhone: Execute entire shipped bash program with protocol-shaped xcrun runtime JSON. The fixture stops at native simctl create after recording independently expected available latest iOS/iPhone IDs; no private embedded-node extraction or real simulator creation.

## apps/daemon/src/boxes/github/workflow-template.test.ts

- **REWRITE** — the workflow: dispatch inputs, OIDC permission, runner choice, lifetime, steps: Retain dispatch defaults/options, literal runner/platform mapping, OIDC permissions/env/token isolation and shell expression injection guard. Remove self-derived runner catalog and exact OS description copy.
- **CONSOLIDATE** — macOS without devices runs exactly the macOS box steps: Exact English step-name/order list fails stable seam/refactor resistance; backward-compatible defaults/platform and meaningful conditional cache behavior remain in workflow artifact owners.
- **REWRITE** — Linux boxes enable KVM before orq-agent starts; device hosts restore the Android and tool caches: Observe semantic cache actions, independent SDK/AVD/tools persisted paths, best-effort restore, restore-before-agent and no-save box lifecycle. Remove English name arrays and producer script/key/paths comparison.
- **REWRITE** — macOS device hosts restore agent-device's iOS runner keyed on the Xcode build: Observe actual runner-cache path and restore action only for a known Xcode output; cache key must reference build output. Remove whole step list, arbitrary private id assertion and same helper-generated key expectation.
- **REWRITE** — the device-cache workflow builds what is missing and saves it under the keys box runs restore: Observe required native cache families, semantic OS selection, literal permissions/input keys, matching delivered save/restore keys/paths (evaluate tools OS branch), and no install/save on cache hits. No exact English step names or incidental order.
- **DELETE** — the templates are deterministic: Calls each renderer twice and compares it to itself: no independently specified outcome or recognizable unique failure. All meaningful YAML bytes/native execution remain protected.
- **DELETE** — runner labels: macOS M4 and x64 Ubuntu 24.04, no ARM Linux: Direct catalog/helper inventory duplicates Blacksmith public offers/create OS/refusal/pricing owners and native input validation. Representation changes would fail despite equivalent dispatched runners.
- **REWRITE** — the step scripts pass bash -n: Extract every unique run script from the actual shipped box/cache YAML and parse it with bash. Private generator script exports are unnecessary and have been internalized.
- **REWRITE** — the input check rejects values that could break out of the run: Execute actual delivered YAML check scripts with literal valid/hostile inputs; retains OS/runner/prepare/URL/token/lifetime/UUID defenses. No private script export.
- **REWRITE** — `the download step (${platform}) gets an OIDC token for the daemon origin and sends it as GitHubOIDC`: Execute actual delivered YAML download program for both real platform endpoint contracts; native HTTP fixture independently checks OIDC audience/bearer/header/path and installed file with no log secrets.

## apps/daemon/src/boxes/hub/hub.test.ts

- **KEEP** — the user-auth exemption names exactly the box routes: Exact public route allow-list is independently specified security configuration; adding any unrelated exemption or losing pair endpoint fails literal path oracle. This is permitted public path-byte inspection, not a private export inventory.

## apps/daemon/src/boxes/hub/pair-route.test.ts

- **KEEP** — a live code answers the script, uncached; the code and the client reach the pairing source: Real Fastify route must return fixed script uncached with shell content type, and forward caller code/IP to the one-time pairing service. Service tests cannot detect wrong route/cache/header plumbing.
- **KEEP** — refusals: 404 for any dead code, 429 with Retry-After when throttled, 404 without pairing at all: Actual HTTP404/429, errorcode and Retry-After120 distinguish expired/unknown/throttled/unconfigured transport behavior; service policy alone does not protect HTTP translation.
- **REWRITE** — the pair route is exempt from user auth by its exact pattern, and its code never reaches a log line: Keep literal public pair URL and actual secret redaction/non-secret URL result; delete includes(BYO_PAIR_ROUTE) declaration self-check superseded by explicit hub allow-list.

## apps/daemon/src/boxes/providers/blacksmith.test.ts

- **KEEP** — describes macOS M4 sizes, images and the 5-day limit without credential fields: Public supported kinds/offers and external maximum lifetime/prices remain. Literal6/12vCPU prices4.8/9.6 and7200min can disagree with adapter tables; unsupported Windows/GPU answers remain empty. Independent source is original VM/provider product offer contract plus Phase2Linux support amendment.
- **REWRITE** — describes x64 Linux sizes at $0.004 per 2 vCPU-minute and the Ubuntu 24.04 image: Retain all literal size/vCPU/RAM/hourly price vectors and Ubuntu image/region identity. Delete incidental label wording; public cost/configuration data uniquely protects the spend UI and Linux runner choice.
- **KEEP** — create dispatches a run named orq-<boxId> with only non-secret inputs: Phase2§5 independently requires os/prepare inputs. LiteralGitHub dispatch keys/runner/domain/lifetime and token absence survive internal refactors. Returned runref/deadline/price and unsupported request rejection are caller-visible; no lower dispatch helper chooses provider-specific inputs or5day clamp.
- **KEEP** — create rents a Linux box (linux-x64 orq-agent, KVM) and a device host that restores the caches: Provider seam proves literalLinux runner/os/prepare,1.92 and0.96 hourly prices, macOS device preparation and kind/image/size refusals. ActualKVM/bootstrap/cache scripts are owned by workflow/bootstrap tests; this case does not claim to execute those systems.
- **REWRITE** — create re-commits workflows whose content changed before it dispatches (old orgs gain the new inputs): Phase2§5 requires existing org workflows to gain newos/prepare inputs atcreate. Seed fixed oldYAML, await successful actualprovider dispatch against external schema-validatingFakeGitHub, inspect parsed published inputs/cache request_id and literalTailscale client/audience. Remove renderer-as-oracle equality and private order ofPUTs. Retain noContentsPUT for unchangedresources as publicAPI idempotence/cost behavior.
- **REWRITE** — dispatchDeviceCacheWarm starts the device-cache workflow; deviceCacheWarmStatus follows it: Phase2§3/5 requires separately dispatched cache warm workflow and observable progress. LiteralworkflowFile/os/runner/request identity, queued→running→completed/gone and exclusion fromboxlisting remain. Remove whole-renderer equality; actualschema-accepted dispatch already proves workflowinstallation and lower template owner proves its semantics.
- **REWRITE** — status follows the run and its job: Keep actualGitHubrun/job state mappings and missing-reference failures. Delete newLinux exactwaiting-copy call; it repeats queuedstate solely to assert prose, with no independent wording contract.

## apps/daemon/src/boxes/providers/bootstrap-size.test.ts

- No incoming test body changed; preserve existing contracts. File-level helper/import adaptation and affected callers are recorded in JSON.

## apps/daemon/src/boxes/providers/byo.test.ts

- **REWRITE** — byo: free Linux and macOS machines, no credentials, no lifetime cap, never creates or lists anything: Phase3§2.1 independently specifies ownmachines Linux/macOS,free,nodeadline,norental/destruction. No-networkfetch guard and publicadaptercreate/list/destroy outcomesremain;replace productionBYO_REGION expectedobjectwithliteralwireid own.
- **REWRITE** — byo offers: one free size per idle, connected machine of the kind; never a device host: Actualoffers contain literaleligiblemachineid/freepriceand excludeoffline,pairing,lent,foreignprovider,devicehost anddisconnectedrecords; macOS/Linux selection remains. Delete directhelperboolean/labelprobes duplicating these publicoutcomes andlabelcopy. Stablecross-module offers API isthelowestpublicpickerowner.

## apps/daemon/src/boxes/remote/git-auth.test.ts

- No incoming test body changed; preserve existing contracts. File-level helper/import adaptation and affected callers are recorded in JSON.

## apps/daemon/src/boxes/remote/mcp-bridge.test.ts

- **KEEP** — a bridged stdio server runs on the host with its own env, piped to the box, and dies with the channel: Incoming removes unused entry(appdir, overrides) helper parameter only; retain cleanup. Current lifecycle wait matches logger English substring: this is an incidental synchronization weakness, not a reason to delete the unique process-lifetime contract.
- **KEEP** — an id the box's directory does not hold is refused: the channel closes, nothing runs: Incoming unused helper parameter deletion is safe; preserve negative + positive control.
- **KEEP** — a bridged HTTP server is reached from the host with its headers; the box never sees them: Unused helper arg removal only. Current test does not prove absence of arbitrary extra secret channel frames; retain independently verified auth/relay contract and avoid overstating absolute secrecy coverage.
- **KEEP** — a box holds at most maxChannelsPerBox open bridges: more are refused until one ends; other boxes are not affected: Helper arg removal only. maxChannelsPerBox is documented configurable resource policy, not an implementation-derived expected result.

## apps/daemon/src/boxes/service/blacksmith-route.test.ts

- **KEEP** — device-cache runs go through the Blacksmith setup's credentials, with the current tailnet join: Service settings choose live account/tailnet credentials, validate unsupported OS/runId, and preserve actual driver dispatch/status values. Generic GitHub adapter tests do not cover settings credential selection or refusal codes.

## apps/daemon/src/boxes/service/byo.test.ts

- **REWRITE** — Add your machine: a pairing record and a one-time command; only the code's hash is stored: Phase3§2.1 specifies one-timecurlcommandand30minutevalidity. Retainliteralcommandroute/tokenlength,typedrecorddata,actualdisk absenceofplaintextcode and64hex hashshape. Replace productionTTL/hashhelper oracle; independentknownSHA256 vector in spendcase ownsalgorithmcompatibility. Newrandomcodemint/spendalso remains exercisedbyexpiry/newPairing andplugin-toggleowners.
- **REWRITE** — the pairing code is spent by the first fetch and its script carries the box's bootstrap token: Arrange known24character code AAAAAAAAAAAAAAAAAAAAAAAA with literalSHA256digest1bda9f0aed80857d43c9329457f28b1ca29f736a0c539901e1ba16a909eb07b4 throughlegitimatepublicrecordstore; require actualfirstfetchsuccess,hubmintedtokenin deliveredscript,code/expiryspent andsecondfetch404. DeleteprivateTvariable/install-service/OSsourcegreps; realbootstraptests457/485 executeactualinstall andwrong-OS refusal.
- **REWRITE** — an expired, unknown or malformed code answers the same 404; failures are throttled per client: Advance independently specified30minutes,notimportedimplementationTTL. Expired/malformed/unknownuniform404,quota429,unspentrefusedvalidcodeand unaffectedclient successfulspend remainobservable. Protectsprivate codeexistence andper-clientabusepolicy,notduplicatedbyone-shotcase.
- **REWRITE** — pairing throttle: IPv6 by /64, IPv4-mapped as IPv4; bounded and pruned in window order: Documentedper-clientsecuritypolicy mustgroup equivalentIPv6/zone/mappedIPv4clients, allowdifferentnetworks,evictoldwindows underboundedflood,retainrecentrefusals andresetexpiredfailures. Assertpublic retryAfterMs outcomes; removeprivatekeystringformat andmap-sizegeometry. Internalizekeyfunctionandremove test-onlysizegetter; no productionconsumerneeds them.
- **REWRITE** — with the plugin off a valid code is refused (404) and stays unspent: Publicplugin gate refuseswhileoffwithoutconsumingcode. Replaceprivatehashpresenceprobe with reenablingandactualsuccessfulfetchof theoriginalcommand. This catches accidentalspend/expirydeletion throughstablecallerbehavior.
- **REWRITE** — first connect pairs the machine; it is offline while away and ready when back, never destroyed: Phase3§2.1 requiresready/offline/ready reconnection,metadata,KVM capabilityandneverdestroyingawaymachines. Actualhubconnect/disconnect eventsdrive persistedservice state; typed409BOX_INVALID_REQUESTnowrequires intended idle-machine rejection, avoidingunrelated-errorfalsepositive.
- **REWRITE** — a chat borrows an idle machine (provider byo) and destroying it gives it back: Phase3§2.1 leasesexistingmachine,excludesconcurrentborrow/removal andreturnsitreadynodeadlinenothreadwithoutdestroyingit. Keepcallerstate/identity/refusaloutcomes; delete3stepcount andemptyproc.list coverageprobe(private collaborator shape), pluserrorcopy.
- **REWRITE** — a machine used for device simulators is never lent to a chat or a project: Devicehost exclusivity isindependentPhase3ownershiprule. Require intendedBOX_NOT_READY/BOX_IN_USEerrors and unchangedpurpose. Supplyvalidprojectdata,pathincluded,instead of asnever malformedobject; broadassertrejectscan no longer passfor unrelatederror.
- **KEEP** — a chat's lease past its time limit is released by the reconciler: Publictime-limit policy releasesBYOleasebacktomachine/readyratherthan destroyingphysicalhost. Controlledindependent11minuteadvanceover10minutelease provesBYO-specificreconciler transition,distinctfromrentedboxdeletiontests.
- **REWRITE** — device-simulator flag and rename persist on the record and show on the summary: ActualHTTP/service preferenceupdate mustshownewname/deviceflagandpersistacrossprocessloss. Keepreturnedsummary data+typedinvalidflag refusal;replacein-memoryonlyregistryassertionwithactualboxes.jsondeviceHost/machineName bytes. LowergenericBoxStoredurabilitydoesnotprovethesefieldswerecommitted.
- **KEEP** — Remove machine: a connected one uninstalls its service first; its credential is revoked and the record deleted: Phase3§2.1 expressly requiresnativeagent.shutdown uninstallprotocol,credentialrevocation andrecordremoval,includingunpairedcancellation. ExactRPCmethod/uninstallfields areexternalorq-agent wirecompatibility,notprivatefunctionshape. Publicresult+recordabsencepreventmistakingphysicaldestructionforunpairing.

## apps/daemon/src/boxes/service/lifecycle.test.ts

- **KEEP** — the connect step keeps orq-agent's KVM report on the record and the summary (unknown from older agents): Persist literal kvm true/false when a newer agent reports it, omit unknown for older peers, and keep ordinary temporary prepare unset. This is unique optional wire-to-storage compatibility.
- **KEEP** — a kind caps lifetimes only when every provider does (Blacksmith Linux next to an uncapped cloud): Aggregated public kind lifetime is capped only when every connected provider caps it; an uncapped Linux offer must not inherit Blacksmith cap, while capped provider records retain deadline.
- **REWRITE** — a device-host box runs create, connect, the device service's `devices` step and ready: Retain actual preparer invocation for correct connected box, prepare=devices request, persistent purpose/ready/devices-step state, supplied log marker and caller destroy reason. Remove exact full setup-step inventory.
- **KEEP** — a device-host box whose `devices` step fails is torn down; without a preparer the step is skipped: A failed device preparation must tear down provider resource with provisioning-failed reason; missing extension safely skips; own machines cannot be rented as device-host boxes through this API. Distinct failure/absent-plugin conditions.

## apps/daemon/src/boxes/service/reconciler.test.ts

- **KEEP** — bring-your-own machines are never destroyed, marked gone or unreachable; only a chat's expired lease is released: Independent ownership rule forbids provider/unreachable deletion for owner machines; only expired chat lease releases and interrupted enabled setup resumes. Fixed records/statuses/clock produce literal actions; no service integration arranges every hostile listing/deadline state.

## apps/daemon/src/boxes/service/routes.test.ts

- **REWRITE** — plugin routes: boxes, providers, kinds and offers, connection, refusals: Retain public absence of Windows image capability and 409 BOX_UNSUPPORTED/404 unknown provider; remove exact diagnostic prose. Existing plugin/auth/settings/offers assertions remain.
- **REWRITE** — your machines: add, flag, new command, remove; a project placed on one keeps it on a failed setup and gives it back on delete: Critical real HTTP/project workflow verifies pair/flag/renew, hidden device-host offers, failed project setup retaining ownership, busy removal409, project delete returning machine, then uninstall/removal. Remove incidental Delete-the-project wording while retaining actual permission-denied failure data.

## apps/daemon/src/boxes/sync/config-sync.test.ts

- No incoming test body changed; preserve existing contracts. File-level helper/import adaptation and affected callers are recorded in JSON.

## apps/daemon/src/boxes/sync/transcripts.test.ts

- **KEEP** — OpenCode: sessions travel as export/import in the project's cwd: Incoming merely prefixes unused HostRunner command params with _. Keep existing per-test fixture cleanup from our branch; no altered oracle.

## apps/daemon/src/boxes/temporary/tools.test.ts

- **REWRITE** — download: tar can close its input before the box finishes; the entire source still decides success: IMPLEMENTED: incoming five receipt-driven native-tar subcases retained. Capture real tar through /bin/sh command -v before changes, resolve to absolute executable; per-subtest bin/tar wrapper invokes it and writes watched closure receipt. Scoped PATH restored in t.after, serial subtests. Remove production tar injection/world passthrough, cap import, and preceding redundant 1MiB-padding wrapper. Literal 4*1024**3 fixture boundary.
- **KEEP** — scenario: Preserve the independently specified state/input scenario at the existing owning seam; incoming delta only adapts the production caller/interface.

## apps/daemon/src/boxes/tooling/provisioner.test.ts

- **KEEP** — provision installs the box's release, writes its preload and state, and the preload redirects tsc in the box: Accept incoming real boxToolingEnv composition and removal of setContribution callback inventory. No production caller remains for removed sessionEnv method or setContribution hook.
- **KEEP** — off, a new version, a disconnected box: every box follows the plugin: Use await boxToolingEnv in harness. Incoming removes obsolete global contribution API; public contribution and actual process outcomes survive.
- **KEEP** — a box that is not connected is refused; a set-up project box is provisioned when it connects: Remove obsolete callback-null assertion as incoming does; public empty contribution/status remain.
- **REWRITE** — a Windows box: tar.exe, Windows paths only, no chmod, and NODE_OPTIONS with Windows quoting: IMPLEMENTED: accept incoming title/env API; removed exec count/order/exact argv/.tmp UUID regex and identifier-coupled preload source grep. Surviving tar.exe existence, no-chmod, all Windows paths, installed binary/marker/state/preload existence, literal NODE_OPTIONS and public contribution protect the target contract.

## packages/ui/src/components/boxes/settings/settings.logic.test.ts

- **REWRITE** — byo: the card lists only the owner's live machines, oldest first; the Boxes list leaves idle ones out: Keep literal owned/live machine filtering, oldest-first ordering, idle-machine exclusion from Boxes and supplied machine name data; remove Free/Release/Destroy/offline/pairing exact copy assertions.
- **DELETE** — byo: status pills for pairing, an expired command, online, offline and in use: Only snapshots pure presentation English labels/tones/title shape; no independently specified wording/visual requirement or unique behavioral outcome. Actual pairingPhase state, service state and UI selection/action owners remain.
- **REWRITE** — byo: names, removal and the device toggle: Keep invalid-name problem existence versus valid null and paired/busy device-toggle/removal decisions. Remove exact validation/confirmation/help prose and now-unused test imports.
- **REWRITE** — byo: the pairing dialog follows the live box — waiting, downloaded, connected, expired, cancelled: Keep independently named waiting/downloaded/connected/expired/gone dialog phases, rounded expiry, actual OS/arch data and absence from API-key providers. Remove arbitrary provider abbreviation copy.

## Removed infrastructure

- workflow CHECK_STEP_SCRIPT/CACHE_CHECK_STEP_SCRIPT/DOWNLOAD_STEP_SCRIPT/PATHS_STEP_SCRIPT test-only exports
- gitBlobSha/controlWorkflowFiles helper exports
- device-cache ANDROID_SDK_PACKAGES/ANDROID_CACHE_PROFILES/ANDROID_CACHE_HASH/boxDeviceToolBin exports
- TemporaryBoxToolsDeps.tar injection and world helper passthrough; BOX_DOWNLOAD_MAX_BYTES export
- BYO pairing throttle size getter/key export/TTL export and unused setup(enabled) flag

## Validation

Syntax/diff checks passed. No tests, typechecks or builds were run by this workstream during the new round; the parent owns the next test slot and complete gate. No performance result is claimed. Exact proposed commands and all source/seam/oracle/refactor/uniqueness evidence are in JSON.
