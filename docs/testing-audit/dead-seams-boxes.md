# Boxes dead-seam follow-up

Final bounded boxes dead-seam follow-up.273 existing-source identity overrides; no new test declarations. This overlaps original boxes and Devices ledgers and must not be added to total test counts.

Removed unused provider/service/GitHub/tooling fetch override chains, filesystem-clock overrides, private tailnet policy export and unused tooling timeout override/exports. Real filesystem and production lifecycle ports remain. Existing tests now observe native fetch/Date.now where no runtime clock port is required, with automatic per-test cleanup. The OIDC domain-clock callback is retained because BoxHub supplies it in production.

Provider auditor AST verified213 behavioral assertion expressions unchanged after normalizing only helper TestContext parameters/options. All request/pricing/state/privacy/cache/signature oracles survive; policy vectors moved from private helper to public native-HTTP consumer.

A separately verified security gap was repaired in the authoritative daemon URL validator: raw POSIX delimiters cannot enter copied pairing commands; percent-encoded URL data remains supported. Normal and historical-policy mutation commands are recorded on the existing bootstrap identity.

## Removed seams

- ProviderCallOptions.fetch
- BoxServiceDeps.fetch plus lifecycle/settings/reconciler forwarding members
- BlacksmithSetupDriverOptions.fetch
- VerifyGithubOidc third-call fetch option
- nodeCredentialFiles optional now argument
- TailscaleKeysDeps.fetch
- TailscaleKeysDeps.now
- evaluateTailnetPolicy exported helper
- ToolingArchiveCacheOptions.fetch/stored fetchImpl
- BoxToolingProvisionerDeps.fetch forwarding
- ToolingArchiveCacheOptions.downloadTimeoutMs
- TOOLING_DOWNLOAD_TIMEOUT_MS and isSafeToolingSegment test-only exports

## Retained runtime boundaries

- CredentialFiles: Actual production broker wiring apps/daemon/src/boxes/wiring.ts:457 supplies nodeCredentialFiles over configured account root; broker.ts uses owned-home/read/mtime/watch filesystem capability. Actual agent-host/boxes/index.ts:638,662 uses read/watch and shares the native adapter. This is a real platform implementation wired into runtime ownership and asynchronous filesystem behavior, not unused test export. The host passed this.now but its Pick<read|watch> never used ageOfNewest; removing that single argument has no host runtime clock effect.
- GitHub API URL/verifier issuer configuration: Public GitHub Enterprise/issuer compatibility fields remain; this sweep removes unused transport/clock override members only.
- Existing box shutdown/status drains: Actual daemon/session lifecycle production consumers still need their ownership/drain contracts; untouched.

## Existing test identities

### own

- `apps/daemon/src/boxes/github/control-repo.test.ts` — ensureControlRepo and ensureWorkflowFile are idempotent and update a changed template (REWRITE).
- `apps/daemon/src/boxes/github/control-repo.test.ts` — ensureControlWorkflows commits both workflows, then only the ones whose content hash changed (REWRITE).
- `apps/daemon/src/boxes/github/control-repo.test.ts` — ensureWorkflowFile trusts a matching blob sha without decoding the content (REWRITE).
- `apps/daemon/src/boxes/github/control-repo.test.ts` — dispatchWorkflowRun starts a device-cache run and finds it by name when GitHub answers 204 (REWRITE).
- `apps/daemon/src/boxes/github/control-repo.test.ts` — a dispatch with inputs the committed workflow does not declare is retried until the deadline (REWRITE).
- `apps/daemon/src/boxes/github/control-repo.test.ts` — waitWorkflowReady and dispatchBoxRun retry until GitHub has indexed the workflow (REWRITE).
- `apps/daemon/src/boxes/github/control-repo.test.ts` — dispatchBoxRun fails at once on a real input error and finds the run when GitHub answers 204 (REWRITE).
- `apps/daemon/src/boxes/github/control-repo.test.ts` — runs: get, list since, cancel and force-cancel (REWRITE).
- `apps/daemon/src/boxes/github/blacksmith-setup.test.ts` — checkAccount needs a classic token with repo and workflow, and points at the tokens page (REWRITE).
- `apps/daemon/src/boxes/github/blacksmith-setup.test.ts` — checkOrg sends each membership problem to the page that fixes it (REWRITE).
- `apps/daemon/src/boxes/github/blacksmith-setup.test.ts` — checkApp: installed, missing, suspended, selected repositories, or not visible to this token (REWRITE).
- `apps/daemon/src/boxes/github/blacksmith-setup.test.ts` — ensureControlRepo creates the private repo, commits the workflow, waits until GitHub lists it, and is idempotent (REWRITE).
- `apps/daemon/src/boxes/github/blacksmith-setup.test.ts` — ensureControlRepo over the tailnet commits the workflow that joins it with the federated identity (REWRITE).
- `apps/daemon/src/boxes/github/blacksmith-setup.test.ts` — ensureControlRepo refuses a daemon URL the workflow cannot use, before touching GitHub (REWRITE).
- `apps/daemon/src/boxes/github/blacksmith-setup.test.ts` — every call honours the caller's signal and the injected API URL (REWRITE).
- `apps/daemon/src/boxes/github/oidc.test.ts` — accepts a correctly signed token for the expected run and caches the keys (REWRITE).
- `apps/daemon/src/boxes/github/oidc.test.ts` — rejects wrong claims, bad signatures and unsupported tokens with a reason (REWRITE).
- `apps/daemon/src/boxes/github/oidc.test.ts` — an unknown kid refetches the keys (rotation), but not more than once a minute (REWRITE).
- `apps/daemon/src/boxes/github/oidc.test.ts` — a discovery failure is reported, not thrown (REWRITE).
- `apps/daemon/src/boxes/service/routes.test.ts` — creating a project in a box answers at once with the project and its provisioning box (REWRITE).
- `apps/daemon/src/boxes/service/routes.test.ts` — a cloned box project lists its repo fields from the record and keeps the template command (REWRITE).
- `apps/daemon/src/boxes/service/routes.test.ts` — the location is validated before anything is created (REWRITE).
- `apps/daemon/src/boxes/service/routes.test.ts` — without a route to this daemon no box project can be created (REWRITE).
- `apps/daemon/src/boxes/service/routes.test.ts` — deleting a box project destroys the box first; a failed destroy keeps the project (REWRITE).
- `apps/daemon/src/boxes/service/routes.test.ts` — plugin routes: boxes, providers, kinds and offers, connection, refusals (REWRITE).
- `apps/daemon/src/boxes/service/routes.test.ts` — with the plugin off, live boxes are still listed and a temporary box can be destroyed (REWRITE).
- `apps/daemon/src/boxes/service/routes.test.ts` — connection reports Tailscale on this machine; Set up for me serves the daemon and checks it (REWRITE).
- `apps/daemon/src/boxes/service/routes.test.ts` — Set up for me retries through passwordless sudo when Tailscale refuses the daemon's user (REWRITE).
- `apps/daemon/src/boxes/service/routes.test.ts` — Set up for me without permission answers 409 with both remedies (REWRITE).
- `apps/daemon/src/boxes/service/routes.test.ts` — Set up for me refuses when Tailscale isn't installed or running (REWRITE).
- `apps/daemon/src/boxes/service/routes.test.ts` — the Check explains a failure and, in Tailscale mode, how to fix it (REWRITE).
- `apps/daemon/src/boxes/service/routes.test.ts` — your machines: add, flag, new command, remove; a project placed on one keeps it on a failed setup and gives it back on delete (REWRITE).
- `apps/daemon/src/boxes/service/blacksmith-route.test.ts` — macOS boxes dial the public URL even in Tailscale mode (REWRITE).
- `apps/daemon/src/boxes/service/blacksmith-route.test.ts` — without a public URL or a federated identity, the control repo step says how to fix it (REWRITE).
- `apps/daemon/src/boxes/service/blacksmith-route.test.ts` — a stored route error is re-checked after a passing Check, not a failing one (REWRITE).
- `apps/daemon/src/boxes/service/blacksmith-route.test.ts` — nothing is re-run before an account is picked; the identity is validated (REWRITE).
- `apps/daemon/src/boxes/service/blacksmith-route.test.ts` — device-cache runs go through the Blacksmith setup's credentials, with the current tailnet join (REWRITE).

