package agent

import (
	"io"
	"sort"
	"sync"

	"orquester/box-agent/internal/wire"
)

// ring keeps the newest `capacity` bytes of a detached process's output as
// stream-tagged chunks. Offsets count stdout and stderr bytes together, in
// emission order (box-protocol.ts "Detached processes and reattach").
type ring struct {
	mu       sync.Mutex
	capacity int64
	chunks   []ringChunk
	start    int64 // offset of the first byte still buffered
	total    int64 // bytes ever appended
	finished bool
	changed  chan struct{}
}

type ringChunk struct {
	offset int64
	stream byte
	data   []byte
}

func newRing(capacity int64) *ring {
	if capacity <= 0 {
		capacity = wire.DetachBufferBytes
	}
	return &ring{capacity: capacity, changed: make(chan struct{})}
}

func (r *ring) bump() {
	close(r.changed)
	r.changed = make(chan struct{})
}

func (r *ring) append(stream byte, data []byte) {
	if len(data) == 0 {
		return
	}
	chunk := make([]byte, len(data))
	copy(chunk, data)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.chunks = append(r.chunks, ringChunk{offset: r.total, stream: stream, data: chunk})
	r.total += int64(len(chunk))
	for r.total-r.start > r.capacity && len(r.chunks) > 0 {
		excess := r.total - r.start - r.capacity
		first := &r.chunks[0]
		if int64(len(first.data)) <= excess {
			r.start += int64(len(first.data))
			r.chunks = r.chunks[1:]
			continue
		}
		first.data = first.data[excess:]
		first.offset += excess
		r.start += excess
	}
	r.bump()
}

func (r *ring) finish() {
	r.mu.Lock()
	r.finished = true
	r.bump()
	r.mu.Unlock()
}

func (r *ring) bounds() (start, total int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.start, r.total
}

// read returns buffered output at `offset`, or a channel to wait on when
// there is nothing yet. `overrun` reports that the buffer has already moved
// past `offset`: the bytes there are gone, and a reader that skipped them
// would silently desynchronise (callers position at `bounds` first).
func (r *ring) read(offset int64, limit int) (stream byte, data []byte, next int64, finished bool, wait <-chan struct{}, overrun bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if offset < r.start {
		return 0, nil, offset, false, nil, true
	}
	if offset >= r.total {
		return 0, nil, offset, r.finished, r.changed, false
	}
	i := sort.Search(len(r.chunks), func(i int) bool {
		return r.chunks[i].offset+int64(len(r.chunks[i].data)) > offset
	})
	chunk := r.chunks[i]
	piece := chunk.data[offset-chunk.offset:]
	if len(piece) > limit {
		piece = piece[:limit]
	}
	out := make([]byte, len(piece))
	copy(out, piece)
	return chunk.stream, out, offset + int64(len(out)), false, nil, false
}

// detachedProc is a process started with `detach`: it keeps running and
// buffering when the link drops; viewers (exec/attach channels) come and go.
type detachedProc struct {
	id   string
	proc process
	pty  bool
	ring *ring

	mu        sync.Mutex
	running   bool
	pid       int
	exitCode  *int
	signal    *string
	delivered bool // some viewer streamed it to the end (exit reported)
	stdin     io.WriteCloser
	// startID names the process beyond its pid (procstate.go); "" where the OS cannot tell.
	startID string
	// lost: a previous orq-agent started it, and its output could not be
	// followed after the restart (procstate.go). It has no process handle.
	lost string
}

func (d *detachedProc) info() wire.DetachedProcInfo {
	d.mu.Lock()
	defer d.mu.Unlock()
	start, total := d.ring.bounds()
	info := wire.DetachedProcInfo{
		ProcID:      d.id,
		Running:     d.running,
		ExitCode:    d.exitCode,
		Signal:      d.signal,
		OutputBytes: total,
		BufferStart: start,
	}
	if d.lost != "" {
		lost := d.lost
		info.Lost = &lost
	}
	if d.running {
		pid := d.pid
		info.PID = &pid
	}
	return info
}

func (d *detachedProc) writeStdin(p []byte) error {
	d.mu.Lock()
	stdin := d.stdin
	d.mu.Unlock()
	if stdin == nil {
		return io.ErrClosedPipe
	}
	_, err := stdin.Write(p)
	return err
}

func (d *detachedProc) closeStdin() {
	d.mu.Lock()
	stdin := d.stdin
	if !d.pty {
		d.stdin = nil
	}
	d.mu.Unlock()
	if stdin != nil && !d.pty {
		_ = stdin.Close()
	}
}

type procRegistry struct {
	mu    sync.Mutex
	procs map[string]*detachedProc

	// statePath records the running processes for the next orq-agent (procstate.go); "" records nothing.
	statePath string
	self      procIdentity
	writeMu   sync.Mutex
}

func newProcRegistry() *procRegistry {
	return &procRegistry{procs: map[string]*detachedProc{}}
}

func (r *procRegistry) get(id string) *detachedProc {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.procs[id]
}

// add registers a new detached process; false when one with that id still runs.
func (r *procRegistry) add(d *detachedProc) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if existing := r.procs[d.id]; existing != nil {
		existing.mu.Lock()
		running := existing.running
		existing.mu.Unlock()
		if running {
			return false
		}
	}
	r.procs[d.id] = d
	return true
}

func (r *procRegistry) list() []wire.DetachedProcInfo {
	r.mu.Lock()
	procs := make([]*detachedProc, 0, len(r.procs))
	for _, d := range r.procs {
		procs = append(procs, d)
	}
	r.mu.Unlock()
	sort.Slice(procs, func(i, j int) bool { return procs[i].id < procs[j].id })
	out := make([]wire.DetachedProcInfo, 0, len(procs))
	for _, d := range procs {
		out = append(out, d.info())
	}
	return out
}

func (r *procRegistry) release(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	d := r.procs[id]
	if d == nil {
		return nil
	}
	d.mu.Lock()
	running := d.running
	d.mu.Unlock()
	if running {
		return rpcErr("BUSY", "the process is still running; signal it first")
	}
	delete(r.procs, id)
	return nil
}

// runningCount counts processes an update would orphan: running ones, and
// finished ones whose output no viewer has streamed to the end yet.
func (r *procRegistry) runningCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, d := range r.procs {
		d.mu.Lock()
		if d.running || !d.delivered {
			n++
		}
		d.mu.Unlock()
	}
	return n
}

func (r *procRegistry) killAll() {
	r.mu.Lock()
	procs := make([]*detachedProc, 0, len(r.procs))
	for _, d := range r.procs {
		procs = append(procs, d)
	}
	r.mu.Unlock()
	for _, d := range procs {
		d.mu.Lock()
		running := d.running
		d.mu.Unlock()
		if running && d.proc != nil {
			d.proc.kill()
		}
	}
}
