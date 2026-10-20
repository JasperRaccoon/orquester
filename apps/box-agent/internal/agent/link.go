package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"orquester/box-agent/internal/wire"
)

// errLinkLost is what pending work sees when the WebSocket to the daemon drops.
var errLinkLost = &wire.RPCError{Code: "BOX_DISCONNECTED", Message: "the link to the daemon dropped"}

// Link is one authenticated WebSocket to the daemon (after `welcome`): it
// multiplexes requests, events and channels (box-protocol.ts "Transport").
type Link struct {
	agent  *Agent
	conn   *websocket.Conn
	ctx    context.Context
	cancel context.CancelFunc
	boxID  string
	config wire.AgentConfig

	writeMu sync.Mutex

	mu       sync.Mutex
	channels map[uint32]*Channel
	nextCh   uint32
	nextReq  int64
	pending  map[int64]chan *wire.Response
	forwards map[int]*forwardListener
	watches  map[string]*watch

	lastRecv atomic.Int64
	pingID   atomic.Int64
}

func newLink(agent *Agent, conn *websocket.Conn, boxID string, config wire.AgentConfig) *Link {
	ctx, cancel := context.WithCancel(context.Background())
	l := &Link{
		agent:    agent,
		conn:     conn,
		ctx:      ctx,
		cancel:   cancel,
		boxID:    boxID,
		config:   config,
		channels: map[uint32]*Channel{},
		nextCh:   1,
		pending:  map[int64]chan *wire.Response{},
		forwards: map[int]*forwardListener{},
		watches:  map[string]*watch{},
	}
	l.lastRecv.Store(time.Now().UnixMilli())
	return l
}

// Done is closed once the link is gone.
func (l *Link) Done() <-chan struct{} { return l.ctx.Done() }

func (l *Link) sendJSON(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return l.write(websocket.MessageText, data)
}

func (l *Link) sendData(ch uint32, stream byte, payload []byte) error {
	frame, err := wire.EncodeDataFrame(ch, stream, payload)
	if err != nil {
		return err
	}
	return l.write(websocket.MessageBinary, frame)
}

func (l *Link) write(kind websocket.MessageType, data []byte) error {
	l.writeMu.Lock()
	defer l.writeMu.Unlock()
	if l.ctx.Err() != nil {
		return errLinkLost
	}
	if err := l.conn.Write(l.ctx, kind, data); err != nil {
		l.cancel()
		return errLinkLost
	}
	return nil
}

// serve runs the read loop until the link drops, then tears down everything
// that belonged to it. Detached processes survive (only their viewers end).
func (l *Link) serve() {
	defer l.teardown()
	go l.heartbeat()
	for {
		kind, data, err := l.conn.Read(l.ctx)
		if err != nil {
			return
		}
		l.lastRecv.Store(time.Now().UnixMilli())
		if kind == websocket.MessageBinary {
			l.handleData(data)
			continue
		}
		msg, err := wire.DecodeControl(data, false)
		if err != nil {
			l.agent.log.Printf("closing link: malformed control frame")
			_ = l.conn.Close(websocket.StatusProtocolError, "malformed control frame")
			return
		}
		l.handleControl(msg)
	}
}

func (l *Link) heartbeat() {
	interval := time.Duration(l.config.HeartbeatMs) * time.Millisecond
	if interval <= 0 {
		interval = wire.HeartbeatMs * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-l.ctx.Done():
			return
		case <-ticker.C:
			silent := time.Since(time.UnixMilli(l.lastRecv.Load()))
			if silent > 3*interval {
				l.agent.log.Printf("closing link: daemon silent for %s", silent.Round(time.Second))
				_ = l.conn.Close(websocket.StatusGoingAway, "heartbeat timeout")
				l.cancel()
				return
			}
			_ = l.sendJSON(wire.Ping{T: "ping", ID: l.pingID.Add(1)})
		}
	}
}

func (l *Link) teardown() {
	l.cancel()
	l.mu.Lock()
	channels := l.channels
	l.channels = map[uint32]*Channel{}
	pending := l.pending
	l.pending = map[int64]chan *wire.Response{}
	forwards := l.forwards
	l.forwards = map[int]*forwardListener{}
	watches := l.watches
	l.watches = map[string]*watch{}
	l.mu.Unlock()
	for _, ch := range channels {
		ch.peerClosed(errLinkLost)
	}
	for _, wait := range pending {
		close(wait)
	}
	for _, f := range forwards {
		f.close()
	}
	for _, w := range watches {
		w.stop()
	}
	_ = l.conn.CloseNow()
}

func (l *Link) handleData(frame []byte) {
	id, stream, payload, err := wire.DecodeDataFrame(frame)
	if err != nil {
		return
	}
	l.mu.Lock()
	ch := l.channels[id]
	l.mu.Unlock()
	if ch == nil {
		// Data for a channel that was just closed: dropped (ids are never reused).
		return
	}
	ch.pushInbound(stream, payload)
}

func (l *Link) channel(id uint32) *Channel {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.channels[id]
}

