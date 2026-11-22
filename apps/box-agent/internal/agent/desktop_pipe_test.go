package agent

import (
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"unicode/utf16"
)

// scriptedProc is a process the fake helper "starts": `run` writes its output and returns its
// exit code; kill ends it with code -1.
type scriptedProc struct {
	n                int
	stdinR           *io.PipeReader
	stdinW           *io.PipeWriter
	stdoutR, stderrR *io.PipeReader
	stdoutW, stderrW *io.PipeWriter
	killOnce         sync.Once
	killed           chan struct{}
	done             chan struct{}
	code             int
}

var scriptedPIDs atomic.Int32

func startScripted(run func(p *scriptedProc) int) *scriptedProc {
	p := &scriptedProc{n: int(scriptedPIDs.Add(1)), killed: make(chan struct{}), done: make(chan struct{})}
	p.stdinR, p.stdinW = io.Pipe()
	p.stdoutR, p.stdoutW = io.Pipe()
	p.stderrR, p.stderrW = io.Pipe()
	go func() {
		code := run(p)
		_ = p.stdoutW.Close()
		_ = p.stderrW.Close()
		p.code = code
		close(p.done)
	}()
	return p
}

func (p *scriptedProc) pid() int              { return p.n }
func (p *scriptedProc) stdin() io.WriteCloser { return p.stdinW }
func (p *scriptedProc) stdout() io.Reader     { return p.stdoutR }
func (p *scriptedProc) stderr() io.Reader     { return p.stderrR }
func (p *scriptedProc) wait() (*int, *string) {
	<-p.done
	code := p.code
	return &code, nil
}
func (p *scriptedProc) signal(string) error   { p.kill(); return nil }
func (p *scriptedProc) resize(int, int) error { return nil }
func (p *scriptedProc) kill() {
	p.killOnce.Do(func() {
		close(p.killed)
		_ = p.stdinR.CloseWithError(io.ErrClosedPipe)
	})
}
func (p *scriptedProc) closeOutput() {
	_ = p.stdoutR.Close()
	_ = p.stderrR.Close()
}
func (p *scriptedProc) release() {}

// connectHelper links a hub to a helper over an in-memory pipe; `start` plays the OS.
func connectHelper(t *testing.T, hub *desktopHub, version string, start func(*startSpec) (process, error)) (*deskSession, chan error) {
	t.Helper()
	service, helper := net.Pipe()
	ended := make(chan error, 1)
	go hub.serveConn(service)
	go func() {
		ended <- runDeskHelperSession(helper, version, start, func() []string { return []string{"PATH=" + os.Getenv("PATH")} })
	}()
	session := hub.await(nil)
	if session == nil {
		t.Fatal("the helper did not connect")
	}
	t.Cleanup(func() { session.conn.close() })
	return session, ended
}

func testHub(version string) *desktopHub {
	hub := newDesktopHub(log.New(io.Discard, "", 0), version, true)
	return hub
}

// The helper resolves commands on its own PATH: give it one that exists everywhere.
func helperCommand(t *testing.T) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return exe
}

func TestDesktopPipeStreamsBeyondTheWindowWithoutHoldingUpOtherProcesses(t *testing.T) {
	big := bytes.Repeat([]byte("0123456789abcdef"), 3*deskWindowBytes/16+5)
	hub := testHub("1.0")
	var starts atomic.Int32
	session, _ := connectHelper(t, hub, "1.0", func(spec *startSpec) (process, error) {
		if starts.Add(1) == 1 {
			// First: far more output than one window, read only at the end.
			return startScripted(func(p *scriptedProc) int {
				if _, err := p.stdoutW.Write(big); err != nil {
					return 9
				}
				return 0
			}), nil
		}
		// Second: echoes its input on stdout, a line on stderr, exits 3.
		return startScripted(func(p *scriptedProc) int {
			data, _ := io.ReadAll(p.stdinR)
			_, _ = p.stdoutW.Write(append([]byte("got "), data...))
			_, _ = p.stderrW.Write([]byte("warn"))
			return 3
		}), nil
	})
	command := helperCommand(t)
	first, err := session.start(deskStartMsg{Command: command})
	if err != nil {
		t.Fatal(err)
	}
	second, err := session.start(deskStartMsg{Command: command})
	if err != nil {
		t.Fatal(err)
	}
	// The first process's unread output fills its window; the second still runs to the end.
	if _, err := second.stdin().Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	_ = second.stdin().Close()
	out, _ := io.ReadAll(second.stdout())
	errOut, _ := io.ReadAll(second.stderr())
	if code, _ := second.wait(); string(out) != "got hello" || string(errOut) != "warn" || code == nil || *code != 3 {
		t.Fatalf("second: stdout %q stderr %q exit %v", out, errOut, code)
	}
	second.release()

	got, _ := io.ReadAll(first.stdout())
	if code, _ := first.wait(); !bytes.Equal(got, big) || code == nil || *code != 0 {
		t.Fatalf("first: %d of %d bytes intact=%v, exit %v", len(got), len(big), bytes.Equal(got, big), code)
	}
}

