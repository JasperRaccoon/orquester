package agent

// The built-in SSH server (spec 2026-11-22-tailnet-machines-and-agent-ssh-design.md
// §4.3 Phase 2). It listens on no network port: each daemon-opened `ssh`
// channel is one SSH transport. Only public keys the daemon pushed with
// `ssh.keys` are accepted; they live in memory and are never written anywhere,
// so replacing the set revokes a key at once (its open connections end too).

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"orquester/box-agent/internal/wire"
)

// sshHostKeyFile is the server's persistent host key in the data dir (0600).
const sshHostKeyFile = "ssh_host_ed25519_key"

// sshKeyIDExtension carries the authenticated key's identity in its Permissions.
const sshKeyIDExtension = "orq-key-id"

var errSSHKeyRefused = errors.New("public key not authorized")

type sshAuthorizedKey struct {
	expiresAt *int64 // epoch ms; nil = no expiry
}

// sshServer is the embedded SSH server.
type sshServer struct {
	agent  *Agent
	signer ssh.Signer
	// hostKey is the host public key in authorized_keys format ("ssh-ed25519 AAAA…").
	hostKey string

	mu    sync.Mutex
	keys  map[string]sshAuthorizedKey // wire-format public key → entry
	conns map[*ssh.ServerConn]string  // open connections → the key they authenticated with
}

func newSSHServer(a *Agent, signer ssh.Signer) *sshServer {
	return &sshServer{
		agent:   a,
		signer:  signer,
		hostKey: strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey()))),
		keys:    map[string]sshAuthorizedKey{},
		conns:   map[*ssh.ServerConn]string{},
	}
}

// loadSSHHostKey reads the host key from the data dir, generating it on first
// use. A file that does not parse is moved aside (`.bad`) and replaced: the
// daemon learns the new key from the authenticated hello and pins it again.
func loadSSHHostKey(dataDir string, logger interface{ Printf(string, ...any) }) (ssh.Signer, error) {
	path := filepath.Join(dataDir, sshHostKeyFile)
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		signer, parseErr := ssh.ParsePrivateKey(data)
		if parseErr == nil {
			return signer, nil
		}
		logger.Printf("the SSH host key %s does not parse (%v); generating a new one", path, parseErr)
		if err := os.Rename(path, path+".bad"); err != nil {
			return nil, fmt.Errorf("moving the unreadable SSH host key aside: %w", err)
		}
	case !errors.Is(err, fs.ErrNotExist):
		return nil, fmt.Errorf("reading the SSH host key: %w", err)
	}
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	block, err := ssh.MarshalPrivateKey(private, "orq-agent host key")
	if err != nil {
		return nil, err
	}
	if err := writeFileAtomic(path, pem.EncodeToMemory(block), 0o600); err != nil {
		return nil, fmt.Errorf("writing the SSH host key: %w", err)
	}
	return ssh.NewSignerFromKey(private)
}

// replaceKeys installs a new authorized set (all or nothing) and closes the
// connections whose key is no longer in it.
func (s *sshServer) replaceKeys(keys []wire.SSHAuthorizedKey) error {
	next := make(map[string]sshAuthorizedKey, len(keys))
	for i, key := range keys {
		parsed, _, _, _, err := ssh.ParseAuthorizedKey([]byte(key.PublicKey))
		if err != nil {
			return rpcErr("BAD_REQUEST", fmt.Sprintf("keys[%d] is not an OpenSSH public key", i))
		}
		next[string(parsed.Marshal())] = sshAuthorizedKey{expiresAt: key.ExpiresAt}
	}
	s.mu.Lock()
	s.keys = next
	var revoked []*ssh.ServerConn
	for conn, id := range s.conns {
		if _, ok := next[id]; !ok {
			revoked = append(revoked, conn)
		}
	}
	s.mu.Unlock()
	for _, conn := range revoked {
		_ = conn.Close()
	}
	return nil
}

// authorize is the PublicKeyCallback: the key must be in the set and unexpired.
func (s *sshServer) authorize(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
	id := string(key.Marshal())
	s.mu.Lock()
	entry, ok := s.keys[id]
	s.mu.Unlock()
	if !ok || (entry.expiresAt != nil && time.Now().UnixMilli() >= *entry.expiresAt) {
		return nil, errSSHKeyRefused
	}
	return &ssh.Permissions{Extensions: map[string]string{sshKeyIDExtension: id}}, nil
}

func (s *sshServer) config() *ssh.ServerConfig {
	cfg := &ssh.ServerConfig{
		// Public keys only: no password or keyboard-interactive callback is set.
		PublicKeyCallback: s.authorize,
		ServerVersion:     "SSH-2.0-orq-agent",
	}
	cfg.AddHostKey(s.signer)
	return cfg
}

// track records an authenticated connection; false when its key was revoked
// between authentication and now.
func (s *sshServer) track(conn *ssh.ServerConn) bool {
	id := conn.Permissions.Extensions[sshKeyIDExtension]
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.keys[id]; !ok {
		return false
	}
	s.conns[conn] = id
	return true
}

func (s *sshServer) untrack(conn *ssh.ServerConn) {
	s.mu.Lock()
	delete(s.conns, conn)
	s.mu.Unlock()
}

