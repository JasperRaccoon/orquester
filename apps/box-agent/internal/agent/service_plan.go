package agent

import (
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"text/template"
)

// install-service and uninstall-service are planned here, from facts about the
// machine, without build tags: the Linux tests cover the macOS LaunchAgent as
// well as both systemd units. The build-tagged service_*.go files only gather
// the facts and run the plan.

// serviceKind is how orq-agent is kept running on a machine.
type serviceKind string

const (
	kindSystemdSystem serviceKind = "systemd-system"
	kindSystemdUser   serviceKind = "systemd-user"
	kindLaunchAgent   serviceKind = "launchagent"
	kindBackground    serviceKind = "background"
	kindWindows       serviceKind = "windows"
)

const systemdUnitPath = "/etc/systemd/system/orq-agent.service"

// systemdDropInDir holds orq-agent.service's drop-ins.
const systemdDropInDir = "/etc/systemd/system/orq-agent.service.d"

// needrestartDir is needrestart's config dir. Ubuntu and Debian run needrestart after every apt
// run, unattended-upgrades included, and it restarts a unit when a process in the unit's cgroup
// still maps an upgraded library. KillMode=process keeps the agent CLIs and terminals orq-agent
// started in its cgroup, so after one upgrade every later apt run restarts orq-agent again, and
// each restart loses its record of those processes: no reattach can reach them.
const needrestartDir = "/etc/needrestart"

// needrestartOverride tells needrestart never to restart orq-agent.service by itself.
const needrestartOverride = "# Written by orq-agent: restarting orq-agent.service loses the agent CLIs and terminals it runs.\n" +
	"$nrconf{override_rc}->{qr(^orq-agent\\.service$)} = 0;\n"

// oomPolicyDropIn: systemd's default OOMPolicy=stop stops the whole unit when the kernel's OOM
// killer kills any process in its cgroup. KillMode=process keeps the agent CLIs and test runs
// orq-agent starts in that cgroup, so one test run that exhausts the box's memory stopped
// orq-agent, and every agent CLI it served ended with it (their stdin is orq-agent's pipe).
const oomPolicyDropIn = "# Written by orq-agent: a process of this unit killed for memory (a test run) must not stop\n" +
	"# orq-agent, and with it every agent CLI it serves.\n" +
	"[Service]\n" +
	"OOMPolicy=continue\n"

// launchAgentLabel names the macOS LaunchAgent (and its plist).
const launchAgentLabel = "dev.orquester.agent"

// serviceFacts is everything install-service and uninstall-service decide on.
type serviceFacts struct {
	GOOS     string
	Euid     int
	UID      int
	Username string
	Home     string
	Exe      string
	DataDir  string
	// Path is the installing shell's PATH, given to the service: service managers start it
	// with a minimal PATH that lacks Homebrew and the owner's own tool directories.
	Path string

	// SystemSystemd: systemd is the init system (/run/systemd/system exists).
	SystemSystemd bool
	// UserSystemd: this user's systemd manager is reachable ($XDG_RUNTIME_DIR/systemd exists).
	UserSystemd bool
	// Linger: loginctl reports lingering for Username; false when it cannot tell.
	Linger bool
	// Needrestart: needrestart is installed (needrestartDir exists).
	Needrestart bool

	// What is installed now (uninstall-service removes what it finds).
	SystemUnitInstalled  bool
	UserUnitInstalled    bool
	LaunchAgentInstalled bool
}

func userUnitPath(home string) string {
	return filepath.Join(home, ".config", "systemd", "user", "orq-agent.service")
}

func launchAgentPath(home string) string {
	return filepath.Join(home, "Library", "LaunchAgents", launchAgentLabel+".plist")
}

func launchAgentLogDir(home string) string {
	return filepath.Join(home, "Library", "Logs", "Orquester")
}

type stepKind int

const (
	stepMkdir  stepKind = iota // create Path (and parents) with Mode
	stepWrite                  // write Content to Path with Mode (parents created)
	stepRemove                 // remove Path recursively; a missing path is fine
	stepRun                    // run Argv and wait
	stepDetach                 // start Argv in the background, output appended to Path
)

// planStep is one action of a servicePlan.
type planStep struct {
	Kind    stepKind
	Path    string
	Content string
	Mode    os.FileMode
	Argv    []string
	// IgnoreError: the step may fail harmlessly (unloading what is not loaded).
	IgnoreError bool
	// Secret: Content is not printed by --dry-run.
	Secret bool
}

