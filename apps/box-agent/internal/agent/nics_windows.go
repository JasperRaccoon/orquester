package agent

import (
	"context"
	"os/exec"
	"syscall"
)

// nicVirtual: Windows' physical check is Get-NetAdapter -Physical, in the probe.
func nicVirtual(string) bool { return false }

// nicFastWired guesses by adapter name ("Ethernet", "Wi-Fi") until the probe reads its media type.
func nicFastWired(name string) bool { return !nicWirelessName.MatchString(name) }

// probeNicDetails reads Get-NetAdapter -Physical and Get-NetAdapterPowerManagement.
// Adapters missing from the physical list (virtual switches, VPNs) are skipped.
func probeNicDetails(ctx context.Context, candidates []nicCandidate) map[string]nicDetail {
	out, ok := nicProbe(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", windowsAdapterScript)
	if !ok {
		return nil
	}
	physical, ok := parseWindowsAdapters(out)
	if !ok {
		return nil
	}
	details := map[string]nicDetail{}
	for _, c := range candidates {
		mac := c.iface.HardwareAddr.String()
		detail, found := physical[mac]
		if !found {
			detail.skip = true
		}
		details[mac] = detail
	}
	return details
}

func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}
