package agent

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"orquester/box-agent/internal/wire"
)

// SSH session request payloads (RFC 4254 §6).
type (
	sshPtyRequest struct {
		Term     string
		Columns  uint32
		Rows     uint32
		Width    uint32
		Height   uint32
		Modelist string
	}
	sshWindowChange struct {
		Columns uint32
		Rows    uint32
		Width   uint32
		Height  uint32
	}
	sshEnvRequest struct {
		Name  string
		Value string
	}
	sshExecRequest      struct{ Command string }
	sshSubsystemRequest struct{ Name string }
	sshSignalRequest    struct{ Signal string }
	sshExitStatus       struct{ Status uint32 }
	sshExitSignal       struct {
		Signal     string
		CoreDumped bool
		Error      string
		Lang       string
	}
)

// sshSessionEnvIgnored are orq-agent's service-manager variables: a login
// session started by sshd would not have them.
var sshSessionEnvIgnored = []string{
	"INVOCATION_ID", "JOURNAL_STREAM", "NOTIFY_SOCKET", "LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES",
	"WATCHDOG_PID", "WATCHDOG_USEC", "MANAGERPID", "SYSTEMD_EXEC_PID", "MAINPID",
	"ORQ_DAEMON_URL", "ORQ_DATA_DIR", "ORQ_WORK_USER", "ORQ_PROXY", "ORQ_GITHUB_OIDC",
}

// sshSession is one "session" channel: a shell, a command or the sftp subsystem.
type sshSession struct {
	agent   *Agent
	channel ssh.Channel

	mu      sync.Mutex
	env     []string // the client's `env` requests, KEY=VALUE
	pty     *wire.PtySpec
	started bool
	proc    process
	exited  chan struct{} // closed once proc was waited for
}

func (a *Agent) serveSSHSession(newChannel ssh.NewChannel) {
	channel, reqs, err := newChannel.Accept()
	if err != nil {
		return
	}
	s := &sshSession{agent: a, channel: channel, exited: make(chan struct{})}
	for req := range reqs {
		ok, run := s.handle(req)
		if req.WantReply {
			_ = req.Reply(ok, nil)
		}
		if run != nil {
			// After the reply: the client sees success before any output.
			go run()
		}
	}
	// The client closed the channel, or the connection ended.
	s.hangup()
}

