//go:build !windows

package agent

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// otherOwner is an owner this process may give a file: as root anyone; otherwise
// itself with a supplementary group, which is what shows a chown landed.
func otherOwner(t *testing.T) *workUser {
	t.Helper()
	if os.Geteuid() == 0 {
		return &workUser{uid: 65534, gid: 65534}
	}
	groups, err := os.Getgroups()
	if err != nil {
		t.Fatal(err)
	}
	for _, group := range groups {
		if group != os.Getegid() {
			return &workUser{uid: uint32(os.Geteuid()), gid: uint32(group)}
		}
	}
	t.Skip("needs root or a supplementary group")
	return nil
}

func groupOf(t *testing.T, path string) uint32 {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Sys().(*syscall.Stat_t).Gid
}

func TestEnsurePathNeverChownsThroughASymlink(t *testing.T) {
	work := otherOwner(t)
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "planted")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	before := groupOf(t, target)
	a := &Agent{work: work}
	if err := a.ensurePath(link); err != nil {
		t.Fatal(err)
	}
	if got := groupOf(t, target); got != before {
		t.Fatalf("the symlink's target went to group %d; want it left at %d", got, before)
	}
}

func TestReplacedFileKeepsItsOwnerAndAPlantedSymlinkGivesNone(t *testing.T) {
	work := otherOwner(t)
	dir := t.TempDir()
	temp := func() *os.File {
		f, err := os.CreateTemp(dir, "temp-*")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { f.Close() })
		return f
	}
	a := &Agent{work: &workUser{uid: work.uid, gid: uint32(os.Getegid())}}

	// A file of another owner keeps that owner when it is replaced.
	target := filepath.Join(dir, "login")
	if err := os.WriteFile(target, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(target, int(work.uid), int(work.gid)); err != nil {
		t.Fatal(err)
	}
	f := temp()
	if err := a.ownTemp(f, target); err != nil {
		t.Fatal(err)
	}
	if got := groupOf(t, f.Name()); got != work.gid {
		t.Fatalf("the replacement is in group %d; want the replaced file's %d", got, work.gid)
	}

	// A symlink to that file does not lend its target's owner: the work user gets it.
	link := filepath.Join(dir, "planted")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	f = temp()
	if err := a.ownTemp(f, link); err != nil {
		t.Fatal(err)
	}
	if got := groupOf(t, f.Name()); got != a.work.gid {
		t.Fatalf("the replacement is in group %d; want the work user's %d", got, a.work.gid)
	}
}
