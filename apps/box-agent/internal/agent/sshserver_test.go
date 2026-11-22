//go:build !windows

package agent

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"orquester/box-agent/internal/wire"
)

// sshTestBox is an agent whose SSH server is reachable on a loopback port
// (the tests' stand-in for the daemon's `ssh` channel).
type sshTestBox struct {
	t     *testing.T
	agent *Agent
	home  string
	addr  string
}

func newSSHTestBox(t *testing.T) *sshTestBox {
	t.Helper()
	me, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	a := &Agent{
		log:    log.New(io.Discard, "", 0),
		procs:  newProcRegistry(),
		linkUp: make(chan struct{}),
		stop:   make(chan struct{}),
		sys:    wire.SysInfo{User: me.Username, Home: home, Shell: "/bin/sh"},
	}
	signer, err := loadSSHHostKey(t.TempDir(), a.log)
	if err != nil {
		t.Fatal(err)
	}
	a.sshd = newSSHServer(a, signer)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go a.sshd.serveConn(conn)
		}
	}()
	return &sshTestBox{t: t, agent: a, home: home, addr: ln.Addr().String()}
}

// clientKey makes a client key pair: its signer and its authorized_keys line.
func clientKey(t *testing.T) (ssh.Signer, string) {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	return signer, strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))
}

func (b *sshTestBox) setKeys(keys ...wire.SSHAuthorizedKey) {
	b.t.Helper()
	if err := b.agent.sshd.replaceKeys(keys); err != nil {
		b.t.Fatal(err)
	}
}

func (b *sshTestBox) clientConfig(signer ssh.Signer) *ssh.ClientConfig {
	return &ssh.ClientConfig{
		User:            "agent",
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: ssh.FixedHostKey(b.agent.sshd.signer.PublicKey()),
	}
}

func (b *sshTestBox) dial(signer ssh.Signer) (*ssh.Client, error) {
	return ssh.Dial("tcp", b.addr, b.clientConfig(signer))
}

// login dials with a fresh authorized key.
func (b *sshTestBox) login() *ssh.Client {
	b.t.Helper()
	signer, line := clientKey(b.t)
	b.setKeys(wire.SSHAuthorizedKey{PublicKey: line, Comment: "orquester chat=t box=b"})
	client, err := b.dial(signer)
	if err != nil {
		b.t.Fatal(err)
	}
	b.t.Cleanup(func() { client.Close() })
	return client
}

