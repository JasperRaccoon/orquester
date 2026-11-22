package agent

import (
	"os"
	"path/filepath"
	"testing"
)

// Linux classifies NICs from sysfs: a backing device means physical, and
// Ethernet without a wireless marker means wired.
func TestLinuxSysfsClassification(t *testing.T) {
	root := t.TempDir()
	write := func(name, kind string, entries ...string) {
		dir := filepath.Join(root, name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "type"), []byte(kind+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			if err := os.Mkdir(filepath.Join(dir, entry), 0o755); err != nil {
				t.Fatal(err)
			}
		}
	}
	write("enp6s0", "1", "device")
	write("wlp2s0", "1", "device", "wireless")
	write("br0", "1")
	write("ib0", "32", "device")
	for name, want := range map[string][2]bool{
		// name: {virtual, wired}
		"enp6s0": {false, true},
		"wlp2s0": {false, false},
		"br0":    {true, true},
		"ib0":    {false, false},
	} {
		if got := linuxNicVirtual(root, name); got != want[0] {
			t.Errorf("%s virtual = %v", name, got)
		}
		if got := linuxNicWired(root, name); got != want[1] {
			t.Errorf("%s wired = %v", name, got)
		}
	}
	if linuxNicVirtual(filepath.Join(root, "missing"), "eth0") {
		t.Error("without sysfs the name filter must decide alone")
	}
}
