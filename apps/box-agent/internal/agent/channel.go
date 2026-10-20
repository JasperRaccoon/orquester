package agent

import (
	"errors"
	"io"
	"sync"

	"orquester/box-agent/internal/wire"
)

// creditBatch is how many consumed bytes are acknowledged at once (or fewer,
// whenever the inbound queue drains, so the peer never stalls on a remainder).
const creditBatch = 64 * 1024

// errChannelClosed is returned by Read/Write once the channel is gone.
var errChannelClosed = errors.New("channel closed")

// Channel is one multiplexed byte stream (box-protocol.ts "Channels"). Inbound
// bytes are stream 0 (toward the box); outbound writes choose stream 1 or 2.
// Both directions honour the BOX_CHANNEL_WINDOW_BYTES credit window.
type Channel struct {
	link *Link
	id   uint32

	mu      sync.Mutex
	changed chan struct{} // closed and replaced on every state change
	done    chan struct{} // closed once the channel is dead (either side)
	dead    bool
	sentEnd bool // we sent `close`

	credit int64 // outbound window left

	inbound   [][]byte
	inEOF     bool
	consumed  int64 // bytes read but not yet credited back
	peerError *wire.RPCError

	onResize func(cols, rows int)
	onSignal func(name string)
	onClose  func(err *wire.RPCError)

	// Box-opened channels: resolved by `opened` / `open-failed`.
	openWait chan struct{}
	openInfo *wire.OpenedInfo
	openErr  *wire.RPCError
	openOnce sync.Once
}

func newChannel(link *Link, id uint32) *Channel {
	return &Channel{
		link:    link,
		id:      id,
		changed: make(chan struct{}),
		done:    make(chan struct{}),
		credit:  wire.ChannelWindowBytes,
	}
}

// bump wakes every waiter; call with mu held.
func (c *Channel) bump() {
	close(c.changed)
	c.changed = make(chan struct{})
}

func (c *Channel) resolveOpen(info *wire.OpenedInfo, err *wire.RPCError) {
	c.openOnce.Do(func() {
		c.openInfo = info
		c.openErr = err
		if c.openWait != nil {
			close(c.openWait)
		}
	})
}

func (c *Channel) pushInbound(stream byte, payload []byte) {
	if stream != wire.StreamToBox || len(payload) == 0 {
		return
	}
	data := make([]byte, len(payload))
	copy(data, payload)
	c.mu.Lock()
	if !c.dead && !c.inEOF {
		c.inbound = append(c.inbound, data)
		c.bump()
	}
	c.mu.Unlock()
}

func (c *Channel) pushEOF() {
	c.mu.Lock()
	c.inEOF = true
	c.bump()
	c.mu.Unlock()
}

func (c *Channel) addCredit(n int64) {
	if n <= 0 {
		return
	}
	c.mu.Lock()
	c.credit += n
	c.bump()
	c.mu.Unlock()
}

func (c *Channel) resize(cols, rows int) {
	c.mu.Lock()
	fn := c.onResize
	c.mu.Unlock()
	if fn != nil {
		fn(cols, rows)
	}
}

func (c *Channel) signal(name string) {
	c.mu.Lock()
	fn := c.onSignal
	c.mu.Unlock()
	if fn != nil {
		fn(name)
	}
}

// SetHandlers installs the resize/signal/close callbacks.
func (c *Channel) SetHandlers(onResize func(cols, rows int), onSignal func(string), onClose func(*wire.RPCError)) {
	c.mu.Lock()
	c.onResize, c.onSignal, c.onClose = onResize, onSignal, onClose
	dead, err := c.dead, c.peerError
	c.mu.Unlock()
	if dead && onClose != nil {
		onClose(err)
	}
}

// peerClosed: the daemon closed the channel or the link dropped.
func (c *Channel) peerClosed(err *wire.RPCError) {
	c.mu.Lock()
	if c.dead {
		c.mu.Unlock()
		return
	}
	c.dead = true
	c.sentEnd = true
	c.peerError = err
	c.bump()
	close(c.done)
	fn := c.onClose
	c.mu.Unlock()
	c.resolveOpen(nil, &wire.RPCError{Code: "CLOSED", Message: "channel closed before it opened"})
	if fn != nil {
		fn(err)
	}
}

// Done is closed once the channel is dead.
func (c *Channel) Done() <-chan struct{} { return c.done }