func session(t *testing.T, client *ssh.Client) *ssh.Session {
	t.Helper()
	s, err := client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestSSHAcceptsOnlyTheCurrentUnexpiredKeys(t *testing.T) {
	b := newSSHTestBox(t)
	keyA, lineA := clientKey(t)
	keyB, lineB := clientKey(t)
	keyC, lineC := clientKey(t)
	past := time.Now().Add(-time.Minute).UnixMilli()
	future := time.Now().Add(time.Hour).UnixMilli()

	if _, err := b.dial(keyA); err == nil {
		t.Fatal("with no keys pushed, every key must be refused")
	}
	b.setKeys(
		wire.SSHAuthorizedKey{PublicKey: lineA, ExpiresAt: &future},
		wire.SSHAuthorizedKey{PublicKey: lineB, ExpiresAt: &past},
	)
	clientA, err := b.dial(keyA)
	if err != nil {
		t.Fatalf("an authorized key was refused: %v", err)
	}
	defer clientA.Close()
	if _, err := b.dial(keyB); err == nil {
		t.Fatal("an expired key was accepted")
	}
	if _, err := b.dial(keyC); err == nil {
		t.Fatal("an unknown key was accepted")
	}
	pw := b.clientConfig(keyA)
	pw.Auth = []ssh.AuthMethod{ssh.Password("x"), ssh.KeyboardInteractive(func(string, string, []string, []bool) ([]string, error) { return nil, nil })}
	if _, err := ssh.Dial("tcp", b.addr, pw); err == nil {
		t.Fatal("password or keyboard-interactive auth was accepted")
	}

	// A set with a malformed key is refused whole: A keeps working.
	if err := b.agent.sshd.replaceKeys([]wire.SSHAuthorizedKey{{PublicKey: lineC}, {PublicKey: "not a key"}}); err == nil {
		t.Fatal("a malformed key was accepted")
	}
	if _, err := b.dial(keyC); err == nil {
		t.Fatal("a refused set was partly applied")
	}

	// Replacing the set revokes A at once: its open connection ends too.
	b.setKeys(wire.SSHAuthorizedKey{PublicKey: lineC, Comment: "orquester box=b"})
	_ = clientA.Wait() // returns once the server closed the connection
	if _, err := clientA.NewSession(); err == nil {
		t.Fatal("a revoked key's connection still opens sessions")
	}
	if _, err := b.dial(keyA); err == nil {
		t.Fatal("a removed key was accepted")
	}
	clientC, err := b.dial(keyC)
	if err != nil {
		t.Fatalf("the replacement key was refused: %v", err)
	}
	clientC.Close()
}

func TestSSHExecReportsExitStatusEnvAndLoginVariables(t *testing.T) {
	b := newSSHTestBox(t)
	s := session(t, b.login())
	if err := s.Setenv("ORQ_SSH_TEST", "from client"); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	s.Stdout, s.Stderr = &stdout, &stderr
	err := s.Run(`printf '%s|%s|%s|%s|' "$ORQ_SSH_TEST" "$HOME" "$(pwd)" "$SHELL"; [ -n "$SSH_CONNECTION" ] && printf ssh; echo oops >&2; exit 3`)
	var exit *ssh.ExitError
	if !errors.As(err, &exit) || exit.ExitStatus() != 3 {
		t.Fatalf("exec = %v; want exit status 3", err)
	}
	want := "from client|" + b.home + "|" + b.home + "|/bin/sh|ssh"
	if stdout.String() != want {
		t.Fatalf("stdout = %q; want %q", stdout.String(), want)
	}
	if stderr.String() != "oops\n" {
		t.Fatalf("stderr = %q", stderr.String())
	}

	// stdin reaches the command, and the client's EOF closes it.
	s2 := session(t, b.login())
	s2.Stdin = strings.NewReader("line one\nline two\n")
	out, err := s2.Output("wc -l")
	if err != nil || strings.TrimSpace(string(out)) != "2" {
		t.Fatalf("wc -l = %q, %v", out, err)
	}
}

func TestSSHPtyShellFollowsWindowChanges(t *testing.T) {
	b := newSSHTestBox(t)
	s := session(t, b.login())
	if err := s.RequestPty("vt100", 24, 80, ssh.TerminalModes{ssh.ECHO: 1}); err != nil {
		t.Fatal(err)
	}
	stdin, err := s.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	s.Stdout = &out
	if err := s.Shell(); err != nil {
		t.Fatal(err)
	}
	if err := s.WindowChange(40, 100); err != nil {
		t.Fatal(err)
	}
	// Requests are served in order: once this one is answered, the resize was applied.
	if _, err := s.SendRequest("sync@orquester.test", true, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(stdin, "tty -s && echo \"term=$TERM\"; stty size; exit 7\n"); err != nil {
		t.Fatal(err)
	}
	err = s.Wait()
	var exit *ssh.ExitError
	if !errors.As(err, &exit) || exit.ExitStatus() != 7 {
		t.Fatalf("shell = %v; want exit status 7 (output %q)", err, out.String())
	}
	if !strings.Contains(out.String(), "term=vt100") || !strings.Contains(out.String(), "40 100") {
		t.Fatalf("pty output = %q; want term=vt100 and the new size 40 100", out.String())
	}
}

func TestSSHSignalEndsTheCommandAndReportsIt(t *testing.T) {
	b := newSSHTestBox(t)
	s := session(t, b.login())
	stdout, err := s.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Start("echo ready; exec sleep 1000"); err != nil {
		t.Fatal(err)
	}
	line := make([]byte, len("ready\n"))
	if _, err := io.ReadFull(stdout, line); err != nil || string(line) != "ready\n" {
		t.Fatalf("read %q, %v", line, err)
	}
	if err := s.Signal(ssh.SIGTERM); err != nil {
		t.Fatal(err)
	}
	err = s.Wait()
	var exit *ssh.ExitError
	if !errors.As(err, &exit) || exit.Signal() != "TERM" {
		t.Fatalf("wait = %v; want exit-signal TERM", err)
	}
}

func TestSSHSftpPutAndGetInTheHome(t *testing.T) {
	b := newSSHTestBox(t)
	client, err := sftp.NewClient(b.login())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if wd, err := client.Getwd(); err != nil || wd != b.home {
		t.Fatalf("sftp cwd = %q, %v; want %q", wd, err, b.home)
	}
	f, err := client.Create("upload.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte("over sftp")); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(b.home, "upload.txt")); err != nil || string(data) != "over sftp" {
		t.Fatalf("on the box: %q, %v", data, err)
	}
	r, err := client.Open(filepath.Join(b.home, "upload.txt"))
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if data, err := io.ReadAll(r); err != nil || string(data) != "over sftp" {
		t.Fatalf("read back %q, %v", data, err)
	}
}

func TestSSHDirectTCPIPReachesTheBoxAndRemoteForwardIsRefused(t *testing.T) {
	b := newSSHTestBox(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = io.Copy(conn, conn)
	}()
	client := b.login()
	conn, err := client.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	if err := conn.(interface{ CloseWrite() error }).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	echoed, err := io.ReadAll(conn)
	if err != nil || string(echoed) != "ping" {
		t.Fatalf("echo = %q, %v", echoed, err)
	}
	conn.Close()
	if _, err := client.Dial("tcp", "127.0.0.1:1"); err == nil {
		t.Fatal("a refused target must fail the channel open")
	}
	if remote, err := client.Listen("tcp", "127.0.0.1:0"); err == nil {
		remote.Close()
		t.Fatal("tcpip-forward (ssh -R) was accepted")
	}
}

func TestSSHHostKeyPersistsAndHelloAdvertisesIt(t *testing.T) {
	dir := t.TempDir()
	logger := log.New(io.Discard, "", 0)
	first, err := loadSSHHostKey(dir, logger)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(dir, sshHostKeyFile))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("host key file: %v, %v; want mode 0600", info, err)
	}
	again, err := loadSSHHostKey(dir, logger)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first.PublicKey().Marshal(), again.PublicKey().Marshal()) {
		t.Fatal("the host key changed across restarts")
	}
	a := &Agent{log: logger, procs: newProcRegistry()}
	a.sshd = newSSHServer(a, again)
	hello := a.hello(wire.Auth{Kind: "credential"})
	if !slices.Contains(hello.Capabilities, wire.CapabilitySSHServer) {
		t.Fatalf("capabilities = %v", hello.Capabilities)
	}
	advertised, _, _, _, err := ssh.ParseAuthorizedKey([]byte(hello.SSHHostKey))
	if err != nil || !bytes.Equal(advertised.Marshal(), first.PublicKey().Marshal()) || !strings.HasPrefix(hello.SSHHostKey, "ssh-ed25519 ") {
		t.Fatalf("sshHostKey = %q, %v", hello.SSHHostKey, err)
	}
	// Without a host key the capability is not claimed.
	if bare := (&Agent{procs: newProcRegistry()}).hello(wire.Auth{}); slices.Contains(bare.Capabilities, wire.CapabilitySSHServer) || bare.SSHHostKey != "" {
		t.Fatalf("hello without a server = %+v", bare)
	}
}

