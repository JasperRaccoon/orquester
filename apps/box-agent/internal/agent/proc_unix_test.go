//go:build !windows

package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/sys/unix"

	"orquester/box-agent/internal/wire"
)

// spawnsGrandchild prints the pid of a background child, then waits for it.
const spawnsGrandchild = `sleep 1000 & echo "$!"; wait`

// testDaemon plays the daemon's side of a link to an in-process agent.
type testDaemon struct {
	t     *testing.T
	ctx   context.Context
	conn  *websocket.Conn
	agent *Agent
	msgs  chan map[string]any
	data  chan dataFrame
}

type dataFrame struct {
	ch      uint32
	payload []byte
}

func newTestDaemon(t *testing.T) *testDaemon {
	t.Helper()
	a := &Agent{
		log:    log.New(io.Discard, "", 0),
		procs:  newProcRegistry(),
		linkUp: make(chan struct{}),
		stop:   make(chan struct{}),
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		conn.SetReadLimit(-1)
		newLink(a, conn, "box-test", wire.AgentConfig{}).serve()
	}))
	ctx, cancel := context.WithCancel(context.Background())
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		cancel()
		srv.Close()
		t.Fatal(err)
	}
	conn.SetReadLimit(-1)
	d := &testDaemon{
		t:     t,
		ctx:   ctx,
		conn:  conn,
		agent: a,
		msgs:  make(chan map[string]any, 1024),
		data:  make(chan dataFrame, 1024),
	}
	go d.readLoop()
	t.Cleanup(func() {
		a.procs.killAll()
		_ = conn.CloseNow()
		cancel()
		srv.Close()
	})
	return d
}

func (d *testDaemon) readLoop() {
	defer close(d.msgs)
	defer close(d.data)
	for {
		kind, raw, err := d.conn.Read(d.ctx)
		if err != nil {
			return
		}
		if kind == websocket.MessageBinary {
			ch, _, payload, err := wire.DecodeDataFrame(raw)
			if err == nil {
				d.data <- dataFrame{ch: ch, payload: append([]byte(nil), payload...)}
			}
			continue
		}
		var msg map[string]any
		if json.Unmarshal(raw, &msg) == nil {
			d.msgs <- msg
		}
	}
}

func (d *testDaemon) send(v any) {
	d.t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		d.t.Fatal(err)
	}
	if err := d.conn.Write(d.ctx, websocket.MessageText, data); err != nil {
		d.t.Fatal(err)
	}
}

// expect returns the next control message matching `match`, skipping others.
func (d *testDaemon) expect(what string, match func(map[string]any) bool) map[string]any {
	d.t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case msg, ok := <-d.msgs:
			if !ok {
				d.t.Fatalf("link closed while waiting for %s", what)
			}
			if match(msg) {
				return msg
			}
		case <-deadline:
			d.t.Fatalf("timed out waiting for %s", what)
		}
	}
}

func isMsg(t string, ch int) func(map[string]any) bool {
	return func(msg map[string]any) bool {
		return msg["t"] == t && msg["ch"] == float64(ch)
	}
}

// openExec opens an exec channel and returns the started process's pid.
func (d *testDaemon) openExec(ch int, spec map[string]any) int {
	d.t.Helper()
	spec["kind"] = "exec"
	d.send(map[string]any{"t": "open", "ch": ch, "spec": spec})
	opened := d.expect("opened", func(msg map[string]any) bool {
		if msg["t"] == "open-failed" && msg["ch"] == float64(ch) {
			d.t.Fatalf("open failed: %v", msg["error"])
		}
		return isMsg("opened", ch)(msg)
	})
	info, _ := opened["info"].(map[string]any)
	pid, ok := info["pid"].(float64)
	if !ok || pid <= 0 {
		d.t.Fatalf("opened without a pid: %v", opened)
	}
	return int(pid)
}

var pidLine = regexp.MustCompile(`(?m)^\s*(\d+)\s*$`)

// readPID reads the channel's output until it printed a pid on its own line.
func (d *testDaemon) readPID(ch int) int {
	d.t.Helper()
	var out strings.Builder
	deadline := time.After(10 * time.Second)
	for {
		select {
		case frame, ok := <-d.data:
			if !ok {
				d.t.Fatalf("link closed; output so far %q", out.String())
			}
			if frame.ch != uint32(ch) {
				continue
			}
			out.Write(frame.payload)
			if m := pidLine.FindStringSubmatch(strings.ReplaceAll(out.String(), "\r", "")); m != nil {
				pid, _ := strconv.Atoi(m[1])
				killOnCleanup(d.t, pid)
				return pid
			}
		case <-deadline:
			d.t.Fatalf("no pid printed; output so far %q", out.String())
		}
	}
}

