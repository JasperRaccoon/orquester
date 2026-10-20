//go:build !windows

package agent

import (
	"net/http"
	"net/http/httptest"
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
	previous := outputDrainAfterExit
	outputDrainAfterExit = 20 * time.Millisecond
	paused := make(chan struct{}, 1)
	drainPausedHook = func() {
		select {
		case paused <- struct{}{}:
		default:
		}
	}
	t.Cleanup(func() {
		outputDrainAfterExit = previous
		drainPausedHook = nil
	})

	// One window plus a tail that is still in the pipe when the process exits.
	const size = wire.ChannelWindowBytes + 50*1024
	d := newTestDaemon(t)
	d.openExec(1, map[string]any{"command": "head", "args": []string{"-c", strconv.Itoa(size), "/dev/zero"}})
	received := 0
	for received < wire.ChannelWindowBytes {
		received += len(d.nextData(1))
	}
	// No credit yet: the process exits, the drain deadline passes while the
	// pump waits for credit, and the channel must stay open.
	select {
	case <-paused:
	case msg := <-d.msgs:
		t.Fatalf("the channel ended before its output was delivered: %v", msg)
	case <-time.After(10 * time.Second):
		t.Fatal("the drain never waited for credit")
	}
	d.send(map[string]any{"t": "credit", "ch": 1, "bytes": received})
	credited := received
	for received < size {
		received += len(d.nextData(1))
		if received-credited >= 64*1024 || received == size {
			d.send(map[string]any{"t": "credit", "ch": 1, "bytes": received - credited})
			credited = received
		}
	}
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
	t.Setenv("ORQ_TAILSCALE_AUTHKEY", "tskey-auth-test-secret")
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
	req, _ := http.NewRequest(http.MethodGet, redirecting.URL+"/api/boxes/agent/linux-x64", nil)
	req.Header.Set("Authorization", "Bearer secret")
	res, err := daemonClient(Config{}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusFound {
		t.Fatalf("status = %d; want the 302 itself", res.StatusCode)
	}
	if daemonClient(Config{Proxy: "http://127.0.0.1:1055"}).CheckRedirect == nil {
		t.Fatal("the proxied client must refuse redirects too")
	}
	if hits.Load() != 0 {
		t.Fatalf("the redirect target was requested %d times", hits.Load())
	}
}
