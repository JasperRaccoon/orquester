import React, { useEffect, useState } from "react";
import { KeyRound, Loader2, Network, Power, ShieldAlert, Terminal, Trash2 } from "lucide-react";
import { EPHEMERAL_VMS_PLUGIN_ID, MACHINE_OS_LABELS, type MachineProblem, type MachineSshHostKey, type MachineSummary, type MachineVisibility } from "@orquester/api";

import { boxesErrorText } from "../../lib/boxes/errors";
import { loadMachines, pairMachineOverSsh, removeMachine, updateMachine, useMachinesState, wakeMachine } from "../../lib/machines/store";
import { isGlobalPluginEnabled } from "../../lib/plugins-state";
import { useAppStore } from "../../store/app";
import { Button, ConfirmDialog, Input, Modal, ModalCloseButton, Switch } from "../ui";
import { Badge, EmptyState, FormField, Notice, SegmentedControl, SettingsCard, SettingsPage, SettingsSection } from "./primitives";
import {
  CAPABILITY_OPTIONS,
  canPairOverSsh,
  canRemove,
  canWake,
  wakeResultView,
  wakeSenderName,
  EMPTY_PAIR_FORM,
  machineStateView,
  pairRequestOf,
  showsRootWarning,
  VISIBILITY_OPTIONS,
  type PairForm
} from "./machines-settings.logic";

/**
 * Settings → Machines (tailnet machines spec 2026-11-22 §4.1, §6): every machine on this server's
 * tailnet and every paired machine, with the owner's visibility and capability choices, Pair over
 * SSH, Wake and Remove. Discovery needs no plugin; pairing needs Ephemeral AI VMs. Live through
 * `machines.changed`; the daemon enforces every choice made here.
 */
export const MachinesSettings: React.FC = () => {
  const api = useAppStore((s) => s.api);
  const openSettings = useAppStore((s) => s.openSettings);
  const pairingOn = useAppStore((s) => isGlobalPluginEnabled(s.plugins, EPHEMERAL_VMS_PLUGIN_ID));
  const { machines, problems } = useMachinesState();
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    setLoadError(null);
    loadMachines(api, controller.signal).catch((err) => {
      if (!controller.signal.aborted) setLoadError(boxesErrorText(err, "Could not load the machines."));
    });
    return () => controller.abort();
  }, [api]);

  const self = machines?.find((machine) => machine.self) ?? null;
  const others = machines?.filter((machine) => !machine.self) ?? [];

  return (
    <SettingsPage
      title="Machines"
      description="Every machine on this server's tailnet, and the machines you paired. Choose, per machine, whether agents may use it and for what."
    >
      {problems.map((problem) => (
        <ProblemNotice key={`${problem.code}:${problem.message}`} problem={problem} tone="warn" />
      ))}
      {loadError && <Notice tone="danger" title="Machines could not be loaded">{loadError}</Notice>}
      {!pairingOn && (
        <Notice
          tone="info"
          title="Pairing needs the Ephemeral AI VMs plugin"
          action={
            <Button size="sm" variant="outline" onClick={() => openSettings("plugins")}>
              Open Plugins
            </Button>
          }
        >
          Machines are listed and their settings saved without it; Pair over SSH needs it turned on.
        </Notice>
      )}
      <SettingsSection
        title="Your tailnet"
        description="Hidden is not a security boundary: agents run as Orquester's user, so `tailscale` and `ssh` still reach your tailnet when you ask a chat to use them. Use Tailscale ACLs to isolate a machine."
      >
        {machines === null ? (
          loadError ? null : (
            <div className="flex items-center gap-2 px-4 py-6 text-sm text-neutral-500">
              <Loader2 size={14} className="animate-spin" /> Loading machines…
            </div>
          )
        ) : others.length === 0 ? (
          <EmptyState
            icon={<Network size={18} />}
            title="No other machines"
            description="Machines on this server's Tailscale tailnet, and machines you pair, appear here."
          />
        ) : (
          <ul aria-label="Machines" className="space-y-3">
            {others.map((machine) => (
              <MachineCard key={machine.id} machine={machine} pairingOn={pairingOn} />
            ))}
          </ul>
        )}
      </SettingsSection>
      {self && (
        <SettingsSection title="This server" description="The machine Orquester runs on. Agents always work here; it has no settings.">
          <SettingsCard>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
              <p className="text-sm text-neutral-100">{self.name}</p>
              <p className="text-xs text-neutral-500">
                {MACHINE_OS_LABELS[self.os]}
                {self.dnsName ? ` · ${self.dnsName}` : ""}
              </p>
            </div>
          </SettingsCard>
        </SettingsSection>
      )}
    </SettingsPage>
  );
};