// killOnCleanup makes sure a test's grandchild never outlives it.
func killOnCleanup(t *testing.T, pid int) {
	t.Cleanup(func() { _ = unix.Kill(pid, unix.SIGKILL) })
}

// processGone: no such process, or only a zombie left for its new parent to reap.
func processGone(pid int) bool {
	if errors.Is(unix.Kill(pid, 0), unix.ESRCH) {
		return true
	}
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return false
	}
	// pid (comm) state ...: comm may contain spaces, the state follows its ')'.
	if i := strings.LastIndexByte(string(stat), ')'); i >= 0 && i+2 < len(stat) {
		return stat[i+2] == 'Z'
	}
	return false
}

func assertGone(t *testing.T, pids ...int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for _, pid := range pids {
		for !processGone(pid) {
			if time.Now().After(deadline) {
				t.Fatalf("process %d is still running", pid)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
}

func shellSpec(command string, pty bool) map[string]any {
	spec := map[string]any{"command": command, "args": []string{}, "shell": true}
	if pty {
		spec["pty"] = map[string]any{"cols": 80, "rows": 24}
	}
	return spec
}

func TestChannelSignalEndsTheWholeProcessGroup(t *testing.T) {
	for _, tc := range []struct {
		name    string
		pty     bool
		command string
		signal  string
	}{
		{"exec", false, spawnsGrandchild, "SIGTERM"},
		{"exec-kill", false, spawnsGrandchild, "SIGKILL"},
		{"pty", true, spawnsGrandchild, "SIGTERM"},
		// Job control puts the background job in a group of its own.
		{"pty-job-control", true, "set -m; " + spawnsGrandchild, "SIGTERM"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := newTestDaemon(t)
			pid := d.openExec(1, shellSpec(tc.command, tc.pty))
			child := d.readPID(1)
			if tc.name == "pty-job-control" {
				if group, err := unix.Getpgid(child); err != nil || group == pid {
					t.Fatalf("background job should have its own group: pgid %d (%v), shell %d", group, err, pid)
				}
			}
			d.send(map[string]any{"t": "signal", "ch": 1, "signal": tc.signal})
			assertGone(t, pid, child)
			exit := d.expect("exit", isMsg("exit", 1))
			if !tc.pty && exit["signal"] != tc.signal {
				t.Fatalf("exit = %v; want signal %s", exit, tc.signal)
			}
		})
	}
}

func TestChannelCloseHangsUpTheWholeProcessGroup(t *testing.T) {
	d := newTestDaemon(t)
	pid := d.openExec(1, shellSpec(spawnsGrandchild, false))
	child := d.readPID(1)
	d.send(map[string]any{"t": "close", "ch": 1})
	assertGone(t, pid, child)
}

func TestProcSignalEndsADetachedProcessGroup(t *testing.T) {
	for _, pty := range []bool{false, true} {
		t.Run("pty="+strconv.FormatBool(pty), func(t *testing.T) {
			d := newTestDaemon(t)
			spec := shellSpec(spawnsGrandchild, pty)
			spec["detach"] = map[string]any{"procId": "p1"}
			pid := d.openExec(1, spec)
			child := d.readPID(1)
			d.send(map[string]any{"t": "req", "id": 1, "method": "proc.signal", "params": map[string]any{"procId": "p1", "signal": "SIGTERM"}})
			res := d.expect("proc.signal response", func(msg map[string]any) bool {
				return msg["t"] == "res" && msg["id"] == float64(1)
			})
			if res["ok"] != true {
				t.Fatalf("proc.signal failed: %v", res)
			}
			assertGone(t, pid, child)
		})
	}
}

// A signal or resize from the link races the exit path closing the PTY master
// (run with -race): neither may read the master's descriptor unsynchronized
// with that Close, and after it neither may touch the closed descriptor.
func TestPtyCallsRacingReleaseNeverUseAClosedMaster(t *testing.T) {
	p, err := startProcess(&startSpec{
		path: "/bin/sh",
		args: []string{"/bin/sh", "-c", "exec sleep 30"},
		env:  os.Environ(),
		pty:  &wire.PtySpec{Cols: 80, Rows: 24},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		p.kill()
		p.wait()
	})
	up := p.(*unixProcess)
	stop := make(chan struct{})
	var started, done sync.WaitGroup
	for range 4 {
		started.Add(1)
		done.Add(1)
		go func() {
			defer done.Done()
			first := true
			for {
				_ = p.resize(100, 30)
				_ = up.targets(true)
				if first {
					started.Done()
					first = false
				}
				select {
				case <-stop:
					return
				default:
				}
			}
		}()
	}
	started.Wait()
	p.closeOutput()
	p.release()
	close(stop)
	done.Wait()

	if err := p.resize(90, 20); err == nil {
		t.Fatal("resize after release succeeded on a closed master")
	}
	if got := up.targets(false); !slices.Equal(got, []int{p.pid()}) {
		t.Fatalf("targets after release = %v; want only the process group %d", got, p.pid())
	}
}

// startShell starts `command` through startProcess and returns the process and
// the pid of the background child it printed.
func startShell(t *testing.T, command string, pty bool) (process, int) {
	t.Helper()
	spec := &startSpec{path: "/bin/sh", args: []string{"/bin/sh", "-c", command}, env: os.Environ()}
	if pty {
		spec.pty = &wire.PtySpec{Cols: 80, Rows: 24}
	}
	p, err := startProcess(spec)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		p.kill()
		p.wait()
		p.release()
	})
	lines := bufio.NewScanner(p.stdout())
	for lines.Scan() {
		if m := pidLine.FindStringSubmatch(strings.TrimRight(lines.Text(), "\r")); m != nil {
			pid, _ := strconv.Atoi(m[1])
			killOnCleanup(t, pid)
			return p, pid
		}
	}
	t.Fatalf("no pid printed: %v", lines.Err())
	return nil, 0
}

