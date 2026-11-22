package agent

// How the desktop-session helper (desktop_pipe.go) is started on Windows: a scheduled task with
// an "At log on" trigger for the desktop user, "Run only when user is logged on" (an interactive
// token, so it runs in that user's desktop session), "Run with highest privileges", no time
// limit, and restarted a minute after it fails to start. The service also runs it every minute
// while no helper is connected (desktop_windows.go helperKeepAlive), which brings back a helper
// that exited or was ended. `orq-agent install-desktop-helper --user NAME`
// registers it (desktop_windows.go) and writes desktop-helper.json beside agent.env, which tells
// the service whom the helper's pipe admits. Rendered here, without build tags, so it is tested
// on every OS.

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"text/template"
	"unicode/utf16"
)

// desktopTaskName is the scheduled task, in the Task Scheduler's root folder (a folder of our
// own would stay behind after removal: schtasks cannot delete folders).
const desktopTaskName = "Orquester desktop helper"

// desktopMarkerFile, in the data dir: the desktop user the helper task runs as.
const desktopMarkerFile = "desktop-helper.json"

// desktopMarker is desktop-helper.json.
type desktopMarker struct {
	// User is `DOMAIN\name`, as the task names it.
	User string `json:"user"`
	// SID is the user's SID: the only account besides LocalSystem the helper pipe admits.
	SID string `json:"sid"`
}

// userSIDPattern: a local, domain (S-1-5-21-…) or Entra ID (S-1-12-1-…) user account. Anything
// else (a well-known group such as Everyone) would open the pipe to more than one user.
var userSIDPattern = regexp.MustCompile(`^S-1-(5-21|12-1)(-[0-9]{1,10}){4,5}$`)

// readDesktopMarker returns the installed helper's user, or nil when none is installed.
func readDesktopMarker(dataDir string) (*desktopMarker, error) {
	data, err := os.ReadFile(filepath.Join(dataDir, desktopMarkerFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var m desktopMarker
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("%s is not valid JSON", desktopMarkerFile)
	}
	if !userSIDPattern.MatchString(m.SID) {
		return nil, fmt.Errorf("%s does not name a user account's SID", desktopMarkerFile)
	}
	if m.User == "" || strings.ContainsAny(m.User, "\r\n") {
		return nil, fmt.Errorf("%s does not name a user", desktopMarkerFile)
	}
	return &m, nil
}

func writeDesktopMarker(dataDir string, m desktopMarker) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(dataDir, desktopMarkerFile), append(data, '\n'), 0o600)
}

// desktopPipeSecurity is the helper pipe's security descriptor: owned by LocalSystem (the helper
// checks that, so no other process can stand in for the service), and open to LocalSystem and the
// desktop user alone.
func desktopPipeSecurity(sid string) (string, error) {
	if !userSIDPattern.MatchString(sid) {
		return "", fmt.Errorf("%q is not a user account's SID", sid)
	}
	return "O:SYG:SYD:P(A;;GA;;;SY)(A;;GRGW;;;" + sid + ")", nil
}

type desktopTaskData struct {
	// User is `DOMAIN\name`.
	User    string
	Exe     string
	DataDir string
}

var desktopTaskTemplate = template.Must(template.New("task").Funcs(template.FuncMap{"xml": xmlText}).Parse(`<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Orquester</Author>
    <Description>Runs orq-agent's desktop-session helper in {{xml .User}}'s desktop session, so Orquester can start programs that need the desktop or the GPU there. Removed when this machine is removed from Orquester.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{{xml .User}}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{{xml .User}}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{{xml .Exe}}</Command>
      <Arguments>{{xml .Arguments}}</Arguments>
    </Exec>
  </Actions>
</Task>
`))

// renderDesktopTask is the task's XML. Priority 4 is normal priority (the default, 7, is below
// normal, and every program the helper starts would inherit it).
func renderDesktopTask(d desktopTaskData) (string, error) {
	for name, value := range map[string]string{"user": d.User, "executable path": d.Exe, "data dir": d.DataDir} {
		if value == "" || strings.IndexFunc(value, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
			return "", fmt.Errorf("the %s is empty or contains a control character", name)
		}
	}
	var b strings.Builder
	err := desktopTaskTemplate.Execute(&b, struct {
		desktopTaskData
		Arguments string
	}{d, "desktop-helper --data-dir " + windowsArg(d.DataDir)})
	if err != nil {
		return "", err
	}
	return b.String(), nil
}

// utf16File encodes text as UTF-16LE with a byte-order mark: what `schtasks /XML` reads
// whatever the system's code page.
func utf16File(text string) []byte {
	units := utf16.Encode([]rune(strings.ReplaceAll(text, "\n", "\r\n")))
	out := make([]byte, 2+2*len(units))
	out[0], out[1] = 0xff, 0xfe
	for i, u := range units {
		binary.LittleEndian.PutUint16(out[2+2*i:], u)
	}
	return out
}

// windowsArg quotes one argument the way CommandLineToArgvW (and Go's os/exec) reads it back.
func windowsArg(arg string) string {
	if arg != "" && !strings.ContainsAny(arg, " \t\"") {
		return arg
	}
	var b strings.Builder
	b.WriteByte('"')
	slashes := 0
	for _, r := range arg {
		switch r {
		case '\\':
			slashes++
			continue
		case '"':
			b.WriteString(strings.Repeat(`\`, 2*slashes+1))
		default:
			b.WriteString(strings.Repeat(`\`, slashes))
		}
		slashes = 0
		b.WriteRune(r)
	}
	b.WriteString(strings.Repeat(`\`, 2*slashes))
	b.WriteByte('"')
	return b.String()
}

// DesktopHelperOptions are install-desktop-helper's and uninstall-desktop-helper's flags.
type DesktopHelperOptions struct {
	// User: the desktop user (`name` or `DOMAIN\name`) the helper runs as.
	User    string
	DataDir string
	DryRun  bool
}

// desktopDataDir is the data dir a desktop-helper command acts on.
func desktopDataDir(dataDir string) (string, error) {
	if dataDir == "" {
		dataDir = os.Getenv("ORQ_DATA_DIR")
	}
	if dataDir == "" {
		dataDir = DefaultDataDir()
	}
	return filepath.Abs(dataDir)
}

// noDesktopHelperMessage: exec with session "desktop" where no helper can exist.
var noDesktopHelperMessage = func() string {
	if isWindows {
		return "this machine has no desktop-session helper (only machines paired with Orquester get one): pair it again to install it"
	}
	return `only Windows machines run commands in a separate desktop session; run the command without "session" here`
}()
