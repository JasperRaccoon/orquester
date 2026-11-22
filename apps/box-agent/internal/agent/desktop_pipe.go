package agent

// The desktop-session helper (tailnet machines spec 2026-11-22 §4.2.6). On Windows orq-agent runs
// as a LocalSystem service in session 0, which has no desktop: programs it starts cannot open
// windows the user sees or use the GPU through the user's display driver (the Android emulator's
// `-gpu host`). `orq-agent desktop-helper` runs in the interactive user's session instead (started
// by a logon scheduled task, desktop_task.go) and dials the service over a local named pipe
// (desktop_windows.go); the service forwards every exec channel with `session: "desktop"` to it.
//
// This file is the pipe protocol both sides speak, and the platform-neutral half of each side:
// the service's desktopHub (which helper is connected, and a `process` that runs through it) and
// the helper's session (which runs the processes). Only the pipe and its access checks are
// Windows-specific, so the protocol and the routing are tested on every OS.
//
// Frames: [type u8][id u32 BE][length u32 BE][payload], payload at most deskMaxPayload bytes. The
// helper opens with hello (JSON deskHelloMsg) and the service answers welcome (deskWelcomeMsg);
// then every frame belongs to one process id the service picked in its start frame:
//
//	S start   service → helper  deskStartMsg (JSON)
//	O started helper → service  deskStartedMsg (JSON): the pid, or why it could not start
//	D data    both              [stream u8][bytes]: 0 stdin (service → helper), 1 stdout, 2 stderr
//	E eof     both              [stream u8]
//	C credit  both              [stream u8][bytes u32 BE]: the receiver consumed this much
//	G signal  service → helper  the signal name (SIGKILL kills the process tree)
//	R resize  service → helper  [cols u16 BE][rows u16 BE]
//	X exit    helper → service  deskExitMsg (JSON), after the output streams' eof
//
// Every stream has a deskWindowBytes window: a sender never has more than that unacknowledged, so
// each side's reader only ever appends to a bounded buffer and never blocks. One process whose
// reader is slow (a daemon that withholds credit) therefore never stalls another. A peer that
// overruns a window, or sends anything malformed, ends the connection. When the connection ends,
// the helper kills what it runs (as orq-agent's own children end with it) and the service reports
// those processes as killed.

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"sort"
	"sync"
	"time"

	"orquester/box-agent/internal/wire"
)

const (
	// deskProtocolVersion: a helper speaking another version is told to exit, so its logon task
	// starts the build on disk (the one the service runs) again.
	deskProtocolVersion = 1
	deskHeaderBytes     = 9
	deskMaxPayload      = 64 * 1024
	deskWindowBytes     = 256 * 1024
	// deskHandshakeTimeout bounds hello and welcome.
	deskHandshakeTimeout = 10 * time.Second
	// deskStartTimeout: how long the service waits for the helper's started frame.
	deskStartTimeout = 30 * time.Second
	// deskWriteTimeout: a peer that reads nothing for this long is gone (the pipe is closed).
	deskWriteTimeout = 30 * time.Second
	// desktopHelperWait: an exec for the desktop session waits this long for a helper to connect
	// (it was just started by its logon task, or the service started it now).
	desktopHelperWait = 20 * time.Second
)

const (
	deskFrameHello   byte = 'H'
	deskFrameWelcome byte = 'W'
	deskFrameStart   byte = 'S'
	deskFrameStarted byte = 'O'
	deskFrameData    byte = 'D'
	deskFrameEOF     byte = 'E'
	deskFrameCredit  byte = 'C'
	deskFrameSignal  byte = 'G'
	deskFrameResize  byte = 'R'
	deskFrameExit    byte = 'X'
)

const (
	deskStdin  byte = 0
	deskStdout byte = 1
	deskStderr byte = 2
)

type deskHelloMsg struct {
	Protocol int    `json:"protocol"`
	Version  string `json:"version"`
	PID      int    `json:"pid"`
}

