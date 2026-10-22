import React, { useState } from "react";
import { Lock } from "lucide-react";
import { Button, Input, Modal } from "../ui";
import { useAppStore } from "../../store/app";
import { loadStoredUsername } from "../../lib/auth";

/**
 * Sign-in prompt for a password-protected daemon. The password is sent to the
 * daemon's login route once; the daemon answers with a revocable session token,
 * which is all the client stores (with the username, to pre-fill this form).
 */
export const AuthModal: React.FC = () => {
  const connectionId = useAppStore((s) => s.authPrompt?.connectionId);
  // Keyed by connection: each prompt starts from that endpoint's stored username.
  return connectionId ? <SignInForm key={connectionId} connectionId={connectionId} /> : null;
};

const SignInForm: React.FC<{ connectionId: string }> = ({ connectionId }) => {
  const connections = useAppStore((s) => s.connections);
  const requiresUsername = useAppStore((s) => s.authRequiresUsername);
  const authError = useAppStore((s) => s.authError);
  const submitCredentials = useAppStore((s) => s.submitCredentials);
  const connection = connections.find((c) => c.id === connectionId);
  const [username, setUsername] = useState(() => (connection ? loadStoredUsername(connection.endpoint) : undefined) ?? "mapacho");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!password || busy) {
      return;
    }
    setBusy(true);
    await submitCredentials(username, password);
    setBusy(false);
    setPassword("");
  };

  return (
    <Modal
      open
      onClose={() => useAppStore.setState({ authPrompt: null })}
      className="max-w-sm"
    >
      <div className="w-full p-5">
        <div className="mb-3 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-neutral-800 text-neutral-300">
            <Lock size={16} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-neutral-100">Authentication required</p>
            <p className="truncate text-xs text-neutral-500">{connection?.name ?? "Server"}</p>
          </div>
        </div>

        {requiresUsername ? (
          <Input
            autoFocus
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void submit();
              }
            }}
            className="mb-2"
          />
        ) : null}

        <Input
          autoFocus={!requiresUsername}
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              void submit();
            }
          }}
        />

        {authError && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {authError}
          </p>
        )}

        <div className="mt-3 flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => useAppStore.setState({ authPrompt: null })}
          >
            Cancel
          </Button>
          <Button size="sm" disabled={!password || busy} onClick={() => void submit()}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
