//go:build linux

package agent

import (
	"os"
	"path/filepath"
	"strings"
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

func TestOOMPolicyDropInIsWrittenOnce(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "orq-agent.service.d")
	changed, err := writeOOMPolicyDropIn(dir)
	if err != nil || !changed {
		t.Fatalf("first write: changed=%v err=%v", changed, err)
	}
	got, err := os.ReadFile(filepath.Join(dir, "oom-policy.conf"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "[Service]\nOOMPolicy=continue\n") {
		t.Fatalf("drop-in = %q", got)
	}
	// A second start finds it in place and asks for no reload.
	if changed, err := writeOOMPolicyDropIn(dir); err != nil || changed {
		t.Fatalf("second write: changed=%v err=%v", changed, err)
	}
}

func TestServiceDryRunsWriteNothing(t *testing.T) {
	home := t.TempDir()
	dataDir := filepath.Join(t.TempDir(), "data dir")
	t.Setenv("HOME", home)
	// Unset: a dry run on a dev host shows a placeholder instead of failing.
	t.Setenv("ORQ_DAEMON_URL", "")
	t.Setenv("ORQ_BOX_ID", "")
	t.Setenv("ORQ_BOOTSTRAP_TOKEN", "")
	t.Setenv("ORQ_BOOTSTRAP_TOKEN_FILE", "")

	var out strings.Builder
	if err := InstallServiceCommand("test", ServiceOptions{DataDir: dataDir, DryRun: true}, &out); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	for _, want := range []string{
		"nothing is written or run",
		"ORQ_DAEMON_URL is not set",
		"write '" + filepath.Join(dataDir, "agent.env") + "' (mode 0600):",
		"ORQ_DAEMON_URL=<ORQ_DAEMON_URL>\n",
		"# service kind: ",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("install dry run lacks %q:\n%s", want, got)
		}
	}
	out.Reset()
	err := UninstallServiceCommand(ServiceOptions{DataDir: dataDir, DryRun: true}, &out)
	if os.Geteuid() != 0 && pathExists(systemdUnitPath) {
		// A system service belongs to root, even for a dry run. The temporary
		// HOME has no user unit that this caller could uninstall instead.
		const want = "orq-agent is installed as a system service: run `sudo orq-agent uninstall-service`"
		if err == nil || err.Error() != want {
			t.Errorf("uninstall dry run error = %v; want %q", err, want)
		}
		if out.Len() != 0 {
			t.Errorf("refused uninstall dry run printed a plan:\n%s", out.String())
		}
	} else {
		if err != nil {
			t.Errorf("uninstall dry run: %v", err)
		}
		if !strings.Contains(out.String(), "nothing is removed or run") {
			t.Errorf("uninstall dry run:\n%s", out.String())
		}
	}
	if pathExists(dataDir) {
		t.Error("a dry run created the data dir")
	}
	if entries, _ := os.ReadDir(home); len(entries) != 0 {
		t.Errorf("a dry run wrote into HOME: %v", entries)
	}
}