### providers

- `apps/daemon/src/boxes/providers/blacksmith.test.ts` — validate checks the account and the control repo without throwing (REWRITE).
- `apps/daemon/src/boxes/providers/blacksmith.test.ts` — create dispatches a run named orq-<boxId> with only non-secret inputs (REWRITE).
- `apps/daemon/src/boxes/providers/blacksmith.test.ts` — create rents a Linux box (linux-x64 orq-agent, KVM) and a device host that restores the caches (REWRITE).
- `apps/daemon/src/boxes/providers/blacksmith.test.ts` — create re-commits workflows whose content changed before it dispatches (old orgs gain the new inputs) (REWRITE).
- `apps/daemon/src/boxes/providers/blacksmith.test.ts` — dispatchDeviceCacheWarm starts the device-cache workflow; deviceCacheWarmStatus follows it (REWRITE).
- `apps/daemon/src/boxes/providers/blacksmith.test.ts` — status follows the run and its job (REWRITE).
- `apps/daemon/src/boxes/providers/blacksmith.test.ts` — destroy cancels, force-cancels a run that does not stop, and is idempotent (REWRITE).
- `apps/daemon/src/boxes/providers/blacksmith.test.ts` — a run 404 behind a control repo the token cannot see is not gone (REWRITE).
- `apps/daemon/src/boxes/providers/blacksmith.test.ts` — listManaged returns the active orq- runs (REWRITE).
- `apps/daemon/src/boxes/providers/byo.test.ts` — byo: free Linux and macOS machines, no credentials, no lifetime cap, never creates or lists anything (REWRITE).
- `apps/daemon/src/boxes/providers/civo.test.ts` — validate: ok with a working key, Civo's reason for a bad or missing one (REWRITE).
- `apps/daemon/src/boxes/providers/civo.test.ts` — offers: instance sizes with table prices, open regions, Ubuntu 24.04 first (REWRITE).
- `apps/daemon/src/boxes/providers/civo.test.ts` — create: resolves image and network in the region, one POST with hostname, tags and the shell script (REWRITE).
- `apps/daemon/src/boxes/providers/civo.test.ts` — create: a chosen image is looked up by name; an unknown one fails before anything is created (REWRITE).
- `apps/daemon/src/boxes/providers/civo.test.ts` — create: a failed create is never retried and surfaces Civo's reason (REWRITE).
- `apps/daemon/src/boxes/providers/civo.test.ts` — status: maps instance states, not found is gone, 429 is retried (REWRITE).
- `apps/daemon/src/boxes/providers/civo.test.ts` — destroy: deletes the instance in its region and is idempotent (REWRITE).
- `apps/daemon/src/boxes/providers/civo.test.ts` — listManaged: every compute region, pages followed, marked instances only (REWRITE).
- `apps/daemon/src/boxes/providers/cloudrift.test.ts` — cloudrift: validate posts /auth/me with X-API-Key; a bad key never leaks into the message (REWRITE).
- `apps/daemon/src/boxes/providers/cloudrift.test.ts` — cloudrift: offers list GPU variants with a free node, priced from cents (REWRITE).
- `apps/daemon/src/boxes/providers/cloudrift.test.ts` — cloudrift: create rents once with the right driver image, one-line cloud-init command, name and tag (REWRITE).
- `apps/daemon/src/boxes/providers/cloudrift.test.ts` — cloudrift: create fails without a free node and never retries a failed rent (REWRITE).
- `apps/daemon/src/boxes/providers/cloudrift.test.ts` — cloudrift: status by id; a missing instance is gone; Failed carries the user message (REWRITE).
- `apps/daemon/src/boxes/providers/cloudrift.test.ts` — cloudrift: destroy terminates; an empty terminated list is fine when the instance is gone (REWRITE).
- `apps/daemon/src/boxes/providers/cloudrift.test.ts` — cloudrift: listManaged reads live statuses and keeps tagged or orq- named instances (REWRITE).
- `apps/daemon/src/boxes/providers/digitalocean.test.ts` — validate: ok with a working token, the provider's message for a bad or missing one (REWRITE).
- `apps/daemon/src/boxes/providers/digitalocean.test.ts` — offers linux: live prices, available regions only, no GPU or sub-1 GB sizes (REWRITE).
- `apps/daemon/src/boxes/providers/digitalocean.test.ts` — offers linux-gpu: only GPU plans with their GPU, the AI/ML-ready image (REWRITE).
- `apps/daemon/src/boxes/providers/digitalocean.test.ts` — create: registers the box key, one Droplet POST with name, tags, cloud-init and the key (REWRITE).
- `apps/daemon/src/boxes/providers/digitalocean.test.ts` — create linux-gpu: the AI/ML-ready image matching the plan (REWRITE).
- `apps/daemon/src/boxes/providers/digitalocean.test.ts` — create: a failed Droplet create is never retried, surfaces DO's message and removes the key (REWRITE).
- `apps/daemon/src/boxes/providers/digitalocean.test.ts` — status: maps Droplet states, 404 is gone, 429 is retried (REWRITE).
- `apps/daemon/src/boxes/providers/digitalocean.test.ts` — destroy: deletes the Droplet and its key, idempotent on 404 (REWRITE).
- `apps/daemon/src/boxes/providers/digitalocean.test.ts` — destroy: a reconciled Droplet's key is found by the box name (REWRITE).
- `apps/daemon/src/boxes/providers/digitalocean.test.ts` — listManaged: filters by the orquester-box tag and follows pages (REWRITE).
- `apps/daemon/src/boxes/providers/exoscale.test.ts` — validate: ok with a working key, a message for a bad or missing one (REWRITE).
- `apps/daemon/src/boxes/providers/exoscale.test.ts` — offers: Linux types with live prices including the root disk, zones and curated templates (REWRITE).
- `apps/daemon/src/boxes/providers/exoscale.test.ts` — offers: Windows sizes from 4 GB with the licence tier by vCPU count (REWRITE).
- `apps/daemon/src/boxes/providers/exoscale.test.ts` — create: one signed POST with name, labels, base64 cloud-init and the resolved ids (REWRITE).
- `apps/daemon/src/boxes/providers/exoscale.test.ts` — create: Windows gets cloudbase-init user data, the template's disk floor and the generated password (REWRITE).
- `apps/daemon/src/boxes/providers/exoscale.test.ts` — create: polls the operation until it names the instance (REWRITE).
- `apps/daemon/src/boxes/providers/exoscale.test.ts` — create: a failed operation surfaces Exoscale's message (REWRITE).
- `apps/daemon/src/boxes/providers/exoscale.test.ts` — create: a 5xx on the create is never retried; unknown sizes and images fail before it (REWRITE).
- `apps/daemon/src/boxes/providers/exoscale.test.ts` — status: maps instance states in the ref's zone, 404 is gone, 429 is retried (REWRITE).
- `apps/daemon/src/boxes/providers/exoscale.test.ts` — destroy: deletes the instance in its zone and is idempotent (REWRITE).
- `apps/daemon/src/boxes/providers/exoscale.test.ts` — listManaged: every zone, by label or orq- name, with the zone in the ref (REWRITE).
- `apps/daemon/src/boxes/providers/fly.test.ts` — validate: ok with a working token, a message for a bad or missing one (REWRITE).
- `apps/daemon/src/boxes/providers/fly.test.ts` — offers: bundled preset prices per live region, regional groups, curated images (REWRITE).
- `apps/daemon/src/boxes/providers/fly.test.ts` — create: one app and one Machine named after the box, the script delivered as a file (REWRITE).
- `apps/daemon/src/boxes/providers/fly.test.ts` — create: a failed Machine create is not retried and removes the app (REWRITE).
- `apps/daemon/src/boxes/providers/fly.test.ts` — create: a failed app create is not retried; a taken name says so (REWRITE).
- `apps/daemon/src/boxes/providers/fly.test.ts` — create: rejects unknown sizes and invalid app names before any call (REWRITE).
- `apps/daemon/src/boxes/providers/fly.test.ts` — status: maps Machine states, 404 is gone, 429 is retried (REWRITE).
- `apps/daemon/src/boxes/providers/fly.test.ts` — status: without a Machine id, the app's Machine; a deleted app is gone (REWRITE).
- `apps/daemon/src/boxes/providers/fly.test.ts` — destroy: force-deletes the app and is idempotent (REWRITE).
- `apps/daemon/src/boxes/providers/fly.test.ts` — listManaged: the org's orq- apps with their Machine (REWRITE).
- `apps/daemon/src/boxes/providers/gpu-providers.test.ts` — gpu providers: validate with no credentials answers ok:false without a request (REWRITE).
- `apps/daemon/src/boxes/providers/hetzner.test.ts` — validate: ok with a working token, a message for a bad or missing one (REWRITE).
- `apps/daemon/src/boxes/providers/hetzner.test.ts` — offers: live sizes per available location with the IPv4 price, converted from EUR (REWRITE).
- `apps/daemon/src/boxes/providers/hetzner.test.ts` — create: one POST with name, labels and cloud-init; price for the chosen location (REWRITE).
- `apps/daemon/src/boxes/providers/hetzner.test.ts` — create: a regional size id is sent as the plain server type (REWRITE).
- `apps/daemon/src/boxes/providers/hetzner.test.ts` — create: a failed create is never retried and surfaces Hetzner's message (REWRITE).
- `apps/daemon/src/boxes/providers/hetzner.test.ts` — status: maps server states, 404 is gone, 429 is retried (REWRITE).
- `apps/daemon/src/boxes/providers/hetzner.test.ts` — destroy: deletes the server and is idempotent (REWRITE).
- `apps/daemon/src/boxes/providers/hetzner.test.ts` — listManaged: filters by the orquester-box label and follows pages (REWRITE).
- `apps/daemon/src/boxes/providers/hyperstack.test.ts` — hyperstack: validate sends the api_key header; a bad key is ok:false (REWRITE).
- `apps/daemon/src/boxes/providers/hyperstack.test.ts` — hyperstack: offers list in-stock GPU flavors priced from the pricebook plus the public IP (REWRITE).
- `apps/daemon/src/boxes/providers/hyperstack.test.ts` — hyperstack: a GPU missing from the pricebook is priced from the bundled table (REWRITE).
- `apps/daemon/src/boxes/providers/hyperstack.test.ts` — hyperstack: create ensures the region environment, imports the box key pair and starts one labelled VM (REWRITE).
- `apps/daemon/src/boxes/providers/hyperstack.test.ts` — hyperstack: a key pair left by an earlier attempt (409) is reused (REWRITE).
- `apps/daemon/src/boxes/providers/hyperstack.test.ts` — hyperstack: a rejected VM create removes the key pair it imported; unknown flavors fail early (REWRITE).
- `apps/daemon/src/boxes/providers/hyperstack.test.ts` — hyperstack: status maps VM states and 404 → gone (REWRITE).
- `apps/daemon/src/boxes/providers/hyperstack.test.ts` — hyperstack: destroy deletes the VM and its key pair, idempotently, retrying after creation settles (REWRITE).
- `apps/daemon/src/boxes/providers/hyperstack.test.ts` — hyperstack: listManaged keeps labelled or orq- named VMs (REWRITE).
- `apps/daemon/src/boxes/providers/hyperstack.test.ts` — hyperstack: helpers pick the newest CUDA image and name environments; 429 is retried (REWRITE).
- `apps/daemon/src/boxes/providers/ionos.test.ts` — validate: ok with a working token, IONOS's message for a bad or missing one (REWRITE).
- `apps/daemon/src/boxes/providers/ionos.test.ts` — offers: curated vCPU sizes at table prices in the vCPU locations the account lists (REWRITE).
- `apps/daemon/src/boxes/providers/ionos.test.ts` — create: a VDC named after the box, labels, a public LAN, then one server with its boot volume and NIC (REWRITE).
- `apps/daemon/src/boxes/providers/ionos.test.ts` — create: an image or size the location cannot serve is refused before anything is created (REWRITE).
- `apps/daemon/src/boxes/providers/ionos.test.ts` — create: the server POST is never retried; a failure deletes the VDC and surfaces IONOS's message (REWRITE).
- `apps/daemon/src/boxes/providers/ionos.test.ts` — create: a failed VDC request deletes the VDC with the request's reason (REWRITE).
- `apps/daemon/src/boxes/providers/ionos.test.ts` — status: maps vmState and metadata.state, 404 is gone, 429 is retried (REWRITE).
- `apps/daemon/src/boxes/providers/ionos.test.ts` — status: a data-center-only ref (from listManaged) is read through the data center; gone only with it (REWRITE).
- `apps/daemon/src/boxes/providers/ionos.test.ts` — destroy: deletes the VDC with everything in it, idempotent on 404 (REWRITE).
- `apps/daemon/src/boxes/providers/ionos.test.ts` — listManaged: VDCs named orq-<boxId>, with their server's state; one without a server is still listed (REWRITE).
- `apps/daemon/src/boxes/providers/jarvislabs.test.ts` — jarvislabs: validate reads the balance on the default host; 403 Not authenticated is ok:false (REWRITE).
- `apps/daemon/src/boxes/providers/jarvislabs.test.ts` — jarvislabs: offers list container GPUs with free devices, live-priced, per region (REWRITE).
- `apps/daemon/src/boxes/providers/jarvislabs.test.ts` — jarvislabs: create uploads the startup script, finds its id, creates once on the region host (REWRITE).
- `apps/daemon/src/boxes/providers/jarvislabs.test.ts` — jarvislabs: a create answered without machine_id fails and removes the script; long names are cut to 40 (REWRITE).
- `apps/daemon/src/boxes/providers/jarvislabs.test.ts` — jarvislabs: status reads users/fetch; success:false (any spelling) means gone (REWRITE).
- `apps/daemon/src/boxes/providers/jarvislabs.test.ts` — jarvislabs: destroy on the region host, tolerating gone instances, then deletes the script (REWRITE).
- `apps/daemon/src/boxes/providers/jarvislabs.test.ts` — jarvislabs: an HTTP-200 error reply is an error, not a gone instance or an empty account (REWRITE).
- `apps/daemon/src/boxes/providers/jarvislabs.test.ts` — jarvislabs: listManaged keeps orq- names with their region (REWRITE).
- `apps/daemon/src/boxes/providers/jarvislabs.test.ts` — jarvislabs: multipart and startup script helpers; GET 429 is retried (REWRITE).
- `apps/daemon/src/boxes/providers/linode.test.ts` — validate: ok with a working token, Linode's reason for a bad or missing one (REWRITE).
- `apps/daemon/src/boxes/providers/linode.test.ts` — offers linux: live prices per regional price, Metadata core regions only, no GPU or accelerated plans (REWRITE).
- `apps/daemon/src/boxes/providers/linode.test.ts` — offers linux-gpu: GPU plans in GPU regions, sold-out regions dropped (REWRITE).
- `apps/daemon/src/boxes/providers/linode.test.ts` — create: one POST with label, tags, base64 cloud-init, the box key and a throwaway root password (REWRITE).
- `apps/daemon/src/boxes/providers/linode.test.ts` — create: a failed create is never retried and surfaces Linode's reasons (REWRITE).
- `apps/daemon/src/boxes/providers/linode.test.ts` — status: maps instance states, 404 is gone, 429 is retried (REWRITE).
- `apps/daemon/src/boxes/providers/linode.test.ts` — destroy: deletes the instance and is idempotent (REWRITE).
- `apps/daemon/src/boxes/providers/linode.test.ts` — listManaged: X-Filter on the tag, pages followed, only marked instances (REWRITE).
- `apps/daemon/src/boxes/providers/massed.test.ts` — massed: validate posts the token check; 401 is ok:false (REWRITE).
- `apps/daemon/src/boxes/providers/massed.test.ts` — massed: offers list GPU products with capacity, their regions and the images (REWRITE).
- `apps/daemon/src/boxes/providers/massed.test.ts` — massed: create registers the box key, launches once with the start command, and prices from inventory (REWRITE).
- `apps/daemon/src/boxes/providers/massed.test.ts` — massed: a refused launch removes the key; the launch is never retried (REWRITE).
- `apps/daemon/src/boxes/providers/massed.test.ts` — massed: status maps booted/booting/terminated and 404 → gone (REWRITE).
- `apps/daemon/src/boxes/providers/massed.test.ts` — massed: destroy terminates and deletes the key; repeated and reconciler destroys succeed (REWRITE).
- `apps/daemon/src/boxes/providers/massed.test.ts` — massed: listManaged keeps orq- names (REWRITE).
- `apps/daemon/src/boxes/providers/massed.test.ts` — massed: helpers parse products and pick the newest Ubuntu; 429 is retried (REWRITE).
- `apps/daemon/src/boxes/providers/morph.test.ts` — validate: ok with a working key, a message for a bad or missing one (REWRITE).
- `apps/daemon/src/boxes/providers/morph.test.ts` — offers: balanced sizes priced in MCUs, one region, live images with the minimal image first (REWRITE).
- `apps/daemon/src/boxes/providers/morph.test.ts` — create: base snapshot by digest, one instance start with the marker, the bootstrap started over exec (REWRITE).
- `apps/daemon/src/boxes/providers/morph.test.ts` — create: reuses the ready snapshot of the size and image (REWRITE).
- `apps/daemon/src/boxes/providers/morph.test.ts` — create: a failed instance start is never retried and surfaces Morph's message (REWRITE).
- `apps/daemon/src/boxes/providers/morph.test.ts` — create: an instance that errors or a failing bootstrap exec is deleted (REWRITE).
- `apps/daemon/src/boxes/providers/morph.test.ts` — create: rejects an unknown size before any call (REWRITE).
- `apps/daemon/src/boxes/providers/morph.test.ts` — status: maps instance states, 404 is gone, 429 is retried (REWRITE).
- `apps/daemon/src/boxes/providers/morph.test.ts` — destroy: deletes the instance, keeps the shared snapshot, and is idempotent (REWRITE).
- `apps/daemon/src/boxes/providers/morph.test.ts` — listManaged: instances with the marker metadata or an orq- name (REWRITE).
- `apps/daemon/src/boxes/providers/oracle.test.ts` — validate: ok with a working key, a message for a bad key, missing fields, malformed input (REWRITE).
- `apps/daemon/src/boxes/providers/oracle.test.ts` — validate: a PEM flattened onto one line still signs (REWRITE).
- `apps/daemon/src/boxes/providers/oracle.test.ts` — offers: flex shape configs per availability domain, live prices, Ubuntu LTS images (REWRITE).
- `apps/daemon/src/boxes/providers/oracle.test.ts` — offers: Windows has no Arm shapes, adds the licence per OCPU, falls back to the price table (REWRITE).
- `apps/daemon/src/boxes/providers/oracle.test.ts` — create: Linux into the existing shared subnet — one signed launch with name, tags, cloud-init and SSH key (REWRITE).
- `apps/daemon/src/boxes/providers/oracle.test.ts` — create: sets up the shared network on first use, waiting for the VCN to become available (REWRITE).
- `apps/daemon/src/boxes/providers/oracle.test.ts` — create: Windows gets cloudbase-init PowerShell user data, a 256 GB boot volume and no SSH key (REWRITE).
- `apps/daemon/src/boxes/providers/oracle.test.ts` — create: an out-of-capacity launch is never retried and surfaces Oracle's message (REWRITE).
- `apps/daemon/src/boxes/providers/oracle.test.ts` — create: refuses bad requests before calling Oracle (REWRITE).
- `apps/daemon/src/boxes/providers/oracle.test.ts` — status: maps lifecycle states, reads the public IP, 404 is gone, 429 is retried (REWRITE).
- `apps/daemon/src/boxes/providers/oracle.test.ts` — status: NotAuthorizedOrNotFound is gone only when the compartment's listing confirms it (REWRITE).
- `apps/daemon/src/boxes/providers/oracle.test.ts` — status: a failing public IP lookup does not fail the status (REWRITE).
- `apps/daemon/src/boxes/providers/oracle.test.ts` — destroy: terminates with the boot volume and is idempotent (REWRITE).
- `apps/daemon/src/boxes/providers/oracle.test.ts` — destroy: a conflict on a running instance still fails (REWRITE).
- `apps/daemon/src/boxes/providers/oracle.test.ts` — listManaged: lists the compartment across pages, keeps marked instances that are not terminated (REWRITE).
- `apps/daemon/src/boxes/providers/ovh.test.ts` — validate: ok with working keys, a message for bad, missing or malformed ones (REWRITE).
- `apps/daemon/src/boxes/providers/ovh.test.ts` — validate: an empty project ID picks the account's only project, and asks when there are several (REWRITE).
- `apps/daemon/src/boxes/providers/ovh.test.ts` — offers (linux): hourly flavors in stock, catalog prices from EUR, one offer per regional price (REWRITE).
- `apps/daemon/src/boxes/providers/ovh.test.ts` — offers (windows): Windows flavors with the licence — per vCore on b3, included in win-* plans (REWRITE).
- `apps/daemon/src/boxes/providers/ovh.test.ts` — offers (GPU kinds): only GPU flavors, described from the catalog (REWRITE).
- `apps/daemon/src/boxes/providers/ovh.test.ts` — offers (ovh-ca): the Canadian endpoint and catalog, CAD converted to USD (REWRITE).
- `apps/daemon/src/boxes/providers/ovh.test.ts` — create (linux): registers the box's SSH key, then one POST with name, flavor, image and raw cloud-init (REWRITE).
- `apps/daemon/src/boxes/providers/ovh.test.ts` — create (windows): no SSH key, cloudbase-init user data, licence in the price (REWRITE).
- `apps/daemon/src/boxes/providers/ovh.test.ts` — create: a regional size id resolves to the flavor of that region; unknown sizes fail before anything is created (REWRITE).
- `apps/daemon/src/boxes/providers/ovh.test.ts` — create: a failed create is never retried, surfaces OVH's message and removes the SSH key (REWRITE).
- `apps/daemon/src/boxes/providers/ovh.test.ts` — create: a quota refusal on the SSH key creates nothing else (REWRITE).
- `apps/daemon/src/boxes/providers/ovh.test.ts` — status: maps instance states, 404 is gone, 429 is retried (REWRITE).
- `apps/daemon/src/boxes/providers/ovh.test.ts` — destroy: deletes the instance and its SSH key, idempotent on 404 (REWRITE).
- `apps/daemon/src/boxes/providers/ovh.test.ts` — listManaged: every orq- instance of the project, with refs destroy can use (REWRITE).
- `apps/daemon/src/boxes/providers/runpod.test.ts` — runpod: validate reads one pod page and maps 401 to ok:false with RunPod's wording (REWRITE).
- `apps/daemon/src/boxes/providers/runpod.test.ts` — runpod: offers list in-stock NVIDIA types per cloud with live prices and their data centers (REWRITE).
- `apps/daemon/src/boxes/providers/runpod.test.ts` — runpod: create sends one POST with name, GPU, cloud, entrypoint and env, and no ports (REWRITE).
- `apps/daemon/src/boxes/providers/runpod.test.ts` — runpod: create pins a data center and never retries (no duplicate rentals) (REWRITE).
- `apps/daemon/src/boxes/providers/runpod.test.ts` — runpod: status maps RUNNING, 404 → gone, and other pod states (REWRITE).
- `apps/daemon/src/boxes/providers/runpod.test.ts` — runpod: destroy is idempotent (204, then 404 resolves too) (REWRITE).
- `apps/daemon/src/boxes/providers/runpod.test.ts` — runpod: listManaged keeps orq- pods, reads the box id from env, and follows the cursor (REWRITE).
- `apps/daemon/src/boxes/providers/scaleway.test.ts` — validate: ok with a working key, a message for a bad key or missing fields (REWRITE).
- `apps/daemon/src/boxes/providers/scaleway.test.ts` — offers: live per-zone prices plus block volume and IPv4, no Windows, GPU or end-of-service types for linux (REWRITE).
- `apps/daemon/src/boxes/providers/scaleway.test.ts` — offers: linux-gpu lists only GPU types with their GPU, a larger root volume and the GPU OS image first (REWRITE).
- `apps/daemon/src/boxes/providers/scaleway.test.ts` — offers: follows X-Total-Count pages of a zone's catalog (REWRITE).
- `apps/daemon/src/boxes/providers/scaleway.test.ts` — create: tagged server on a block root volume, cloud-init as raw user data, then poweron (REWRITE).
- `apps/daemon/src/boxes/providers/scaleway.test.ts` — create: Arm types get the zone's arm64 image; a regional size id is sent as the plain type (REWRITE).
- `apps/daemon/src/boxes/providers/scaleway.test.ts` — create: an image the type cannot boot is refused before anything is created (REWRITE).
- `apps/daemon/src/boxes/providers/scaleway.test.ts` — create: a failed create is never retried and surfaces Scaleway's message (REWRITE).
- `apps/daemon/src/boxes/providers/scaleway.test.ts` — create: a failure after the server exists deletes the stopped server and its volume (REWRITE).
- `apps/daemon/src/boxes/providers/scaleway.test.ts` — status: maps server states, 404 is gone, 429 is retried (REWRITE).
- `apps/daemon/src/boxes/providers/scaleway.test.ts` — status: a box is gone only once its block volume is; a loose volume's ref reads the volume alone (REWRITE).
- `apps/daemon/src/boxes/providers/scaleway.test.ts` — destroy: a loose volume's ref deletes the volume only (REWRITE).
- `apps/daemon/src/boxes/providers/scaleway.test.ts` — destroy: terminates a running server, then deletes its detached block volume (REWRITE).
- `apps/daemon/src/boxes/providers/scaleway.test.ts` — destroy: idempotent when the server and volume are already gone; volumes found on the server are deleted too (REWRITE).
- `apps/daemon/src/boxes/providers/scaleway.test.ts` — listManaged: lists the orquester-box tag in every zone of the project, and tagged volumes no server holds (REWRITE).
- `apps/daemon/src/boxes/providers/tensordock.test.ts` — tensordock: Linux + GPU only, and validate checks the token on /instances (REWRITE).
- `apps/daemon/src/boxes/providers/tensordock.test.ts` — tensordock: offers price the fixed size per location and keep the cheapest per GPU (REWRITE).
- `apps/daemon/src/boxes/providers/tensordock.test.ts` — tensordock: create places on the cheapest location and sends cloud-init, the key and the name once (REWRITE).
- `apps/daemon/src/boxes/providers/tensordock.test.ts` — tensordock: create honours a chosen location, refuses unavailable sizes and never retries (REWRITE).
- `apps/daemon/src/boxes/providers/tensordock.test.ts` — tensordock: status reads the unwrapped instance; 404 → gone; status words map case-insensitively (REWRITE).
- `apps/daemon/src/boxes/providers/tensordock.test.ts` — tensordock: destroy is idempotent (REWRITE).
- `apps/daemon/src/boxes/providers/tensordock.test.ts` — tensordock: listManaged accepts both documented list shapes and keeps orq- names (REWRITE).
- `apps/daemon/src/boxes/providers/thunder.test.ts` — thunder: offers no box kinds and refuses create with the reason, without calling the API (REWRITE).
- `apps/daemon/src/boxes/providers/thunder.test.ts` — thunder: validate lists instances with the bearer token; 401 is ok:false (REWRITE).
- `apps/daemon/src/boxes/providers/thunder.test.ts` — thunder: offers price in-stock specs from the public pricing (REWRITE).
- `apps/daemon/src/boxes/providers/thunder.test.ts` — thunder: status finds the instance by uuid in the list; missing → gone (REWRITE).
- `apps/daemon/src/boxes/providers/thunder.test.ts` — thunder: destroy deletes by the current index and is idempotent (REWRITE).
- `apps/daemon/src/boxes/providers/thunder.test.ts` — thunder: listManaged keeps orq- names with uuid and index; 429 is retried (REWRITE).
- `apps/daemon/src/boxes/providers/upcloud.test.ts` — validate: bearer token or Basic subaccount; a message for bad or missing credentials (REWRITE).
- `apps/daemon/src/boxes/providers/upcloud.test.ts` — offers: current non-GPU plans priced per zone, Cloud Native with its disk, Linux templates (REWRITE).
- `apps/daemon/src/boxes/providers/upcloud.test.ts` — offers: USD accounts are not converted; Windows is refused (REWRITE).
- `apps/daemon/src/boxes/providers/upcloud.test.ts` — create: one POST with title, labels, cloud-init, metadata and the throwaway SSH key (REWRITE).
- `apps/daemon/src/boxes/providers/upcloud.test.ts` — create: a regional Cloud Native size gets its own MaxIOPS disk and the chosen template (REWRITE).
- `apps/daemon/src/boxes/providers/upcloud.test.ts` — create: a 5xx on the create is never retried; unknown plans and templates fail before it (REWRITE).
- `apps/daemon/src/boxes/providers/upcloud.test.ts` — status: maps server states, 404 is gone, 429 is retried (REWRITE).
- `apps/daemon/src/boxes/providers/upcloud.test.ts` — destroy: hard stop, poll until stopped, then delete the server with its storage (REWRITE).
- `apps/daemon/src/boxes/providers/upcloud.test.ts` — destroy: idempotent when the server is already gone, and gives up after its deadline (REWRITE).
- `apps/daemon/src/boxes/providers/upcloud.test.ts` — listManaged: the label filter, paged (REWRITE).
- `apps/daemon/src/boxes/providers/vastai.test.ts` — vastai: validate reads the current user; a bad key is ok:false (REWRITE).
- `apps/daemon/src/boxes/providers/vastai.test.ts` — vastai: offers search verified on-demand single-GPU offers and keep the best price per GPU model (REWRITE).
- `apps/daemon/src/boxes/providers/vastai.test.ts` — vastai: create rents the cheapest matching offer once, with label, onstart and env (REWRITE).
- `apps/daemon/src/boxes/providers/vastai.test.ts` — vastai: create moves to the next offer only when the offer is gone, and never retries a failed rent (REWRITE).
- `apps/daemon/src/boxes/providers/vastai.test.ts` — vastai: onstart is the staged first stage of a real bootstrap, with Tailscale, and fits (REWRITE).
- `apps/daemon/src/boxes/providers/vastai.test.ts` — vastai: create refuses an onstart script over 4048 characters before renting (REWRITE).
- `apps/daemon/src/boxes/providers/vastai.test.ts` — vastai: status maps the instance, and {instances:null} means gone (REWRITE).
- `apps/daemon/src/boxes/providers/vastai.test.ts` — vastai: destroy is idempotent (200, 404, and success:false for a gone instance) (REWRITE).
- `apps/daemon/src/boxes/providers/vastai.test.ts` — vastai: listManaged pages through v1 instances and keeps orq- labels (REWRITE).
- `apps/daemon/src/boxes/providers/vultr.test.ts` — validate: ok with a working key, the provider's message for a bad one (REWRITE).
- `apps/daemon/src/boxes/providers/vultr.test.ts` — offers linux: live plan prices, no GPU, IPv6-only or sub-1 GB plans (REWRITE).
- `apps/daemon/src/boxes/providers/vultr.test.ts` — offers windows: 2 GB minimum and the per-vCPU licence fee from the price table (REWRITE).
- `apps/daemon/src/boxes/providers/vultr.test.ts` — create linux: tags, label, base64 cloud-init, one POST (REWRITE).
- `apps/daemon/src/boxes/providers/vultr.test.ts` — create windows: a boot script carrying the PowerShell bootstrap, the Administrator password kept (REWRITE).
- `apps/daemon/src/boxes/providers/vultr.test.ts` — create windows: the boot script is removed when the instance create fails, and the create is not retried (REWRITE).
- `apps/daemon/src/boxes/providers/vultr.test.ts` — status: installing reads as pending, 404 as gone, 429 retried (REWRITE).
- `apps/daemon/src/boxes/providers/vultr.test.ts` — status: a stopped or suspended instance reads as stopped (REWRITE).
- `apps/daemon/src/boxes/providers/vultr.test.ts` — destroy: deletes the instance and its boot script, idempotently (REWRITE).
- `apps/daemon/src/boxes/providers/vultr.test.ts` — listManaged: tagged or orq- labelled instances, with the boot script of Windows boxes (REWRITE).

