//go:build !windows

package agent

import (
	"bytes"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"orquester/box-agent/internal/wire"
)

// sendInput writes `text` to the process behind channel `ch` (stream 0).
func (d *testDaemon) sendInput(ch int, text string) {
	d.t.Helper()
	frame, err := wire.EncodeDataFrame(uint32(ch), wire.StreamToBox, []byte(text))
	if err != nil {
		d.t.Fatal(err)
	}
	if err := d.conn.Write(d.ctx, websocket.MessageBinary, frame); err != nil {
		d.t.Fatal(err)
	}
}

// nextData returns the next data frame of channel `ch`, failing after 10 s.
func (d *testDaemon) nextData(ch int) []byte {
	d.t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case frame, ok := <-d.data:
			if !ok {
				d.t.Fatal("link closed while waiting for data")
			}
			if frame.ch == uint32(ch) {
				return frame.payload
			}
		case <-deadline:
			d.t.Fatal("timed out waiting for data")
		}
	}
}

// A non-detached exec whose daemon withholds credit past the drain deadline
// still delivers every byte before `exit`: waiting for credit is not idle.
func TestExecOutputTailSurvivesADaemonSlowerThanTheDrainDeadline(t *testing.T) {
	const tailBytes = 4096
	const size = wire.ChannelWindowBytes + 1 + tailBytes
	d := newTestDaemon(t)
	pid := d.openExec(1, shellSpec("head -c "+strconv.Itoa(wire.ChannelWindowBytes-1)+
		" /dev/zero; read first; printf xy; read finish; head -c "+strconv.Itoa(tailBytes)+" /dev/zero", false))
	received := 0
	for received < wire.ChannelWindowBytes-1 {
		received += len(d.nextData(1))
	}
	// The two-byte write consumes the last credit byte with x, leaving the
	// pump blocked on y before the child is allowed to write its separate tail.
	d.sendInput(1, "first\n")
	if marker := d.nextData(1); string(marker) != "x" {
		t.Fatalf("last credited byte = %q; want x", marker)
	}
	received++
	d.sendInput(1, "finish\n")
	assertGone(t, pid)

	// Exercise the actual application timers: a daemon may withhold credit
	// longer than both two-second read-drain budgets after the child exited.
	hold := time.NewTimer(5 * time.Second)
	defer hold.Stop()
holding:
	for {
		select {
		case msg, ok := <-d.msgs:
			if !ok {
				t.Fatal("link closed before its pending output was delivered")
			}
			if isMsg("eof", 1)(msg) || isMsg("exit", 1)(msg) || isMsg("close", 1)(msg) {
				t.Fatalf("the channel ended before its output was delivered: %v", msg)
			}
		case <-hold.C:
			break holding
		}
	}
	d.send(map[string]any{"t": "credit", "ch": 1, "bytes": received})
	var tail []byte
	for len(tail) < tailBytes+1 {
		tail = append(tail, d.nextData(1)...)
	}
	if !bytes.Equal(tail, append([]byte{'y'}, make([]byte, tailBytes)...)) {
		t.Fatalf("pending output was lost or changed: got %d bytes; want y and %d zero bytes", len(tail), tailBytes)
	}
	received += len(tail)
	exit := d.expect("exit", isMsg("exit", 1))
	if exit["code"] != float64(0) {
		t.Fatalf("exit = %v", exit)
	}
	d.expect("close", isMsg("close", 1))
	if received != size {
		t.Fatalf("received %d bytes; want %d", received, size)
	}
}

// waitProc asks the box (proc.list) until `procId` satisfies `done`; every
// other control message seen meanwhile goes to `other`.
func (d *testDaemon) waitProc(procId string, done func(map[string]any) bool, other func(map[string]any)) {
	d.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for id := 1000; ; id++ {
		d.send(map[string]any{"t": "req", "id": id, "method": "proc.list", "params": map[string]any{}})
		res := d.expect("proc.list", func(msg map[string]any) bool {
			if msg["t"] == "res" && msg["id"] == float64(id) {
				return true
			}
			other(msg)
			return false
		})
		procs, _ := res["result"].([]any)
		for _, entry := range procs {
			proc, _ := entry.(map[string]any)
			if proc["procId"] == procId && done(proc) {
				return
			}
		}
		if time.Now().After(deadline) {
			d.t.Fatalf("process %s never reached the expected state", procId)
		}
	}
}

// A detached process that writes past its buffer faster than its viewer
// delivers (here: the viewer is stuck on credit) ends the viewer's channel
// with OUTPUT_OVERRUN rather than skipping the lost bytes.
func TestDetachedViewerThatFallsBehindItsBufferEndsWithAnError(t *testing.T) {
	d := newTestDaemon(t)
	// The process writes only once its viewer is there (on input), so the
	// viewer starts at offset 0 and has to fall behind, not start late.
	spec := shellSpec("read go; head -c "+strconv.Itoa(3*wire.ChannelWindowBytes)+" /dev/zero", false)
	spec["detach"] = map[string]any{"procId": "fast", "bufferBytes": 64 * 1024}
	d.openExec(1, spec)
	d.sendInput(1, "go\n")
	// The viewer may overrun on its own while the process writes.
	var closed map[string]any
	d.waitProc("fast", func(proc map[string]any) bool { return proc["running"] == false }, func(msg map[string]any) {
		if isMsg("close", 1)(msg) {
			closed = msg
		}
	})
	if closed == nil {
		// A viewer waiting for credit overruns on its next read.
		d.send(map[string]any{"t": "credit", "ch": 1, "bytes": wire.ChannelWindowBytes})
		closed = d.expect("close", isMsg("close", 1))
	}
	errInfo, _ := closed["error"].(map[string]any)
	if errInfo["code"] != "OUTPUT_OVERRUN" {
		t.Fatalf("close = %v; want an OUTPUT_OVERRUN error", closed)
	}
}

