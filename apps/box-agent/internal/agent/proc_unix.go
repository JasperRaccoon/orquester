//go:build !windows

package agent

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

// process is a started child, with pipes or a PTY.
type process interface {
	pid() int
	stdin() io.WriteCloser
	stdout() io.Reader
	stderr() io.Reader
	// wait blocks until the process exits: (code, nil) or (nil, signal name).
	wait() (*int, *string)
	signal(name string) error
	resize(cols, rows int) error
	kill()
	// closeOutput aborts output reads (pipes held open by a background child).
	closeOutput()
	// release frees the PTY / stdin after the output was drained.
	release()
}

type unixProcess struct {
	cmd  *exec.Cmd
	ptmx *os.File

	in      io.WriteCloser
	out     io.ReadCloser
	errOut  io.ReadCloser
	waitMu  sync.Mutex
	waited  bool
	code    *int
	sigName *string
}

func startProcess(s *startSpec) (process, error) {
	cmd := &exec.Cmd{Path: s.path, Args: s.args, Dir: s.dir, Env: s.env}
	attrs := &syscall.SysProcAttr{}
	if s.work != nil {
		attrs.Credential = &syscall.Credential{Uid: s.work.uid, Gid: s.work.gid, Groups: s.work.groups}
	}
	p := &unixProcess{cmd: cmd}
	if s.pty != nil {
		attrs.Setsid = true
		attrs.Setctty = true
		cols, rows := clampSize(s.pty.Cols, s.pty.Rows)
		ptmx, err := pty.StartWithAttrs(cmd, &pty.Winsize{Cols: cols, Rows: rows}, attrs)
		if err != nil {
			return nil, spawnError(err)
		}
		p.ptmx = ptmx
		p.in = ptmx
		p.out = ptmx
		return p, nil
	}
	attrs.Setpgid = true
	cmd.SysProcAttr = attrs
	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		stdinR.Close()
		stdinW.Close()
		return nil, err
	}
	stderrR, stderrW, err := os.Pipe()
	if err != nil {
		stdinR.Close()
		stdinW.Close()
		stdoutR.Close()
		stdoutW.Close()
		return nil, err
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdinR, stdoutW, stderrW
	err = cmd.Start()
	// The child holds its ends now; ours read EOF once every writer is gone.
	stdinR.Close()
	stdoutW.Close()
	stderrW.Close()
	if err != nil {
		stdinW.Close()
		stdoutR.Close()
		stderrR.Close()
		return nil, spawnError(err)
	}
	p.in, p.out, p.errOut = stdinW, stdoutR, stderrR
	return p, nil
}

func spawnError(err error) error {
	if errors.Is(err, os.ErrNotExist) {
		return rpcErr("ENOENT", err.Error())
	}
	if errors.Is(err, os.ErrPermission) {
		return rpcErr("EACCES", err.Error())
	}
	return rpcErr("SPAWN_FAILED", err.Error())
}

func clampSize(cols, rows int) (uint16, uint16) {
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	return uint16(min(cols, 65535)), uint16(min(rows, 65535))
}

func (p *unixProcess) pid() int { return p.cmd.Process.Pid }

func (p *unixProcess) stdin() io.WriteCloser { return p.in }

func (p *unixProcess) stdout() io.Reader { return p.out }

func (p *unixProcess) stderr() io.Reader {
	if p.errOut == nil {
		return nil
	}
	return p.errOut
}

func (p *unixProcess) wait() (*int, *string) {
	p.waitMu.Lock()
	defer p.waitMu.Unlock()
	if p.waited {
		return p.code, p.sigName
	}
	_ = p.cmd.Wait()
	p.waited = true
	state := p.cmd.ProcessState
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		name := unix.SignalName(status.Signal())
		if name == "" {
			name = status.Signal().String()
		}
		p.sigName = &name
	} else {
		code := state.ExitCode()
		p.code = &code
	}
	return p.code, p.sigName
}

// targets: the process group, plus a PTY's foreground group (a job a shell started).
func (p *unixProcess) targets() []int {
	pid := p.cmd.Process.Pid
	groups := []int{pid}
	if p.ptmx != nil {
		if fg, err := unix.IoctlGetInt(int(p.ptmx.Fd()), unix.TIOCGPGRP); err == nil && fg > 0 && fg != pid {
			groups = append([]int{fg}, groups...)
		}
	}
	return groups
}

func (p *unixProcess) signal(name string) error {
	sig := unix.SignalNum(name)
	if sig == 0 {
		return rpcErr("BAD_REQUEST", "unknown signal "+name)
	}
	if p.ptmx != nil && sig == unix.SIGINT {
		// Like ^C at a terminal: only the foreground job.
		groups := p.targets()
		return ignoreESRCH(unix.Kill(-groups[0], sig))
	}
	var firstErr error
	for _, group := range p.targets() {
		if err := unix.Kill(-group, sig); err != nil && !errors.Is(err, unix.ESRCH) {
			firstErr = err
		}
	}
	return firstErr
}

func ignoreESRCH(err error) error {
	if errors.Is(err, unix.ESRCH) {
		return nil
	}
	return err
}

func (p *unixProcess) resize(cols, rows int) error {
	if p.ptmx == nil {
		return nil
	}
	c, r := clampSize(cols, rows)
	return pty.Setsize(p.ptmx, &pty.Winsize{Cols: c, Rows: r})
}

func (p *unixProcess) kill() {
	for _, group := range p.targets() {
		_ = unix.Kill(-group, unix.SIGKILL)
	}
	_ = p.cmd.Process.Kill()
}

func (p *unixProcess) closeOutput() {
	if p.ptmx != nil {
		_ = p.ptmx.Close()
		return
	}
	_ = p.out.Close()
	_ = p.errOut.Close()
}

func (p *unixProcess) release() {
	if p.ptmx != nil {
		_ = p.ptmx.Close()
		return
	}
	_ = p.in.Close()
	_ = p.out.Close()
	_ = p.errOut.Close()
}