type deskWelcomeMsg struct {
	OK bool `json:"ok"`
	// Exit: the helper must exit (another build, or not the helper the service expects): its
	// logon task starts the right one.
	Exit   bool   `json:"exit,omitempty"`
	Reason string `json:"reason,omitempty"`
}

// deskStartMsg is an exec spec as the helper needs it: the helper resolves the command against
// its own (the desktop user's) PATH and environment, with Env merged over it.
type deskStartMsg struct {
	Command  string            `json:"command"`
	Args     []string          `json:"args"`
	Shell    bool              `json:"shell,omitempty"`
	Cwd      string            `json:"cwd,omitempty"`
	Env      map[string]string `json:"env,omitempty"`
	EnvUnset []string          `json:"envUnset,omitempty"`
	Pty      *wire.PtySpec     `json:"pty,omitempty"`
}

type deskStartedMsg struct {
	PID   int            `json:"pid,omitempty"`
	Error *wire.RPCError `json:"error,omitempty"`
}

type deskExitMsg struct {
	Code   *int    `json:"code"`
	Signal *string `json:"signal"`
}

var errDeskClosed = errors.New("the desktop-session helper's connection is closed")

type deskFrame struct {
	typ     byte
	id      uint32
	payload []byte
}

func readDeskFrame(r io.Reader) (deskFrame, error) {
	var h [deskHeaderBytes]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return deskFrame{}, err
	}
	n := binary.BigEndian.Uint32(h[5:])
	if n > deskMaxPayload {
		return deskFrame{}, fmt.Errorf("desktop pipe: a %d-byte frame is over the limit", n)
	}
	f := deskFrame{typ: h[0], id: binary.BigEndian.Uint32(h[1:5]), payload: make([]byte, n)}
	if _, err := io.ReadFull(r, f.payload); err != nil {
		return deskFrame{}, err
	}
	return f, nil
}

// deskConn is one helper connection: framed writes from any goroutine, reads from one.
type deskConn struct {
	conn net.Conn
	br   *bufio.Reader
	wmu  sync.Mutex
	once sync.Once
	done chan struct{}
}

func newDeskConn(conn net.Conn) *deskConn {
	return &deskConn{conn: conn, br: bufio.NewReaderSize(conn, 64*1024), done: make(chan struct{})}
}

func (c *deskConn) send(typ byte, id uint32, payload []byte) error {
	if len(payload) > deskMaxPayload {
		return fmt.Errorf("desktop pipe: a %d-byte frame is over the limit", len(payload))
	}
	select {
	case <-c.done:
		return errDeskClosed
	default:
	}
	buf := make([]byte, deskHeaderBytes+len(payload))
	buf[0] = typ
	binary.BigEndian.PutUint32(buf[1:5], id)
	binary.BigEndian.PutUint32(buf[5:9], uint32(len(payload)))
	copy(buf[deskHeaderBytes:], payload)
	c.wmu.Lock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(deskWriteTimeout))
	_, err := c.conn.Write(buf)
	c.wmu.Unlock()
	if err != nil {
		c.close()
		return errDeskClosed
	}
	return nil
}

func (c *deskConn) sendJSON(typ byte, id uint32, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.send(typ, id, data)
}

func (c *deskConn) credit(id uint32, stream byte, n int) {
	var p [5]byte
	p[0] = stream
	binary.BigEndian.PutUint32(p[1:], uint32(n))
	_ = c.send(deskFrameCredit, id, p[:])
}

func (c *deskConn) read() (deskFrame, error) { return readDeskFrame(c.br) }

// readWithin reads one frame, failing after `d` (the handshake).
func (c *deskConn) readWithin(d time.Duration) (deskFrame, error) {
	_ = c.conn.SetReadDeadline(time.Now().Add(d))
	defer func() { _ = c.conn.SetReadDeadline(time.Time{}) }()
	return c.read()
}

func (c *deskConn) close() {
	c.once.Do(func() {
		close(c.done)
		_ = c.conn.Close()
	})
}

// deskWindow is a sender's credit for one stream.
type deskWindow struct {
	mu      sync.Mutex
	avail   int
	closed  bool
	changed chan struct{}
}