// boxChannelConn is the daemon's end of a box channel, as a net.Conn.
type boxChannelConn struct {
	d       *testDaemon
	ch      uint32
	pending []byte
}

func (c *boxChannelConn) Read(p []byte) (int, error) {
	for len(c.pending) == 0 {
		frame, ok := <-c.d.data
		if !ok {
			return 0, io.EOF
		}
		if frame.ch != c.ch {
			continue
		}
		c.pending = frame.payload
		credit, _ := json.Marshal(wire.Credit{T: "credit", Ch: c.ch, Bytes: int64(len(frame.payload))})
		if err := c.d.conn.Write(c.d.ctx, websocket.MessageText, credit); err != nil {
			return 0, err
		}
	}
	n := copy(p, c.pending)
	c.pending = c.pending[n:]
	return n, nil
}

func (c *boxChannelConn) Write(p []byte) (int, error) {
	for sent := 0; sent < len(p); {
		n := min(len(p)-sent, wire.MaxFramePayload)
		frame, err := wire.EncodeDataFrame(c.ch, wire.StreamToBox, p[sent:sent+n])
		if err != nil {
			return sent, err
		}
		if err := c.d.conn.Write(c.d.ctx, websocket.MessageBinary, frame); err != nil {
			return sent, err
		}
		sent += n
	}
	return len(p), nil
}