func TestKillEndsTheWholeTree(t *testing.T) {
	for _, tc := range []struct {
		name    string
		pty     bool
		command string
	}{
		{"exec", false, spawnsGrandchild},
		{"pty", true, spawnsGrandchild},
		{"pty-job-control", true, "set -m; " + spawnsGrandchild},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, child := startShell(t, tc.command, tc.pty)
			p.kill()
			if _, sig := p.wait(); sig == nil || *sig != "SIGKILL" {
				t.Fatalf("wait signal = %v; want SIGKILL", sig)
			}
			assertGone(t, child)
		})
	}
}

// A child that left its process group is still signalled, by pid.
func TestSignalFallsBackToThePidWhenTheGroupIsGone(t *testing.T) {
	spec := &startSpec{
		path: os.Args[0],
		args: []string{os.Args[0], "-test.run=^TestHelperLeaveGroup$"},
		env:  append(os.Environ(), "ORQ_TEST_HELPER=leave-group"),
	}
	p, err := startProcess(spec)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		p.kill()
		p.wait()
		p.release()
	})
	ready := bufio.NewScanner(p.stdout())
	if !ready.Scan() || ready.Text() != "ready" {
		t.Fatalf("helper did not get ready: %q %v", ready.Text(), ready.Err())
	}
	if err := unix.Kill(-p.pid(), 0); !errors.Is(err, unix.ESRCH) {
		t.Fatalf("the helper's own group should be gone: %v", err)
	}
	if err := p.signal("SIGTERM"); err != nil {
		t.Fatal(err)
	}
	exited := make(chan *string, 1)
	go func() {
		_, sig := p.wait()
		exited <- sig
	}()
	select {
	case sig := <-exited:
		if sig == nil || *sig != "SIGTERM" {
			t.Fatalf("wait signal = %v; want SIGTERM", sig)
		}
	case <-time.After(10 * time.Second):
		// Cleanup's kill() ends it by pid.
		t.Fatal("the helper did not get the signal")
	}
}

// TestHelperLeaveGroup is the child of the test above: it moves into its
// parent's process group, then waits to be signalled.
func TestHelperLeaveGroup(t *testing.T) {
	if os.Getenv("ORQ_TEST_HELPER") != "leave-group" {
		t.Skip("helper process only")
	}
	group, err := unix.Getpgid(os.Getppid())
	if err != nil {
		os.Exit(2)
	}
	if err := unix.Setpgid(0, group); err != nil {
		os.Exit(3)
	}
	os.Stdout.WriteString("ready\n")
	_, _ = io.Copy(io.Discard, os.Stdin)
	os.Exit(0)
}
