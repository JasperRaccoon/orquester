package agent

import (
	"context"
	"net"
	"strconv"
	"sync"
	"time"

	"orquester/box-agent/internal/wire"
)

// forwardListener is one `forward.listen`: box 127.0.0.1:boxPort, each
// accepted connection piped to the daemon target over a `host-tcp` channel.
// Listeners belong to a link; the daemon re-establishes them on reconnect.
type forwardListener struct {
	link    *Link
	boxPort int
	ln      net.Listener
	mu      sync.Mutex
	target  string
}

func (l *Link) listenForward(spec wire.ForwardSpec) error {
	l.mu.Lock()
	if existing := l.forwards[spec.BoxPort]; existing != nil {
		l.mu.Unlock()
		existing.mu.Lock()
		existing.target = spec.Target
		existing.mu.Unlock()
		return nil
	}
	l.mu.Unlock()
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(spec.BoxPort)))
	if err != nil {
		return err
	}
	f := &forwardListener{link: l, boxPort: spec.BoxPort, ln: ln, target: spec.Target}
	l.mu.Lock()
	if l.ctx.Err() != nil {
		l.mu.Unlock()
		ln.Close()
		return errLinkLost
	}
	if existing := l.forwards[spec.BoxPort]; existing != nil {
		// Lost a race with a concurrent listen for the same port.
		l.mu.Unlock()
		ln.Close()
		existing.mu.Lock()
		existing.target = spec.Target
		existing.mu.Unlock()
		return nil
	}
	l.forwards[spec.BoxPort] = f
	l.mu.Unlock()
	go f.accept()
	return nil
}

func (l *Link) unlistenForward(port int) {
	l.mu.Lock()
	f := l.forwards[port]
	delete(l.forwards, port)
	l.mu.Unlock()
	if f != nil {
		f.close()
	}
}

func (f *forwardListener) close() { _ = f.ln.Close() }

func (f *forwardListener) accept() {
	for {
		conn, err := f.ln.Accept()
		if err != nil {
			return
		}
		go f.handle(conn)
	}
}

func (f *forwardListener) handle(conn net.Conn) {
	f.mu.Lock()
	target := f.target
	f.mu.Unlock()
	ctx, cancel := context.WithTimeout(f.link.ctx, 30*time.Second)
	defer cancel()
	ch, err := f.link.OpenChannel(ctx, wire.HostTCPSpec{Kind: "host-tcp", Target: target, BoxPort: f.boxPort})
	if err != nil {
		conn.Close()
		return
	}
	bridge(ch, conn)
}
