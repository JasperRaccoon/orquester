//go:build !windows

// The plans hold Unix paths, which Windows path functions would rewrite.

package agent

import (
	"encoding/xml"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestSystemUnitPreservesRuntimeAndPathEscaping(t *testing.T) {
	got, err := renderSystemdUnit(systemSystemdUnit, systemdUnitData{Exe: "/usr/local/bin/orq-agent", DataDir: "/var/lib/orq-agent"})
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range []string{
		"ExecStart=/usr/local/bin/orq-agent run --data-dir /var/lib/orq-agent",
		"Restart=on-failure", "KillMode=process", "WantedBy=multi-user.target",
	} {
		if !strings.Contains(got, "\n"+line+"\n") {
			t.Errorf("missing service setting %q:\n%s", line, got)
		}
	}
	got, _ = renderSystemdUnit(systemSystemdUnit, systemdUnitData{Exe: "/opt/my tools/orq-agent", DataDir: `/var/lib/100%"agent"`})
	if !strings.Contains(got, "\nExecStart=\"/opt/my tools/orq-agent\" run --data-dir \"/var/lib/100%%\\\"agent\\\"\"\n") {
		t.Fatalf("unsafe systemd path escaping:\n%s", got)
	}
}

func TestUserUnit(t *testing.T) {
	got, err := renderSystemdUnit(userSystemdUnit, systemdUnitData{Exe: "/home/j/.local/bin/orq-agent", DataDir: "/home/j/.orq-agent", Path: "/home/j/my bin:/usr/bin"})
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range []string{
		`Environment="PATH=/home/j/my bin:/usr/bin"`,
		"ExecStart=/home/j/.local/bin/orq-agent run --data-dir /home/j/.orq-agent",
		"Restart=on-failure", "KillMode=process", "OOMPolicy=continue", "WantedBy=default.target",
	} {
		if !strings.Contains(got, "\n"+line+"\n") {
			t.Errorf("missing user-service setting %q:\n%s", line, got)
		}
	}
	got, _ = renderSystemdUnit(userSystemdUnit, systemdUnitData{Exe: "/x/orq-agent", DataDir: "/d"})
	if strings.Contains(got, "Environment=") {
		t.Fatalf("an empty PATH must not hide the service manager's PATH:\n%s", got)
	}
}

type plistNode struct {
	XMLName xml.Name
	Text    string      `xml:",chardata"`
	Nodes   []plistNode `xml:",any"`
}

func plistValue(t *testing.T, n plistNode) any {
	t.Helper()
	switch n.XMLName.Local {
	case "dict":
		out := map[string]any{}
		if len(n.Nodes)%2 != 0 {
			t.Fatalf("dict with a key and no value")
		}
		for i := 0; i < len(n.Nodes); i += 2 {
			if n.Nodes[i].XMLName.Local != "key" {
				t.Fatalf("dict entry %d is <%s>, not <key>", i, n.Nodes[i].XMLName.Local)
			}
			out[n.Nodes[i].Text] = plistValue(t, n.Nodes[i+1])
		}
		return out
	case "array":
		out := []any{}
		for _, child := range n.Nodes {
			out = append(out, plistValue(t, child))
		}
		return out
	case "string":
		return n.Text
	case "true":
		return true
	case "false":
		return false
	}
	t.Fatalf("unexpected <%s>", n.XMLName.Local)
	return nil
}

func TestLaunchAgentPlist(t *testing.T) {
	home := "/Users/Jo & <Kim>"
	exe := home + "/Library/Application Support/Orquester/orq-agent"
	plan, err := planInstall(serviceFacts{
		GOOS: "darwin", Euid: 501, UID: 501, Username: "jo", Home: home, Exe: exe,
		DataDir: home + "/.orq-agent", Path: "/opt/homebrew/bin:/usr/bin",
	})
	if err != nil {
		t.Fatal(err)
	}
	var plist string
	for _, step := range plan.Steps {
		if step.Kind == stepWrite && step.Path == home+"/Library/LaunchAgents/dev.orquester.agent.plist" {
			plist = step.Content
		}
	}

	var root plistNode
	if err := xml.Unmarshal([]byte(plist), &root); err != nil {
		t.Fatalf("not XML: %v\n%s", err, plist)
	}
	if root.XMLName.Local != "plist" || len(root.Nodes) != 1 {
		t.Fatalf("root = %+v", root.XMLName)
	}
	got := plistValue(t, root.Nodes[0])
	want := map[string]any{
		"Label":            "dev.orquester.agent",
		"ProgramArguments": []any{exe, "run", "--data-dir", home + "/.orq-agent"},
		"RunAtLoad":        true,
		// Restarted after a failure only: an exit 0 (shut down, box destroyed) stays down.
		"KeepAlive":         map[string]any{"SuccessfulExit": false},
		"ProcessType":       "Interactive",
		"StandardOutPath":   home + "/Library/Logs/Orquester/orq-agent.log",
		"StandardErrorPath": home + "/Library/Logs/Orquester/orq-agent.err.log",
		"EnvironmentVariables": map[string]any{
			"PATH": "/opt/homebrew/bin:/usr/bin",
		},
	}
	for key, value := range want {
		if !reflect.DeepEqual(got.(map[string]any)[key], value) {
			t.Errorf("plist %s = %#v; want %#v", key, got.(map[string]any)[key], value)
		}
	}
	commands := stepsOf(plan, stepRun)
	enable := slices.Index(commands, "launchctl enable gui/501/dev.orquester.agent")
	bootstrap := slices.Index(commands, "launchctl bootstrap gui/501 "+home+"/Library/LaunchAgents/dev.orquester.agent.plist")
	if enable < 0 || bootstrap <= enable {
		t.Fatalf("the GUI job must be enabled before bootstrap: %v", commands)
	}
	for _, step := range plan.Steps {
		if step.Kind != stepRun {
			continue
		}
		if slices.Contains(step.Argv, "bootout") && !step.IgnoreError {
			t.Fatal("a first install must tolerate an unloaded job")
		}
		if slices.Contains(step.Argv, "kickstart") && slices.Contains(step.Argv, "-k") {
			t.Fatal("kickstart must not kill the new process and its single-use token exchange")
		}
	}
}

func linuxFacts() serviceFacts {
	return serviceFacts{
		GOOS: "linux", Euid: 1000, UID: 1000, Username: "jo", Home: "/home/jo",
		Exe: "/home/jo/.local/bin/orq-agent", DataDir: "/home/jo/.orq-agent", Path: "/usr/bin:/bin",
	}
}

func stepsOf(plan servicePlan, kind stepKind) []string {
	var out []string
	for _, step := range plan.Steps {
		if step.Kind != kind {
			continue
		}
		if kind == stepRun || kind == stepDetach {
			out = append(out, strings.Join(step.Argv, " "))
		} else {
			out = append(out, step.Path)
		}
	}
	return out
}

func TestServicePlansRejectUnsafeInputs(t *testing.T) {
	mac := linuxFacts()
	mac.GOOS, mac.Euid = "darwin", 0
	if _, err := planInstall(mac); err == nil || !strings.Contains(err.Error(), "sudo") {
		t.Fatalf("macOS must install in the logged-in user's GUI session: %v", err)
	}
	bad := linuxFacts()
	bad.DataDir = "/tmp/a\nb"
	if _, err := planInstall(bad); err == nil || !strings.Contains(err.Error(), "data dir") {
		t.Fatalf("control characters cannot enter a service file: %v", err)
	}
}

func TestPlanInstallSystemd(t *testing.T) {
	f := linuxFacts()
	f.Euid, f.SystemSystemd, f.Needrestart = 0, true, true
	plan, _ := planInstall(f)
	wantFiles := []string{"/etc/systemd/system/orq-agent.service", "/etc/systemd/system/orq-agent.service.d/oom-policy.conf", "/etc/needrestart/conf.d/orq-agent.conf"}
	if got := stepsOf(plan, stepWrite); !containsAll(got, wantFiles) {
		t.Fatalf("files %v", got)
	}
	wantRun := []string{"systemctl daemon-reload", "systemctl enable orq-agent.service", "systemctl restart orq-agent.service"}
	if got := stepsOf(plan, stepRun); !containsAll(got, wantRun) {
		t.Fatalf("commands %v", got)
	}
	f.Needrestart = false
	plan, _ = planInstall(f)
	if got := stepsOf(plan, stepWrite); slices.Contains(got, "/etc/needrestart/conf.d/orq-agent.conf") {
		t.Fatalf("without needrestart: %v", got)
	}

	user := linuxFacts()
	user.SystemSystemd, user.UserSystemd = true, true
	plan, _ = planInstall(user)
	if got := stepsOf(plan, stepWrite); !slices.Contains(got, "/home/jo/.config/systemd/user/orq-agent.service") {
		t.Fatalf("user files %v", got)
	}
	for _, path := range stepsOf(plan, stepWrite) {
		if !strings.HasPrefix(path, user.Home+"/") {
			t.Fatalf("a user service must not write system configuration: %s", path)
		}
	}
	wantRun = []string{"systemctl --user daemon-reload", "systemctl --user enable orq-agent.service", "systemctl --user restart orq-agent.service"}
	if got := stepsOf(plan, stepRun); !containsAll(got, wantRun) {
		t.Fatalf("user commands %v", got)
	}
	if !strings.Contains(strings.Join(plan.Notes, "\n"), "sudo loginctl enable-linger jo") {
		t.Fatalf("no linger hint: %v", plan.Notes)
	}
	user.Linger = true
	plan, _ = planInstall(user)
	if strings.Contains(strings.Join(plan.Notes, "\n"), "enable-linger") {
		t.Fatalf("linger hint while lingering: %v", plan.Notes)
	}

	background := linuxFacts()
	plan, _ = planInstall(background)
	if got := stepsOf(plan, stepDetach); !reflect.DeepEqual(got, []string{"/home/jo/.local/bin/orq-agent run --data-dir /home/jo/.orq-agent"}) {
		t.Fatalf("background %v", got)
	}
}

func TestPlanUninstall(t *testing.T) {
	root := linuxFacts()
	root.Euid, root.SystemUnitInstalled = 0, true
	plan, err := planUninstall(root)
	if err != nil || !plan.BestEffort {
		t.Fatalf("system: %v %+v", err, plan)
	}
	var order []string
	for _, step := range plan.Steps {
		if step.Kind == stepRun {
			order = append(order, strings.Join(step.Argv, " "))
		} else {
			order = append(order, "rm "+step.Path)
		}
	}
	// Disabling and removing come before the stop, which may end this very process.
	want := []string{
		"systemctl disable orq-agent.service",
		"rm /etc/systemd/system/orq-agent.service",
		"rm /etc/systemd/system/orq-agent.service.d",
		"rm /etc/needrestart/conf.d/orq-agent.conf",
		"systemctl daemon-reload",
		"systemctl stop orq-agent.service",
	}
	if !containsAll(order, want) || order[len(order)-1] != "systemctl stop orq-agent.service" {
		t.Fatalf("service must be disabled and removed before its final stop: %v", order)
	}

	user := linuxFacts()
	user.UserUnitInstalled = true
	plan, _ = planUninstall(user)
	if got := stepsOf(plan, stepRun); !containsAll(got, []string{"systemctl --user disable orq-agent.service", "systemctl --user daemon-reload", "systemctl --user stop orq-agent.service"}) || got[len(got)-1] != "systemctl --user stop orq-agent.service" {
		t.Fatalf("user commands %v", got)
	}
	if got := stepsOf(plan, stepRemove); !reflect.DeepEqual(got, []string{"/home/jo/.config/systemd/user/orq-agent.service"}) {
		t.Fatalf("user removes %v", got)
	}

	nothing := linuxFacts()
	plan, _ = planUninstall(nothing)
	if len(plan.Steps) != 0 {
		t.Fatalf("background: %+v", plan)
	}

	userWithSystemUnit := linuxFacts()
	userWithSystemUnit.SystemUnitInstalled = true
	if _, err := planUninstall(userWithSystemUnit); err == nil || !strings.Contains(err.Error(), "sudo") {
		t.Fatalf("system unit as a user: %v", err)
	}

	mac := linuxFacts()
	mac.GOOS, mac.UID, mac.Home, mac.LaunchAgentInstalled = "darwin", 501, "/Users/jo", true
	plan, _ = planUninstall(mac)
	macOrder := stepsOf(plan, stepRemove)
	if !slices.Contains(macOrder, "/Users/jo/Library/LaunchAgents/dev.orquester.agent.plist") {
		t.Fatalf("macOS: %+v", plan)
	}
	removed := false
	for _, step := range plan.Steps {
		if step.Kind == stepRemove && step.Path == "/Users/jo/Library/LaunchAgents/dev.orquester.agent.plist" {
			removed = true
		}
		if step.Kind == stepRun && strings.Join(step.Argv, " ") == "launchctl bootout gui/501/dev.orquester.agent" {
			if !removed || !step.IgnoreError {
				t.Fatal("remove the LaunchAgent before unloading it, tolerating an absent job")
			}
			removed = false
		}
	}
	if removed {
		t.Fatal("the removed LaunchAgent was never unloaded")
	}
	mac.Euid = 0
	if _, err := planUninstall(mac); err == nil {
		t.Fatal("macOS uninstall as root must be refused")
	}

}

func TestApplyPlan(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "with space")
	obsolete := filepath.Join(dir, "obsolete")
	if err := os.MkdirAll(obsolete, 0o700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(dir, "ran")
	plan := servicePlan{Kind: kindSystemdUser}
	plan.mkdir(filepath.Join(dir, "logs"), 0o700)
	plan.write(filepath.Join(dir, "a", "unit"), "content\n", 0o640)
	plan.remove(obsolete)
	plan.runIgnoringError("/bin/sh", "-c", "exit 1")
	plan.run("/bin/sh", "-c", `printf ready > "$1"`, "orq-plan", marker)
	if err := applyPlan(plan, t.Logf); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(filepath.Join(dir, "logs")); err != nil || !info.IsDir() {
		t.Fatalf("mkdir: %v", err)
	}
	if data, err := os.ReadFile(filepath.Join(dir, "a", "unit")); err != nil || string(data) != "content\n" {
		t.Fatalf("write: %q %v", data, err)
	}
	if info, err := os.Stat(filepath.Join(dir, "a", "unit")); err != nil || info.Mode().Perm() != 0o640 {
		t.Fatalf("file permissions: %v %v", info, err)
	}
	if pathExists(obsolete) {
		t.Fatal("the obsolete directory was not removed")
	}
	if data, err := os.ReadFile(marker); err != nil || string(data) != "ready" {
		t.Fatalf("ignored failure prevented the real command: %q %v", data, err)
	}
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}

	// A failed install stops; an uninstall still performs the remaining cleanup.
	strict := servicePlan{}
	strict.run("/bin/sh", "-c", "exit 1")
	strict.run("/bin/sh", "-c", `printf cleanup > "$1"`, "orq-plan", marker)
	if err := applyPlan(strict, t.Logf); err == nil || pathExists(marker) {
		t.Fatalf("strict plan continued after failure: %v", err)
	}
	strict.BestEffort = true
	if err := applyPlan(strict, t.Logf); err == nil {
		t.Fatal("best-effort plan hid its failed command")
	}
	if data, err := os.ReadFile(marker); err != nil || string(data) != "cleanup" {
		t.Fatalf("best-effort cleanup was not performed: %q %v", data, err)
	}
}

func TestRemoveAgentState(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"credential", "bootstrap-token", "agent.env", "procs.json"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if errs := removeAgentState(dir); len(errs) != 0 {
		t.Fatal(errs)
	}
	for _, name := range []string{"credential", "agent.env", "bootstrap-token"} {
		if pathExists(filepath.Join(dir, name)) {
			t.Errorf("%s is still there", name)
		}
	}
	if !pathExists(filepath.Join(dir, "procs.json")) {
		t.Error("removed more than the credentials")
	}
	if errs := removeAgentState(dir); len(errs) != 0 {
		t.Fatalf("repeated removal: %v", errs)
	}
}

func containsAll(got, required []string) bool {
	for _, value := range required {
		if !slices.Contains(got, value) {
			return false
		}
	}
	return true
}
