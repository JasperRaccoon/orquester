package agent

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// sysClassNet is where Linux describes network interfaces.
const sysClassNet = "/sys/class/net"

// nicVirtual: a Linux NIC without a backing device (bridges, veths, tunnels) is virtual.
func nicVirtual(name string) bool { return linuxNicVirtual(sysClassNet, name) }

func linuxNicVirtual(root, name string) bool {
	if _, err := os.Stat(root); err != nil {
		// No sysfs (a restricted container): the name filter decides alone.
		return false
	}
	_, err := os.Stat(filepath.Join(root, name, "device"))
	return err != nil
}

// nicFastWired: Ethernet (ARPHRD_ETHER) and not a wireless device.
func nicFastWired(name string) bool { return linuxNicWired(sysClassNet, name) }

func linuxNicWired(root, name string) bool {
	dir := filepath.Join(root, name)
	kind, err := os.ReadFile(filepath.Join(dir, "type"))
	if err != nil {
		return !nicWirelessName.MatchString(name)
	}
	if strings.TrimSpace(string(kind)) != "1" {
		return false
	}
	for _, marker := range []string{"wireless", "phy80211"} {
		if _, err := os.Stat(filepath.Join(dir, marker)); err == nil {
			return false
		}
	}
	return true
}

// probeNicDetails asks ethtool for each NIC's Wake-on setting (unknown
// without ethtool, or when it needs root to say).
func probeNicDetails(ctx context.Context, candidates []nicCandidate) map[string]nicDetail {
	ethtool := findEthtool()
	details := map[string]nicDetail{}
	if ethtool == "" {
		return details
	}
	for _, c := range candidates {
		out, _ := nicProbe(ctx, ethtool, c.iface.Name)
		details[c.iface.HardwareAddr.String()] = nicDetail{wol: parseEthtoolWakeOn(out)}
	}
	return details
}

// findEthtool: on PATH, or in the sbin directories a non-root PATH lacks.
func findEthtool() string {
	if path, err := exec.LookPath("ethtool"); err == nil {
		return path
	}
	for _, path := range []string{"/usr/sbin/ethtool", "/sbin/ethtool"} {
		if st, err := os.Stat(path); err == nil && !st.IsDir() {
			return path
		}
	}
	return ""
}

func hideWindow(*exec.Cmd) {}
