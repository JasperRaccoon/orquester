import React, { useEffect, useState } from "react";
import { Button } from "./button";
import { useAppStore } from "../../store/app";
import { loadStoredHash, verifyLocalPassword } from "../../lib/auth";

export interface PasswordVerifyProps {
  /** Called once the typed password matches the stored credential hash. */
  onVerified: () => void;
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
 * With no stored hash (local unix-socket desktop — auth is HTTP-only), the
 * gate is inert: it auto-verifies on mount and renders nothing.
 */
export const PasswordVerify: React.FC<PasswordVerifyProps> = ({
  onVerified,
  message,
  autoFocus
}) => {
  const api = useAppStore((s) => s.api);
  const storedHash = api ? loadStoredHash(api.connection.endpoint) : undefined;
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!storedHash) {
      onVerified();
    }
    // Inert-gate auto-pass fires once per mount by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!storedHash) {
    return null;
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
      <Button size="sm" disabled={!value} onClick={submit}>
        Unlock
      </Button>
    </div>
  );
};