const ProblemNotice: React.FC<{ problem: MachineProblem; tone?: "warn" | "danger" }> = ({ problem, tone = "warn" }) => (
  <Notice tone={tone} title={problem.message}>
    {problem.fix && <span className="whitespace-pre-wrap break-words">Fix: {problem.fix}</span>}
  </Notice>
);

const MachineCard: React.FC<{ machine: MachineSummary; pairingOn: boolean }> = ({ machine, pairingOn }) => {
  const api = useAppStore((s) => s.api);
  const { machines } = useMachinesState();
  const wakeVia = wakeSenderName(machine.wake.via, machines);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const state = machineStateView(machine);
  const visibility = VISIBILITY_OPTIONS.find((option) => option.value === machine.visibility)!;
  const tailnetName = machine.dnsName ?? machine.hostname;
  const hidden = machine.visibility === "hidden";

  const run = async (what: string, action: () => Promise<void>, fallback: string) => {
    if (!api) return;
    setBusy(what);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setError(boxesErrorText(err, fallback));
    } finally {
      setBusy(null);
    }
  };

  return (
    <li aria-label={machine.name} className="rounded-lg border border-neutral-800 bg-neutral-900/40">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3">
        <div className="min-w-0 flex-1 basis-56">
          <p className="truncate text-sm text-neutral-100" title={machine.name}>
            {machine.name}
          </p>
          <p className="truncate text-xs text-neutral-500" title={tailnetName ?? undefined}>
            {MACHINE_OS_LABELS[machine.os]}
            {tailnetName ? ` · ${tailnetName}` : " · not on the tailnet"}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Badge tone={state.tone}>{state.label}</Badge>
          {canWake(machine) && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              aria-label={`Wake ${machine.name}`}
              title={wakeVia ? `Sends a Wake-on-LAN packet through ${wakeVia}, on the same network.` : "Sends a Wake-on-LAN packet from another machine on the same network."}
              onClick={() =>
                void run(
                  "wake",
                  async () => {
                    const view = wakeResultView(await wakeMachine(api!, machine.id), machine, machines);
                    if (view.sent) setNotice(view.text);
                    else setError(view.text);
                  },
                  "Could not wake the machine."
                )
              }
            >
              {busy === "wake" ? <Loader2 size={12} className="animate-spin" /> : <Power size={12} />} Wake
            </Button>
          )}
          {canPairOverSsh(machine) && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null || !pairingOn}
              title={pairingOn ? undefined : "Turn on Ephemeral AI VMs in Settings → Plugins to pair machines."}
              aria-label={`Pair ${machine.name} over SSH`}
              onClick={() => setPairing(true)}
            >
              <Terminal size={12} /> Pair over SSH
            </Button>
          )}
          {canRemove(machine) && (
            <Button size="sm" variant="outline" disabled={busy !== null} aria-label={`Remove ${machine.name}`} onClick={() => setConfirmRemove(true)}>
              {busy === "remove" ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Remove
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-3 border-t border-neutral-800/80 px-4 py-3">
        <div className="space-y-1.5">
          <SegmentedControl<MachineVisibility>
            ariaLabel={`Who may use ${machine.name}`}
            value={machine.visibility}
            options={VISIBILITY_OPTIONS.map((option) => ({ value: option.value, label: option.label, title: option.explanation }))}
            onChange={(next) => {
              if (next !== machine.visibility) void run("visibility", () => updateMachine(api!, machine.id, { visibility: next }), "Could not change who may use it.");
            }}
          />
          <p className="text-xs text-neutral-500">{visibility.explanation}</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {CAPABILITY_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-start gap-2 text-xs text-neutral-300">
              <Switch
                checked={machine.capabilities[option.value]}
                disabled={busy !== null}
                label={`${option.label} on ${machine.name}`}
                onChange={(on) => void run(option.value, () => updateMachine(api!, machine.id, { capabilities: { [option.value]: on } }), "Could not change the setting.")}
              />
              <span className="min-w-0">
                <span className={hidden ? "text-neutral-500" : undefined}>{option.label}</span>
                <span className="block text-neutral-600">{option.description}</span>
              </span>
            </label>
          ))}
        </div>
        {hidden && <p className="text-xs text-neutral-500">While Hidden, none of these is used.</p>}
        {machine.sshAlias && (
          <p className="flex items-center gap-1.5 text-xs text-neutral-400">
            <KeyRound size={12} /> Agents reach it with <code className="rounded bg-neutral-800 px-1 py-px text-neutral-200">ssh {machine.sshAlias}</code>
          </p>
        )}
        {showsRootWarning(machine) && (
          <p className="flex items-start gap-1.5 text-xs text-warn">
            <ShieldAlert size={12} className="mt-px shrink-0" /> Passwordless sudo is on here: agents with SSH on {machine.name} are effectively root.
          </p>
        )}
        {machine.problems.map((problem) => (
          <ProblemNotice key={`${problem.code}:${problem.message}`} problem={problem} />
        ))}
        {notice && <p className="break-words text-xs text-neutral-400">{notice}</p>}
        {error && <p className="break-words text-xs text-danger">{error}</p>}
      </div>

      {pairing && <PairOverSshDialog machine={machine} onClose={() => setPairing(false)} />}
      <ConfirmDialog
        open={confirmRemove}
        title={`Remove ${machine.name}?`}
        message={
          machine.state === "ready"
            ? "Its orq-agent removes its own service and stops, its credential is revoked and every key or alias Orquester added for it goes. Its tailnet entry stays here, Hidden."
            : "It is not connected, so it can't uninstall itself: its credential is revoked now. Run `orq-agent uninstall-service` on it to remove the service."
        }
        confirmLabel="Remove"
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false);
          void run(
            "remove",
            async () => {
              const result = await removeMachine(api!, machine.id);
              if (!result.uninstalled) setNotice("Removed. Run `orq-agent uninstall-service` on the machine to remove its service.");
              for (const problem of result.problems) setError(`${problem.message}${problem.fix ? ` ${problem.fix}` : ""}`);
            },
            "Could not remove the machine."
          );
        }}
      />
    </li>
  );
};