// Read returns inbound stream-0 bytes; io.EOF after the peer's eof, and
// errChannelClosed when the channel died without one.
func (c *Channel) Read(p []byte) (int, error) {
	for {
		c.mu.Lock()
		if len(c.inbound) > 0 {
			n := copy(p, c.inbound[0])
			if n == len(c.inbound[0]) {
				c.inbound = c.inbound[1:]
			} else {
				c.inbound[0] = c.inbound[0][n:]
			}
			c.consumed += int64(n)
			var grant int64
			if c.consumed >= creditBatch || len(c.inbound) == 0 {
				grant = c.consumed
				c.consumed = 0
			}
			dead := c.dead
			c.mu.Unlock()
			if grant > 0 && !dead {
				_ = c.link.sendJSON(wire.Credit{T: "credit", Ch: c.id, Bytes: grant})
			}
			return n, nil
		}
		if c.inEOF {
			c.mu.Unlock()
			return 0, io.EOF
		}
		if c.dead {
			c.mu.Unlock()
			return 0, errChannelClosed
		}
		wait := c.changed
		c.mu.Unlock()
		<-wait
	}
}

// Write sends bytes on `stream`, split into frames and paced by credit.
func (c *Channel) Write(stream byte, p []byte) error {
	for len(p) > 0 {
		c.mu.Lock()
		for c.credit <= 0 && !c.dead {
			wait := c.changed
			c.mu.Unlock()
			<-wait
			c.mu.Lock()
		}
		if c.dead {
			c.mu.Unlock()
			return errChannelClosed
		}
		n := int64(len(p))
		if n > wire.MaxFramePayload {
			n = wire.MaxFramePayload
		}
		if n > c.credit {
			n = c.credit
		}
		c.credit -= n
		c.mu.Unlock()
		if err := c.link.sendData(c.id, stream, p[:n]); err != nil {
			return err
		}
		p = p[n:]
	}
	return nil
}

// StreamWriter adapts one outbound stream to io.Writer.
func (c *Channel) StreamWriter(stream byte) io.Writer { return streamWriter{c, stream} }

type streamWriter struct {
	c      *Channel
	stream byte
}

func (w streamWriter) Write(p []byte) (int, error) {
	if err := w.c.Write(w.stream, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

// gotEOF reports whether the peer half-closed stream 0.
func (c *Channel) gotEOF() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.inEOF
}

func (c *Channel) alive() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return !c.dead
}

// Opened answers the daemon's `open`.
func (c *Channel) Opened(info *wire.OpenedInfo) error {
	return c.link.sendJSON(wire.Opened{T: "opened", Ch: c.id, Info: info})
}

// OpenFailed answers the daemon's `open` with an error and frees the id.
func (c *Channel) OpenFailed(err error) {
	rpcErr := toRPCError(err)
	c.mu.Lock()
	if c.dead {
		c.mu.Unlock()
		return
	}
	c.dead = true
	c.sentEnd = true
	c.bump()
	close(c.done)
	c.mu.Unlock()
	c.link.forget(c.id)
	_ = c.link.sendJSON(wire.OpenFailed{T: "open-failed", Ch: c.id, Error: *rpcErr})
}

// EOF half-closes one outbound stream.
func (c *Channel) EOF(stream byte) {
	if c.alive() {
		_ = c.link.sendJSON(wire.Eof{T: "eof", Ch: c.id, Stream: stream})
	}
}

// Exit reports a process's end (exec/attach channels).
func (c *Channel) Exit(code *int, signal *string) {
	if c.alive() {
		_ = c.link.sendJSON(wire.Exit{T: "exit", Ch: c.id, Code: code, Signal: signal})
	}
}

// Close ends the channel from our side; err (optional) tells the daemon why
// a write/transfer failed. Idempotent; a no-op after the peer closed. The
// onClose handler runs only for peer closes and link loss.
func (c *Channel) Close(err error) {
	c.mu.Lock()
	if c.dead {
		c.mu.Unlock()
		return
	}
	c.dead = true
	c.sentEnd = true
	c.bump()
	close(c.done)
	c.mu.Unlock()
	c.link.forget(c.id)
	msg := wire.Close{T: "close", Ch: c.id}
	if err != nil {
		msg.Error = toRPCError(err)
	}
	_ = c.link.sendJSON(msg)
	c.resolveOpen(nil, &wire.RPCError{Code: "CLOSED", Message: "channel closed"})
}

// ReadCloser adapts the inbound stream to io.Reader for io.Copy.
func (c *Channel) Reader() io.Reader { return channelReader{c} }

type channelReader struct{ c *Channel }

func (r channelReader) Read(p []byte) (int, error) { return r.c.Read(p) }
