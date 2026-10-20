package agent

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"orquester/box-agent/internal/wire"
)

// After a process exits, its output pipes may stay open (a background child
// inherited them): give them this long to drain before the channel ends.
const outputDrainAfterExit = 2 * time.Second

// hangupGrace: a non-detached process whose channel closed gets SIGHUP, then
// SIGKILL after this long.
const hangupGrace = 5 * time.Second

// handleOpen serves a daemon-opened channel. The channel is already
// registered (data frames may have arrived behind the open).
func (a *Agent) handleOpen(l *Link, ch *Channel, raw json.RawMessage) {
	kind, spec, err := wire.DecodeSpec(raw, false)
	if err != nil {
		ch.OpenFailed(rpcErr("BAD_REQUEST", err.Error()))
		return
	}
	switch s := spec.(type) {
	case *wire.ExecSpec:
		a.openExec(ch, s)
	case *wire.AttachSpec:
		a.openAttach(ch, s)
	case *wire.TCPSpec:
		openTCP(ch, s)
	case *wire.FileReadSpec:
		openFileRead(ch, s)
	case *wire.FileWriteSpec:
		a.openFileWrite(ch, s)
	case *wire.TarReadSpec:
		a.openTarRead(ch, s)
	case *wire.TarWriteSpec:
		a.openTarWrite(ch, s)
	default:
		// host-tcp, ssh-agent and mcp-bridge are opened by the box, never by the daemon.
		ch.OpenFailed(rpcErr("UNKNOWN_CHANNEL", "the box does not accept "+kind+" channels"))
	}
}

// startSpec is a resolved process launch.
type startSpec struct {
	path string
	args []string // argv including argv[0]
	dir  string
	env  []string
	pty  *wire.PtySpec
	work *workUser
}

func (a *Agent) buildStart(spec *wire.ExecSpec) (*startSpec, error) {
	shell := spec.Shell != nil && *spec.Shell
	if shell && len(spec.Args) > 0 {
		return nil, rpcErr("BAD_REQUEST", "shell mode takes the whole command line in `command`; args must be empty")
	}
	if spec.Command == "" {
		return nil, rpcErr("BAD_REQUEST", "command is required")
	}
	env := a.processEnv(spec.Env, spec.EnvUnset, spec.Pty)
	var argv []string
	switch {
	case shell && isWindows:
		argv = []string{"powershell.exe", "-NoProfile", "-NonInteractive", "-Command", spec.Command}
	case shell:
		argv = []string{"/bin/sh", "-c", spec.Command}
	default:
		argv = append([]string{spec.Command}, spec.Args...)
	}
	path, err := lookPath(argv[0], envLookup(env, "PATH"), envLookup(env, "PATHEXT"))
	if err != nil {
		return nil, err
	}
	dir := spec.Cwd
	if dir != "" {
		info, err := os.Stat(dir)
		if err != nil {
			return nil, err
		}
		if !info.IsDir() {
			return nil, rpcErr("ENOTDIR", "cwd is not a directory: "+dir)
		}
	}
	return &startSpec{path: path, args: argv, dir: dir, env: env, pty: spec.Pty, work: a.work}, nil
}

// processEnv: orq-agent's env (secrets removed) + ORQ_* + SSH_AUTH_SOCK, then
// `unset` removed, then `extra` merged over it.
func (a *Agent) processEnv(extra map[string]string, unset []string, pty *wire.PtySpec) []string {
	env := newEnvMap(os.Environ())
	for _, key := range secretEnv {
		env.del(key)
	}
	env.set("ORQ_AGENT_PATH", a.sysInfo().AgentPath)
	a.authMu.Lock()
	env.set("ORQ_BOX_ID", a.boxID)
	a.authMu.Unlock()
	if a.controlPath != "" {
		env.set("ORQ_AGENT_CONTROL", a.controlPath)
	}
	if a.sshSocket != "" {
		env.set("SSH_AUTH_SOCK", a.sshSocket)
	}
	if a.work != nil {
		env.set("HOME", a.work.home)
		env.set("USER", a.work.name)
		env.set("LOGNAME", a.work.name)
	}
	if pty != nil {
		term := pty.Term
		if term == "" {
			term = "xterm-256color"
		}
		env.set("TERM", term)
	}
	for _, key := range unset {
		env.del(key)
	}
	keys := make([]string, 0, len(extra))
	for key := range extra {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		env.set(key, extra[key])
	}
	return env.list()
}

// envMap is an ordered environment; keys compare case-insensitively on Windows.
type envMap struct {
	keys   []string
	values map[string]string
	names  map[string]string
}

func envKey(key string) string {
	if isWindows {
		return strings.ToUpper(key)
	}
	return key
}