// servicePlan is what install-service or uninstall-service does, in order.
type servicePlan struct {
	Kind  serviceKind
	Steps []planStep
	// Notes are printed for the owner (hints and caveats).
	Notes []string
	// BestEffort: run every step even after one fails (uninstall removes what it can).
	BestEffort bool
}

func (p *servicePlan) mkdir(path string, mode os.FileMode) {
	p.Steps = append(p.Steps, planStep{Kind: stepMkdir, Path: path, Mode: mode})
}

func (p *servicePlan) write(path, content string, mode os.FileMode) {
	p.Steps = append(p.Steps, planStep{Kind: stepWrite, Path: path, Content: content, Mode: mode})
}

func (p *servicePlan) remove(path string) {
	p.Steps = append(p.Steps, planStep{Kind: stepRemove, Path: path})
}

func (p *servicePlan) run(argv ...string) {
	p.Steps = append(p.Steps, planStep{Kind: stepRun, Argv: argv})
}

func (p *servicePlan) runIgnoringError(argv ...string) {
	p.Steps = append(p.Steps, planStep{Kind: stepRun, Argv: argv, IgnoreError: true})
}

func (p *servicePlan) note(format string, args ...any) {
	p.Notes = append(p.Notes, fmt.Sprintf(format, args...))
}

// checkServiceFacts refuses values a unit file or plist cannot carry on one line.
func checkServiceFacts(f serviceFacts) error {
	for name, value := range map[string]string{"executable path": f.Exe, "data dir": f.DataDir, "home": f.Home, "PATH": f.Path, "user name": f.Username} {
		if strings.IndexFunc(value, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
			return fmt.Errorf("the %s contains a control character", name)
		}
	}
	return nil
}

// planInstall decides how install-service keeps orq-agent running.
func planInstall(f serviceFacts) (servicePlan, error) {
	if err := checkServiceFacts(f); err != nil {
		return servicePlan{}, err
	}
	args := []string{f.Exe, "run", "--data-dir", f.DataDir}
	switch f.GOOS {
	case "windows":
		p := servicePlan{Kind: kindWindows}
		p.note("register the Windows service OrqAgent (automatic start, LocalSystem, restarted on failure) running %s, then start it",
			shellJoin([]string{f.Exe, "service", "--data-dir", f.DataDir}))
		return p, nil
	case "darwin":
		if f.Euid == 0 {
			return servicePlan{}, errors.New("install-service on macOS installs a LaunchAgent for the logged-in user " +
				"(the iOS Simulator and screen capture need that user's GUI session): run it as that user, not with sudo")
		}
		if f.Home == "" {
			return servicePlan{}, errors.New("no home directory to install the LaunchAgent in")
		}
		plist, err := renderLaunchAgent(launchAgentData{
			Label:      launchAgentLabel,
			Args:       args,
			StdoutPath: filepath.Join(launchAgentLogDir(f.Home), "orq-agent.log"),
			StderrPath: filepath.Join(launchAgentLogDir(f.Home), "orq-agent.err.log"),
			Path:       f.Path,
		})
		if err != nil {
			return servicePlan{}, err
		}
		domain := "gui/" + strconv.Itoa(f.UID)
		service := domain + "/" + launchAgentLabel
		p := servicePlan{Kind: kindLaunchAgent}
		p.mkdir(launchAgentLogDir(f.Home), 0o700)
		p.mkdir(filepath.Dir(launchAgentPath(f.Home)), 0o755)
		p.write(launchAgentPath(f.Home), plist, 0o644)
		// A reinstall replaces the loaded job; on a first install there is none to unload.
		p.runIgnoringError("launchctl", "bootout", service)
		// Enable before bootstrap: launchd refuses to bootstrap a label left disabled.
		p.run("launchctl", "enable", service)
		// RunAtLoad starts it here. No kickstart -k: killing the fresh process mid-connect could
		// lose the one-time bootstrap token after the daemon accepted it.
		p.run("launchctl", "bootstrap", domain, launchAgentPath(f.Home))
		p.run("launchctl", "kickstart", service)
		p.note("orq-agent runs while %s is logged in to this Mac; turn on automatic login so it starts again after a restart", userLabel(f.Username))
		p.note("logs: %s", launchAgentLogDir(f.Home))
		return p, nil
	case "linux":
		if f.Euid == 0 && f.SystemSystemd {
			unit, err := renderSystemdUnit(systemSystemdUnit, systemdUnitData{Exe: f.Exe, DataDir: f.DataDir})
			if err != nil {
				return servicePlan{}, err
			}
			p := servicePlan{Kind: kindSystemdSystem}
			p.write(systemdUnitPath, unit, 0o644)
			p.write(filepath.Join(systemdDropInDir, "oom-policy.conf"), oomPolicyDropIn, 0o644)
			if f.Needrestart {
				p.write(filepath.Join(needrestartDir, "conf.d", "orq-agent.conf"), needrestartOverride, 0o644)
			}
			p.run("systemctl", "daemon-reload")
			p.run("systemctl", "enable", "orq-agent.service")
			p.run("systemctl", "restart", "orq-agent.service")
			return p, nil
		}
		if f.Euid != 0 && f.UserSystemd && f.Home != "" {
			unit, err := renderSystemdUnit(userSystemdUnit, systemdUnitData{Exe: f.Exe, DataDir: f.DataDir, Path: f.Path})
			if err != nil {
				return servicePlan{}, err
			}
			p := servicePlan{Kind: kindSystemdUser}
			p.write(userUnitPath(f.Home), unit, 0o644)
			p.run("systemctl", "--user", "daemon-reload")
			p.run("systemctl", "--user", "enable", "orq-agent.service")
			p.run("systemctl", "--user", "restart", "orq-agent.service")
			if !f.Linger {
				p.note("run `sudo loginctl enable-linger %s` so orq-agent keeps running after you log out and starts at boot", userLabel(f.Username))
			}
			p.note("logs: journalctl --user -u orq-agent.service")
			return p, nil
		}
	}
	// Containers, Fly machines, and Linux without a reachable systemd.
	p := servicePlan{Kind: kindBackground}
	p.Steps = append(p.Steps, planStep{Kind: stepDetach, Argv: args, Path: filepath.Join(f.DataDir, "agent.log")})
	p.note("orq-agent runs as a background process: it does not start again after a reboot")
	return p, nil
}