type PairStep = { kind: "form" } | { kind: "confirm"; hostKey: MachineSshHostKey } | { kind: "pairing" } | { kind: "failed"; problem: MachineProblem };

/**
 * Pair over SSH: the connection overrides (blank: this server's SSH setup), then the host key to
 * confirm when the server does not know it, then the bootstrap's progress or its named problem.
 * The machine turns Ready live once its orq-agent connects.
 */
const PairOverSshDialog: React.FC<{ machine: MachineSummary; onClose: () => void }> = ({ machine, onClose }) => {
  const api = useAppStore((s) => s.api);
  const [form, setForm] = useState<PairForm>(EMPTY_PAIR_FORM);
  const [step, setStep] = useState<PairStep>({ kind: "form" });
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<{ error: string; field: keyof PairForm } | null>(null);
  const live = useMachinesState().machines?.find((entry) => entry.id === machine.id) ?? machine;

  const submit = async (acceptHostKeyFingerprint?: string) => {
    if (!api) return;
    const parsed = pairRequestOf(form);
    if ("error" in parsed) {
      setFormError(parsed);
      return;
    }
    setFormError(null);
    setBusy(true);
    try {
      const answer = await pairMachineOverSsh(api, machine.id, { ...parsed.request, ...(acceptHostKeyFingerprint ? { acceptHostKeyFingerprint } : {}) });
      if (answer.status === "confirm-host-key") setStep({ kind: "confirm", hostKey: answer.hostKey });
      else if (answer.status === "pairing") setStep({ kind: "pairing" });
      else setStep({ kind: "failed", problem: answer.problem });
    } catch (err) {
      setStep({ kind: "failed", problem: { code: "pair-bootstrap-failed", machineId: machine.id, message: boxesErrorText(err, "Pairing could not start.") } });
    } finally {
      setBusy(false);
    }
  };

  const field = (key: keyof PairForm, label: string, hint: string, placeholder: string) => (
    <FormField label={label} hint={formError?.field === key ? <span className="text-danger">{formError.error}</span> : hint} htmlFor={`pair-${key}`}>
      <Input
        id={`pair-${key}`}
        value={form[key]}
        placeholder={placeholder}
        aria-invalid={formError?.field === key}
        disabled={busy}
        onChange={(event) => setForm({ ...form, [key]: event.target.value })}
      />
    </FormField>
  );

  return (
    <Modal open onClose={onClose} className="max-w-xl">
      <div className="flex items-start justify-between gap-3 border-b border-neutral-800 px-5 py-4">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-neutral-100">Pair {machine.name} over SSH</h3>
          <p className="mt-0.5 text-xs text-neutral-500">Orquester connects with this server's SSH setup and installs orq-agent on it. Nothing is ever asked on the machine.</p>
        </div>
        <ModalCloseButton onClose={onClose} />
      </div>
      <div className="space-y-4 px-5 py-4">
        {step.kind === "form" && (
          <>
            <p className="text-xs text-neutral-400">Leave a field blank to use this server's SSH setup (its ~/.ssh/config and ~/.ssh/id_ed25519). What you enter is kept for this machine.</p>
            {machine.os === "windows" && (
              <p className="text-xs text-neutral-400">
                Log in as an administrator of {machine.name}: orq-agent installs a Windows service for shells and files, and a helper that runs in the signed-in user's desktop
                for programs that need the screen or the GPU (Android emulators). Turn on automatic sign-in there so the helper is back after a restart.
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              {field(
                "user",
                "User",
                machine.os === "windows" ? "An administrator account on the machine." : "The account orq-agent runs as there.",
                "your login on the machine"
              )}
              {field("port", "Port", "SSH port on the machine.", "22")}
              {field("identityFile", "Identity file", "Private key path on the Orquester server.", "/home/you/.ssh/id_ed25519")}
              {field("sshAlias", "SSH alias", "A Host from ~/.ssh/config on the Orquester server.", "minipc")}
            </div>
          </>
        )}
        {step.kind === "confirm" && (
          <div className="space-y-2" role="group" aria-label="Confirm the host key">
            <p className="text-sm text-neutral-200">This server has not seen {step.hostKey.host}'s host key before. Pair only if it is the key the machine shows.</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-neutral-800 bg-neutral-950/50 px-3 py-2 text-xs">
              <dt className="text-neutral-500">Type</dt>
              <dd className="text-neutral-200">{step.hostKey.keyType}</dd>
              <dt className="text-neutral-500">Fingerprint</dt>
              <dd className="break-all font-mono text-neutral-100">{step.hostKey.fingerprint}</dd>
            </dl>
            <p className="text-xs text-neutral-500">
              On the machine,{" "}
              <code>
                ssh-keygen -lf {machine.os === "windows" ? "C:\\ProgramData\\ssh\\" : "/etc/ssh/"}ssh_host_{step.hostKey.keyType.replace(/^ssh-|-.*$/g, "") || "ed25519"}_key.pub
              </code>{" "}
              prints it.
            </p>
          </div>
        )}
        {step.kind === "pairing" && (
          <div role="status" className="space-y-2">
            {live.state === "ready" ? (
              <Notice tone="ok" title={`${machine.name} is paired`}>
                It is Ask first until you choose otherwise.
              </Notice>
            ) : (
              <p className="flex items-center gap-2 text-sm text-neutral-300">
                <Loader2 size={14} className="animate-spin" /> orq-agent is starting on {machine.name}; it turns Ready when it connects.
              </p>
            )}
            {live.problems.map((problem) => (
              <ProblemNotice key={`${problem.code}:${problem.message}`} problem={problem} />
            ))}
          </div>
        )}
        {step.kind === "failed" && <ProblemNotice problem={step.problem} tone="danger" />}
      </div>
      <div className="flex justify-end gap-2 border-t border-neutral-800 px-5 py-3">
        {step.kind === "form" && (
          <>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void submit()}>
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Terminal size={12} />} Connect
            </Button>
          </>
        )}
        {step.kind === "confirm" && (
          <>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setStep({ kind: "form" })}>
              Back
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void submit(step.hostKey.fingerprint)}>
              {busy ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />} Trust this key and pair
            </Button>
          </>
        )}
        {step.kind === "failed" && (
          <>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button size="sm" variant="outline" onClick={() => setStep({ kind: "form" })}>
              Change and retry
            </Button>
          </>
        )}
        {step.kind === "pairing" && (
          <Button size="sm" onClick={onClose}>
            {live.state === "ready" ? "Done" : "Close"}
          </Button>
        )}
      </div>
    </Modal>
  );
};
