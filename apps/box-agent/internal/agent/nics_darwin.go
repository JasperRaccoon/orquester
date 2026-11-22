package agent

import (
	"context"
	"os/exec"
)

// nicVirtual: macOS has no cheap device check; the name filter decides.
func nicVirtual(string) bool { return false }

// nicFastWired guesses by name until networksetup names the hardware port.
func nicFastWired(name string) bool { return !nicWirelessName.MatchString(name) }

// probeNicDetails: networksetup names each device's hardware port (Ethernet,
// Wi-Fi, …); pmset's womp ("Wake for network access") is system-wide.
func probeNicDetails(ctx context.Context, candidates []nicCandidate) map[string]nicDetail {
	var womp *bool
	if out, ok := nicProbe(ctx, "/usr/bin/pmset", "-g"); ok {
		womp = parsePmsetWomp(out)
	}
	var ports map[string]string
	if out, ok := nicProbe(ctx, "/usr/sbin/networksetup", "-listallhardwareports"); ok {
		ports = parseHardwarePorts(out)
	}
	details := map[string]nicDetail{}
	for _, c := range candidates {
		var detail nicDetail
		if port, ok := ports[c.iface.Name]; ok {
			detail = macHardwarePortDetail(port)
		}
		detail.wol = womp
		details[c.iface.HardwareAddr.String()] = detail
	}
	return details
}

func hideWindow(*exec.Cmd) {}
