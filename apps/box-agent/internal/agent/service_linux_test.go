//go:build linux

package agent

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNeedrestartOverrideIsWrittenWhereNeedrestartIsInstalled(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "needrestart")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writeNeedrestartOverride(dir); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "conf.d", "orq-agent.conf")
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := "$nrconf{override_rc}->{qr(^orq-agent\\.service$)} = 0;\n"
	if len(got) < len(want) || string(got[len(got)-len(want):]) != want {
		t.Fatalf("override = %q", got)
	}
}

func TestNeedrestartOverrideIsSkippedWithoutNeedrestart(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "needrestart")
	if err := writeNeedrestartOverride(dir); err != nil {
		t.Fatal(err)
	}
	if pathExists(dir) {
		t.Fatal("created needrestart's config dir on a box without needrestart")
	}
}