// planUninstall removes what install-service set up, as found on the machine. Steps that
// stop orq-agent come last: when orq-agent uninstalls itself, stopping it ends this process.
func planUninstall(f serviceFacts) (servicePlan, error) {
	if err := checkServiceFacts(f); err != nil {
		return servicePlan{}, err
	}
	switch f.GOOS {
	case "windows":
		p := servicePlan{Kind: kindWindows, BestEffort: true}
		p.note("delete the Windows service OrqAgent and stop it (nothing to do if it is not installed)")
		return p, nil
	case "darwin":
		if f.Euid == 0 {
			return servicePlan{}, errors.New("the LaunchAgent belongs to the logged-in user: run uninstall-service as that user, not with sudo")
		}
		p := servicePlan{Kind: kindLaunchAgent, BestEffort: true}
		if !f.LaunchAgentInstalled {
			p.note("no LaunchAgent plist at %s; unloading the job in case it is still loaded", launchAgentPath(f.Home))
		}
		p.remove(launchAgentPath(f.Home))
		// The job is gone once booted out: KeepAlive no longer restarts it.
		p.runIgnoringError("launchctl", "bootout", "gui/"+strconv.Itoa(f.UID)+"/"+launchAgentLabel)
		return p, nil
	case "linux":
		if f.SystemUnitInstalled && f.Euid == 0 {
			p := servicePlan{Kind: kindSystemdSystem, BestEffort: true}
			p.run("systemctl", "disable", "orq-agent.service")
			p.remove(systemdUnitPath)
			p.remove(systemdDropInDir)
			p.remove(filepath.Join(needrestartDir, "conf.d", "orq-agent.conf"))
			p.run("systemctl", "daemon-reload")
			// Fails harmlessly when the unit is not running (and so no longer loaded).
			p.runIgnoringError("systemctl", "stop", "orq-agent.service")
			return p, nil
		}
		if f.UserUnitInstalled && f.Euid != 0 {
			p := servicePlan{Kind: kindSystemdUser, BestEffort: true}
			p.run("systemctl", "--user", "disable", "orq-agent.service")
			p.remove(userUnitPath(f.Home))
			p.run("systemctl", "--user", "daemon-reload")
			p.runIgnoringError("systemctl", "--user", "stop", "orq-agent.service")
			return p, nil
		}
		if f.SystemUnitInstalled {
			return servicePlan{}, errors.New("orq-agent is installed as a system service: run `sudo orq-agent uninstall-service`")
		}
	}
	p := servicePlan{Kind: kindBackground, BestEffort: true}
	p.note("no orq-agent service is installed, so there is nothing to unload; a background orq-agent runs until it exits or the machine restarts")
	return p, nil
}