func newDeskWindow() *deskWindow {
	return &deskWindow{avail: deskWindowBytes, changed: make(chan struct{})}
}

func (w *deskWindow) bump() {
	close(w.changed)
	w.changed = make(chan struct{})
}

// take waits for credit and takes up to max bytes of it; false once the window closed.
func (w *deskWindow) take(max int) (int, bool) {
	for {
		w.mu.Lock()
		if w.closed {
			w.mu.Unlock()
			return 0, false
		}
		if w.avail > 0 {
			n := min(w.avail, max)
			w.avail -= n
			w.mu.Unlock()
			return n, true
		}
		changed := w.changed
		w.mu.Unlock()
		<-changed
	}
}

func (w *deskWindow) give(n int) {
	w.mu.Lock()
	w.avail += n
	w.bump()
	w.mu.Unlock()
}

func (w *deskWindow) close() {
	w.mu.Lock()
	if !w.closed {
		w.closed = true
		w.bump()
	}
	w.mu.Unlock()
}

// deskStreamWriter writes one stream of one process as data frames, within its window; Close
// sends the stream's eof once.
type deskStreamWriter struct {
	conn   *deskConn
	id     uint32
	stream byte
	window *deskWindow
	mu     sync.Mutex
	eof    bool
}

func newDeskStreamWriter(conn *deskConn, id uint32, stream byte) *deskStreamWriter {
	return &deskStreamWriter{conn: conn, id: id, stream: stream, window: newDeskWindow()}
}

func (w *deskStreamWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.eof {
		return 0, io.ErrClosedPipe
	}
	written := 0
	for written < len(p) {
		n, ok := w.window.take(min(len(p)-written, deskMaxPayload-1))
		if !ok {
			return written, io.ErrClosedPipe
		}
		payload := make([]byte, 1+n)
		payload[0] = w.stream
		copy(payload[1:], p[written:written+n])
		if err := w.conn.send(deskFrameData, w.id, payload); err != nil {
			return written, err
		}
		written += n
	}
	return written, nil
}

func (w *deskStreamWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.eof {
		return nil
	}
	w.eof = true
	return w.conn.send(deskFrameEOF, w.id, []byte{w.stream})
}

// deskInbox is a receiver's buffer for one stream: the connection's reader appends, a consumer
// reads, and what it read is credited back to the sender.
type deskInbox struct {
	mu      sync.Mutex
	buf     []byte
	eof     bool
	local   bool // closed on this side: data is dropped (and credited at once)
	changed chan struct{}
	credit  func(n int)
}

func newDeskInbox(credit func(n int)) *deskInbox {
	return &deskInbox{changed: make(chan struct{}), credit: credit}
}

func (b *deskInbox) bump() {
	close(b.changed)
	b.changed = make(chan struct{})
}

// push appends data from the peer; an error means the peer overran the window.
func (b *deskInbox) push(data []byte) error {
	b.mu.Lock()
	if b.local || b.eof {
		b.mu.Unlock()
		// Nobody reads it any more: credit it so the sender never waits on it.
		b.credit(len(data))
		return nil
	}
	if len(b.buf)+len(data) > deskWindowBytes {
		b.mu.Unlock()
		return errors.New("desktop pipe: the peer overran a stream's window")
	}
	b.buf = append(b.buf, data...)
	b.bump()
	b.mu.Unlock()
	return nil
}

// finish: the peer's eof (or the connection ended); reads return EOF once the buffer is empty.
func (b *deskInbox) finish() {
	b.mu.Lock()
	if !b.eof {
		b.eof = true
		b.bump()
	}
	b.mu.Unlock()
}

// closeLocal ends reading now: buffered data is dropped and credited.
func (b *deskInbox) closeLocal() {
	b.mu.Lock()
	dropped := len(b.buf)
	b.buf = nil
	b.local = true
	b.eof = true
	b.bump()
	b.mu.Unlock()
	if dropped > 0 {
		b.credit(dropped)
	}
}