// An attach from an offset the buffer has dropped reports the loss up front.
func TestAttachFromADroppedOffsetReportsTheLoss(t *testing.T) {
	d := newTestDaemon(t)
	spec := shellSpec("printf 0123456789abcdef; read x", false)
	spec["detach"] = map[string]any{"procId": "small", "bufferBytes": 8}
	d.openExec(1, spec)
	d.waitProc("small", func(proc map[string]any) bool { return proc["outputBytes"] == float64(16) }, func(map[string]any) {})
	d.send(map[string]any{"t": "open", "ch": 2, "spec": map[string]any{"kind": "attach", "procId": "small", "fromOffset": 0}})
	opened := d.expect("attach opened", func(msg map[string]any) bool {
		return (msg["t"] == "opened" || msg["t"] == "open-failed") && msg["ch"] == float64(2)
	})
	info, _ := opened["info"].(map[string]any)
	if info["droppedBytes"] != float64(8) {
		t.Fatalf("opened = %v; want droppedBytes 8", opened)
	}
	d.send(map[string]any{"t": "req", "id": 1, "method": "proc.signal", "params": map[string]any{"procId": "small", "signal": "SIGKILL"}})
	d.expect("proc.signal", func(msg map[string]any) bool { return msg["t"] == "res" && msg["id"] == float64(1) })
}

// The Tailscale auth key a container box starts with is never inherited.
func TestProcessesNeverInheritTheTailscaleAuthKey(t *testing.T) {
	// Split so secret scanners do not read the fake key as a real one.
	t.Setenv("ORQ_TAILSCALE_AUTHKEY", "tskey-auth-"+"test-secret")
	d := newTestDaemon(t)
	d.openExec(1, shellSpec(`echo "key=${ORQ_TAILSCALE_AUTHKEY:-none}"`, false))
	var out strings.Builder
	for !strings.Contains(out.String(), "\n") {
		out.Write(d.nextData(1))
	}
	if out.String() != "key=none\n" {
		t.Fatalf("output = %q", out.String())
	}
}

// orq-agent started by a service manager has no HOME or USER: its processes get the box user's.
func TestProcessesGetHomeAndUserWhenOrqAgentHasNone(t *testing.T) {
	t.Setenv("HOME", "")
	t.Setenv("USER", "")
	t.Setenv("LOGNAME", "")
	d := newTestDaemon(t)
	account, err := user.LookupId(strconv.Itoa(os.Getuid()))
	if err != nil || account.HomeDir == "" || account.Username == "" {
		t.Skip("the host account database is unavailable")
	}
	// Refresh the agent as Run does, but use the OS account as the independent oracle.
	d.agent.refreshSysInfo()
	d.openExec(1, shellSpec(`echo "home=${HOME:-none} user=${USER:-none}"`, false))
	var out strings.Builder
	for !strings.Contains(out.String(), "\n") {
		out.Write(d.nextData(1))
	}
	if want := "home=" + account.HomeDir + " user=" + account.Username + "\n"; out.String() != want {
		t.Fatalf("output = %q, want %q", out.String(), want)
	}
}

// The daemon client answers a redirect as is: the credential it carries is
// never replayed to another URL.
func TestDaemonClientNeverFollowsRedirects(t *testing.T) {
	var hits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
	}))
	t.Cleanup(target.Close)
	redirecting := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/steal", http.StatusFound)
	}))
	t.Cleanup(redirecting.Close)
	for _, cfg := range []Config{{}, {Proxy: redirecting.URL}} {
		req, _ := http.NewRequest(http.MethodGet, redirecting.URL+"/api/boxes/agent/linux-x64", nil)
		req.Header.Set("Authorization", "Bearer secret")
		res, err := daemonClient(cfg).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		if res.StatusCode != http.StatusFound {
			t.Fatalf("status = %d; want the 302 itself", res.StatusCode)
		}
	}
	if hits.Load() != 0 {
		t.Fatalf("the redirect target was requested %d times", hits.Load())
	}
}

func TestUnixChannelBridgesASocketInTheBox(t *testing.T) {
	d := newTestDaemon(t)
	path := filepath.Join(t.TempDir(), "echo.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		buf := make([]byte, 64)
		n, _ := conn.Read(buf)
		conn.Write([]byte("echo:" + string(buf[:n])))
	}()
	d.send(map[string]any{"t": "open", "ch": 3, "spec": map[string]any{"kind": "unix", "path": path}})
	d.expect("opened", func(msg map[string]any) bool {
		if msg["t"] == "open-failed" && msg["ch"] == float64(3) {
			t.Fatalf("open failed: %v", msg["error"])
		}
		return isMsg("opened", 3)(msg)
	})
	d.sendInput(3, "vnc")
	if got := string(d.nextData(3)); got != "echo:vnc" {
		t.Fatalf("got %q", got)
	}
}

func TestUnixChannelRefusesARelativePathAndAMissingSocket(t *testing.T) {
	d := newTestDaemon(t)
	for _, tc := range []struct {
		ch         int
		path, code string
	}{
		{5, "vnc.sock", "BAD_REQUEST"},
		{7, filepath.Join(t.TempDir(), "none.sock"), "ENOENT"},
	} {
		d.send(map[string]any{"t": "open", "ch": tc.ch, "spec": map[string]any{"kind": "unix", "path": tc.path}})
		failed := d.expect("open-failed", isMsg("open-failed", tc.ch))
		info, _ := failed["error"].(map[string]any)
		if info["code"] != tc.code {
			t.Fatalf("open %q failed for the wrong reason: %v", tc.path, failed)
		}
	}
}
