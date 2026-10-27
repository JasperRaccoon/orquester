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
	for _, key := range serviceEnvKeys {
		t.Setenv(key, "")
	}
	tokenFile := filepath.Join(t.TempDir(), "one-time-token")
	const secret = "private-bootstrap-for-dry-run"
	if err := os.WriteFile(tokenFile, []byte(secret+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ORQ_BOOTSTRAP_TOKEN_FILE", tokenFile)

	var out strings.Builder
	if err := InstallServiceCommand("test", ServiceOptions{DataDir: dataDir, DryRun: true}, &out); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{
		"ORQ_DAEMON_URL=<ORQ_DAEMON_URL>",
		"ORQ_BOOTSTRAP_TOKEN_FILE=" + filepath.Join(dataDir, "bootstrap-token"),
		filepath.Join(dataDir, "agent.env"),
	} {
		if !strings.Contains(out.String(), value) {
			t.Errorf("dry run omitted planned configuration %q", value)
		}
	}
	if strings.Contains(out.String(), secret) {
		t.Fatal("dry run revealed the bootstrap credential")
	}
	out.Reset()
	err := UninstallServiceCommand(ServiceOptions{DataDir: dataDir, DryRun: true}, &out)
	_, unitErr := os.Stat("/etc/systemd/system/orq-agent.service")
	if os.Geteuid() != 0 && unitErr == nil {
		// This temporary HOME owns no user unit; a system installation needs root.
		if err == nil || !strings.Contains(err.Error(), "system service") || !strings.Contains(err.Error(), "sudo") {
			t.Fatalf("expected the system-service ownership refusal: %v", err)
		}
	} else if err != nil {
		t.Fatalf("uninstall dry run: %v", err)
	}
	if pathExists(dataDir) {
		t.Error("a dry run created the data dir")
	}
	if entries, err := os.ReadDir(home); err != nil || len(entries) != 0 {
		t.Errorf("dry run wrote into HOME: %v %v", entries, err)
	}
	if data, err := os.ReadFile(tokenFile); err != nil || string(data) != secret+"\n" {
		t.Fatalf("dry run consumed or changed the source token: %q %v", data, err)
	}
}