### tooling

- `apps/daemon/src/boxes/tooling/provisioner.test.ts` — provision installs the box's release, writes its preload and state, and the preload redirects tsc in the box (REWRITE).
- `apps/daemon/src/boxes/tooling/provisioner.test.ts` — a second provision reuses the cache and installs nothing (REWRITE).
- `apps/daemon/src/boxes/tooling/provisioner.test.ts` — off, a new version, a disconnected box: every box follows the plugin (REWRITE).
- `apps/daemon/src/boxes/tooling/provisioner.test.ts` — failures leave the box as it was and show as the box's status (REWRITE).
- `apps/daemon/src/boxes/tooling/provisioner.test.ts` — a box that is not connected is refused; a set-up project box is provisioned when it connects (REWRITE).
- `apps/daemon/src/boxes/tooling/provisioner.test.ts` — a Windows box: tar.exe, Windows paths only, no chmod, and NODE_OPTIONS with Windows quoting (REWRITE).

### broker-tail

- `apps/daemon/src/boxes/broker/credentials.test.ts` — grants are built field by field: no refresh token, id token or other secret survives (KEEP).
- `apps/daemon/src/boxes/broker/credentials.test.ts` — unusable files give no grant (KEEP).
- `apps/daemon/src/boxes/broker/credentials.test.ts` — codex falls back to the token's chatgpt_account_id claim; unknown expiries are null (KEEP).
- `apps/daemon/src/boxes/broker/credentials.test.ts` — nodeCredentialFiles: missing files read as null, lock ages, and the watch sees a rename-replace (REWRITE).
- `apps/daemon/src/boxes/broker/refresh-scheduling.test.ts` — hostLocalAccountIds leaves out box-project sessions; liveAccountIds still counts them as in use (KEEP).
- `apps/daemon/src/boxes/broker/refresh-scheduling.test.ts` — an account only box chats use is refreshed by the daemon; a host chat on it blocks that (REWRITE).
- `apps/daemon/src/boxes/broker/refresh-scheduling.test.ts` — broker over the real service: concurrent requests and the usage path share one refresh; nothing secret leaves (REWRITE).
- `apps/daemon/src/boxes/broker/refresh-scheduling.test.ts` — invalid_grant: the account is flagged needsReauth and the box gets TOKEN_NEEDS_REAUTH (REWRITE).
- `apps/daemon/src/boxes/broker/refresh-scheduling.test.ts` — a held Claude account whose CLI holds the refresh lock, over real files: the CLI's rename-replace ends the wait (REWRITE).
- `apps/daemon/src/boxes/broker/refresh-scheduling.test.ts` — a held Codex account with nothing usable left is renewed through the real account service (REWRITE).
- `apps/daemon/src/boxes/tailscale/keys.test.ts` — mints a single-use, ephemeral, pre-authorized, tagged key with an API token (REWRITE).
- `apps/daemon/src/boxes/tailscale/keys.test.ts` — an OAuth client gets an access token once and reuses it until it nearly expires (REWRITE).
- `apps/daemon/src/boxes/tailscale/keys.test.ts` — removeNode deletes only tagged devices named orq-<boxId> (REWRITE).
- `apps/daemon/src/boxes/tailscale/keys.test.ts` — unconfigured credentials and API errors fail without leaking secrets (REWRITE).
- `apps/daemon/src/boxes/tailscale/keys.test.ts` — evaluates the tailnet policy (REWRITE).
- `apps/daemon/src/boxes/tailscale/keys.test.ts` — the policy snippet names the alias, IP and ports (KEEP).

- `apps/daemon/src/boxes/bootstrap/bootstrap.test.ts` — validates its input before anything reaches a script (REWRITE: daemon URL command-injection prevention).

All six behavioral-bar requirements and exact610d source identities are inline in [dead-seams-boxes.json](dead-seams-boxes.json); these are disposition overrides, not additional tests.

## Validation

Static syntax/assertion and scoped diff checks passed. No tests, typechecks, builds or timing measurements were run by this workstream while the parent owns the runner. Relevant focused/full gates and the non-mutating URL-policy regression check remain pending. No performance improvement is claimed.

The earlier caller audit missed `hub/hub.ts:196`, which supplies the OIDC verifier's domain clock. That optional `now` port and its implementation have been restored; the existing JWT/rotation tests again explicitly supply fixed/advanced caller clocks. The current root gate owns revalidation.

The backend URL regression was validated by the UI workstream in its exclusive slot: the old-policy loader fails the intended expected-rejection assertion; the current full bootstrap file passes16/16 (946.338ms). Logs: `/tmp/orquester-test-audit/boxes-url-baseline-proof.log` and `boxes-bootstrap-current.log`.
