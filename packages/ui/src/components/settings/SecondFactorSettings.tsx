import React, { useCallback, useEffect, useState } from "react";
import { Check, Copy, Download, KeyRound, Loader2, ShieldCheck, ShieldOff, X } from "lucide-react";
import QRCode from "qrcode";
import {
  authErrorCodes,
  type AuthSecondFactorProof,
  type AuthSecondFactorSetupResponse,
  type AuthSecondFactorStatusResponse
} from "@orquester/api";
import { useApi } from "../../context/orquester-context";
import { ApiError } from "../../lib/api-client";
import { Button, Modal, ModalCloseButton } from "../ui";
import { CopyButton } from "../agent-chat/primitives/CopyButton";
import { Badge, Notice, SettingRow, SettingsSection } from "./primitives";
import { authErrorCode, ProofPrompt } from "./ProofPrompt";

const dateOf = (iso: string | null): string => {
  const date = iso ? new Date(iso) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleDateString() : "";
};

const timeOf = (iso: string): string => {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : iso;
};

const errorText = (err: unknown, fallback: string): string =>
  (err instanceof ApiError ? err.serverMessage : null) ?? fallback;

/** The `otpauth://` URI as a scannable QR: black on a white quiet zone, so it reads in dark mode too. */
const QrImage: React.FC<{ value: string }> = ({ value }) => {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setSvg(null);
    QRCode.toString(value, { type: "svg", margin: 4, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } })
      .then((out) => {
        if (active) setSvg(out);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [value]);
  return (
    <div className="mx-auto flex h-48 w-48 shrink-0 items-center justify-center rounded-lg bg-white">
      {svg ? (
        <img
          alt="QR code to scan with your authenticator app"
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
          className="h-full w-full [image-rendering:pixelated]"
        />
      ) : (
        <Loader2 size={18} className="animate-spin text-neutral-500" />
      )}
    </div>
  );
};

const downloadCodes = (codes: string[]) => {
  try {
    const text = [
      "Orquester recovery codes",
      "Each code signs you in once in place of an authenticator code.",
      "",
      ...codes,
      ""
    ].join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "orquester-recovery-codes.txt";
    anchor.click();
    URL.revokeObjectURL(url);
  } catch {
    // A blocked download still leaves the codes on screen to copy by hand.
  }
};