func (b *deskInbox) Read(p []byte) (int, error) {
	for {
		b.mu.Lock()
		if len(b.buf) > 0 {
			n := copy(p, b.buf)
			b.buf = b.buf[n:]
			if len(b.buf) == 0 {
				b.buf = nil
			}
			b.mu.Unlock()
			b.credit(n)
			return n, nil
		}
		if b.eof {
			b.mu.Unlock()
			return 0, io.EOF
		}
		changed := b.changed
		b.mu.Unlock()
		<-changed
	}
}

func decodeCredit(payload []byte) (byte, int, bool) {
	if len(payload) != 5 {
		return 0, 0, false
	}
	return payload[0], int(binary.BigEndian.Uint32(payload[1:])), true
}

func rpcErrorOf(err error) *wire.RPCError {
	var rpc *wire.RPCError
	if errors.As(err, &rpc) {
		return rpc
	}
	return rpcErr("SPAWN_FAILED", err.Error())
}

// ---------------------------------------------------------------------------
// Service side
// ---------------------------------------------------------------------------

// desktopHub is the service's end: at most one helper is connected at a time (a newer
// connection replaces an older one), and processes for the desktop session start through it.
type desktopHub struct {
	log     *log.Logger
	version string
	// installed: the helper's logon task is registered on this machine (desktop-helper.json), so
	// the `desktop-session` capability is advertised even while no helper is connected (see
	// Agent.hello).
	installed bool
	// wait: how long an exec waits for a helper (desktopHelperWait; tests shorten it).
	wait time.Duration
	// verify checks who dialled (Windows: the client process is this orq-agent.exe in an
	// interactive session); nil accepts anyone that could open the pipe.
	verify func(conn net.Conn) error
	// kick asks the OS to start the helper now (Windows: run its scheduled task); nil: nothing.
	kick func()

	mu      sync.Mutex
	current *deskSession
	changed chan struct{}
}

func newDesktopHub(logger *log.Logger, version string, installed bool) *desktopHub {
	return &desktopHub{log: logger, version: version, installed: installed, wait: desktopHelperWait, changed: make(chan struct{})}
}

// advertised: whether hello lists CapabilityDesktopSession.
func (h *desktopHub) advertised() bool {
	if h == nil {
		return false
	}
	return h.installed || h.connected() != nil
}

func (h *desktopHub) connected() *deskSession {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.current
}

func (h *desktopHub) setCurrent(s *deskSession) {
	h.mu.Lock()
	previous := h.current
	h.current = s
	close(h.changed)
	h.changed = make(chan struct{})
	h.mu.Unlock()
	if previous != nil {
		previous.conn.close()
	}
}

func (h *desktopHub) clearCurrent(s *deskSession) {
	h.mu.Lock()
	if h.current == s {
		h.current = nil
		close(h.changed)
		h.changed = make(chan struct{})
	}
	h.mu.Unlock()
}

// close drops the connected helper (the service is stopping).
func (h *desktopHub) close() {
	if s := h.connected(); s != nil {
		s.conn.close()
	}
}

// serveConn runs one helper connection until it ends.
func (h *desktopHub) serveConn(conn net.Conn) {
	dc := newDeskConn(conn)
	defer dc.close()
	f, err := dc.readWithin(deskHandshakeTimeout)
	if err != nil || f.typ != deskFrameHello {
		return
	}
	var hello deskHelloMsg
	if json.Unmarshal(f.payload, &hello) != nil {
		return
	}
	// refuse tells the helper to exit and waits (briefly) for it to hang up; then its logon task
	// starts the build on disk again.
	refuse := func(reason string) {
		h.log.Printf("desktop-session helper (pid %d) refused: %s", hello.PID, reason)
		if dc.sendJSON(deskFrameWelcome, 0, deskWelcomeMsg{OK: false, Exit: true, Reason: reason}) == nil {
			_, _ = dc.readWithin(deskHandshakeTimeout)
		}
		dc.close()
		if h.kick != nil {
			h.kick()
		}
	}
	if hello.Protocol != deskProtocolVersion {
		refuse(fmt.Sprintf("it speaks desktop pipe protocol %d, this orq-agent %d", hello.Protocol, deskProtocolVersion))
		return
	}
	if h.version != "" && hello.Version != h.version {
		refuse(fmt.Sprintf("it is orq-agent %s, the service %s", hello.Version, h.version))
		return
	}
	if h.verify != nil {
		if err := h.verify(conn); err != nil {
			refuse(err.Error())
			return
		}
	}
	if err := dc.sendJSON(deskFrameWelcome, 0, deskWelcomeMsg{OK: true}); err != nil {
		return
	}
	s := newDeskSession(dc)
	h.setCurrent(s)
	h.log.Printf("desktop-session helper connected (pid %d)", hello.PID)
	s.serve()
	h.clearCurrent(s)
	h.log.Printf("desktop-session helper disconnected (pid %d)", hello.PID)
}

