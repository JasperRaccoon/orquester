package agent

// NIC report for Wake-on-LAN (spec 2026-11-22-tailnet-machines-and-agent-ssh-design.md
// §4.8 item 1): each physical NIC's MAC, IPv4 subnet and broadcast, whether it
// is wired, and whether wake-on-magic-packet is on. Hello carries the list at
// connect; `sys.nics` follows whenever it changes. Enumerating interfaces is
// instant; the wake-on probes (ethtool, pmset, PowerShell) are slow, so they run
// in the background and are cached, and hello never waits for them.

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os/exec"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"orquester/box-agent/internal/wire"
)

const (
	// nicPollInterval: how often the NIC list is re-read.
	nicPollInterval = 60 * time.Second
	// nicDetailsMaxAge: wired/wake-on details are re-probed this often, or when the NIC set changes.
	nicDetailsMaxAge = 10 * time.Minute
	// nicProbeTimeout bounds one probe command.
	nicProbeTimeout = 20 * time.Second
)

// nicVirtualName matches interfaces that are never a machine's own LAN port:
// tunnels (Tailscale, WireGuard, utun), container and VM bridges and their
// veths, Apple's peer-to-peer links, and Windows' Hyper-V switches.
var nicVirtualName = regexp.MustCompile(`(?i)^(lo|tailscale|utun|wg|tun|tap|zt|docker|br-|bridge|veth|virbr|vnet|vmnet|vboxnet|cni|flannel|cali|kube|lxc|lxd|podman|awdl|llw|anpi|gif|stf|ap\d|ipsec|ppp|isatap|teredo|vethernet|bluetooth)`)

// nicWirelessName: interface or hardware-port names that say Wi-Fi.
var nicWirelessName = regexp.MustCompile(`(?i)(wi-?fi|wlan|wireless|airport|802\.11)`)

// nicCandidate is an interface that may be reported.
type nicCandidate struct {
	iface net.Interface
	addrs []net.Addr
}

// nicDetail is what a platform probe learned about one NIC (by MAC).
type nicDetail struct {
	skip  bool  // not a physical LAN port after all (Windows: not -Physical; Bluetooth)
	wired *bool // nil: keep the fast guess
	wol   *bool // nil: the OS would not say
}

// listNicCandidates enumerates the interfaces worth reporting: with a MAC, not
// loopback or point-to-point, not virtual by name or by the platform's check.
func listNicCandidates() []nicCandidate {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var out []nicCandidate
	for _, iface := range ifaces {
		if iface.Flags&(net.FlagLoopback|net.FlagPointToPoint) != 0 || len(iface.HardwareAddr) != 6 {
			continue
		}
		if nicVirtualName.MatchString(iface.Name) || nicVirtual(iface.Name) {
			continue
		}
		addrs, _ := iface.Addrs()
		out = append(out, nicCandidate{iface: iface, addrs: addrs})
	}
	return out
}

// buildNics turns candidates and probe details into the report, sorted by name.
func buildNics(candidates []nicCandidate, details map[string]nicDetail) []wire.Nic {
	nics := []wire.Nic{}
	for _, c := range candidates {
		mac := c.iface.HardwareAddr.String()
		detail := details[mac]
		if detail.skip {
			continue
		}
		nic := wire.Nic{Name: c.iface.Name, MAC: mac, Wired: nicFastWired(c.iface.Name), WolEnabled: detail.wol}
		if detail.wired != nil {
			nic.Wired = *detail.wired
		}
		nic.IPv4, nic.PrefixLength, nic.Broadcast = nicIPv4(c.addrs)
		nics = append(nics, nic)
	}
	slices.SortFunc(nics, func(a, b wire.Nic) int { return strings.Compare(a.Name, b.Name) })
	return nics
}

