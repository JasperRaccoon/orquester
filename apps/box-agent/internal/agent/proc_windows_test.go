package agent

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"

	"orquester/box-agent/internal/wire"
)

// orq-agent's own standard handles are often pipes (a service supervisor, an SSH session, a
// redirected shell): a pty process must still read and write its pseudoconsole, not those.
func TestConPTYProcessUsesItsConsoleWhenOrqAgentsOutputIsRedirected(t *testing.T) {
	ownOutR, ownOutW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer ownOutR.Close()
	saved := map[uint32]windows.Handle{}
	for _, std := range []uint32{windows.STD_OUTPUT_HANDLE, windows.STD_ERROR_HANDLE} {
		if saved[std], err = windows.GetStdHandle(std); err != nil {
			t.Fatal(err)
		}
		if err := windows.SetStdHandle(std, windows.Handle(ownOutW.Fd())); err != nil {
			t.Fatal(err)
		}
	}
	restore := func() {
		for std, h := range saved {
			_ = windows.SetStdHandle(std, h)
		}
	}
	defer restore()

	cmd := filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe")
	proc, err := startProcess(&startSpec{path: cmd, args: []string{cmd, "/c", "echo conpty-out"}, env: os.Environ(), pty: &wire.PtySpec{Cols: 80, Rows: 24}})
	restore()
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(&out, proc.stdout())
		close(done)
	}()
	code, _ := proc.wait()
	<-done
	proc.release()
	_ = ownOutW.Close()
	leaked, _ := io.ReadAll(ownOutR)
	if code == nil || *code != 0 || !strings.Contains(out.String(), "conpty-out") {
		t.Fatalf("console output %q; written to orq-agent's own stdout: %q", out.String(), leaked)
	}
}
