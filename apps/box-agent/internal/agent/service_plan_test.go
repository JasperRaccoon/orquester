//go:build !windows

// The plans hold Unix paths, which Windows path functions would rewrite.

package agent

import (
	"encoding/xml"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestSystemUnitIsUnchanged(t *testing.T) {
	got, err := renderSystemdUnit(systemSystemdUnit, systemdUnitData{Exe: "/usr/local/bin/orq-agent", DataDir: "/var/lib/orq-agent", Path: "/ignored"})
	if err != nil {
		t.Fatal(err)
	}
	// The unit boxes were installed with before plans existed.
	want := "[Unit]\nDescription=Orquester box agent (orq-agent)\nWants=network-online.target\nAfter=network-online.target\n\n" +
		"[Service]\nType=simple\nExecStart=/usr/local/bin/orq-agent run --data-dir /var/lib/orq-agent\nRestart=on-failure\nRestartSec=2\nKillMode=process\n\n" +
		"[Install]\nWantedBy=multi-user.target\n"
	if got != want {
		t.Fatalf("system unit:\n%s\nwant:\n%s", got, want)
	}
	got, _ = renderSystemdUnit(systemSystemdUnit, systemdUnitData{Exe: "/opt/my tools/orq-agent", DataDir: `/var/lib/100%"agent"`})
	if !strings.Contains(got, "\nExecStart=\"/opt/my tools/orq-agent\" run --data-dir \"/var/lib/100%%\\\"agent\\\"\"\n") {
		t.Fatalf("quoting:\n%s", got)
	}
}

func TestUserUnit(t *testing.T) {
	got, err := renderSystemdUnit(userSystemdUnit, systemdUnitData{
		Exe:     "/home/j/.local/bin/orq-agent",
		DataDir: "/home/j/.orq-agent",
		Path:    "/home/j/my bin:/usr/bin",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := "[Unit]\nDescription=Orquester box agent (orq-agent)\n\n" +
		"[Service]\nType=simple\nEnvironment=\"PATH=/home/j/my bin:/usr/bin\"\n" +
		"ExecStart=/home/j/.local/bin/orq-agent run --data-dir /home/j/.orq-agent\n" +
		"Restart=on-failure\nRestartSec=2\nKillMode=process\nOOMPolicy=continue\n\n" +
		"[Install]\nWantedBy=default.target\n"
	if got != want {
		t.Fatalf("user unit:\n%s\nwant:\n%s", got, want)
	}
	got, _ = renderSystemdUnit(userSystemdUnit, systemdUnitData{Exe: "/x/orq-agent", DataDir: "/d"})
	if strings.Contains(got, "Environment=") {
		t.Fatalf("an empty PATH must not be set:\n%s", got)
	}
}

// plistNode decodes any plist element.
type plistNode struct {
	XMLName xml.Name
	Text    string      `xml:",chardata"`
	Nodes   []plistNode `xml:",any"`
}

// plistValue turns a decoded plist value into Go values (dict → map, array → slice).
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
		if step.Kind == stepWrite && step.Path == launchAgentPath(home) {
			plist = step.Content
		}
	}
	if !strings.Contains(plist, "Jo &amp; &lt;Kim&gt;") {
		t.Fatalf("not escaped:\n%s", plist)
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
		"Label":             "dev.orquester.agent",
		"ProgramArguments":  []any{exe, "run", "--data-dir", home + "/.orq-agent"},
		"RunAtLoad":         true,
		"KeepAlive":         true,
		"ProcessType":       "Interactive",
		"StandardOutPath":   home + "/Library/Logs/Orquester/orq-agent.log",
		"StandardErrorPath": home + "/Library/Logs/Orquester/orq-agent.err.log",
		"EnvironmentVariables": map[string]any{
			"PATH": "/opt/homebrew/bin:/usr/bin",
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("plist = %#v\nwant %#v", got, want)
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

func TestPlanInstallChoosesTheServiceManager(t *testing.T) {
	root := linuxFacts()
	root.Euid, root.UID, root.Home, root.DataDir, root.Exe = 0, 0, "/root", "/var/lib/orq-agent", "/usr/local/bin/orq-agent"

	cases := []struct {
		name  string
		facts func(f *serviceFacts)
		base  serviceFacts
		kind  serviceKind
	}{
		{"linux root with systemd", func(f *serviceFacts) { f.SystemSystemd = true }, root, kindSystemdSystem},
		{"linux root without systemd", func(f *serviceFacts) {}, root, kindBackground},
		{"linux user with a user manager", func(f *serviceFacts) { f.SystemSystemd, f.UserSystemd = true, true }, linuxFacts(), kindSystemdUser},
		{"linux user without a user manager", func(f *serviceFacts) { f.SystemSystemd = true }, linuxFacts(), kindBackground},
		{"linux user without a home", func(f *serviceFacts) { f.SystemSystemd, f.UserSystemd, f.Home = true, true, "" }, linuxFacts(), kindBackground},
		{"macOS user", func(f *serviceFacts) { f.GOOS, f.Home = "darwin", "/Users/jo" }, linuxFacts(), kindLaunchAgent},
		{"windows", func(f *serviceFacts) { f.GOOS, f.Euid = "windows", -1 }, linuxFacts(), kindWindows},
	}
	for _, c := range cases {
		facts := c.base
		c.facts(&facts)
		plan, err := planInstall(facts)
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if plan.Kind != c.kind {
			t.Errorf("%s: kind %s, want %s", c.name, plan.Kind, c.kind)
		}
	}

	darwinRoot := linuxFacts()
	darwinRoot.GOOS, darwinRoot.Euid = "darwin", 0
	if _, err := planInstall(darwinRoot); err == nil || !strings.Contains(err.Error(), "not with sudo") {
		t.Fatalf("macOS as root: %v", err)
	}
	bad := linuxFacts()
	bad.DataDir = "/tmp/a\nb"
	if _, err := planInstall(bad); err == nil {
		t.Fatal("a newline in the data dir must be refused")
	}
}

func TestPlanInstallSystemd(t *testing.T) {
	f := linuxFacts()
	f.Euid, f.SystemSystemd, f.Needrestart = 0, true, true
	plan, _ := planInstall(f)
	wantFiles := []string{systemdUnitPath, systemdDropInDir + "/oom-policy.conf", "/etc/needrestart/conf.d/orq-agent.conf"}
	if got := stepsOf(plan, stepWrite); !reflect.DeepEqual(got, wantFiles) {
		t.Fatalf("files %v", got)
	}
	wantRun := []string{"systemctl daemon-reload", "systemctl enable orq-agent.service", "systemctl restart orq-agent.service"}
	if got := stepsOf(plan, stepRun); !reflect.DeepEqual(got, wantRun) {
		t.Fatalf("commands %v", got)
	}
	f.Needrestart = false
	plan, _ = planInstall(f)
	if got := stepsOf(plan, stepWrite); len(got) != 2 {
		t.Fatalf("without needrestart: %v", got)
	}

	user := linuxFacts()
	user.SystemSystemd, user.UserSystemd = true, true
	plan, _ = planInstall(user)
	if got := stepsOf(plan, stepWrite); !reflect.DeepEqual(got, []string{"/home/jo/.config/systemd/user/orq-agent.service"}) {
		t.Fatalf("user files %v", got)
	}
	wantRun = []string{"systemctl --user daemon-reload", "systemctl --user enable orq-agent.service", "systemctl --user restart orq-agent.service"}
	if got := stepsOf(plan, stepRun); !reflect.DeepEqual(got, wantRun) {
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
	if !strings.Contains(strings.Join(plan.Notes, "\n"), "reboot") {
		t.Fatalf("no reboot note: %v", plan.Notes)
	}
}

func TestPlanInstallLaunchAgent(t *testing.T) {
	f := linuxFacts()
	f.GOOS, f.UID, f.Euid, f.Home = "darwin", 501, 501, "/Users/jo"
	plan, _ := planInstall(f)
	if got := stepsOf(plan, stepMkdir); !reflect.DeepEqual(got, []string{"/Users/jo/Library/Logs/Orquester", "/Users/jo/Library/LaunchAgents"}) {
		t.Fatalf("dirs %v", got)
	}
	want := []string{
		"launchctl bootout gui/501/dev.orquester.agent",
		"launchctl enable gui/501/dev.orquester.agent",
		"launchctl bootstrap gui/501 /Users/jo/Library/LaunchAgents/dev.orquester.agent.plist",
		"launchctl kickstart gui/501/dev.orquester.agent",
	}
	if got := stepsOf(plan, stepRun); !reflect.DeepEqual(got, want) {
		t.Fatalf("commands %v", got)
	}
	for _, step := range plan.Steps {
		if step.Kind == stepRun && step.IgnoreError != (step.Argv[1] == "bootout") {
			t.Errorf("%v: IgnoreError %v", step.Argv, step.IgnoreError)
		}
	}
}

func TestPlanUninstall(t *testing.T) {
	root := linuxFacts()
	root.Euid, root.SystemUnitInstalled = 0, true
	plan, err := planUninstall(root)
	if err != nil || plan.Kind != kindSystemdSystem || !plan.BestEffort {
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
		"rm " + systemdUnitPath,
		"rm " + systemdDropInDir,
		"rm /etc/needrestart/conf.d/orq-agent.conf",
		"systemctl daemon-reload",
		"systemctl stop orq-agent.service",
	}
	if !reflect.DeepEqual(order, want) {
		t.Fatalf("system steps %v", order)
	}

	user := linuxFacts()
	user.UserUnitInstalled = true
	plan, _ = planUninstall(user)
	if plan.Kind != kindSystemdUser {
		t.Fatalf("user kind %s", plan.Kind)
	}
	if got := stepsOf(plan, stepRun); !reflect.DeepEqual(got, []string{"systemctl --user disable orq-agent.service", "systemctl --user daemon-reload", "systemctl --user stop orq-agent.service"}) {
		t.Fatalf("user commands %v", got)
	}
	if got := stepsOf(plan, stepRemove); !reflect.DeepEqual(got, []string{"/home/jo/.config/systemd/user/orq-agent.service"}) {
		t.Fatalf("user removes %v", got)
	}

	nothing := linuxFacts()
	plan, _ = planUninstall(nothing)
	if plan.Kind != kindBackground || len(plan.Steps) != 0 || !strings.Contains(strings.Join(plan.Notes, " "), "nothing to unload") {
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
	if plan.Kind != kindLaunchAgent || len(plan.Steps) != 2 ||
		plan.Steps[0].Kind != stepRemove || plan.Steps[0].Path != "/Users/jo/Library/LaunchAgents/dev.orquester.agent.plist" ||
		strings.Join(plan.Steps[1].Argv, " ") != "launchctl bootout gui/501/dev.orquester.agent" || !plan.Steps[1].IgnoreError {
		t.Fatalf("macOS: %+v", plan)
	}
	mac.Euid = 0
	if _, err := planUninstall(mac); err == nil {
		t.Fatal("macOS uninstall as root must be refused")
	}

	win := linuxFacts()
	win.GOOS = "windows"
	if plan, _ := planUninstall(win); plan.Kind != kindWindows || len(plan.Steps) != 0 {
		t.Fatalf("windows: %+v", plan)
	}
}

func TestPrintPlan(t *testing.T) {
	f := linuxFacts()
	f.GOOS, f.UID, f.Home = "darwin", 501, "/Users/jo"
	f.Exe = "/Users/jo/Library/Application Support/Orquester/orq-agent"
	plan, _ := planInstall(f)
	plan.Steps = append([]planStep{{Kind: stepWrite, Path: "/d/bootstrap-token", Content: "SECRET", Mode: 0o600, Secret: true}}, plan.Steps...)
	var out strings.Builder
	printPlan(&out, plan)
	got := out.String()
	for _, want := range []string{
		"# service kind: launchagent\n",
		"mkdir -p -m 0700 /Users/jo/Library/Logs/Orquester\n",
		"write /d/bootstrap-token (mode 0600): secret, not shown\n",
		"write /Users/jo/Library/LaunchAgents/dev.orquester.agent.plist (mode 0644):\n----- begin dev.orquester.agent.plist -----\n<?xml",
		"<string>/Users/jo/Library/Application Support/Orquester/orq-agent</string>",
		"</plist>\n----- end dev.orquester.agent.plist -----\n",
		"run: launchctl bootout gui/501/dev.orquester.agent  (failure ignored)\n",
		"run: launchctl bootstrap gui/501 /Users/jo/Library/LaunchAgents/dev.orquester.agent.plist\n",
		"note: orq-agent runs while jo is logged in",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("output lacks %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "SECRET") {
		t.Fatal("printed a secret")
	}
	out.Reset()
	printPlan(&out, servicePlan{Kind: kindBackground, Steps: []planStep{{Kind: stepDetach, Argv: []string{"/a b/orq-agent", "run"}, Path: "/d/agent.log"}}})
	if !strings.Contains(out.String(), "start in the background: '/a b/orq-agent' run  (output to /d/agent.log)\n") {
		t.Fatalf("detach line:\n%s", out.String())
	}
}

func TestApplyPlan(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "with space")
	var ran []string
	runner := planRunner{
		run: func(argv []string) error {
			ran = append(ran, strings.Join(argv, " "))
			if argv[0] == "fail" {
				return errors.New("failed")
			}
			return nil
		},
		detach: func(argv []string, logPath string) error {
			ran = append(ran, "detach "+strings.Join(argv, " ")+" > "+logPath)
			return nil
		},
	}
	plan := servicePlan{Kind: kindSystemdUser}
	plan.mkdir(filepath.Join(dir, "logs"), 0o700)
	plan.write(filepath.Join(dir, "a", "unit"), "content\n", 0o640)
	plan.remove(filepath.Join(dir, "missing"))
	plan.runIgnoringError("fail", "ignored")
	plan.run("ok")
	plan.Steps = append(plan.Steps, planStep{Kind: stepDetach, Argv: []string{"agent"}, Path: "/log"})
	if err := applyPlan(plan, runner, t.Logf); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(filepath.Join(dir, "logs")); err != nil || !info.IsDir() {
		t.Fatalf("mkdir: %v", err)
	}
	if data, err := os.ReadFile(filepath.Join(dir, "a", "unit")); err != nil || string(data) != "content\n" {
		t.Fatalf("write: %q %v", data, err)
	}
	if !isWindows {
		if info, _ := os.Stat(filepath.Join(dir, "a", "unit")); info.Mode().Perm() != 0o640 {
			t.Fatalf("mode %v", info.Mode())
		}
	}
	if !reflect.DeepEqual(ran, []string{"fail ignored", "ok", "detach agent > /log"}) {
		t.Fatalf("ran %v", ran)
	}

	// Install stops at the first failure; uninstall goes on and reports it.
	ran = nil
	strict := servicePlan{}
	strict.run("fail")
	strict.run("after")
	if err := applyPlan(strict, runner, t.Logf); err == nil || len(ran) != 1 {
		t.Fatalf("strict: %v, ran %v", err, ran)
	}
	ran = nil
	strict.BestEffort = true
	if err := applyPlan(strict, runner, t.Logf); err == nil || len(ran) != 2 {
		t.Fatalf("best effort: %v, ran %v", err, ran)
	}
}

func TestRemoveAgentState(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"credential", "agent.env", "procs.json"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// bootstrap-token is already gone: not an error.
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
}

func TestServiceEnvWritesNothing(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("tok\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, key := range serviceEnvKeys {
		t.Setenv(key, "")
	}
	env, token, err := serviceEnv(Config{DaemonURL: "https://d.example", BoxID: "box1", DataDir: dir, BootstrapTokenFile: tokenFile})
	if err != nil || token != "tok" {
		t.Fatalf("token %q err %v", token, err)
	}
	want := "# Written by `orq-agent install-service`.\nORQ_BOOTSTRAP_TOKEN_FILE=" + filepath.Join(dir, "bootstrap-token") +
		"\nORQ_BOX_ID=box1\nORQ_DAEMON_URL=https://d.example\nORQ_DATA_DIR=" + dir + "\n"
	if env != want {
		t.Fatalf("env:\n%s\nwant:\n%s", env, want)
	}
	if pathExists(dir) {
		t.Fatal("serviceEnv created the data dir")
	}
}