func (c *boxChannelConn) Close() error                     { return nil }
func (c *boxChannelConn) LocalAddr() net.Addr              { return channelAddr{} }
func (c *boxChannelConn) RemoteAddr() net.Addr             { return channelAddr{} }
func (c *boxChannelConn) SetDeadline(time.Time) error      { return nil }
func (c *boxChannelConn) SetReadDeadline(time.Time) error  { return nil }
func (c *boxChannelConn) SetWriteDeadline(time.Time) error { return nil }

// The daemon's path: `ssh.keys` over the link, then an SSH connection through an `ssh` channel.
func TestSSHChannelServesAnSSHConnectionOverTheLink(t *testing.T) {
	d := newTestDaemon(t)
	signer, err := loadSSHHostKey(t.TempDir(), d.agent.log)
	if err != nil {
		t.Fatal(err)
	}
	d.agent.sshd = newSSHServer(d.agent, signer)
	d.agent.sys = wire.SysInfo{Home: t.TempDir(), Shell: "/bin/sh"}
	key, line := clientKey(t)
	d.send(map[string]any{"t": "req", "id": 1, "method": "ssh.keys", "params": map[string]any{
		"keys": []map[string]any{{"publicKey": line, "comment": "orquester chat=t box=b", "expiresAt": nil}},
	}})
	if res := d.expect("ssh.keys response", isRes(1)); res["ok"] != true {
		t.Fatalf("ssh.keys = %v", res)
	}
	d.send(map[string]any{"t": "open", "ch": 2, "spec": map[string]any{"kind": "ssh"}})
	d.expect("opened", isMsg("opened", 2))
	conn, chans, reqs, err := ssh.NewClientConn(&boxChannelConn{d: d, ch: 2}, "box", &ssh.ClientConfig{
		User:            "agent",
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(key)},
		HostKeyCallback: ssh.FixedHostKey(signer.PublicKey()),
	})
	if err != nil {
		t.Fatal(err)
	}
	client := ssh.NewClient(conn, chans, reqs)
	defer client.Close()
	s := session(t, client)
	out, err := s.Output("echo over the link")
	if err != nil || string(out) != "over the link\n" {
		t.Fatalf("exec = %q, %v", out, err)
	}
}

func isRes(id int) func(map[string]any) bool {
	return func(msg map[string]any) bool { return msg["t"] == "res" && msg["id"] == float64(id) }
}