func userLabel(name string) string {
	if name == "" {
		return "this user"
	}
	return name
}

type systemdUnitData struct {
	Exe     string
	DataDir string
	Path    string
}

var systemdFuncs = template.FuncMap{"quote": systemdQuote}

// systemSystemdUnit runs as root at boot. KillMode=process: a crash or restart of orq-agent
// must not take the detached processes (agent CLIs, terminals) it owns with it.
var systemSystemdUnit = template.Must(template.New("system").Funcs(systemdFuncs).Parse(`[Unit]
Description=Orquester box agent (orq-agent)
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStart={{quote .Exe}} run --data-dir {{quote .DataDir}}
Restart=on-failure
RestartSec=2
KillMode=process

[Install]
WantedBy=multi-user.target
`))

// userSystemdUnit runs in the owner's user manager (bring-your-own Linux without root).
// The user manager's network-online.target is not the system's, so there is no ordering on
// it: orq-agent retries its connection anyway. OOMPolicy=continue: see oomPolicyDropIn.
var userSystemdUnit = template.Must(template.New("user").Funcs(systemdFuncs).Parse(`[Unit]
Description=Orquester box agent (orq-agent)

[Service]
Type=simple
{{- if .Path}}
Environment={{quote (printf "PATH=%s" .Path)}}
{{- end}}
ExecStart={{quote .Exe}} run --data-dir {{quote .DataDir}}
Restart=on-failure
RestartSec=2
KillMode=process
OOMPolicy=continue

[Install]
WantedBy=default.target
`))

func renderSystemdUnit(tmpl *template.Template, data systemdUnitData) (string, error) {
	var b strings.Builder
	if err := tmpl.Execute(&b, data); err != nil {
		return "", err
	}
	return b.String(), nil
}

// systemdQuote quotes a unit-file value that has spaces, quotes or backslashes, and doubles
// `%` so systemd does not read it as a specifier.
func systemdQuote(value string) string {
	value = strings.ReplaceAll(value, "%", "%%")
	if !strings.ContainsAny(value, " \t\"'\\") {
		return value
	}
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(value) + `"`
}

type launchAgentData struct {
	Label      string
	Args       []string
	StdoutPath string
	StderrPath string
	Path       string
}