// await returns the connected helper, waiting up to h.wait for one (and asking the OS to start
// it); nil when none came. `cancel` ends the wait early (the channel closed).
func (h *desktopHub) await(cancel <-chan struct{}) *deskSession {
	timer := time.NewTimer(h.wait)
	defer timer.Stop()
	kicked := false
	for {
		h.mu.Lock()
		s, changed := h.current, h.changed
		h.mu.Unlock()
		if s != nil {
			return s
		}
		if !kicked && h.kick != nil && h.wait > 0 {
			kicked = true
			go h.kick()
		}
		select {
		case <-changed:
		case <-timer.C:
			return nil
		case <-cancel:
			return nil
		}
	}
}

// deskSession is the service's view of one connected helper.
type deskSession struct {
	conn   *deskConn
	mu     sync.Mutex
	procs  map[uint32]*deskProc
	nextID uint32
	ended  bool
}

func newDeskSession(conn *deskConn) *deskSession {
	return &deskSession{conn: conn, procs: map[uint32]*deskProc{}, nextID: 1}
}

func (s *deskSession) get(id uint32) *deskProc {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.procs[id]
}

func (s *deskSession) remove(id uint32) {
	s.mu.Lock()
	delete(s.procs, id)
	s.mu.Unlock()
}

// serve reads the helper's frames until the connection ends; then every process still known is
// reported killed.
func (s *deskSession) serve() {
	defer func() {
		s.conn.close()
		s.mu.Lock()
		s.ended = true
		procs := s.procs
		s.procs = map[uint32]*deskProc{}
		s.mu.Unlock()
		for _, p := range procs {
			p.lost()
		}
	}()
	for {
		f, err := s.conn.read()
		if err != nil {
			return
		}
		if !s.dispatch(f) {
			return
		}
	}
}

// dispatch handles one frame; false ends the connection (a protocol error).
func (s *deskSession) dispatch(f deskFrame) bool {
	p := s.get(f.id)
	switch f.typ {
	case deskFrameStarted:
		var msg deskStartedMsg
		if json.Unmarshal(f.payload, &msg) != nil {
			return false
		}
		if p != nil {
			select {
			case p.started <- msg:
			default:
			}
		}
	case deskFrameData:
		if len(f.payload) < 1 {
			return false
		}
		data := f.payload[1:]
		if p == nil {
			s.conn.credit(f.id, f.payload[0], len(data))
			return true
		}
		inbox := p.inbox(f.payload[0])
		if inbox == nil {
			return false
		}
		if inbox.push(data) != nil {
			return false
		}
	case deskFrameEOF:
		if len(f.payload) != 1 {
			return false
		}
		if p != nil {
			if inbox := p.inbox(f.payload[0]); inbox != nil {
				inbox.finish()
			}
		}
	case deskFrameCredit:
		stream, n, ok := decodeCredit(f.payload)
		if !ok || stream != deskStdin {
			return false
		}
		if p != nil {
			p.in.window.give(n)
		}
	case deskFrameExit:
		var msg deskExitMsg
		if json.Unmarshal(f.payload, &msg) != nil {
			return false
		}
		if p != nil {
			p.exit(msg.Code, msg.Signal)
		}
	default:
		return false
	}
	return true
}