/** The new recovery codes, shown once: copy, download, then confirm they are kept. */
const RecoveryCodes: React.FC<{ codes: string[]; onDone: () => void }> = ({ codes, onDone }) => {
  const [copied, setCopied] = useState(false);
  const copyAll = () => {
    navigator.clipboard
      ?.writeText(codes.join("\n"))
      .then(() => setCopied(true))
      .catch(() => undefined);
  };
  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-neutral-400">
        Keep these somewhere safe, away from this device. Each one signs you in once if you lose your authenticator.
        They are not shown again.
      </p>
      <ul
        aria-label="Recovery codes"
        className="grid grid-cols-1 gap-x-4 gap-y-1 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2.5 font-mono text-sm text-neutral-200 min-[360px]:grid-cols-2"
      >
        {codes.map((code) => (
          <li key={code} className="break-all">
            {code}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={copyAll}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy all"}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => downloadCodes(codes)}>
          <Download size={13} />
          Download
        </Button>
        <Button type="button" size="sm" className="ml-auto" onClick={onDone}>
          I've saved these
        </Button>
      </div>
    </div>
  );
};

const ignore = () => undefined;

const DialogFrame: React.FC<{
  title: string;
  icon: React.ReactNode;
  onClose: () => void;
  /** Off while recovery codes are shown once: Escape, Back and the X stay put, so "I've saved these" is the way out. */
  dismissible?: boolean;
  children: React.ReactNode;
}> = ({ title, icon, onClose, dismissible = true, children }) => (
  // Only the explicit controls close it: a stray backdrop tap must not throw away typed proof.
  <Modal open onClose={dismissible ? onClose : ignore} onBackdropClick={ignore} className="max-w-md" ariaLabel={title}>
    <div className="w-full space-y-4 overflow-y-auto p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neutral-800 text-neutral-300">
          {icon}
        </span>
        <p className="min-w-0 flex-1 pt-1.5 text-sm font-medium text-neutral-100">{title}</p>
        {dismissible && <ModalCloseButton onClose={onClose} />}
      </div>
      {children}
    </div>
  </Modal>
);

type SetupStep =
  | { kind: "password"; notice?: string }
  | { kind: "scan"; setup: AuthSecondFactorSetupResponse; notice?: string }
  | { kind: "codes"; codes: string[] };

/**
 * Pairing an authenticator: password (remote only) → scan and confirm a code → the recovery codes.
 * Leaving before the code is confirmed changes nothing (the daemon's pending secret lapses after 10 minutes).
 */
const SetupDialog: React.FC<{
  initial: SetupStep;
  isLocal: boolean;
  onEnabled: () => void;
  onClose: () => void;
}> = ({ initial, isLocal, onEnabled, onClose }) => {
  const api = useApi();
  const [step, setStep] = useState<SetupStep>(initial);

  const start = async (proof: AuthSecondFactorProof) => {
    setStep({ kind: "scan", setup: await api.setupSecondFactor(isLocal ? undefined : proof.password) });
  };

  const confirm = async ({ code }: AuthSecondFactorProof) => {
    try {
      const { recoveryCodes } = await api.enableSecondFactor(code ?? "");
      onEnabled();
      setStep({ kind: "codes", codes: recoveryCodes });
    } catch (err) {
      if (authErrorCode(err) !== authErrorCodes.noPendingSetup) throw err;
      const notice = "Setup timed out. Start again.";
      if (!isLocal) {
        setStep({ kind: "password", notice });
        return;
      }
      setStep({ kind: "scan", setup: await api.setupSecondFactor(), notice: "Setup timed out. Scan this new code." });
    }
  };

  return (
    <DialogFrame
      title="Set up two-step sign-in"
      icon={<ShieldCheck size={15} />}
      onClose={onClose}
      dismissible={step.kind !== "codes"}
    >
      {step.kind === "password" && (
        <>
          {step.notice && <Notice tone="warn">{step.notice}</Notice>}
          <ProofPrompt
            autoFocus
            password
            code={false}
            submitLabel="Continue"
            message="After your password, signing in will also ask for a code from an authenticator app. Enter your password to start."
            failureMessage="Could not start setup."
            onCancel={onClose}
            onSubmit={start}
          />
        </>
      )}
      {step.kind === "scan" && (
        <div className="space-y-4">
          {step.notice && <Notice tone="warn">{step.notice}</Notice>}
          <p className="text-xs leading-relaxed text-neutral-400">
            Scan this with your authenticator app (1Password, Google Authenticator, Authy…).
          </p>
          <QrImage value={step.setup.otpauthUri} />
          <div className="space-y-1">
            <p className="text-[11px] text-neutral-500">Can't scan? Enter this key</p>
            <div className="flex items-start gap-2 rounded-md border border-neutral-800 bg-neutral-950 px-2.5 py-1.5">
              <code className="min-w-0 flex-1 break-all font-mono text-xs text-neutral-200" data-testid="second-factor-secret">
                {step.setup.secret}
              </code>
              <CopyButton value={step.setup.secret} label="Copy key" />
            </div>
          </div>
          <ProofPrompt
            key={step.setup.secret}
            autoFocus
            password={false}
            code
            submitLabel="Turn on"
            message="Then enter the code it shows to confirm."
            failureMessage="Could not turn on two-step sign-in."
            onCancel={onClose}
            onSubmit={confirm}
          />
        </div>
      )}
      {step.kind === "codes" && (
        <>
          <Notice tone="ok" title="Two-step sign-in is on">
            Your other signed-in devices were signed out; API tokens keep working.
          </Notice>
          <RecoveryCodes codes={step.codes} onDone={onClose} />
        </>
      )}
    </DialogFrame>
  );
};

/** New recovery codes or turning the factor off, each behind the owner's proof (remote only). */
const ManageDialog: React.FC<{
  action: "codes" | "disable";
  isLocal: boolean;
  onChanged: () => void;
  onClose: () => void;
}> = ({ action, isLocal, onChanged, onClose }) => {
  const api = useApi();
  const [codes, setCodes] = useState<string[] | null>(null);
  const proofNote = isLocal ? "" : " Enter your password and a code to confirm.";

  const submit = async (proof: AuthSecondFactorProof) => {
    if (action === "codes") {
      const { recoveryCodes } = await api.regenerateRecoveryCodes(proof);
      onChanged();
      setCodes(recoveryCodes);
      return;
    }
    try {
      await api.disableSecondFactor(proof);
    } catch (err) {
      // Already off (another client got there first): the outcome asked for.
      if (authErrorCode(err) !== authErrorCodes.secondFactorDisabled) throw err;
    }
    onChanged();
    onClose();
  };

  return (
    <DialogFrame
      title={action === "codes" ? "New recovery codes" : "Turn off two-step sign-in"}
      icon={action === "codes" ? <KeyRound size={15} /> : <ShieldOff size={15} />}
      onClose={onClose}
      dismissible={codes === null}
    >
      {codes ? (
        <RecoveryCodes codes={codes} onDone={onClose} />
      ) : (
        <ProofPrompt
          autoFocus
          password={!isLocal}
          code={!isLocal}
          danger={action === "disable"}
          submitLabel={action === "codes" ? "Make new codes" : "Turn off"}
          message={
            (action === "codes"
              ? "Your current recovery codes stop working."
              : "Signing in will ask only for your password, and your recovery codes stop working.") + proofNote
          }
          failureMessage={action === "codes" ? "Could not make new recovery codes." : "Could not turn it off."}
          onCancel={onClose}
          onSubmit={submit}
        />
      )}
    </DialogFrame>
  );
};

type Dialog = { kind: "setup"; initial: SetupStep } | { kind: "codes" } | { kind: "disable" };

/**
 * Settings → Server: "Two-step sign-in" — a code from an authenticator app (or a one-time recovery
 * code) after the password on remote sign-in. Over HTTP every change re-asks the password and, once
 * on, a code; over the local socket it does not.
 */
export const SecondFactorSettings: React.FC<{
  /** Turning it on signs every other device out: the device list should reload. */
  onSessionsChanged?: () => void;
}> = ({ onSessionsChanged }) => {
  const api = useApi();
  const isLocal = api.connection.kind === "local";
  const [status, setStatus] = useState<AuthSecondFactorStatusResponse | null>(null);
  // An older daemon without the routes: nothing to show.
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [starting, setStarting] = useState(false);

  const reload = useCallback(async () => {
    try {
      setStatus(await api.secondFactorStatus());
      setUnsupported(false);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setUnsupported(true);
      else setError(errorText(err, "Could not load two-step sign-in."));
    }
  }, [api]);

  useEffect(() => {
    setStatus(null);
    setDialog(null);
    void reload();
  }, [reload]);

  const begin = async () => {
    if (!isLocal) {
      setDialog({ kind: "setup", initial: { kind: "password" } });
      return;
    }
    // No password over the socket: straight to the code to scan.
    setStarting(true);
    setError(null);
    try {
      setDialog({ kind: "setup", initial: { kind: "scan", setup: await api.setupSecondFactor() } });
    } catch (err) {
      if (authErrorCode(err) === authErrorCodes.secondFactorEnabled) void reload();
      else setError(errorText(err, "Could not start setup."));
    } finally {
      setStarting(false);
    }
  };

  const dismissAlert = async () => {
    try {
      await api.dismissSecondFactorAlert();
      setStatus((s) => (s ? { ...s, lastFailedChallenge: null } : s));
    } catch (err) {
      setError(errorText(err, "Could not dismiss the warning."));
    }
  };

  const closeDialog = () => {
    setDialog(null);
    void reload();
  };

  if (unsupported) return null;

  const enabled = status?.enabled ?? false;
  const remaining = status?.recoveryCodesRemaining ?? 0;
  const alert = status?.lastFailedChallenge ?? null;

  return (
    <SettingsSection
      title="Two-step sign-in"
      description="After the password, signing in remotely also asks for a code from an authenticator app."
      actions={status && (enabled ? <Badge tone={status.unavailable ? "danger" : "ok"}>On</Badge> : <Badge>Off</Badge>)}
    >
      {alert && (
        <div className="px-4 py-3">
          <Notice
            tone="warn"
            title="Your password may have leaked"
            action={
              <Button size="sm" variant="ghost" onClick={() => void dismissAlert()}>
                <X size={13} />
                Dismiss
              </Button>
            }
          >
            <p>
              Someone entered your password from <span className="font-mono">{alert.ip}</span> at {timeOf(alert.at)} but
              not a valid code. Change your password.
            </p>
          </Notice>
        </div>
      )}

      {status?.unavailable && (
        <div className="px-4 py-3">
          <Notice tone="danger" title="Two-step sign-in can't be read">
            <p>
              Its file on the server is unreadable, so no password sign-in can finish. Devices already signed in keep
              working. Reset it on the server with <code className="break-all text-neutral-200">./deploy.sh reset-2fa &lt;target&gt;</code>,
              then set it up again.
            </p>
          </Notice>
        </div>
      )}

      {error && (
        <div className="px-4 py-3">
          <Notice tone="danger">{error}</Notice>
        </div>
      )}

      {status === null ? (
        !error && <p className="px-4 py-3.5 text-xs text-neutral-500">Loading…</p>
      ) : !enabled ? (
        <SettingRow
          icon={<ShieldCheck size={14} />}
          label="Authenticator app"
          description="Off: the password alone signs a device in."
        >
          <Button size="sm" variant="outline" disabled={starting} onClick={() => void begin()}>
            {starting && <Loader2 size={13} className="animate-spin" />}
            Set up
          </Button>
        </SettingRow>
      ) : (
        !status.unavailable && (
          <>
            <SettingRow
              icon={<ShieldCheck size={14} />}
              label={status.enabledAt ? `On since ${dateOf(status.enabledAt)}` : "On"}
              description="Signing in asks for your password, then an authenticator or recovery code."
            >
              <Button size="sm" variant="outline" className="text-danger-300" onClick={() => setDialog({ kind: "disable" })}>
                Turn off
              </Button>
            </SettingRow>
            <SettingRow
              icon={<KeyRound size={14} />}
              label={
                <span className="inline-flex flex-wrap items-center gap-2">
                  Recovery codes
                  <Badge tone={remaining <= 3 ? "warn" : "neutral"}>
                    {remaining === 1 ? "1 code left" : `${remaining} codes left`}
                  </Badge>
                </span>
              }
              description={
                remaining <= 3
                  ? "Running low: make new ones before you run out."
                  : "Each signs you in once without your authenticator."
              }
            >
              <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "codes" })}>
                New recovery codes
              </Button>
            </SettingRow>
          </>
        )
      )}

      {dialog?.kind === "setup" && (
        <SetupDialog
          initial={dialog.initial}
          isLocal={isLocal}
          onEnabled={() => {
            void reload();
            onSessionsChanged?.();
          }}
          onClose={closeDialog}
        />
      )}
      {(dialog?.kind === "codes" || dialog?.kind === "disable") && (
        <ManageDialog action={dialog.kind} isLocal={isLocal} onChanged={() => void reload()} onClose={closeDialog} />
      )}
    </SettingsSection>
  );
};