func TestDesktopPipeHelperGoneReportsItsProcessesKilledAndKillsThem(t *testing.T) {
	hub := testHub("1.0")
	started := make(chan *scriptedProc, 1)
	session, ended := connectHelper(t, hub, "1.0", func(*startSpec) (process, error) {
		p := startScripted(func(p *scriptedProc) int {
			<-p.killed
			return -1
		})
		started <- p
		return p, nil
	})
	proc, err := session.start(deskStartMsg{Command: helperCommand(t)})
	if err != nil {
		t.Fatal(err)
	}
	helperSide := <-started
	session.conn.close()
	code, sig := proc.wait()
	if code != nil || sig == nil || *sig != "SIGKILL" {
		t.Fatalf("exit after the helper went away: code %v signal %v", code, sig)
	}
	<-helperSide.done
	<-ended
	if hub.connected() != nil {
		t.Fatal("the hub still lists the helper")
	}
}

func TestDesktopPipeRefusesAHelperOfAnotherBuildAndStartsTheRightOne(t *testing.T) {
	hub := testHub("2.0")
	kicked := make(chan struct{}, 1)
	hub.kick = func() { kicked <- struct{}{} }
	service, helper := net.Pipe()
	go hub.serveConn(service)
	err := runDeskHelperSession(helper, "1.0", func(*startSpec) (process, error) {
		t.Error("a refused helper started a process")
		return nil, errors.New("no")
	}, os.Environ)
	if !errors.Is(err, errDeskHelperExit) {
		t.Fatalf("helper of another build: %v", err)
	}
	<-kicked
	if hub.connected() != nil {
		t.Fatal("a refused helper became the hub's helper")
	}
}

func TestDesktopPipeHelperResolvesCommandsInItsOwnEnvironment(t *testing.T) {
	hub := testHub("1.0")
	var seen *startSpec
	session, _ := connectHelper(t, hub, "1.0", func(spec *startSpec) (process, error) {
		seen = spec
		return startScripted(func(*scriptedProc) int { return 0 }), nil
	})
	_, err := session.start(deskStartMsg{Command: "orq-no-such-command-anywhere"})
	if err == nil || !strings.Contains(err.Error(), "ENOENT") {
		t.Fatalf("missing command: %v", err)
	}
	proc, err := session.start(deskStartMsg{Command: helperCommand(t), Env: map[string]string{"ORQ_BOX_ID": "box-1"}, EnvUnset: []string{"PATH"}})
	if err != nil {
		t.Fatal(err)
	}
	proc.wait()
	if envLookup(seen.env, "ORQ_BOX_ID") != "box-1" || envLookup(seen.env, "PATH") != "" {
		t.Fatalf("env: %v", seen.env)
	}
}

func TestDesktopTaskRunsTheHelperInTheUsersSessionAndQuotesItsDataDir(t *testing.T) {
	task, err := renderDesktopTask(desktopTaskData{User: `PC\user`, Exe: `C:\orq\agent\orq-agent.exe`, DataDir: `C:\Program Data\orq\`})
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Trigger   string `xml:"Triggers>LogonTrigger>UserId"`
		User      string `xml:"Principals>Principal>UserId"`
		LogonType string `xml:"Principals>Principal>LogonType"`
		RunLevel  string `xml:"Principals>Principal>RunLevel"`
		Limit     string `xml:"Settings>ExecutionTimeLimit"`
		Restart   string `xml:"Settings>RestartOnFailure>Count"`
		Command   string `xml:"Actions>Exec>Command"`
		Arguments string `xml:"Actions>Exec>Arguments"`
	}
	// encoding/xml refuses a declared UTF-16 document it was handed as UTF-8 text.
	if err := xml.Unmarshal([]byte(strings.Replace(task, `encoding="UTF-16"`, `encoding="UTF-8"`, 1)), &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.Trigger != `PC\user` || parsed.User != `PC\user` || parsed.LogonType != "InteractiveToken" || parsed.RunLevel != "HighestAvailable" ||
		parsed.Limit != "PT0S" || parsed.Restart == "" || parsed.Command != `C:\orq\agent\orq-agent.exe` {
		t.Fatalf("task: %+v", parsed)
	}
	// CommandLineToArgvW: a trailing backslash before the closing quote is doubled.
	if parsed.Arguments != `desktop-helper --data-dir "C:\Program Data\orq\\"` {
		t.Fatalf("arguments: %s", parsed.Arguments)
	}

	file := utf16File("<a>é</a>\n")
	if file[0] != 0xff || file[1] != 0xfe {
		t.Fatal("no UTF-16LE byte-order mark")
	}
	units := make([]uint16, (len(file)-2)/2)
	for i := range units {
		units[i] = uint16(file[2+2*i]) | uint16(file[3+2*i])<<8
	}
	if got := string(utf16.Decode(units)); got != "<a>é</a>\r\n" {
		t.Fatalf("decoded %q", got)
	}
}

func TestDesktopPipeOpensOnlyToAUserAccount(t *testing.T) {
	if _, err := desktopPipeSecurity("S-1-5-21-2155407436-1256685922-3698577549-1001"); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	for _, sid := range []string{"S-1-1-0", "S-1-5-11", "S-1-5-32-545", "S-1-5-21-1-2-3-4)(A;;GA;;;WD"} {
		if _, err := desktopPipeSecurity(sid); err == nil {
			t.Errorf("%s: pipe security accepted", sid)
		}
		if err := os.WriteFile(filepath.Join(dir, desktopMarkerFile), []byte(`{"user":"x","sid":"`+sid+`"}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if m, err := readDesktopMarker(dir); err == nil {
			t.Errorf("%s: marker accepted: %+v", sid, m)
		}
	}
	if m, err := readDesktopMarker(t.TempDir()); m != nil || err != nil {
		t.Fatalf("no marker: %+v, %v", m, err)
	}
}
