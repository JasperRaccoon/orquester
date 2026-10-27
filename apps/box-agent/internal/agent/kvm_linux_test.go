//go:build linux

package agent

import (
	"os"
	"path/filepath"
	"testing"
)

func kvmFixture(t *testing.T, mode os.FileMode) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "kvm")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestKVMUsableOpensTheDeviceReadWrite(t *testing.T) {
	if kvmUsable(filepath.Join(t.TempDir(), "missing"), nil) {
		t.Fatal("a missing /dev/kvm is not usable")
	}
	if !kvmUsable(kvmFixture(t, 0o600), nil) {
		t.Fatal("a read-write device is usable")
	}
	if os.Geteuid() == 0 {
		t.Skip("root opens read-only files read-write")
	}
	if kvmUsable(kvmFixture(t, 0o400), nil) {
		t.Fatal("a read-only device is not usable")
	}
}

func TestKVMUsableForTheWorkUserFollowsTheModeBits(t *testing.T) {
	uid, gid := uint32(os.Getuid()), uint32(os.Getgid())
	other := uid + 1000
	otherGroup := gid + 1000
	cases := []struct {
		name string
		mode os.FileMode
		work workUser
		want bool
	}{
		{"owner rw", 0o600, workUser{uid: uid, gid: otherGroup}, true},
		{"owner read-only, group rw", 0o460, workUser{uid: uid, gid: gid}, false},
		{"group rw (primary)", 0o660, workUser{uid: other, gid: gid}, true},
		{"group rw (supplementary)", 0o660, workUser{uid: other, gid: otherGroup, groups: []uint32{otherGroup + 1, gid}}, true},
		{"group only, not a member", 0o660, workUser{uid: other, gid: otherGroup}, false},
		{"udev rule 0666", 0o666, workUser{uid: other, gid: otherGroup}, true},
		{"others read-only", 0o664, workUser{uid: other, gid: otherGroup}, false},
	}
	for _, c := range cases {
		work := c.work
		if got := kvmUsable(kvmFixture(t, c.mode), &work); got != c.want {
			t.Errorf("%s: kvmUsable = %v, want %v", c.name, got, c.want)
		}
	}
	work := workUser{uid: other, gid: otherGroup}
	if kvmUsable(filepath.Join(t.TempDir(), "missing"), &work) {
		t.Error("a missing device is not usable for the work user")
	}
}

func TestDetectSysInfoReportsKVM(t *testing.T) {
	a := &Agent{}
	info := detectSysInfo(a)
	f, err := os.OpenFile(kvmDevice, os.O_RDWR, 0)
	if err == nil {
		defer f.Close()
	}
	if want := err == nil; info.KVM != want {
		t.Fatalf("sys.kvm = %v, want %v (open /dev/kvm: %v)", info.KVM, want, err)
	}
}