// start runs a process in the desktop session.
func (s *deskSession) start(msg deskStartMsg) (process, error) {
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()
		return nil, rpcErr("NO_DESKTOP_SESSION", "the desktop-session helper disconnected")
	}
	id := s.nextID
	s.nextID++
	p := newDeskProc(s, id, msg.Pty != nil)
	s.procs[id] = p
	s.mu.Unlock()
	if err := s.conn.sendJSON(deskFrameStart, id, msg); err != nil {
		s.remove(id)
		return nil, rpcErr("NO_DESKTOP_SESSION", "the desktop-session helper disconnected")
	}
	timer := time.NewTimer(deskStartTimeout)
	defer timer.Stop()
	select {
	case started := <-p.started:
		if started.Error != nil {
			s.remove(id)
			return nil, started.Error
		}
		p.pidNum = started.PID
		return p, nil
	case <-p.exited:
		s.remove(id)
		return nil, rpcErr("NO_DESKTOP_SESSION", "the desktop-session helper disconnected before the process started")
	case <-timer.C:
		// It may still start: kill whatever it starts, and forget it.
		p.kill()
		s.remove(id)
		return nil, rpcErr("SPAWN_FAILED", "the desktop-session helper did not start the process in time")
	}
}

// deskProc is a process the helper runs, as the exec code sees it (the `process` interface).
type deskProc struct {
	s       *deskSession
	id      uint32
	pidNum  int
	pty     bool
	started chan deskStartedMsg
	out     *deskInbox
	errOut  *deskInbox
	in      *deskStreamWriter

	exitOnce sync.Once
	exited   chan struct{}
	code     *int
	sig      *string
}

func newDeskProc(s *deskSession, id uint32, pty bool) *deskProc {
	p := &deskProc{s: s, id: id, pty: pty, started: make(chan deskStartedMsg, 1), exited: make(chan struct{})}
	p.out = newDeskInbox(func(n int) { s.conn.credit(id, deskStdout, n) })
	p.errOut = newDeskInbox(func(n int) { s.conn.credit(id, deskStderr, n) })
	p.in = newDeskStreamWriter(s.conn, id, deskStdin)
	return p
}

func (p *deskProc) inbox(stream byte) *deskInbox {
	switch stream {
	case deskStdout:
		return p.out
	case deskStderr:
		return p.errOut
	}
	return nil
}

func (p *deskProc) exit(code *int, sig *string) {
	p.exitOnce.Do(func() {
		p.code, p.sig = code, sig
		close(p.exited)
	})
}

// lost: the helper went away; it kills what it ran when its connection ends.
func (p *deskProc) lost() {
	p.out.finish()
	p.errOut.finish()
	p.in.window.close()
	killed := "SIGKILL"
	p.exit(nil, &killed)
}

func (p *deskProc) pid() int              { return p.pidNum }
func (p *deskProc) stdin() io.WriteCloser { return p.in }
func (p *deskProc) stdout() io.Reader     { return p.out }

// stderr: none with a pseudo-console (its output is all on stdout), as for local processes.
func (p *deskProc) stderr() io.Reader {
	if p.pty {
		return nil
	}
	return p.errOut
}

func (p *deskProc) wait() (*int, *string) {
	<-p.exited
	return p.code, p.sig
}

func (p *deskProc) signal(name string) error {
	if name == "" || len(name) > 32 {
		return rpcErr("BAD_REQUEST", "bad signal name")
	}
	return p.s.conn.send(deskFrameSignal, p.id, []byte(name))
}

func (p *deskProc) resize(cols, rows int) error {
	var b [4]byte
	binary.BigEndian.PutUint16(b[:2], uint16(min(max(cols, 0), 0xffff)))
	binary.BigEndian.PutUint16(b[2:], uint16(min(max(rows, 0), 0xffff)))
	return p.s.conn.send(deskFrameResize, p.id, b[:])
}

func (p *deskProc) kill() { _ = p.signal("SIGKILL") }

func (p *deskProc) closeOutput() {
	p.out.closeLocal()
	p.errOut.closeLocal()
}

func (p *deskProc) release() {
	p.in.window.close()
	p.s.remove(p.id)
}

// ---------------------------------------------------------------------------
// Helper side
// ---------------------------------------------------------------------------

