import React, { useEffect, useState } from "react";
import { Check, CheckCircle2, Copy, Laptop, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { BoxSummary, ByoMachineKind, ByoPairingResponse } from "@orquester/api";

import { copyText } from "../../../lib/clipboard";
import { useAppStore } from "../../../store/app";
import { boxesErrorText } from "../../../lib/boxes/errors";
import { useNow } from "../../../lib/boxes/hooks";
import { addByoMachine, newByoPairing, removeByoMachine, updateByoMachine, useBoxes, useBoxesLoaded } from "../../../lib/boxes/store";
import { Button, ConfirmDialog, Input, Modal, ModalCloseButton, Switch } from "../../ui";
import { Badge, EmptyState, FormField, Notice, SegmentedControl, SettingsSection } from "../../settings/primitives";
import {
  byoMachines,
  byoStatusView,
  byoSubline,
  canHostDevices,
  canRemoveMachine,
  machineNameProblem,
  pairingHint,
  pairingPhase,
  removeMachineText,
  MACHINE_NAME_MAX
} from "./byo.logic";

const KINDS: readonly { value: ByoMachineKind; label: string }[] = [
  { value: "macos", label: "macOS" },
  { value: "linux", label: "Linux" }
];

/** Status pills and the pairing countdown move with a display tick. */
const TICK_MS = 15_000;

/**
 * "Your machines" (Devices phase 3 §2.1): the owner's own always-on Mac or
 * Linux machines. "Add your machine" shows a one-line pairing command and
 * follows it live (waiting → connected); each machine can be marked for device
 * simulators, or removed (it uninstalls its own service when connected).
 */
export const ByoMachinesCard: React.FC = () => {
  const boxes = useBoxes();
  const loaded = useBoxesLoaded();
  const now = useNow(TICK_MS);
  const machines = byoMachines(boxes);
  /** The dialog: a new machine (no pairing yet), or the pairing of one. */
  const [dialog, setDialog] = useState<{ pairing: ByoPairingResponse | null } | null>(null);

  return (
    <SettingsSection
      title="Your machines"
      description="Pair an always-on Mac or Linux machine you own. It is free, projects and approved agent chats can use it, and Orquester never deletes it."
      actions={
        <Button size="sm" variant="outline" onClick={() => setDialog({ pairing: null })}>
          <Plus size={12} /> Add your machine
        </Button>
      }
    >
      {!loaded ? (
        <div className="flex items-center gap-2 px-4 py-6 text-sm text-neutral-500">
          <Loader2 size={14} className="animate-spin" /> Loading machines…
        </div>
      ) : machines.length === 0 ? (
        <EmptyState
          icon={<Laptop size={18} />}
          title="No machines yet"
          description="Add a Mac mini or a Linux server you keep running: one command on it pairs it with this server."
        />
      ) : (
        <ul aria-label="Your machines" className="divide-y divide-neutral-800/80">
          {machines.map((box) => (
            <MachineRow key={box.id} box={box} now={now} onPairing={(pairing) => setDialog({ pairing })} />
          ))}
        </ul>
      )}
      {dialog && <AddMachineDialog initial={dialog.pairing} onClose={() => setDialog(null)} />}
    </SettingsSection>
  );
};

const MachineRow: React.FC<{ box: BoxSummary; now: number; onPairing: (pairing: ByoPairingResponse) => void }> = ({ box, now, onPairing }) => {
  const api = useAppStore((s) => s.api);
  const [busy, setBusy] = useState<"remove" | "pairing" | "devices" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const status = byoStatusView(box, now);
  const name = box.byo?.name ?? box.sizeLabel;

  const run = async (kind: "remove" | "pairing" | "devices", action: () => Promise<void>, fallback: string) => {
    if (!api) return;
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(boxesErrorText(err, fallback));
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1 basis-56">
          <p className="truncate text-sm text-neutral-100" title={name}>
            {name}
          </p>
          <p className="truncate text-xs text-neutral-500">{byoSubline(box)}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Badge tone={status.tone} title={status.title ?? undefined}>
            {status.label}
          </Badge>
          {box.state === "pairing" && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              aria-label={`New pairing command for ${name}`}
              onClick={() => void run("pairing", async () => onPairing(await newByoPairing(api!, box.id)), "Could not make a new pairing command.")}
            >
              {busy === "pairing" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Pairing command
            </Button>
          )}
          {canRemoveMachine(box) && (
            <Button size="sm" variant="outline" disabled={busy !== null} aria-label={`Remove ${name}`} onClick={() => setConfirm(true)}>
              {busy === "remove" ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} {box.state === "pairing" ? "Cancel" : "Remove"}
            </Button>
          )}
        </div>
      </div>
      {canHostDevices(box) && (
        <label className="flex items-center gap-2 text-xs text-neutral-400">
          <Switch
            checked={box.deviceHost === true}
            disabled={busy !== null}
            label={`Use ${name} for device simulators`}
            onChange={(deviceHost) =>
              void run("devices", () => updateByoMachine(api!, box.id, { deviceHost }), "Could not change the setting.")
            }
          />
          Use for device simulators
          <span className="text-neutral-600">({box.kind === "macos" ? "iOS Simulator" : "Android emulator, needs KVM"})</span>
        </label>
      )}
      {notice && <p className="text-xs text-neutral-400">{notice}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
      <ConfirmDialog
        open={confirm}
        title={box.state === "pairing" ? `Cancel pairing ${name}?` : `Remove ${name}?`}
        message={removeMachineText(box)}
        confirmLabel={box.state === "pairing" ? "Cancel pairing" : "Remove"}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          void run(
            "remove",
            async () => {
              const { uninstalled } = await removeByoMachine(api!, box.id);
              if (!uninstalled && box.state !== "pairing") setNotice("Removed. Run `orq-agent uninstall-service` on the machine to remove its service.");
            },
            "Could not remove the machine."
          );
        }}
      />
    </li>
  );
};

