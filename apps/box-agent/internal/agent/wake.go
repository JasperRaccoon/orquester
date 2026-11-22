package agent

// Wake-on-LAN sender (spec 2026-11-22-tailnet-machines-and-agent-ssh-design.md
// §4.8 item 2): "net.wake" sends the standard magic packet — six 0xFF bytes,
// then the target's MAC sixteen times — as an IPv4 UDP broadcast onto one of
// this machine's own LANs, so the daemon (often elsewhere) can wake a machine
// that sleeps next to this one. The broadcast address must be one of this
// machine's own interfaces': the daemon cannot use a box to send UDP anywhere
// else. Ports 9 (discard) and 7 (echo) are the two NICs listen on; both are
// sent unless one is asked for.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"regexp"
	"syscall"
	"time"

	"orquester/box-agent/internal/wire"
)

// wakeWriteTimeout bounds one packet's send.
const wakeWriteTimeout = 5 * time.Second

// wakeMACPattern is the only accepted MAC spelling: six hex pairs joined by ':'.
var wakeMACPattern = regexp.MustCompile(`^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$`)

// wakeLAN is one of this machine's IPv4 networks that has a broadcast address.
type wakeLAN struct {
	local     net.IP
	broadcast net.IP
}

// wakeLANs lists the machine's LANs (replaced in tests).
var wakeLANs = listWakeLANs

// listWakeLANs is every up, non-loopback interface's IPv4 network with a broadcast address (not /31, /32).
func listWakeLANs() []wakeLAN {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var out []wakeLAN
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&(net.FlagLoopback|net.FlagPointToPoint) != 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, addr := range addrs {
			ipnet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip4, mask := ipnet.IP.To4(), net.IP(ipnet.Mask).To4()
			if ip4 == nil || mask == nil || ip4.IsLinkLocalUnicast() {
				continue
			}
			if ones, _ := net.IPMask(mask).Size(); ones >= 31 {
				continue
			}
			broadcast := make(net.IP, 4)
			for i := range broadcast {
				broadcast[i] = ip4[i] | ^mask[i]
			}
			out = append(out, wakeLAN{local: ip4, broadcast: broadcast})
		}
	}
	return out
}

// parseWakeMAC accepts a unicast MAC as "aa:bb:cc:dd:ee:ff" (either case) and nothing else.
func parseWakeMAC(text string) (net.HardwareAddr, error) {
	if !wakeMACPattern.MatchString(text) {
		return nil, rpcErr("BAD_REQUEST", "mac must be six hex pairs joined by ':' (aa:bb:cc:dd:ee:ff)")
	}
	mac, err := net.ParseMAC(text)
	if err != nil || len(mac) != 6 {
		return nil, rpcErr("BAD_REQUEST", "mac is not a MAC address")
	}
	if bytes.Equal(mac, make(net.HardwareAddr, 6)) || mac[0]&1 == 1 {
		return nil, rpcErr("BAD_REQUEST", "mac must be a network adapter's own (unicast) address")
	}
	return mac, nil
}

// wakeSource is the local address to send from for `broadcast`, which must be one of `lans`' broadcast addresses.
func wakeSource(broadcast string, lans []wakeLAN) (net.IP, net.IP, error) {
	ip := net.ParseIP(broadcast).To4()
	if ip == nil || ip.String() != broadcast {
		return nil, nil, rpcErr("BAD_REQUEST", "broadcast must be an IPv4 address (a.b.c.d)")
	}
	for _, lan := range lans {
		if lan.broadcast.Equal(ip) {
			return lan.local, ip, nil
		}
	}
	return nil, nil, rpcErr("NOT_ON_LAN", fmt.Sprintf("%s is not the broadcast address of any network this machine is on", broadcast))
}

// wakePorts: 0 → both 9 and 7; 7 or 9 → that one.
func wakePorts(port int) ([]int, error) {
	switch port {
	case 0:
		return []int{9, 7}, nil
	case 7, 9:
		return []int{port}, nil
	}
	return nil, rpcErr("BAD_REQUEST", "port must be 7 or 9")
}

// magicPacket is 6 × 0xFF followed by the MAC 16 times (102 bytes).
func magicPacket(mac net.HardwareAddr) []byte {
	packet := bytes.Repeat([]byte{0xff}, 6)
	for range 16 {
		packet = append(packet, mac...)
	}
	return packet
}

// sendMagicPacket sends `packet` from `local` to `dst` over IPv4 UDP with SO_BROADCAST on.
func sendMagicPacket(ctx context.Context, local net.IP, dst *net.UDPAddr, packet []byte) error {
	lc := net.ListenConfig{Control: func(_, _ string, raw syscall.RawConn) error {
		var sockErr error
		if err := raw.Control(func(fd uintptr) { sockErr = setBroadcast(fd) }); err != nil {
			return err
		}
		return sockErr
	}}
	conn, err := lc.ListenPacket(ctx, "udp4", net.JoinHostPort(local.String(), "0"))
	if err != nil {
		return err
	}
	defer conn.Close()
	if err := conn.SetWriteDeadline(time.Now().Add(wakeWriteTimeout)); err != nil {
		return err
	}
	_, err = conn.WriteTo(packet, dst)
	return err
}

// handleNetWake serves "net.wake".
func handleNetWake(ctx context.Context, _ *Agent, _ *Link, raw json.RawMessage) (any, error) {
	p, err := decodeParams[wire.NetWakeParams](raw)
	if err != nil {
		return nil, err
	}
	mac, err := parseWakeMAC(p.MAC)
	if err != nil {
		return nil, err
	}
	ports, err := wakePorts(p.Port)
	if err != nil {
		return nil, err
	}
	local, broadcast, err := wakeSource(p.Broadcast, wakeLANs())
	if err != nil {
		return nil, err
	}
	packet := magicPacket(mac)
	for _, port := range ports {
		if err := sendMagicPacket(ctx, local, &net.UDPAddr{IP: broadcast, Port: port}, packet); err != nil {
			return nil, rpcErr("WAKE_SEND_FAILED", fmt.Sprintf("sending the wake packet to %s port %d failed: %v", broadcast, port, err))
		}
	}
	return nil, nil
}