// deskHelper is the helper's end of one connection: it runs the processes the service asks for.
type deskHelper struct {
	conn  *deskConn
	start func(*startSpec) (process, error)
	// env is the helper's own environment (the desktop user's), the base of every process's.
	env func() []string

	mu    sync.Mutex
	procs map[uint32]*helperProc
	wg    sync.WaitGroup
}

type helperProc struct {
	proc    process // nil until started
	pending []string
	stdin   *deskInbox
	out     *deskStreamWriter
	errOut  *deskStreamWriter
}

// errDeskHelperExit: the service told the helper to exit (desktopHub.serveConn).
var errDeskHelperExit = errors.New("the orq-agent service asked the desktop-session helper to exit")

// runDeskHelperSession greets the service and runs processes for it until the connection ends.
// It returns errDeskHelperExit when the service wants this helper gone.
func runDeskHelperSession(conn net.Conn, version string, start func(*startSpec) (process, error), env func() []string) error {
	dc := newDeskConn(conn)
	defer dc.close()
	if err := dc.sendJSON(deskFrameHello, 0, deskHelloMsg{Protocol: deskProtocolVersion, Version: version, PID: os.Getpid()}); err != nil {
		return err
	}
	f, err := dc.readWithin(deskHandshakeTimeout)
	if err != nil {
		return err
	}
	var welcome deskWelcomeMsg
	if f.typ != deskFrameWelcome || json.Unmarshal(f.payload, &welcome) != nil {
		return errors.New("desktop pipe: the service sent no welcome")
	}
	if !welcome.OK {
		if welcome.Exit {
			return fmt.Errorf("%w: %s", errDeskHelperExit, welcome.Reason)
		}
		return fmt.Errorf("the orq-agent service refused this helper: %s", welcome.Reason)
	}
	h := &deskHelper{conn: dc, start: start, env: env, procs: map[uint32]*helperProc{}}
	h.serve()
	return nil
}

func (h *deskHelper) serve() {
	defer func() {
		h.conn.close()
		h.mu.Lock()
		procs := h.procs
		h.procs = map[uint32]*helperProc{}
		h.mu.Unlock()
		// Nobody reads their output or writes their input any more: they end with the connection.
		for _, hp := range procs {
			hp.stdin.closeLocal()
			hp.out.window.close()
			hp.errOut.window.close()
			if hp.proc != nil {
				hp.proc.kill()
			}
		}
		h.wg.Wait()
	}()
	for {
		f, err := h.conn.read()
		if err != nil {
			return
		}
		if !h.dispatch(f) {
			return
		}
	}
}

func (h *deskHelper) get(id uint32) *helperProc {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.procs[id]
}

func (h *deskHelper) dispatch(f deskFrame) bool {
	hp := h.get(f.id)
	switch f.typ {
	case deskFrameStart:
		var msg deskStartMsg
		if hp != nil || json.Unmarshal(f.payload, &msg) != nil {
			return false
		}
		id := f.id
		hp = &helperProc{
			stdin:  newDeskInbox(func(n int) { h.conn.credit(id, deskStdin, n) }),
			out:    newDeskStreamWriter(h.conn, id, deskStdout),
			errOut: newDeskStreamWriter(h.conn, id, deskStderr),
		}
		h.mu.Lock()
		h.procs[id] = hp
		h.mu.Unlock()
		h.wg.Add(1)
		go func() {
			defer h.wg.Done()
			h.run(id, hp, msg)
		}()
	case deskFrameData:
		if len(f.payload) < 1 || f.payload[0] != deskStdin {
			return false
		}
		if hp == nil {
			h.conn.credit(f.id, deskStdin, len(f.payload)-1)
			return true
		}
		if hp.stdin.push(f.payload[1:]) != nil {
			return false
		}
	case deskFrameEOF:
		if len(f.payload) != 1 || f.payload[0] != deskStdin {
			return false
		}
		if hp != nil {
			hp.stdin.finish()
		}
	case deskFrameCredit:
		stream, n, ok := decodeCredit(f.payload)
		if !ok {
			return false
		}
		if hp != nil {
			switch stream {
			case deskStdout:
				hp.out.window.give(n)
			case deskStderr:
				hp.errOut.window.give(n)
			default:
				return false
			}
		}
	case deskFrameSignal:
		if hp != nil {
			h.signal(hp, string(f.payload))
		}
	case deskFrameResize:
		if len(f.payload) != 4 {
			return false
		}
		if hp != nil {
			h.mu.Lock()
			proc := hp.proc
			h.mu.Unlock()
			if proc != nil {
				_ = proc.resize(int(binary.BigEndian.Uint16(f.payload[:2])), int(binary.BigEndian.Uint16(f.payload[2:])))
			}
		}
	default:
		return false
	}
	return true
}