// handle serves one channel request; `run` (when set) starts once the reply is sent.
func (s *sshSession) handle(req *ssh.Request) (ok bool, run func()) {
	switch req.Type {
	case "pty-req":
		var msg sshPtyRequest
		if ssh.Unmarshal(req.Payload, &msg) != nil {
			return false, nil
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.started {
			return false, nil
		}
		s.pty = &wire.PtySpec{Cols: int(msg.Columns), Rows: int(msg.Rows), Term: msg.Term}
		return true, nil
	case "env":
		var msg sshEnvRequest
		if ssh.Unmarshal(req.Payload, &msg) != nil || msg.Name == "" || strings.ContainsAny(msg.Name, "=\x00") || strings.ContainsRune(msg.Value, 0) {
			return false, nil
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.started {
			return false, nil
		}
		s.env = append(s.env, msg.Name+"="+msg.Value)
		return true, nil
	case "window-change":
		var msg sshWindowChange
		if ssh.Unmarshal(req.Payload, &msg) != nil {
			return false, nil
		}
		s.mu.Lock()
		proc, pty := s.proc, s.pty
		if pty != nil && proc == nil {
			pty.Cols, pty.Rows = int(msg.Columns), int(msg.Rows)
		}
		s.mu.Unlock()
		if proc != nil && pty != nil {
			return proc.resize(int(msg.Columns), int(msg.Rows)) == nil, nil
		}
		return pty != nil, nil
	case "signal":
		var msg sshSignalRequest
		if ssh.Unmarshal(req.Payload, &msg) != nil || msg.Signal == "" {
			return false, nil
		}
		s.mu.Lock()
		proc := s.proc
		s.mu.Unlock()
		if proc == nil || s.hasExited() {
			return false, nil
		}
		return proc.signal("SIG"+msg.Signal) == nil, nil
	case "shell":
		return s.start("", false)
	case "exec":
		var msg sshExecRequest
		if ssh.Unmarshal(req.Payload, &msg) != nil {
			return false, nil
		}
		return s.start(msg.Command, true)
	case "subsystem":
		var msg sshSubsystemRequest
		if ssh.Unmarshal(req.Payload, &msg) != nil || msg.Name != "sftp" {
			return false, nil
		}
		return s.startSFTP()
	}
	// x11-req, auth-agent-req@openssh.com, break, keepalives, …: refused.
	return false, nil
}

func (s *sshSession) hasExited() bool {
	select {
	case <-s.exited:
		return true
	default:
		return false
	}
}

// claim marks the session started; false when a shell/exec/subsystem already ran.
func (s *sshSession) claim() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.started {
		return false
	}
	s.started = true
	return true
}

// start runs the user's login shell, or `command` through it.
func (s *sshSession) start(command string, isExec bool) (bool, func()) {
	if !s.claim() {
		return false, nil
	}
	login := s.agent.sshLogin()
	s.mu.Lock()
	pty := s.pty
	env := s.agent.sshSessionEnv(login, s.env, pty)
	s.mu.Unlock()
	argv := sshShellArgv(login.shell, command, isExec)
	path, err := lookPath(login.shell, envLookup(env, "PATH"), envLookup(env, "PATHEXT"))
	if err != nil {
		return s.failStart(err)
	}
	return s.startProcess(&startSpec{path: path, args: argv, dir: login.dir, env: env, pty: pty, work: s.agent.work})
}

// startSFTP serves the sftp subsystem as the work user: in this process when
// orq-agent already runs as that user, else in an `orq-agent sftp-server`
// child started through the same credential drop as every command.
func (s *sshSession) startSFTP() (bool, func()) {
	if !s.claim() {
		return false, nil
	}
	login := s.agent.sshLogin()
	if s.agent.work != nil {
		argv, err := sftpServerArgv()
		if err != nil {
			return s.failStart(err)
		}
		s.mu.Lock()
		env := s.agent.sshSessionEnv(login, s.env, nil)
		s.mu.Unlock()
		return s.startProcess(&startSpec{path: argv[0], args: argv, dir: login.dir, env: env, work: s.agent.work})
	}
	var opts []sftp.ServerOption
	if login.dir != "" {
		opts = append(opts, sftp.WithServerWorkingDirectory(login.dir))
	}
	server, err := sftp.NewServer(s.channel, opts...)
	if err != nil {
		return s.failStart(err)
	}
	return true, func() {
		err := server.Serve()
		close(s.exited)
		code := 0
		if err != nil && !errors.Is(err, io.EOF) {
			code = 1
		}
		s.finish(&code, nil)
	}
}

// sftpServerArgv starts orq-agent's internal sftp-server mode.
var sftpServerArgv = func() ([]string, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	return []string{exe, "sftp-server"}, nil
}

func (s *sshSession) failStart(err error) (bool, func()) {
	s.agent.log.Printf("ssh session could not start: %v", err)
	_, _ = fmt.Fprintf(s.channel.Stderr(), "orq-agent: %v\r\n", err)
	close(s.exited)
	_ = s.channel.Close()
	return false, nil
}

func (s *sshSession) startProcess(spec *startSpec) (bool, func()) {
	proc, err := startProcess(spec)
	if err != nil {
		return s.failStart(err)
	}
	s.mu.Lock()
	s.proc = proc
	s.mu.Unlock()
	return true, func() { s.run(proc, spec.pty != nil) }
}

// run pipes the process and the channel until it exits, then reports how.
func (s *sshSession) run(proc process, pty bool) {
	go func() {
		stdin := proc.stdin()
		if stdin == nil {
			return
		}
		_, err := io.Copy(stdin, s.channel)
		if err == nil && !pty {
			// The client's EOF closes the process's stdin.
			_ = stdin.Close()
		}
	}()
	pumps := newOutputPumps()
	pumps.start(
		pumpPair{s.channel, proc.stdout()},
		pumpPair{s.channel.Stderr(), proc.stderr()},
	)
	code, signal := proc.wait()
	close(s.exited)
	pumps.drain(proc)
	proc.release()
	s.finish(code, signal)
}

// finish sends EOF, the exit status (or signal), and closes the channel.
func (s *sshSession) finish(code *int, signal *string) {
	_ = s.channel.CloseWrite()
	if signal != nil {
		_, _ = s.channel.SendRequest("exit-signal", false, ssh.Marshal(sshExitSignal{Signal: strings.TrimPrefix(*signal, "SIG")}))
	} else {
		status := 255
		if code != nil && *code >= 0 {
			status = *code
		}
		_, _ = s.channel.SendRequest("exit-status", false, ssh.Marshal(sshExitStatus{Status: uint32(status)}))
	}
	_ = s.channel.Close()
}

// hangup: the channel went away while the process may still run. Like a
// closed exec channel: SIGHUP, then SIGKILL after hangupGrace.
func (s *sshSession) hangup() {
	s.mu.Lock()
	proc := s.proc
	s.mu.Unlock()
	if proc == nil || s.hasExited() {
		return
	}
	_ = proc.signal("SIGHUP")
	time.AfterFunc(hangupGrace, func() {
		if !s.hasExited() {
			proc.kill()
		}
	})
}

// sshLoginInfo is whom a session runs as: the box's work user (or orq-agent's own).
type sshLoginInfo struct {
	user  string
	home  string
	shell string
	dir   string // the session's cwd: home when it exists
}

func (a *Agent) sshLogin() sshLoginInfo {
	info := a.sysInfo()
	login := sshLoginInfo{user: info.User, home: info.Home, shell: info.Shell}
	if a.work != nil {
		login.user, login.home = a.work.name, a.work.home
		if a.work.shell != "" {
			login.shell = a.work.shell
		}
	}
	if login.home == "" {
		login.home, _ = os.UserHomeDir()
	}
	if login.shell == "" {
		login.shell = defaultShell(login.user)
	}
	if st, err := os.Stat(login.home); err == nil && st.IsDir() {
		login.dir = login.home
	} else if !isWindows {
		// sshd: "Could not chdir to home directory", then starts in /.
		login.dir = "/"
	}
	return login
}

// sshSessionEnv is what exec channels get (orq-agent's env without secrets,
// ORQ_*, SSH_AUTH_SOCK to the host's agent, GH_CONFIG_DIR), without
// service-manager variables, then the client's `env`, then the login
// variables sshd sets.
func (a *Agent) sshSessionEnv(login sshLoginInfo, clientEnv []string, pty *wire.PtySpec) []string {
	env := newEnvMap(a.processEnv(nil, sshSessionEnvIgnored, pty))
	for _, kv := range clientEnv {
		key, value, _ := strings.Cut(kv, "=")
		env.set(key, value)
	}
	// There is no client address: the connection is relayed by the daemon.
	env.set("SSH_CLIENT", "127.0.0.1 0 0")
	env.set("SSH_CONNECTION", "127.0.0.1 0 127.0.0.1 0")
	if pty != nil {
		term := pty.Term
		if term == "" {
			term = "xterm-256color"
		}
		env.set("TERM", term)
	}
	sshPlatformEnv(env, login, a.work)
	return env.list()
}

// ServeSFTP is `orq-agent sftp-server`: the sftp subsystem over stdin/stdout,
// as whichever user started it (the SSH session's work user), relative paths
// from the current directory (the session starts it in the user's home).
func ServeSFTP(in io.Reader, out io.WriteCloser) error {
	server, err := sftp.NewServer(stdioConn{in, out})
	if err != nil {
		return err
	}
	if err := server.Serve(); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

type stdioConn struct {
	io.Reader
	io.WriteCloser
}
