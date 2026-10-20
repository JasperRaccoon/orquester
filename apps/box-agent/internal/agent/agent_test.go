package agent

import (
	"context"
	"testing"
	"time"

	"orquester/box-agent/internal/wire"
)

func TestEveryHostToBoxMethodHasAHandler(t *testing.T) {
	for name := range wire.HostToBoxMethods {
		if _, ok := requestHandlers[name]; !ok {
			t.Errorf("no handler for %s", name)
		}
	}
	for name := range requestHandlers {
		if _, ok := wire.HostToBoxMethods[name]; !ok {
			t.Errorf("handler for %s, which is not a protocol method", name)
		}
	}
}

func TestRingKeepsNewestBytesAndReportsStart(t *testing.T) {
	r := newRing(10)
	r.append(1, []byte("hello"))
	r.append(2, []byte("world!"))
	start, total := r.bounds()
	if start != 1 || total != 11 {
		t.Fatalf("bounds = %d,%d; want 1,11", start, total)
	}
	// Offset 0 was overwritten: reported, never skipped silently.
	if _, data, _, _, _, overrun := r.read(0, 100); !overrun || data != nil {
		t.Fatalf("a read before the buffer start must report an overrun")
	}
	stream, data, next, _, _, _ := r.read(start, 100)
	if stream != 1 || string(data) != "ello" || next != 5 {
		t.Fatalf("first read = %d %q %d", stream, data, next)
	}
	stream, data, next, _, _, _ = r.read(next, 3)
	if stream != 2 || string(data) != "wor" || next != 8 {
		t.Fatalf("second read = %d %q %d", stream, data, next)
	}
	_, data, _, finished, wait, _ := r.read(11, 100)
	if data != nil || finished || wait == nil {
		t.Fatalf("read at the end should wait")
	}
	r.finish()
	select {
	case <-wait:
	case <-time.After(time.Second):
		t.Fatal("finish did not wake the reader")
	}
	if _, _, _, finished, _, _ := r.read(11, 100); !finished {
		t.Fatal("finished not reported")
	}
}

func TestConnectURL(t *testing.T) {
	cases := map[string]string{
		"https://d.example":       "wss://d.example/api/boxes/connect",
		"http://127.0.0.1:47931/": "ws://127.0.0.1:47931/api/boxes/connect",
		"https://d.example/t2":    "wss://d.example/t2/api/boxes/connect",
	}
	for in, want := range cases {
		got, err := connectURL(in)
		if err != nil || got != want {
			t.Errorf("connectURL(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	if origin := daemonOrigin("https://d.example:8443/t2"); origin != "https://d.example:8443" {
		t.Errorf("daemonOrigin = %q", origin)
	}
	if _, err := connectURL("ftp://x"); err == nil {
		t.Error("ftp must be refused")
	}
}

func TestEnvMergeOrder(t *testing.T) {
	env := newEnvMap([]string{"A=1", "B=2", "C=3"})
	env.del("B")
	env.set("C", "4")
	env.set("D", "5")
	got := env.list()
	want := []string{"A=1", "C=4", "D=5"}
	if len(got) != len(want) {
		t.Fatalf("env = %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("env = %v; want %v", got, want)
		}
	}
}

func TestWatchCoalescing(t *testing.T) {
	w := &watch{root: "/r", params: wire.WatchParams{Recursive: true}, pending: map[string]string{}}
	w.ctx, w.cancel = context.WithCancel(context.Background())
	defer w.cancel()
	w.emit("/r/a", "create")
	w.emit("/r/a", "update")
	w.emit("/r/b", "create")
	w.emit("/r/b", "delete")
	w.emit("/r/c", "delete")
	w.emit("/r/c", "create")
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.timer != nil {
		w.timer.Stop()
	}
	if w.pending["/r/a"] != "create" || w.pending["/r/c"] != "update" {
		t.Fatalf("pending = %v", w.pending)
	}
	if _, ok := w.pending["/r/b"]; ok {
		t.Fatalf("create+delete should cancel out: %v", w.pending)
	}
}

func TestWatchIgnore(t *testing.T) {
	w := &watch{root: "/r", params: wire.WatchParams{Ignore: []string{"node_modules", "*.log", "build/out"}}}
	for path, want := range map[string]bool{
		"/r/node_modules/x/y.js": true,
		"/r/src/a.log":           true,
		"/r/build/out/z":         true,
		"/r/build/keep":          false,
		"/r/src/a.ts":            false,
	} {
		if got := w.ignored(path); got != want {
			t.Errorf("ignored(%s) = %v", path, got)
		}
	}
}