// launchAgentPlist is a per-user LaunchAgent, not a LaunchDaemon: it runs in the user's Aqua
// session, which the iOS Simulator and ScreenCaptureKit need.
var launchAgentPlist = template.Must(template.New("plist").Funcs(template.FuncMap{"xml": xmlText}).Parse(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{{xml .Label}}</string>
	<key>ProgramArguments</key>
	<array>
{{- range .Args}}
		<string>{{xml .}}</string>
{{- end}}
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>StandardOutPath</key>
	<string>{{xml .StdoutPath}}</string>
	<key>StandardErrorPath</key>
	<string>{{xml .StderrPath}}</string>
{{- if .Path}}
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>{{xml .Path}}</string>
	</dict>
{{- end}}
</dict>
</plist>
`))

func renderLaunchAgent(data launchAgentData) (string, error) {
	var b strings.Builder
	if err := launchAgentPlist.Execute(&b, data); err != nil {
		return "", err
	}
	return b.String(), nil
}

func xmlText(value string) (string, error) {
	var b strings.Builder
	if err := xml.EscapeText(&b, []byte(value)); err != nil {
		return "", err
	}
	return b.String(), nil
}

// shellQuote quotes an argument for display, so paths with spaces read unambiguously.
func shellQuote(arg string) string {
	if arg != "" && strings.IndexFunc(arg, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("-_./:=@%+,", r))
	}) < 0 {
		return arg
	}
	return "'" + strings.ReplaceAll(arg, "'", `'\''`) + "'"
}

func shellJoin(argv []string) string {
	quoted := make([]string, len(argv))
	for i, arg := range argv {
		quoted[i] = shellQuote(arg)
	}
	return strings.Join(quoted, " ")
}

// printPlan writes what the plan would do, file contents included, for --dry-run.
func printPlan(w io.Writer, plan servicePlan) {
	fmt.Fprintf(w, "# service kind: %s\n", plan.Kind)
	for _, step := range plan.Steps {
		switch step.Kind {
		case stepMkdir:
			fmt.Fprintf(w, "mkdir -p -m %04o %s\n", step.Mode, shellQuote(step.Path))
		case stepWrite:
			if step.Secret {
				fmt.Fprintf(w, "write %s (mode %04o): secret, not shown\n", shellQuote(step.Path), step.Mode)
				continue
			}
			fmt.Fprintf(w, "write %s (mode %04o):\n", shellQuote(step.Path), step.Mode)
			content := step.Content
			if !strings.HasSuffix(content, "\n") {
				content += "\n"
			}
			fmt.Fprintf(w, "----- begin %s -----\n%s----- end %s -----\n", filepath.Base(step.Path), content, filepath.Base(step.Path))
		case stepRemove:
			fmt.Fprintf(w, "rm -rf %s\n", shellQuote(step.Path))
		case stepRun:
			if step.IgnoreError {
				fmt.Fprintf(w, "run: %s  (failure ignored)\n", shellJoin(step.Argv))
			} else {
				fmt.Fprintf(w, "run: %s\n", shellJoin(step.Argv))
			}
		case stepDetach:
			fmt.Fprintf(w, "start in the background: %s  (output to %s)\n", shellJoin(step.Argv), shellQuote(step.Path))
		}
	}
	for _, note := range plan.Notes {
		fmt.Fprintf(w, "note: %s\n", note)
	}
}

// planRunner runs a plan's commands; tests replace it.
type planRunner struct {
	run    func(argv []string) error
	detach func(argv []string, logPath string) error
}

var osPlanRunner = planRunner{run: runCommand, detach: startDetached}

func runCommand(argv []string) error {
	out, err := exec.Command(argv[0], argv[1:]...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %v: %s", shellJoin(argv), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// applyPlan carries out the plan. It stops at the first failure unless the plan is best-effort,
// which runs every step and returns every failure that was not to be ignored.
func applyPlan(plan servicePlan, runner planRunner, logf func(string, ...any)) error {
	var errs []error
	for _, step := range plan.Steps {
		var err error
		switch step.Kind {
		case stepMkdir:
			err = os.MkdirAll(step.Path, step.Mode)
		case stepWrite:
			if err = os.MkdirAll(filepath.Dir(step.Path), 0o755); err == nil {
				err = writeFileAtomic(step.Path, []byte(step.Content), step.Mode)
			}
			if err == nil {
				logf("wrote %s", step.Path)
			}
		case stepRemove:
			if err = os.RemoveAll(step.Path); err == nil {
				logf("removed %s", step.Path)
			}
		case stepRun:
			logf("running %s", shellJoin(step.Argv))
			err = runner.run(step.Argv)
		case stepDetach:
			logf("starting %s in the background", shellJoin(step.Argv))
			err = runner.detach(step.Argv, step.Path)
		}
		if err == nil {
			continue
		}
		if step.IgnoreError {
			logf("ignored: %v", err)
			continue
		}
		if !plan.BestEffort {
			return err
		}
		logf("failed: %v", err)
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// gatherServiceFacts reads the facts install-service and uninstall-service plan from.
func gatherServiceFacts(dataDir string) (serviceFacts, error) {
	exe, err := executablePath()
	if err != nil {
		return serviceFacts{}, err
	}
	if dataDir, err = filepath.Abs(dataDir); err != nil {
		return serviceFacts{}, err
	}
	home, _ := os.UserHomeDir()
	f := serviceFacts{
		GOOS:    runtime.GOOS,
		Euid:    os.Geteuid(),
		UID:     os.Getuid(),
		Home:    home,
		Exe:     exe,
		DataDir: dataDir,
		Path:    os.Getenv("PATH"),
	}
	if u, err := user.Current(); err == nil {
		f.Username = u.Username
	} else {
		f.Username = os.Getenv("USER")
	}
	switch f.GOOS {
	case "linux":
		f.SystemUnitInstalled = pathExists(systemdUnitPath)
		f.UserUnitInstalled = home != "" && pathExists(userUnitPath(home))
	case "darwin":
		f.LaunchAgentInstalled = home != "" && pathExists(launchAgentPath(home))
	}
	detectServiceManager(&f)
	return f, nil
}

// ServiceOptions are install-service's and uninstall-service's flags.
type ServiceOptions struct {
	DataDir string
	DryRun  bool
}

// InstallServiceCommand is `orq-agent install-service`: it stores the config in
// `<dataDir>/agent.env` and has the OS service manager keep orq-agent running.
// With DryRun it prints what it would write and run, and does neither.
func InstallServiceCommand(version string, opts ServiceOptions, out io.Writer) error {
	cfg, cfgErr := LoadConfig(version, opts.DataDir)
	facts, err := gatherServiceFacts(cfg.DataDir)
	if err != nil {
		return err
	}
	cfg.DataDir = facts.DataDir
	plan, err := planInstall(facts)
	if err != nil {
		return err
	}
	if opts.DryRun {
		fmt.Fprintln(out, "# orq-agent install-service --dry-run: nothing is written or run.")
		if cfgErr != nil {
			fmt.Fprintf(out, "# a real install would stop here: %v\n", cfgErr)
		}
		if cfg.DaemonURL == "" {
			cfg.DaemonURL = "<ORQ_DAEMON_URL>"
		}
		env, token, err := serviceEnv(cfg)
		if err != nil {
			return err
		}
		envPlan := servicePlan{Kind: plan.Kind}
		if token != "" {
			envPlan.Steps = append(envPlan.Steps, planStep{Kind: stepWrite, Path: filepath.Join(cfg.DataDir, "bootstrap-token"), Mode: 0o600, Secret: true})
		}
		envPlan.write(filepath.Join(cfg.DataDir, "agent.env"), env, 0o600)
		plan.Steps = append(envPlan.Steps, plan.Steps...)
		printPlan(out, plan)
		return nil
	}
	if cfgErr != nil {
		return cfgErr
	}
	if err := writeServiceEnv(cfg); err != nil {
		return err
	}
	logf := func(format string, args ...any) { fmt.Fprintf(out, format+"\n", args...) }
	if plan.Kind == kindWindows {
		err = installWindowsService(cfg)
	} else {
		err = applyPlan(plan, osPlanRunner, logf)
	}
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "orq-agent installed (%s)\n", plan.Kind)
	for _, note := range plan.Notes {
		fmt.Fprintf(out, "note: %s\n", note)
	}
	return nil
}

// UninstallServiceCommand is `orq-agent uninstall-service`: it stops and removes the service
// install-service set up. Running it again, or where nothing is installed, is not an error.
func UninstallServiceCommand(opts ServiceOptions, out io.Writer) error {
	dataDir := opts.DataDir
	if dataDir == "" {
		dataDir = os.Getenv("ORQ_DATA_DIR")
	}
	if dataDir == "" {
		dataDir = DefaultDataDir()
	}
	facts, err := gatherServiceFacts(dataDir)
	if err != nil {
		return err
	}
	plan, err := planUninstall(facts)
	if err != nil {
		return err
	}
	if opts.DryRun {
		fmt.Fprintln(out, "# orq-agent uninstall-service --dry-run: nothing is removed or run.")
		printPlan(out, plan)
		return nil
	}
	if err := uninstallService(plan, func(format string, args ...any) { fmt.Fprintf(out, format+"\n", args...) }); err != nil {
		return err
	}
	for _, note := range plan.Notes {
		fmt.Fprintf(out, "note: %s\n", note)
	}
	return nil
}

func uninstallService(plan servicePlan, logf func(string, ...any)) error {
	if plan.Kind == kindWindows {
		return uninstallWindowsService()
	}
	return applyPlan(plan, osPlanRunner, logf)
}

// uninstall is the end of a box its owner removed: the credentials go, then the service.
// Stopping the service may end this process; the daemon already has its answer.
func (a *Agent) uninstall() {
	defer func() {
		if r := recover(); r != nil {
			a.log.Printf("uninstall failed: %v", r)
		}
	}()
	for _, err := range removeAgentState(a.cfg.DataDir) {
		a.log.Printf("uninstall: %v", err)
	}
	facts, err := gatherServiceFacts(a.cfg.DataDir)
	if err != nil {
		a.log.Printf("uninstall: %v", err)
		return
	}
	plan, err := planUninstall(facts)
	if err != nil {
		a.log.Printf("uninstall: %v", err)
		return
	}
	logf := func(format string, args ...any) { a.log.Printf("uninstall: "+format, args...) }
	if err := uninstallService(plan, logf); err != nil {
		a.log.Printf("uninstall: %v", err)
	}
}

// removeAgentState deletes what lets this machine connect as the box again.
func removeAgentState(dataDir string) []error {
	var errs []error
	for _, name := range []string{"credential", "bootstrap-token", "agent.env"} {
		if err := os.Remove(filepath.Join(dataDir, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	return errs
}
