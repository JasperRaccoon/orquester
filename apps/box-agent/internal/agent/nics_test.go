package agent

import (
	"net"
	"reflect"
	"testing"

	"orquester/box-agent/internal/wire"
)

func boolString(b *bool) string {
	if b == nil {
		return "nil"
	}
	if *b {
		return "true"
	}
	return "false"
}

func TestWakeOnProbeParsers(t *testing.T) {
	const ethtoolRoot = "Settings for enp6s0:\n\tSupported ports: [ TP ]\n\tSupports Wake-on: pumbg\n\tWake-on: g\n\tLink detected: yes\n"
	const ethtoolOff = "Settings for enp6s0:\n\tSupports Wake-on: pumbg\n\tWake-on: d\n"
	// Without root ethtool prints no Wake-on line at all.
	const ethtoolUser = "Settings for enp6s0:\n\tSupported ports: [ TP ]\n\tSpeed: 1000Mb/s\n\tLink detected: yes\n"
	const pmset = "System-wide power settings:\nCurrently in use:\n standby              1\n Sleep On Power Button 1\n womp                 1\n hibernatefile        /var/vm/sleepimage\n"
	for name, c := range map[string]struct {
		got  *bool
		want string
	}{
		"ethtool g":       {parseEthtoolWakeOn(ethtoolRoot), "true"},
		"ethtool d":       {parseEthtoolWakeOn(ethtoolOff), "false"},
		"ethtool no root": {parseEthtoolWakeOn(ethtoolUser), "nil"},
		"pmset womp 1":    {parsePmsetWomp(pmset), "true"},
		"pmset no womp":   {parsePmsetWomp("Currently in use:\n standby 1\n"), "nil"},
	} {
		if got := boolString(c.got); got != c.want {
			t.Errorf("%s = %s; want %s", name, got, c.want)
		}
	}
}

func TestMacHardwarePorts(t *testing.T) {
	const out = "\nHardware Port: Ethernet\nDevice: en0\nEthernet Address: 3c:a6:f6:00:00:01\n\nHardware Port: Wi-Fi\nDevice: en1\nEthernet Address: 3c:a6:f6:00:00:02\n\nHardware Port: iPhone USB\nDevice: en5\nEthernet Address: 3c:a6:f6:00:00:03\n\nVLAN Configurations\n===================\n"
	ports := parseHardwarePorts(out)
	if len(ports) != 3 || ports["en0"] != "Ethernet" || ports["en1"] != "Wi-Fi" {
		t.Fatalf("ports = %v", ports)
	}
	if d := macHardwarePortDetail(ports["en0"]); d.skip || boolString(d.wired) != "true" {
		t.Errorf("Ethernet = %+v", d)
	}
	if d := macHardwarePortDetail(ports["en1"]); d.skip || boolString(d.wired) != "false" {
		t.Errorf("Wi-Fi = %+v", d)
	}
	if d := macHardwarePortDetail(ports["en5"]); !d.skip {
		t.Errorf("iPhone USB must not be reported: %+v", d)
	}
}

func TestWindowsAdapters(t *testing.T) {
	const list = `[{"Name":"Ethernet","Mac":"AA-BB-CC-00-11-22","Media":"802.3","Wol":"Enabled"},` +
		`{"Name":"Wi-Fi","Mac":"AA-BB-CC-00-11-33","Media":"Native 802.11","Wol":"Disabled"},` +
		`{"Name":"Bluetooth Network Connection","Mac":"AA-BB-CC-00-11-44","Media":"BlueTooth","Wol":"Unsupported"}]`
	details, ok := parseWindowsAdapters(list)
	if !ok {
		t.Fatal("unreadable")
	}
	eth, wifi, bt := details["aa:bb:cc:00:11:22"], details["aa:bb:cc:00:11:33"], details["aa:bb:cc:00:11:44"]
	if boolString(eth.wired) != "true" || boolString(eth.wol) != "true" {
		t.Errorf("Ethernet = %+v", eth)
	}
	if boolString(wifi.wired) != "false" || boolString(wifi.wol) != "false" {
		t.Errorf("Wi-Fi = %+v", wifi)
	}
	if !bt.skip {
		t.Errorf("Bluetooth must not be reported: %+v", bt)
	}
	// One adapter: Windows PowerShell 5.1 may print a bare object.
	one, ok := parseWindowsAdapters(`{"Name":"Ethernet","Mac":"AA-BB-CC-00-11-22","Media":"802.3","Wol":null}`)
	if !ok || len(one) != 1 || one["aa:bb:cc:00:11:22"].wol != nil {
		t.Errorf("single object = %v, %v", one, ok)
	}
	if _, ok := parseWindowsAdapters("Get-NetAdapter : not recognized"); ok {
		t.Error("an error message must not parse")
	}
}

func TestBuildNicsReportsSubnetBroadcastAndProbeDetails(t *testing.T) {
	mac := func(s string) net.HardwareAddr {
		m, err := net.ParseMAC(s)
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	lan := nicCandidate{
		iface: net.Interface{Name: "lan-test", HardwareAddr: mac("02:00:00:00:00:01")},
		addrs: []net.Addr{
			&net.IPNet{IP: net.ParseIP("fe80::1"), Mask: net.CIDRMask(64, 128)},
			&net.IPNet{IP: net.IPv4(169, 254, 3, 4), Mask: net.CIDRMask(16, 32)},
			&net.IPNet{IP: net.IPv4(192, 168, 1, 23), Mask: net.CIDRMask(24, 32)},
		},
	}
	unplugged := nicCandidate{iface: net.Interface{Name: "aux-test", HardwareAddr: mac("02:00:00:00:00:02")}}
	virtual := nicCandidate{iface: net.Interface{Name: "hidden-test", HardwareAddr: mac("02:00:00:00:00:03")}}
	details := map[string]nicDetail{
		"02:00:00:00:00:01": {wired: boolPtr(true), wol: boolPtr(true)},
		"02:00:00:00:00:02": {wired: boolPtr(false)},
		"02:00:00:00:00:03": {skip: true},
	}
	ip, prefix, broadcast := "192.168.1.23", 24, "192.168.1.255"
	want := []wire.Nic{
		{Name: "aux-test", MAC: "02:00:00:00:00:02", Wired: false},
		{Name: "lan-test", MAC: "02:00:00:00:00:01", IPv4: &ip, PrefixLength: &prefix, Broadcast: &broadcast, Wired: true, WolEnabled: boolPtr(true)},
	}
	if got := buildNics([]nicCandidate{lan, unplugged, virtual}, details); !reflect.DeepEqual(got, want) {
		t.Fatalf("nics = %+v; want %+v", got, want)
	}
	for _, name := range []string{"lo", "tailscale0", "utun3", "docker0", "br-0a1b", "veth12ab", "virbr0", "bridge100", "awdl0", "vEthernet (WSL)", "Tailscale"} {
		if !nicVirtualName.MatchString(name) {
			t.Errorf("%s should be skipped", name)
		}
	}
	for _, name := range []string{"eth0", "enp6s0", "en0", "wlan0", "Ethernet", "Wi-Fi"} {
		if nicVirtualName.MatchString(name) {
			t.Errorf("%s should be reported", name)
		}
	}
}