// nicIPv4 is the interface's first routable IPv4 address, its prefix length
// and broadcast address (nil for /31 and /32, which have none).
func nicIPv4(addrs []net.Addr) (*string, *int, *string) {
	for _, addr := range addrs {
		ipnet, ok := addr.(*net.IPNet)
		if !ok {
			continue
		}
		ip4 := ipnet.IP.To4()
		if ip4 == nil || ip4.IsLinkLocalUnicast() || ip4.IsLoopback() {
			continue
		}
		mask := net.IP(ipnet.Mask).To4()
		if mask == nil {
			continue
		}
		ones, _ := net.IPMask(mask).Size()
		ip := ip4.String()
		var broadcast *string
		if ones < 31 {
			b := make(net.IP, 4)
			for i := range b {
				b[i] = ip4[i] | ^mask[i]
			}
			value := b.String()
			broadcast = &value
		}
		return &ip, &ones, broadcast
	}
	return nil, nil, nil
}

func boolPtr(v bool) *bool { return &v }

// parseEthtoolWakeOn reads `ethtool <if>`'s "Wake-on:" line (not "Supports
// Wake-on:"): true when it has g (magic packet). Without the line (ethtool
// needs root for it) the answer is unknown.
func parseEthtoolWakeOn(out string) *bool {
	scanner := bufio.NewScanner(strings.NewReader(out))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if value, ok := strings.CutPrefix(line, "Wake-on:"); ok {
			return boolPtr(strings.ContainsRune(strings.TrimSpace(value), 'g'))
		}
	}
	return nil
}

// parsePmsetWomp reads `pmset -g`'s "womp" (Wake for network access).
func parsePmsetWomp(out string) *bool {
	scanner := bufio.NewScanner(strings.NewReader(out))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 2 && fields[0] == "womp" {
			switch fields[1] {
			case "1":
				return boolPtr(true)
			case "0":
				return boolPtr(false)
			}
		}
	}
	return nil
}

// parseHardwarePorts reads `networksetup -listallhardwareports`: device → port name.
func parseHardwarePorts(out string) map[string]string {
	ports := map[string]string{}
	port := ""
	scanner := bufio.NewScanner(strings.NewReader(out))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if value, ok := strings.CutPrefix(line, "Hardware Port:"); ok {
			port = strings.TrimSpace(value)
		} else if value, ok := strings.CutPrefix(line, "Device:"); ok && port != "" {
			ports[strings.TrimSpace(value)] = port
			port = ""
		}
	}
	return ports
}

// macHardwarePortDetail: what a macOS hardware port name says about its NIC.
func macHardwarePortDetail(port string) nicDetail {
	lower := strings.ToLower(port)
	if strings.Contains(lower, "bluetooth") || strings.Contains(lower, "iphone") || strings.Contains(lower, "ipad") {
		return nicDetail{skip: true}
	}
	return nicDetail{wired: boolPtr(!nicWirelessName.MatchString(port))}
}

// windowsAdapterScript lists physical adapters with their media type and
// magic-packet setting as JSON (enum values as strings).
const windowsAdapterScript = `$ErrorActionPreference = 'SilentlyContinue'
$pm = @{}
Get-NetAdapterPowerManagement | ForEach-Object { $pm[$_.Name] = [string]$_.WakeOnMagicPacket }
$list = @(Get-NetAdapter -Physical | ForEach-Object { [pscustomobject]@{ Name = $_.Name; Mac = $_.MacAddress; Media = [string]$_.PhysicalMediaType; Wol = $pm[$_.Name] } })
ConvertTo-Json -InputObject $list -Compress`

type windowsAdapter struct {
	Name  string `json:"Name"`
	Mac   string `json:"Mac"`
	Media string `json:"Media"`
	Wol   string `json:"Wol"`
}