func (l *Link) handleControl(msg any) {
	switch m := msg.(type) {
	case *wire.Ping:
		if m.T == "ping" {
			_ = l.sendJSON(wire.Ping{T: "pong", ID: m.ID})
		}
	case *wire.Request:
		go l.agent.handleRequest(l, m)
	case *wire.Response:
		l.mu.Lock()
		wait := l.pending[m.ID]
		delete(l.pending, m.ID)
		l.mu.Unlock()
		if wait != nil {
			wait <- m
		}
	case *wire.Open:
		// Register synchronously: the daemon may send the channel's data
		// right behind the open frame.
		ch := l.registerChannel(m.Ch)
		go l.agent.handleOpen(l, ch, m.Spec)
	case *wire.Opened:
		if ch := l.channel(m.Ch); ch != nil {
			ch.resolveOpen(m.Info, nil)
		}
	case *wire.OpenFailed:
		if ch := l.channel(m.Ch); ch != nil {
			err := m.Error
			ch.resolveOpen(nil, &err)
		}
	case *wire.Eof:
		if ch := l.channel(m.Ch); ch != nil && m.Stream == wire.StreamToBox {
			ch.pushEOF()
		}
	case *wire.Resize:
		if ch := l.channel(m.Ch); ch != nil {
			ch.resize(m.Cols, m.Rows)
		}
	case *wire.Signal:
		if ch := l.channel(m.Ch); ch != nil {
			ch.signal(m.Signal)
		}
	case *wire.Credit:
		if ch := l.channel(m.Ch); ch != nil {
			ch.addCredit(m.Bytes)
		}
	case *wire.Close:
		l.mu.Lock()
		ch := l.channels[m.Ch]
		delete(l.channels, m.Ch)
		l.mu.Unlock()
		if ch != nil {
			ch.peerClosed(m.Error)
		}
	case *wire.Reject:
		// A reject after welcome: the daemon gave up on this connection
		// (e.g. AGENT_OUTDATED after a failed update request).
		l.agent.handleReject(m)
		l.cancel()
	case *wire.Event, *wire.Exit, *wire.Hello, *wire.Welcome:
		// Not expected from the daemon after the handshake; ignored.
	}
}

func (l *Link) registerChannel(id uint32) *Channel {
	ch := newChannel(l, id)
	l.mu.Lock()
	l.channels[id] = ch
	l.mu.Unlock()
	return ch
}

func (l *Link) forget(id uint32) {
	l.mu.Lock()
	delete(l.channels, id)
	l.mu.Unlock()
}

// Request sends a box → host request and waits for its response.
func (l *Link) Request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	raw, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	wait := make(chan *wire.Response, 1)
	l.mu.Lock()
	if l.ctx.Err() != nil {
		l.mu.Unlock()
		return nil, errLinkLost
	}
	l.nextReq++
	id := l.nextReq
	l.pending[id] = wait
	l.mu.Unlock()
	if err := l.sendJSON(wire.Request{T: "req", ID: id, Method: method, Params: raw}); err != nil {
		l.mu.Lock()
		delete(l.pending, id)
		l.mu.Unlock()
		return nil, err
	}
	select {
	case res, ok := <-wait:
		if !ok {
			return nil, errLinkLost
		}
		if !res.OK {
			if res.Error == nil {
				return nil, &wire.RPCError{Code: "INTERNAL", Message: "request failed"}
			}
			return nil, res.Error
		}
		return res.Result, nil
	case <-ctx.Done():
		l.mu.Lock()
		delete(l.pending, id)
		l.mu.Unlock()
		return nil, &wire.RPCError{Code: "TIMEOUT", Message: fmt.Sprintf("%s timed out", method)}
	}
}

// OpenChannel opens a box → host channel (odd id) and waits for `opened`.
func (l *Link) OpenChannel(ctx context.Context, spec any) (*Channel, error) {
	raw, err := json.Marshal(spec)
	if err != nil {
		return nil, err
	}
	l.mu.Lock()
	if l.ctx.Err() != nil {
		l.mu.Unlock()
		return nil, errLinkLost
	}
	id := l.nextCh
	l.nextCh += 2
	ch := newChannel(l, id)
	ch.openWait = make(chan struct{})
	l.channels[id] = ch
	l.mu.Unlock()
	if err := l.sendJSON(wire.Open{T: "open", Ch: id, Spec: raw}); err != nil {
		l.forget(id)
		return nil, err
	}
	select {
	case <-ch.openWait:
		if ch.openErr != nil {
			l.forget(id)
			return nil, ch.openErr
		}
		return ch, nil
	case <-ch.done:
		return nil, errLinkLost
	case <-ctx.Done():
		ch.Close(nil)
		return nil, &wire.RPCError{Code: "TIMEOUT", Message: "channel open timed out"}
	}
}

// SendEvent emits a box event (e.g. `fs.change`).
func (l *Link) SendEvent(name string, data any) error {
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	return l.sendJSON(wire.Event{T: "event", Name: name, Data: raw})
}

var errBadParams = errors.New("bad params")