func newEnvMap(environ []string) *envMap {
	m := &envMap{values: map[string]string{}, names: map[string]string{}}
	for _, kv := range environ {
		key, value, ok := strings.Cut(kv, "=")
		if !ok || key == "" {
			continue
		}
		m.set(key, value)
	}
	return m
}

func (m *envMap) set(key, value string) {
	k := envKey(key)
	if _, ok := m.values[k]; !ok {
		m.keys = append(m.keys, k)
		m.names[k] = key
	}
	m.values[k] = value
}

func (m *envMap) del(key string) {
	delete(m.values, envKey(key))
}

func (m *envMap) list() []string {
	out := make([]string, 0, len(m.values))
	for _, k := range m.keys {
		if value, ok := m.values[k]; ok {
			out = append(out, m.names[k]+"="+value)
		}
	}
	return out
}

func envLookup(env []string, key string) string {
	k := envKey(key)
	for i := len(env) - 1; i >= 0; i-- {
		name, value, ok := strings.Cut(env[i], "=")
		if ok && envKey(name) == k {
			return value
		}
	}
	return ""
}

// lookPath resolves a command against the process's PATH (not orq-agent's).
func lookPath(command, pathEnv, pathExt string) (string, error) {
	exts := []string{""}
	if isWindows {
		exts = []string{""}
		if filepath.Ext(command) == "" {
			if pathExt == "" {
				pathExt = ".COM;.EXE;.BAT;.CMD"
			}
			exts = nil
			for _, ext := range strings.Split(pathExt, ";") {
				if ext != "" {
					exts = append(exts, strings.ToLower(ext))
				}
			}
		}
	}
	try := func(candidate string) (string, bool) {
		for _, ext := range exts {
			full := candidate + ext
			if info, err := os.Stat(full); err == nil && !info.IsDir() && (isWindows || info.Mode()&0o111 != 0) {
				return full, true
			}
		}
		return "", false
	}
	if strings.ContainsRune(command, '/') || (isWindows && strings.ContainsAny(command, `\:`)) {
		if found, ok := try(command); ok {
			return found, nil
		}
		return "", rpcErr("ENOENT", "no such executable: "+command)
	}
	for _, dir := range filepath.SplitList(pathEnv) {
		if dir == "" {
			dir = "."
		}
		if found, ok := try(filepath.Join(dir, command)); ok {
			return found, nil
		}
	}
	return "", rpcErr("ENOENT", "command not found: "+command)
}

func pidInfo(pid int) *wire.OpenedInfo {
	return &wire.OpenedInfo{PID: &pid}
}

// pumpOutput copies one output stream into the channel; it ends at EOF, on a
// read error (a closed PTY reads EIO), or when the channel dies.
func pumpOutput(dst io.Writer, src io.Reader, wg *sync.WaitGroup) {
	defer wg.Done()
	if src == nil {
		return
	}
	_, _ = io.Copy(dst, src)
}

// waitDrained waits for the output pumps, at most outputDrainAfterExit.
func waitDrained(wg *sync.WaitGroup) bool {
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(outputDrainAfterExit):
		return false
	}
}

func (a *Agent) openExec(ch *Channel, spec *wire.ExecSpec) {
	start, err := a.buildStart(spec)
	if err != nil {
		ch.OpenFailed(err)
		return
	}
	if spec.Detach != nil {
		a.openDetached(ch, spec, start)
		return
	}
	proc, err := startProcess(start)
	if err != nil {
		ch.OpenFailed(err)
		return
	}
	var exited sync.Once
	exitedCh := make(chan struct{})
	ch.SetHandlers(
		func(cols, rows int) { _ = proc.resize(cols, rows) },
		func(name string) { _ = proc.signal(name) },
		func(*wire.RPCError) {
			// The daemon closed the channel or the link dropped: hang up.
			select {
			case <-exitedCh:
				return
			default:
			}
			_ = proc.signal("SIGHUP")
			time.AfterFunc(hangupGrace, func() {
				select {
				case <-exitedCh:
				default:
					proc.kill()
				}
			})
		},
	)
	if err := ch.Opened(pidInfo(proc.pid())); err != nil {
		proc.kill()
	}
	go func() {
		stdin := proc.stdin()
		if stdin == nil {
			return
		}
		_, err := io.Copy(stdin, ch.Reader())
		if err == nil && start.pty == nil {
			// The daemon's eof on stream 0 closes the process's stdin.
			_ = stdin.Close()
		}
	}()
	var wg sync.WaitGroup
	wg.Add(2)
	go pumpOutput(ch.StreamWriter(wire.StreamFromBox), proc.stdout(), &wg)
	go pumpOutput(ch.StreamWriter(wire.StreamStderr), proc.stderr(), &wg)
	code, signal := proc.wait()
	exited.Do(func() { close(exitedCh) })
	if !waitDrained(&wg) {
		proc.closeOutput()
		waitDrained(&wg)
	}
	proc.release()
	ch.EOF(wire.StreamFromBox)
	if start.pty == nil {
		ch.EOF(wire.StreamStderr)
	}
	ch.Exit(code, signal)
	ch.Close(nil)
}