// Real OpenSSH clients: rsync over exec, and scp (OpenSSH ≥ 9 speaks sftp).
func TestOpenSSHClientsRsyncAndScp(t *testing.T) {
	sshPath, err := exec.LookPath("ssh")
	if err != nil {
		t.Skip("no ssh client on this host")
	}
	b := newSSHTestBox(t)
	_, port, _ := net.SplitHostPort(b.addr)
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	block, err := ssh.MarshalPrivateKey(private, "test")
	if err != nil {
		t.Fatal(err)
	}
	clientHome := t.TempDir()
	keyPath := filepath.Join(clientHome, "id_ed25519")
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(block), 0o600); err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	b.setKeys(wire.SSHAuthorizedKey{PublicKey: string(ssh.MarshalAuthorizedKey(signer.PublicKey()))})
	knownHosts := filepath.Join(clientHome, "known_hosts")
	pinned := "[127.0.0.1]:" + port + " " + b.agent.sshd.hostKey + "\n"
	if err := os.WriteFile(knownHosts, []byte(pinned), 0o600); err != nil {
		t.Fatal(err)
	}
	// Never the host's own ssh config, keys or known_hosts.
	opts := []string{"-F", "/dev/null", "-i", keyPath, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
		"-o", "UserKnownHostsFile=" + knownHosts, "-o", "StrictHostKeyChecking=yes", "-o", "GlobalKnownHostsFile=/dev/null"}
	run := func(name string, args ...string) {
		t.Helper()
		cmd := exec.Command(name, args...)
		cmd.Env = append(os.Environ(), "HOME="+clientHome)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%s %v: %v\n%s", name, args, err, out)
		}
	}
	src := filepath.Join(clientHome, "src")
	if err := os.MkdirAll(filepath.Join(src, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "sub", "file.txt"), []byte("synced"), 0o644); err != nil {
		t.Fatal(err)
	}

	sshArgs := append(append([]string{}, opts...), "-p", port, "agent@127.0.0.1", "printf", "%s", "plain-ssh")
	cmd := exec.Command(sshPath, sshArgs...)
	cmd.Env = append(os.Environ(), "HOME="+clientHome)
	if out, err := cmd.Output(); err != nil || string(out) != "plain-ssh" {
		t.Fatalf("ssh exec = %q, %v", out, err)
	}

	if scp, err := exec.LookPath("scp"); err == nil {
		run(scp, append(append([]string{}, opts...), "-P", port, filepath.Join(src, "sub", "file.txt"), "agent@127.0.0.1:copied.txt")...)
		if data, err := os.ReadFile(filepath.Join(b.home, "copied.txt")); err != nil || string(data) != "synced" {
			t.Fatalf("scp result = %q, %v", data, err)
		}
	}
	rsync, err := exec.LookPath("rsync")
	if err != nil {
		t.Log("no rsync on this host: rsync not checked")
		return
	}
	// rsync splits -e on spaces; the temp paths have none.
	transport := sshPath + " -p " + port + " " + strings.Join(opts, " ")
	run(rsync, "-a", "-e", transport, src+"/", "agent@127.0.0.1:dst/")
	if data, err := os.ReadFile(filepath.Join(b.home, "dst", "sub", "file.txt")); err != nil || string(data) != "synced" {
		t.Fatalf("rsync result = %q, %v", data, err)
	}
}

// As root with a work user, the sftp subsystem runs in a child dropped to that
// user: what it writes belongs to the work user, never to root.
func TestSSHSftpRunsAsTheWorkUser(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root to drop to a work user")
	}
	const nobody = 65534
	b := newSSHTestBox(t)
	// The work user must reach the helper binary and own its home.
	binDir, err := os.MkdirTemp("", "orq-sftp-bin-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(binDir)
	home, err := os.MkdirTemp("", "orq-sftp-home-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(home)
	for _, dir := range []string{binDir, home} {
		if err := os.Chmod(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chown(home, nobody, nobody); err != nil {
		t.Fatal(err)
	}
	self, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	helper := filepath.Join(binDir, "agent.test")
	if err := os.WriteFile(helper, self, 0o755); err != nil {
		t.Fatal(err)
	}
	restore := sftpServerArgv
	sftpServerArgv = func() ([]string, error) { return []string{helper, "sftp-server"}, nil }
	defer func() { sftpServerArgv = restore }()
	t.Setenv("ORQ_TEST_HELPER", "sftp-server")
	b.agent.work = &workUser{name: "nobody", uid: nobody, gid: nobody, home: home, shell: "/bin/sh"}

	client, err := sftp.NewClient(b.login())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	f, err := client.Create("owned.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte("mine")); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(home, "owned.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if uid := info.Sys().(*syscall.Stat_t).Uid; uid != nobody {
		t.Fatalf("the sftp upload belongs to uid %d; want the work user %d", uid, nobody)
	}
	if _, err := client.Create("/root/orq-sftp-escape"); err == nil {
		client.Remove("/root/orq-sftp-escape")
		t.Fatal("the sftp server wrote where only root may")
	}
}