// serveConn runs one SSH connection over `transport` until it ends.
func (s *sshServer) serveConn(transport net.Conn) {
	conn, chans, reqs, err := ssh.NewServerConn(transport, s.config())
	if err != nil {
		_ = transport.Close()
		s.agent.log.Printf("ssh connection refused: %v", err)
		return
	}
	defer conn.Close()
	if !s.track(conn) {
		return
	}
	defer s.untrack(conn)
	// Global requests: tcpip-forward (ssh -R) and anything else are refused;
	// keepalives get the "failure" reply OpenSSH expects.
	go ssh.DiscardRequests(reqs)
	for newChannel := range chans {
		switch newChannel.ChannelType() {
		case "session":
			go s.agent.serveSSHSession(newChannel)
		case "direct-tcpip":
			go serveDirectTCPIP(newChannel)
		default:
			// x11, auth-agent@openssh.com, forwarded-tcpip, …
			_ = newChannel.Reject(ssh.UnknownChannelType, "channel type "+newChannel.ChannelType()+" is not supported")
		}
	}
}

// directTCPIPMsg is RFC 4254 §7.2's channel-open payload.
type directTCPIPMsg struct {
	Host       string
	Port       uint32
	OriginHost string
	OriginPort uint32
}

// serveDirectTCPIP (ssh -L) connects from the box to the requested address.
func serveDirectTCPIP(newChannel ssh.NewChannel) {
	var msg directTCPIPMsg
	if err := ssh.Unmarshal(newChannel.ExtraData(), &msg); err != nil {
		_ = newChannel.Reject(ssh.ConnectionFailed, "malformed direct-tcpip request")
		return
	}
	if msg.Port == 0 || msg.Port > 65535 {
		_ = newChannel.Reject(ssh.ConnectionFailed, "port out of range")
		return
	}
	target, err := net.DialTimeout("tcp", net.JoinHostPort(msg.Host, strconv.Itoa(int(msg.Port))), 15*time.Second)
	if err != nil {
		_ = newChannel.Reject(ssh.ConnectionFailed, err.Error())
		return
	}
	channel, reqs, err := newChannel.Accept()
	if err != nil {
		_ = target.Close()
		return
	}
	go ssh.DiscardRequests(reqs)
	pipeSSHChannel(channel, target)
}

// pipeSSHChannel copies both ways; a clean EOF half-closes, an error ends both.
func pipeSSHChannel(channel ssh.Channel, conn net.Conn) {
	var once sync.Once
	abort := func() {
		once.Do(func() {
			_ = conn.Close()
			_ = channel.Close()
		})
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		if _, err := io.Copy(conn, channel); err != nil {
			abort()
			return
		}
		if hc, ok := conn.(halfCloser); ok {
			_ = hc.CloseWrite()
		}
	}()
	go func() {
		defer wg.Done()
		if _, err := io.Copy(channel, conn); err != nil {
			abort()
			return
		}
		_ = channel.CloseWrite()
	}()
	wg.Wait()
	abort()
}

// openSSH serves a daemon-opened `ssh` channel: its byte stream is the SSH transport.
func (a *Agent) openSSH(ch *Channel) {
	if a.sshd == nil {
		ch.OpenFailed(rpcErr("UNKNOWN_CHANNEL", "the built-in SSH server is unavailable on this box (it has no host key)"))
		return
	}
	if err := ch.Opened(nil); err != nil {
		return
	}
	a.sshd.serveConn(channelConn{ch})
}

// handleSSHKeys serves "ssh.keys": replace the whole authorized set.
func handleSSHKeys(_ context.Context, a *Agent, _ *Link, raw json.RawMessage) (any, error) {
	p, err := decodeParams[wire.SSHKeysParams](raw)
	if err != nil {
		return nil, err
	}
	if a.sshd == nil {
		return nil, rpcErr("UNAVAILABLE", "the built-in SSH server is unavailable on this box (it has no host key)")
	}
	return nil, a.sshd.replaceKeys(p.Keys)
}

// channelConn is a box channel as the SSH transport: stream 0 in, stream 1 out.
type channelConn struct{ ch *Channel }

func (c channelConn) Read(p []byte) (int, error) { return c.ch.Read(p) }

func (c channelConn) Write(p []byte) (int, error) {
	if err := c.ch.Write(wire.StreamFromBox, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

// Close ends the transport like a tcp channel: eof on stream 1 after the last
// byte (writes are synchronous, so none is still in flight), then close.
func (c channelConn) Close() error {
	c.ch.EOF(wire.StreamFromBox)
	c.ch.Close(nil)
	return nil
}

func (channelConn) LocalAddr() net.Addr  { return channelAddr{} }
func (channelConn) RemoteAddr() net.Addr { return channelAddr{} }

// Deadlines: the SSH library sets none; the daemon's channel close ends reads.
func (channelConn) SetDeadline(time.Time) error      { return nil }
func (channelConn) SetReadDeadline(time.Time) error  { return nil }
func (channelConn) SetWriteDeadline(time.Time) error { return nil }

// channelAddr names the daemon relay: the client has no network address here.
type channelAddr struct{}

func (channelAddr) Network() string { return "orq-box" }
func (channelAddr) String() string  { return "daemon" }
