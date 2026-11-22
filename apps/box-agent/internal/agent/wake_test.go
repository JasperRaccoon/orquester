package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"testing"
	"time"

	"orquester/box-agent/internal/wire"
)

func TestMagicPacketReachesAUDPListener(t *testing.T) {
	listener, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	mac, err := parseWakeMAC("02:00:5E:10:00:01")
	if err != nil {
		t.Fatal(err)
	}
	dst := listener.LocalAddr().(*net.UDPAddr)
	if err := sendMagicPacket(context.Background(), net.IPv4(127, 0, 0, 1), dst, magicPacket(mac)); err != nil {
		t.Fatal(err)
	}
	if err := listener.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, 512)
	n, _, err := listener.ReadFromUDP(got)
	if err != nil {
		t.Fatal(err)
	}
	want := bytes.Repeat([]byte{0xff}, 6)
	for range 16 {
		want = append(want, 0x02, 0x00, 0x5e, 0x10, 0x00, 0x01)
	}
	if !bytes.Equal(got[:n], want) {
		t.Fatalf("payload = %x; want %x", got[:n], want)
	}
}

func TestNetWakeRefusesWhatIsNotAWakeOntoItsOwnLAN(t *testing.T) {
	saved := wakeLANs
	defer func() { wakeLANs = saved }()
	wakeLANs = func() []wakeLAN {
		return []wakeLAN{{local: net.IPv4(192, 168, 50, 21).To4(), broadcast: net.IPv4(192, 168, 50, 255).To4()}}
	}
	for name, c := range map[string]struct {
		params wire.NetWakeParams
		code   string
	}{
		"dashes":                    {wire.NetWakeParams{MAC: "02-00-5e-10-00-01", Broadcast: "192.168.50.255"}, "BAD_REQUEST"},
		"short":                     {wire.NetWakeParams{MAC: "02:00:5e:10:00", Broadcast: "192.168.50.255"}, "BAD_REQUEST"},
		"eight bytes":               {wire.NetWakeParams{MAC: "02:00:5e:10:00:01:02:03", Broadcast: "192.168.50.255"}, "BAD_REQUEST"},
		"all zero":                  {wire.NetWakeParams{MAC: "00:00:00:00:00:00", Broadcast: "192.168.50.255"}, "BAD_REQUEST"},
		"broadcast mac":             {wire.NetWakeParams{MAC: "ff:ff:ff:ff:ff:ff", Broadcast: "192.168.50.255"}, "BAD_REQUEST"},
		"multicast mac":             {wire.NetWakeParams{MAC: "01:00:5e:10:00:01", Broadcast: "192.168.50.255"}, "BAD_REQUEST"},
		"ipv6":                      {wire.NetWakeParams{MAC: "02:00:5e:10:00:01", Broadcast: "ff02::1"}, "BAD_REQUEST"},
		"leading zeros":             {wire.NetWakeParams{MAC: "02:00:5e:10:00:01", Broadcast: "192.168.050.255"}, "BAD_REQUEST"},
		"another network":           {wire.NetWakeParams{MAC: "02:00:5e:10:00:01", Broadcast: "10.0.0.255"}, "NOT_ON_LAN"},
		"a host, not the broadcast": {wire.NetWakeParams{MAC: "02:00:5e:10:00:01", Broadcast: "192.168.50.21"}, "NOT_ON_LAN"},
		"limited broadcast":         {wire.NetWakeParams{MAC: "02:00:5e:10:00:01", Broadcast: "255.255.255.255"}, "NOT_ON_LAN"},
		"another port":              {wire.NetWakeParams{MAC: "02:00:5e:10:00:01", Broadcast: "192.168.50.255", Port: 53}, "BAD_REQUEST"},
	} {
		raw, _ := json.Marshal(c.params)
		_, err := handleNetWake(context.Background(), nil, nil, raw)
		var rpc *wire.RPCError
		if !errors.As(err, &rpc) || rpc.Code != c.code {
			t.Errorf("%s: err = %v; want code %s", name, err, c.code)
		}
	}
}
