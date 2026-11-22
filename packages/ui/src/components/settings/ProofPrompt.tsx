import React, { useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { authErrorCodes, type AuthSecondFactorProof } from "@orquester/api";
import { ApiError } from "../../lib/api-client";
import { cn } from "../../lib/cn";
import { Button, Input } from "../ui";
import { FormField } from "./primitives";

type ProofField = "password" | "code";

interface ProofFailure {
  /** The field the message belongs under; null for the form as a whole. */
  field: ProofField | null;
  message: string;
}

const bodyCode = (err: ApiError): string | null => {
  const code = (err.body as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : null;
};

/** The `code` the daemon put in an error body, if any (`NO_PENDING_SETUP`, `SECOND_FACTOR_ENABLED`…). */
export const authErrorCode = (err: unknown): string | null => (err instanceof ApiError ? bodyCode(err) : null);

const waitText = (seconds: number | null): string => {
  const s = seconds ?? 60;
  return s >= 90 ? `${Math.ceil(s / 60)} min` : `${s}s`;
};

/**
 * What a failed proof-gated call means for the form. A wrong proof is a 403 (the session is still
 * good), so nothing here signs the user out.
 */
const proofFailure = (err: unknown, fallback: string): ProofFailure => {
  if (!(err instanceof ApiError)) return { field: null, message: fallback };
  if (err.status === 429) return { field: null, message: `Too many attempts. Try again in ${waitText(err.retryAfterSeconds)}.` };
  const code = bodyCode(err);
  if (code === authErrorCodes.invalidProof) {
    const field = err.serverField === "password" || err.serverField === "code" ? err.serverField : null;
    if (field === "password") return { field, message: "Wrong password." };
    if (field === "code") return { field, message: "That code didn't work." };
  }
  if (code === authErrorCodes.secondFactorUnavailable) {
    return { field: null, message: "Two-step sign-in can't be checked right now: its file on the server is unreadable." };
  }
  return { field: null, message: err.serverMessage ?? fallback };
};

export interface ProofPromptProps {
  /** Which proofs to ask for. Neither (the local socket) leaves a plain confirm. */
  password: boolean;
  code: boolean;
  submitLabel: string;
  /** Shown above the fields. */
  message?: React.ReactNode;
  /** Extra fields of the same form, above the proof (a token's name). Enter in them submits. */
  children?: React.ReactNode;
  /** False keeps the submit button disabled (a required extra field is empty). */
  canSubmit?: boolean;
  danger?: boolean;
  autoFocus?: boolean;
  /** Shown when the call fails for a reason the daemon did not explain. */
  failureMessage?: string;
  onCancel?: () => void;
  /**
   * Runs the gated call. A rejection is shown: under the field the daemon named (`INVALID_PROOF`),
   * as a wait (429), or for the form. Resolve to keep the prompt as it is.
   */
  onSubmit: (proof: AuthSecondFactorProof) => Promise<void>;
}

/**
 * The owner's re-proof for a gated action: the password and, while two-step sign-in is on, a code
 * (an authenticator code or a recovery code). Used by every action the daemon gates on it remotely:
 * starting setup, turning it on, new recovery codes, turning it off, minting an API token.
 */
export const ProofPrompt: React.FC<ProofPromptProps> = ({
  password: askPassword,
  code: askCode,
  submitLabel,
  message,
  children,
  canSubmit = true,
  danger,
  autoFocus,
  failureMessage = "That didn't work. Try again.",
  onCancel,
  onSubmit
}) => {
  const id = useId();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ProofFailure | null>(null);
  // The daemon asked for a code this prompt did not offer (the factor was turned on since).
  const [codeAsked, setCodeAsked] = useState(false);
  const showCode = askCode || codeAsked;

  const ready = canSubmit && (!askPassword || password !== "") && (!showCode || code.trim() !== "") && !busy;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setFailure(null);
    try {
      await onSubmit({
        ...(askPassword ? { password } : {}),
        ...(showCode ? { code: code.trim() } : {})
      });
    } catch (err) {
      const next = proofFailure(err, failureMessage);
      setFailure(next);
      if (next.field === "code") {
        setCode("");
        setCodeAsked(true);
      }
      if (next.field === "password") setPassword("");
    } finally {
      setBusy(false);
    }
  };

  const fieldError = (field: ProofField) =>
    failure?.field === field ? (
      <p id={`${id}-${field}-error`} className="text-[11px] text-danger">
        {failure.message}
      </p>
    ) : null;

  return (
    <form className="space-y-3" onSubmit={(e) => void submit(e)} noValidate>
      {message && <div className="text-xs leading-relaxed text-neutral-400">{message}</div>}
      {children}
      {askPassword && (
        <FormField label="Password" htmlFor={`${id}-password`}>
          <Input
            id={`${id}-password`}
            type="password"
            autoComplete="current-password"
            autoFocus={autoFocus}
            value={password}
            aria-invalid={failure?.field === "password" || undefined}
            aria-describedby={failure?.field === "password" ? `${id}-password-error` : undefined}
            className={cn(failure?.field === "password" && "border-danger")}
            onChange={(e) => setPassword(e.target.value)}
          />
          {fieldError("password")}
        </FormField>
      )}
      {showCode && (
        <FormField
          label="Authentication code"
          htmlFor={`${id}-code`}
          hint="From your authenticator app, or one of your recovery codes."
        >
          <Input
            id={`${id}-code`}
            autoComplete="one-time-code"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus={autoFocus && !askPassword}
            maxLength={64}
            value={code}
            aria-invalid={failure?.field === "code" || undefined}
            aria-describedby={failure?.field === "code" ? `${id}-code-error` : undefined}
            className={cn("font-mono tracking-wider", failure?.field === "code" && "border-danger")}
            onChange={(e) => setCode(e.target.value)}
          />
          {fieldError("code")}
        </FormField>
      )}
      {failure && failure.field === null && (
        <p role="alert" className="text-xs text-danger">
          {failure.message}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {onCancel && (
          <Button type="button" size="sm" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          size="sm"
          disabled={!ready}
          className={cn(
            danger && "bg-danger-600 text-white hover:bg-danger-500",
            danger && "disabled:bg-danger-600/40 disabled:text-white/70"
          )}
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
};
