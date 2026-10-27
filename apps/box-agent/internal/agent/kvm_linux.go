//go:build linux

package agent

import (
	"os"

	"golang.org/x/sys/unix"
)

// kvmDevice is the KVM device Android emulators open.
const kvmDevice = "/dev/kvm"

// detectKVM: /dev/kvm exists and the account processes run as can open it
// read-write (orq-agent itself, or the work user when one is set).
func detectKVM(work *workUser) bool {
	return kvmUsable(kvmDevice, work)
}

// kvmUsable checks path for read-write access. Without a work user it opens
// the device (opening /dev/kvm creates nothing; only its ioctls do). With
// one, orq-agent runs as root, so access is decided from the mode bits for
// the work user's uid and groups, as the kernel would (ACLs aside).
func kvmUsable(path string, work *workUser) bool {
	if work == nil {
		f, err := os.OpenFile(path, os.O_RDWR, 0)
		if err != nil {
			return false
		}
		_ = f.Close()
		return true
	}
	var st unix.Stat_t
	if err := unix.Stat(path, &st); err != nil {
		return false
	}
	const rw = 0o6
	mode := st.Mode
	switch {
	case work.uid == st.Uid:
		return (mode>>6)&rw == rw
	case work.inGroup(st.Gid):
		return (mode>>3)&rw == rw
	default:
		return mode&rw == rw
	}
}

func (w *workUser) inGroup(gid uint32) bool {
	if w.gid == gid {
		return true
	}
	for _, g := range w.groups {
		if g == gid {
			return true
		}
	}
	return false
}