/**
 * "Add your machine": the kind and a name, then the one-line command and its
 * live status. `initial`: open straight on an existing pairing (a new command
 * for a machine still pairing).
 */
const AddMachineDialog: React.FC<{ initial: ByoPairingResponse | null; onClose: () => void }> = ({ initial, onClose }) => {
  const api = useAppStore((s) => s.api);
  const boxes = useBoxes();
  const now = useNow(TICK_MS);
  const [kind, setKind] = useState<ByoMachineKind>("macos");
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [pairing, setPairing] = useState<ByoPairingResponse | null>(initial);
  const [busy, setBusy] = useState<"create" | "renew" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const problem = machineNameProblem(name);
  const live = pairing ? boxes.find((box) => box.id === pairing.box.id) : undefined;
  const phase = pairing ? pairingPhase(live, pairing.expiresAt, now) : null;

  const act = async (what: "create" | "renew" | "cancel", action: () => Promise<void>, fallback: string) => {
    if (!api) return;
    setBusy(what);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(boxesErrorText(err, fallback));
    } finally {
      setBusy(null);
    }
  };

  const create = () => {
    setTouched(true);
    if (problem) return;
    void act("create", async () => setPairing(await addByoMachine(api!, { kind, name: name.trim() })), "Could not add the machine.");
  };

  return (
    <Modal open onClose={onClose} className="max-w-xl">
      <div className="flex w-full flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 px-4">
          <span className="text-sm font-medium text-neutral-100">
            {pairing ? `Pair ${pairing.box.byo?.name ?? "your machine"}` : "Add your machine"}
          </span>
          <ModalCloseButton onClose={onClose} />
        </div>
        <div className="space-y-4 p-4">
          {!pairing ? (
            <>
              <FormField label="Kind">
                <SegmentedControl ariaLabel="Machine kind" value={kind} options={KINDS} onChange={setKind} />
              </FormField>
              <FormField
                label="Name"
                htmlFor="byo-machine-name"
                hint={touched && problem ? <span className="text-danger">{problem}</span> : "Shown in lists and on approval cards."}
              >
                <Input
                  id="byo-machine-name"
                  placeholder={kind === "macos" ? "Mac mini" : "Build server"}
                  maxLength={MACHINE_NAME_MAX}
                  value={name}
                  disabled={busy !== null}
                  aria-invalid={touched && problem ? true : undefined}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") create();
                  }}
                />
              </FormField>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
                <Button size="sm" disabled={busy !== null} onClick={create}>
                  {busy === "create" && <Loader2 size={12} className="animate-spin" />} Create pairing command
                </Button>
              </div>
            </>
          ) : (
            <>
              <PairingCommand command={pairing.command} />
              <p className="text-xs leading-relaxed text-neutral-500">{pairingHint(pairing.box.kind === "macos" ? "macos" : "linux")}</p>
              {phase?.kind === "waiting" && (
                <p className="flex items-center gap-2 text-xs text-neutral-400" role="status">
                  <Loader2 size={12} className="animate-spin" /> Waiting for the machine… The command works once, for {phase.expiresInMinutes} more min.
                </p>
              )}
              {phase?.kind === "downloaded" && (
                <p className="flex items-center gap-2 text-xs text-neutral-400" role="status">
                  <Loader2 size={12} className="animate-spin" /> The machine fetched the script; waiting for orq-agent to connect…
                </p>
              )}
              {phase?.kind === "connected" && (
                <Notice tone="ok" title="Connected">
                  {pairing.box.byo?.name ?? "The machine"} is paired{phase.detail ? ` (${phase.detail})` : ""}. Its service starts with the machine.
                </Notice>
              )}
              {phase?.kind === "expired" && <Notice tone="warn" title="The command expired">Make a new one; the old one no longer works.</Notice>}
              {phase?.kind === "gone" && <Notice tone="warn" title="Cancelled">This machine was removed.</Notice>}
              <div className="flex flex-wrap justify-end gap-2">
                {(phase?.kind === "waiting" || phase?.kind === "downloaded" || phase?.kind === "expired") && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(
                        "cancel",
                        async () => {
                          await removeByoMachine(api!, pairing.box.id);
                          onClose();
                        },
                        "Could not cancel the pairing."
                      )
                    }
                  >
                    {busy === "cancel" && <Loader2 size={12} className="animate-spin" />} Cancel pairing
                  </Button>
                )}
                {phase?.kind === "expired" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void act("renew", async () => setPairing(await newByoPairing(api!, pairing.box.id)), "Could not make a new command.")}
                  >
                    {busy === "renew" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} New command
                  </Button>
                )}
                <Button size="sm" variant={phase?.kind === "connected" ? "default" : "outline"} onClick={onClose}>
                  {phase?.kind === "connected" ? <CheckCircle2 size={12} /> : null} {phase?.kind === "connected" ? "Done" : "Close"}
                </Button>
              </div>
            </>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
        </div>
      </div>
    </Modal>
  );
};

/** The one-line command, with Copy. */
const PairingCommand: React.FC<{ command: string }> = ({ command }) => {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-neutral-300">Run this on the machine</span>
        <Button size="sm" variant="ghost" aria-label="Copy the pairing command" onClick={() => void copyText(command).then((ok) => setCopied(ok))}>
          {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-[11px] leading-relaxed text-neutral-200">
        <code>{command}</code>
      </pre>
    </div>
  );
};
