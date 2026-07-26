import React, { useEffect, useState } from "react";
import { Button } from "./button";
import { useAppStore } from "../../store/app";
import {
  asBcryptHash,
  hashFromCredential,
  loadStoredHash,
  verifyLocalPassword
} from "../../lib/auth";

export interface PasswordVerifyProps {
  /** Called once the typed password matches the stored credential hash. */
  onVerified: () => void;
  /** When given, renders a Cancel button that dismisses the surrounding surface. */
  onCancel?: () => void;
  /** Short explainer shown above the field. */
  message?: string;
  autoFocus?: boolean;
}

/**
 * Retype-the-password gate for "Protect archived data" (spec decision #4/#6).
 * Fully client-side: bcrypt-compares the typed password against the
 * per-endpoint stored hash (the hash embeds its salt) — nothing crosses the
 * wire. Anti-autofill: `autoComplete="new-password"` (the reliable opt-out —
 * `off` is widely ignored for password fields), a non-credential `name`, no
 * surrounding form/username field, and 1Password/LastPass ignore attributes.
 * The typed value lives only in component state.
 *
 * On a LOCAL (unix-socket) connection there is no password at all — auth is
 * HTTP-only — so the gate is inert there: it auto-verifies on mount and renders
 * nothing. On an authenticated connection a missing stored hash is NOT taken as
 * "no auth configured" (that would hand the curtain away after Sign out, or
 * whenever localStorage was cleared/unavailable): the gate fails closed and
 * asks the user to sign in again.
 */
export const PasswordVerify: React.FC<PasswordVerifyProps> = ({
  onVerified,
  onCancel,
  message,
  autoFocus
}) => {
  const api = useAppStore((s) => s.api);
  const isLocal = api?.connection.kind === "local";
  // localStorage first, then the live credential itself (storage can be
  // unavailable, and a seeded remote's credential comes from remotes.json).
  // The cached value is validated exactly like the credential-derived one: an
  // old-bundle/garbage entry must fall through to the live credential instead
  // of shadowing it (bcrypt throws on a non-hash ⇒ the gate would never open).
  const storedHash = api
    ? (asBcryptHash(loadStoredHash(api.connection.endpoint)) ??
      hashFromCredential(api.connection.password))
    : undefined;
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    if (isLocal) {
      onVerified();
    }
    // Inert-gate auto-pass fires once per mount by design.
  }, []);

  if (isLocal) {
    return null;
  }

  if (!storedHash) {
    // Authenticated connection with no credential to compare against (signed
    // out, or storage cleared/unavailable). Never auto-pass here.
    return (
      <div className="space-y-2 px-2 py-1.5">
        <p className="text-xs text-neutral-400">
          Sign in again to unlock this — no stored credential is available on this device.
        </p>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    );
  }

  const submit = () => {
    if (verifyLocalPassword(value, storedHash)) {
      setValue("");
      onVerified();
    } else {
      setValue("");
      setError(true);
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
          setError(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            submit();
          }
        }}
        className="h-8 w-full rounded-md border border-neutral-700 bg-neutral-900 px-2.5 text-sm text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
      />
      {error && <p className="text-xs text-red-400">Wrong password. Try again.</p>}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!value} onClick={submit}>
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
