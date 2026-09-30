import React from "react";
import { HostStatusControls, HostStatusView, useHostStatus } from "../system/SystemSettings";
import { SettingsPage } from "./primitives";

/**
 * Settings → Host status: live resources, the daemon's process tree and its
 * listening ports. The polls live in this page (via {@link useHostStatus}), so
 * they run only while it is the page on screen.
 */
export const HostStatusSettings: React.FC = () => {
  const status = useHostStatus();
  return (
    <SettingsPage
      wide
      title="Host status"
      description="The machine the daemon runs on — read live while this page is open."
      actions={<HostStatusControls status={status} />}
    >
      <HostStatusView status={status} />
    </SettingsPage>
  );
};