func (a *Agent) openDetached(ch *Channel, spec *wire.ExecSpec, start *startSpec) {
	if spec.Detach.ProcID == "" {
		ch.OpenFailed(rpcErr("BAD_REQUEST", "detach.procId is required"))
		return
	}
	capacity := int64(wire.DetachBufferBytes)
	if spec.Detach.BufferBytes != nil && *spec.Detach.BufferBytes > 0 {
		capacity = *spec.Detach.BufferBytes
	}
	if a.procs.get(spec.Detach.ProcID) != nil {
		if existing := a.procs.get(spec.Detach.ProcID); existing.info().Running {
			ch.OpenFailed(rpcErr("EEXIST", "a detached process with this id is running"))
			return
		}
	}
	proc, err := startProcess(start)
	if err != nil {
		ch.OpenFailed(err)
		return
	}
	d := &detachedProc{
		id:      spec.Detach.ProcID,
		proc:    proc,
		pty:     start.pty != nil,
		ring:    newRing(capacity),
		running: true,
		pid:     proc.pid(),
		stdin:   proc.stdin(),
	}
	if !a.procs.add(d) {
		proc.kill()
		ch.OpenFailed(rpcErr("EEXIST", "a detached process with this id is running"))
		return
	}
	a.log.Printf("detached process %s started", d.id)
	go func() {
		var wg sync.WaitGroup
		wg.Add(2)
		go pumpOutput(ringWriter{d.ring, wire.StreamFromBox}, proc.stdout(), &wg)
		go pumpOutput(ringWriter{d.ring, wire.StreamStderr}, proc.stderr(), &wg)
		code, signal := proc.wait()
		if !waitDrained(&wg) {
			proc.closeOutput()
			waitDrained(&wg)
		}
		proc.release()
		d.mu.Lock()
		d.running = false
		d.exitCode = code
		d.signal = signal
		d.mu.Unlock()
		d.ring.finish()
		a.log.Printf("detached process %s ended", d.id)
	}()
	a.runViewer(ch, d, 0, true)
}

type ringWriter struct {
	r      *ring
	stream byte
}

func (w ringWriter) Write(p []byte) (int, error) {
	w.r.append(w.stream, p)
	return len(p), nil
}

func (a *Agent) openAttach(ch *Channel, spec *wire.AttachSpec) {
	d := a.procs.get(spec.ProcID)
	if d == nil {
		ch.OpenFailed(rpcErr("NOT_FOUND", "no detached process "+spec.ProcID))
		return
	}
	from := spec.FromOffset
	if from < 0 {
		from = 0
	}
	a.runViewer(ch, d, from, false)
}

// runViewer streams a detached process's output from `from` into a channel
// and forwards the channel's input to it, until the process's output ends
// (then eof + exit) or the channel goes away (the process keeps running).
func (a *Agent) runViewer(ch *Channel, d *detachedProc, from int64, isExec bool) {
	start, total := d.ring.bounds()
	if from > total {
		from = total
	}
	info := &wire.OpenedInfo{}
	if dinfo := d.info(); dinfo.PID != nil {
		info.PID = dinfo.PID
	}
	if !isExec {
		dropped := int64(0)
		if from < start {
			dropped = start - from
		}
		info.DroppedBytes = &dropped
	}
	ch.SetHandlers(
		func(cols, rows int) { _ = d.proc.resize(cols, rows) },
		func(name string) { _ = d.proc.signal(name) },
		nil,
	)
	if err := ch.Opened(info); err != nil {
		return
	}
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := ch.Read(buf)
			if n > 0 {
				if werr := d.writeStdin(buf[:n]); werr != nil && !errors.Is(werr, io.ErrClosedPipe) {
					return
				}
			}
			if err != nil {
				if errors.Is(err, io.EOF) {
					d.closeStdin()
				}
				return
			}
		}
	}()
	offset := from
	for {
		stream, data, next, finished, wait := d.ring.read(offset, wire.MaxFramePayload)
		if len(data) > 0 {
			if err := ch.Write(stream, data); err != nil {
				return
			}
			offset = next
			continue
		}
		offset = next
		if finished {
			ch.EOF(wire.StreamFromBox)
			if !d.pty {
				ch.EOF(wire.StreamStderr)
			}
			dinfo := d.info()
			ch.Exit(dinfo.ExitCode, dinfo.Signal)
			d.mu.Lock()
			d.delivered = true
			d.mu.Unlock()
			ch.Close(nil)
			a.applyPendingUpdate()
			return
		}
		select {
		case <-wait:
		case <-ch.Done():
			return
		}
	}
}

var isWindows = runtime.GOOS == "windows"
