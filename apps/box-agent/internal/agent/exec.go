package agent

import (
	"encoding/json"
	"errors"
	"fmt"
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
// inherited them): the pumps get this much reading time to drain them before
// the channel ends. Time a pump spends waiting for the daemon's credit does
// not count: output the process already wrote is never cut off because the
// daemon reads slowly. A var so tests can shorten it.
var outputDrainAfterExit = 2 * time.Second

// drainPausedHook, when set (tests only), runs each time the drain deadline
// passes while a pump is waiting for credit (and so does not end the drain).
var drainPausedHook func()

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

// outputPumps copy a process's output streams into writers (a channel's
// streams, or a detached process's ring) and report whether one is blocked
// writing, so the drain after exit can tell a slow daemon from a pipe that a
// background child holds open.
type outputPumps struct {
	mu      sync.Mutex
	writing int           // pumps inside dst.Write (waiting for credit counts)
	changed chan struct{} // closed and replaced whenever `writing` changes
	wg      sync.WaitGroup
	done    chan struct{} // closed once every pump has returned
}

func newOutputPumps() *outputPumps {
	return &outputPumps{changed: make(chan struct{}), done: make(chan struct{})}
}

// pumpPair is one output stream and where it goes; a nil src (a PTY's
// stderr) ends its pump at once.
type pumpPair struct {
	dst io.Writer
	src io.Reader
}

// start launches one pump per pair; call once.
func (p *outputPumps) start(pairs ...pumpPair) {
	for _, pair := range pairs {
		p.wg.Add(1)
		go p.pump(pair.dst, pair.src)
	}
	go func() {
		p.wg.Wait()
		close(p.done)
	}()
}

func (p *outputPumps) setWriting(delta int) {
	p.mu.Lock()
	p.writing += delta
	close(p.changed)
	p.changed = make(chan struct{})
	p.mu.Unlock()
}

func (p *outputPumps) state() (writing bool, changed <-chan struct{}) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.writing > 0, p.changed
}

// pump copies one stream; it ends at EOF, on a read error (a closed PTY reads
// EIO, closeOutput), or when the writer fails (the channel died).
func (p *outputPumps) pump(dst io.Writer, src io.Reader) {
	defer p.wg.Done()
	if src == nil || dst == nil {
		return
	}
	buf := make([]byte, 32*1024)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			p.setWriting(1)
			_, werr := dst.Write(buf[:n])
			p.setWriting(-1)
			if werr != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

// waitFor waits for every pump to return, spending at most `budget` of time
// in which no pump is writing. A pump blocked on credit pauses the clock, so
// bytes already read always reach the daemon; only reads are bounded.
func (p *outputPumps) waitFor(budget time.Duration) bool {
	for {
		writing, changed := p.state()
		if !writing && budget <= 0 {
			select {
			case <-p.done:
				return true
			default:
				return false
			}
		}
		started := time.Now()
		timer := time.NewTimer(max(budget, 0))
		select {
		case <-p.done:
			timer.Stop()
			return true
		case <-changed:
			timer.Stop()
			if !writing {
				budget -= time.Since(started)
			}
		case <-timer.C:
			if !writing {
				budget = 0
				continue
			}
			// The deadline passed while a pump waits for credit: not counted.
			if hook := drainPausedHook; hook != nil {
				hook()
			}
			select {
			case <-p.done:
				return true
			case <-changed:
			}
		}
	}
}

// drain waits for the pumps after the process exited: reads get
// outputDrainAfterExit, then the output is closed (a background child holds
// the pipes) and the pumps get as long again to notice.
func (p *outputPumps) drain(proc process) {
	if p.waitFor(outputDrainAfterExit) {
		return
	}
	proc.closeOutput()
	p.waitFor(outputDrainAfterExit)
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
	pumps := newOutputPumps()
	pumps.start(
		pumpPair{ch.StreamWriter(wire.StreamFromBox), proc.stdout()},
		pumpPair{ch.StreamWriter(wire.StreamStderr), proc.stderr()},
	)
	code, signal := proc.wait()
	exited.Do(func() { close(exitedCh) })
	pumps.drain(proc)
	// A pump that still has not returned (a read that ignored the close) can
	// no longer write: EOF fences both streams first.
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
		pumps := newOutputPumps()
		pumps.start(
			pumpPair{ringWriter{d.ring, wire.StreamFromBox}, proc.stdout()},
			pumpPair{ringWriter{d.ring, wire.StreamStderr}, proc.stderr()},
		)
		code, signal := proc.wait()
		pumps.drain(proc)
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
	// Output already gone from the buffer is skipped once, here, and reported
	// (an exec viewer starts at 0, so it reports only a real loss).
	dropped := int64(0)
	if from < start {
		dropped = start - from
		from = start
	}
	if !isExec || dropped > 0 {
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
		stream, data, next, finished, wait, overrun := d.ring.read(offset, wire.MaxFramePayload)
		if overrun {
			// The process wrote faster than this viewer delivered and the
			// buffer moved past it: skipping ahead would hand the daemon a
			// stream with a hole in it. End the channel with an error instead.
			start, _ := d.ring.bounds()
			a.log.Printf("detached process %s: viewer fell %d bytes behind its buffer", d.id, start-offset)
			ch.Close(rpcErr("OUTPUT_OVERRUN", fmt.Sprintf("the output buffer moved past offset %d (now starts at %d): %d bytes lost", offset, start, start-offset)))
			return
		}
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
