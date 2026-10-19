import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { useAppStore } from "../../../store/app";
import { boxesErrorText } from "../../../lib/boxes/errors";
import { loadBlacksmithSetup, loadBoxConnection, loadBoxes } from "../../../lib/boxes/store";
import { Button } from "../../ui";
import { Notice, SettingsSection } from "../../settings/primitives";
import { BoxesList } from "./BoxesList";
import { ConnectionCard } from "./ConnectionCard";
import { ProvidersCard } from "./ProvidersCard";

/**
 * The Ephemeral AI VMs plugin's part of its detail panel (spec §2 goal 1, §6,
 * §8.10, §11.3): what it does and, while it is on, the providers (Blacksmith's
 * macOS checklist among them), how boxes reach this server, and every box.
 */
export const BoxesPluginSection: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const api = useAppStore((s) => s.api);
  const connected = useAppStore((s) => s.connectionStatus === "connected");
  const [loadError, setLoadError] = useState<string | null>(null);

  // On open, on a connection switch and after every reconnect (the event stream
  // has no replay); the connection and Blacksmith setup are only read here.
  const load = useCallback(() => {
    if (!api) return;
    setLoadError(null);
    Promise.all([loadBoxes(api), loadBoxConnection(api), loadBlacksmithSetup(api)]).catch((err: unknown) =>
      setLoadError(boxesErrorText(err, "Could not load the plugin's state."))
    );
  }, [api]);

  useEffect(() => {
    if (enabled && connected) load();
  }, [enabled, connected, load]);

  return (
    <>
      <SettingsSection title="How it works">
        <div className="space-y-2 px-4 py-3 text-sm leading-relaxed text-neutral-400">
          <p>
            A project can run on a rented machine — Linux, Linux with a GPU, Windows or macOS — instead of this
            server: choose it under Runs on when you create the project. Its files, terminals, builds and agents run
            there, and the box is destroyed when you delete the project. Agents can also rent a box for a task; you
            approve each one.
          </p>
          <p>
            Provider keys and agent logins stay on this server. Prices are estimates from each provider; boxes bill
            until they are destroyed.
          </p>
        </div>
      </SettingsSection>

      {enabled && (
        <>
          {loadError && (
            <Notice
              tone="danger"
              title="Could not load everything"
              action={
                <Button size="sm" variant="outline" onClick={load}>
                  <RefreshCw size={13} /> Retry
                </Button>
              }
            >
              {loadError}
            </Notice>
          )}
          <ProvidersCard />
          <ConnectionCard />
          <BoxesList />
        </>
      )}
    </>
  );
};