// signal applies a signal, or keeps it for the process that is still starting.
func (h *deskHelper) signal(hp *helperProc, name string) {
	h.mu.Lock()
	proc := hp.proc
	if proc == nil {
		hp.pending = append(hp.pending, name)
	}
	h.mu.Unlock()
	if proc != nil {
		applyDeskSignal(proc, name)
	}
}

func applyDeskSignal(proc process, name string) {
	if name == "SIGKILL" {
		proc.kill()
		return
	}
	_ = proc.signal(name)
}

// run starts one process and serves it: its input from the service, its output to it within the
// windows, then eof and exit (the same drain as a local exec, exec.go openExec).
func (h *deskHelper) run(id uint32, hp *helperProc, msg deskStartMsg) {
	defer func() {
		h.mu.Lock()
		delete(h.procs, id)
		h.mu.Unlock()
		hp.stdin.closeLocal()
	}()
	spec, err := helperStartSpec(msg, h.env())
	var proc process
	if err == nil {
		proc, err = h.start(spec)
	}
	if err != nil {
		_ = h.conn.sendJSON(deskFrameStarted, id, deskStartedMsg{Error: rpcErrorOf(err)})
		return
	}
	h.mu.Lock()
	hp.proc = proc
	pending := hp.pending
	hp.pending = nil
	h.mu.Unlock()
	if err := h.conn.sendJSON(deskFrameStarted, id, deskStartedMsg{PID: proc.pid()}); err != nil {
		proc.kill()
	}
	for _, name := range pending {
		applyDeskSignal(proc, name)
	}
	go func() {
		stdin := proc.stdin()
		if stdin == nil {
			return
		}
		_, err := io.Copy(stdin, hp.stdin)
		if err == nil && spec.pty == nil {
			_ = stdin.Close()
		}
	}()
	pumps := newOutputPumps()
	pumps.start(pumpPair{hp.out, proc.stdout()}, pumpPair{hp.errOut, proc.stderr()})
	code, sig := proc.wait()
	pumps.drain(proc)
	proc.release()
	_ = hp.out.Close()
	if spec.pty == nil {
		_ = hp.errOut.Close()
	}
	_ = h.conn.sendJSON(deskFrameExit, id, deskExitMsg{Code: code, Signal: sig})
}

// helperStartSpec resolves a start request in the helper's own environment (the desktop user's):
// its PATH, profile and variables, with the request's env merged over them.
func helperStartSpec(msg deskStartMsg, base []string) (*startSpec, error) {
	if msg.Shell && len(msg.Args) > 0 {
		return nil, rpcErr("BAD_REQUEST", "shell mode takes the whole command line in `command`; args must be empty")
	}
	if msg.Command == "" {
		return nil, rpcErr("BAD_REQUEST", "command is required")
	}
	env := newEnvMap(base)
	for _, key := range secretEnv {
		env.del(key)
	}
	if msg.Pty != nil {
		term := msg.Pty.Term
		if term == "" {
			term = "xterm-256color"
		}
		env.set("TERM", term)
	}
	for _, key := range msg.EnvUnset {
		env.del(key)
	}
	keys := make([]string, 0, len(msg.Env))
	for key := range msg.Env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		env.set(key, msg.Env[key])
	}
	return resolveStart(msg.Command, msg.Args, msg.Shell, msg.Cwd, env.list(), msg.Pty, nil)
}
