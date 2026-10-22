import React, { useEffect, useState } from "react";
import { Button } from "./button";
import { useAppStore } from "../../store/app";
import { ApiError } from "../../lib/api-client";

export interface PasswordVerifyProps {
  /** Called once the daemon confirms the typed password. */
  onVerified: () => void;
  /** When given, renders a Cancel button that dismisses the surrounding surface. */
  onCancel?: () => void;
  /** Short explainer shown above the field. */
  message?: string;
  autoFocus?: boolean;
}

/**
 * Retype-the-password gate for "Protect archived data" (spec decision #4/#6).
 * The daemon checks the typed password (`authRoutes.verifyPassword`, throttled
 * like a login), so the client holds nothing that could stand in for it.
 * Anti-autofill: `autoComplete="new-password"` (the reliable opt-out — `off` is
 * widely ignored for password fields), a non-credential `name`, no surrounding
 * form/username field, and 1Password/LastPass ignore attributes. The typed
 * value lives only in component state.
 *
 * On a LOCAL (unix-socket) connection there is no password at all — auth is
 * HTTP-only — so the gate is inert there: it auto-verifies on mount and renders
 * nothing. Anywhere else it fails closed: only the daemon's `ok` opens it.
 */
export const PasswordVerify: React.FC<PasswordVerifyProps> = ({
  onVerified,
  onCancel,
  message,
  autoFocus
}) => {
  const api = useAppStore((s) => s.api);
  const isLocal = api?.connection.kind === "local";
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isLocal) {
      onVerified();
    }
    // Inert-gate auto-pass fires once per mount by design.
  }, []);

  if (isLocal) {
    return null;
  }

  const submit = async () => {
    if (!api || !value || busy) {
      return;
    }
    setBusy(true);
    try {
      const { ok } = await api.verifyPassword(value);
      setValue("");
      if (ok) {
        onVerified();
      } else {
        setError("Wrong password. Try again.");
      }
    } catch (err) {
      setValue("");
      setError(
        err instanceof ApiError && err.status === 429
          ? `Too many failed attempts. Try again in ${err.retryAfterSeconds ?? 60}s.`
          : "Could not check the password. Try again."
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 px-2 py-1.5">
      <p className="text-xs text-neutral-400">{message ?? "Enter your password to continue."}</p>
      <input
        type="password"
        name="orq-verify"
        autoComplete="new-password"
        data-1p-ignore=""
        data-lpignore="true"
        autoFocus={autoFocus}
        placeholder="Password"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            void submit();
          }
        }}
        className="h-8 w-full rounded-md border border-neutral-700 bg-neutral-900 px-2.5 text-sm text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
      />
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!value || busy} onClick={() => void submit()}>
          Unlock
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
};