// parseWindowsAdapters reads windowsAdapterScript's output (an array, or one
// object from an older PowerShell) into details by MAC; false when unreadable.
func parseWindowsAdapters(out string) (map[string]nicDetail, bool) {
	out = strings.TrimSpace(out)
	var adapters []windowsAdapter
	if err := json.Unmarshal([]byte(out), &adapters); err != nil {
		var one windowsAdapter
		if err := json.Unmarshal([]byte(out), &one); err != nil {
			return nil, false
		}
		adapters = []windowsAdapter{one}
	}
	details := map[string]nicDetail{}
	for _, adapter := range adapters {
		mac, err := net.ParseMAC(adapter.Mac)
		if err != nil {
			continue
		}
		var detail nicDetail
		media := strings.ToLower(adapter.Media)
		switch {
		case strings.Contains(media, "bluetooth"):
			detail.skip = true
		case media == "802.3":
			detail.wired = boolPtr(true)
		case strings.Contains(media, "802.11") || strings.Contains(media, "wireless"):
			detail.wired = boolPtr(false)
		}
		switch strings.ToLower(adapter.Wol) {
		case "enabled":
			detail.wol = boolPtr(true)
		case "disabled":
			detail.wol = boolPtr(false)
		}
		details[mac.String()] = detail
	}
	return details, true
}

// nicProbe runs a probe command, bounded by ctx and nicProbeTimeout.
func nicProbe(ctx context.Context, name string, args ...string) (string, bool) {
	ctx, cancel := context.WithTimeout(ctx, nicProbeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	hideWindow(cmd)
	out, err := cmd.Output()
	return string(out), err == nil
}

// nicMonitor holds the current NIC list and the cached probe details.
type nicMonitor struct {
	mu         sync.Mutex
	nics       []wire.Nic
	details    map[string]nicDetail
	detailsKey string // the MACs the details were probed for
	detailsAt  time.Time
}

// newNicMonitor starts from the instant part (no probe details yet).
func newNicMonitor() *nicMonitor {
	return &nicMonitor{nics: buildNics(listNicCandidates(), nil)}
}

// snapshot is the current list (nil-safe for agents built without a monitor).
func (m *nicMonitor) snapshot() []wire.Nic {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return slices.Clone(m.nics)
}

// refresh re-reads the interfaces, re-probing details when they are stale.
func (m *nicMonitor) refresh(ctx context.Context) {
	candidates := listNicCandidates()
	macs := make([]string, 0, len(candidates))
	for _, c := range candidates {
		macs = append(macs, c.iface.HardwareAddr.String())
	}
	slices.Sort(macs)
	key := strings.Join(macs, ",")
	m.mu.Lock()
	details := m.details
	fresh := details != nil && key == m.detailsKey && time.Since(m.detailsAt) < nicDetailsMaxAge
	m.mu.Unlock()
	if !fresh {
		details = probeNicDetails(ctx, candidates)
		if details == nil {
			details = map[string]nicDetail{}
		}
	}
	nics := buildNics(candidates, details)
	m.mu.Lock()
	if !fresh {
		m.details, m.detailsKey, m.detailsAt = details, key, time.Now()
	}
	m.nics = nics
	m.mu.Unlock()
}

// watchNics keeps the list current and tells the daemon when it changes.
func (a *Agent) watchNics() {
	if a.nics == nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		<-a.stop
		cancel()
	}()
	for {
		a.nics.refresh(ctx)
		a.publishNics()
		select {
		case <-time.After(nicPollInterval):
		case <-a.stop:
			return
		}
	}
}

// publishNics sends `sys.nics` on the live link when its list differs from
// what that link's daemon last heard.
func (a *Agent) publishNics() {
	if a.nics == nil {
		return
	}
	if link := a.currentLink(); link != nil {
		link.syncNics(a.nics.snapshot())
	}
}

func (l *Link) syncNics(nics []wire.Nic) {
	l.nicsMu.Lock()
	defer l.nicsMu.Unlock()
	if len(nics) == 0 && len(l.sentNics) == 0 || reflect.DeepEqual(nics, l.sentNics) {
		return
	}
	if nics == nil {
		nics = []wire.Nic{}
	}
	if err := l.SendEvent(wire.NicsEventName, wire.NicsEvent{Nics: nics}); err == nil {
		l.sentNics = nics
	}
}
