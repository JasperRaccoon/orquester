package agent

import "orquester/box-agent/internal/wire"

// desktopStart is the launch of an exec with `session: "desktop"` (desktop_pipe.go): it runs
// through the desktop-session helper, in the interactive user's session, with that user's own
// environment and PATH. orq-agent's identity (ORQ_BOX_ID, ORQ_AGENT_PATH, ORQ_AGENT_CONTROL)
// is added, then the request's env. Without a helper the open fails with NO_DESKTOP_SESSION.
func (a *Agent) desktopStart(spec *wire.ExecSpec, shell bool) (*startSpec, error) {
	if spec.Session != "desktop" {
		return nil, rpcErr("BAD_REQUEST", "unknown session "+spec.Session+` (only "desktop" exists)`)
	}
	hub := a.desktop
	if hub == nil {
		return nil, rpcErr("NO_DESKTOP_SESSION", noDesktopHelperMessage)
	}
	env := map[string]string{"ORQ_AGENT_PATH": a.sysInfo().AgentPath}
	a.authMu.Lock()
	env["ORQ_BOX_ID"] = a.boxID
	a.authMu.Unlock()
	if a.controlPath != "" {
		env["ORQ_AGENT_CONTROL"] = a.controlPath
	}
	for key, value := range spec.Env {
		env[key] = value
	}
	msg := deskStartMsg{Command: spec.Command, Args: spec.Args, Shell: shell, Cwd: spec.Cwd, Env: env, EnvUnset: spec.EnvUnset, Pty: spec.Pty}
	return &startSpec{
		pty: spec.Pty,
		remote: func() (process, error) {
			session := hub.await(nil)
			if session == nil {
				return nil, rpcErr("NO_DESKTOP_SESSION", noDesktopSessionMessage)
			}
			return session.start(msg)
		},
	}, nil
}

// noDesktopSessionMessage: a helper is installed but none connected in time.
const noDesktopSessionMessage = "nobody is signed in to this machine's desktop, so the desktop-session helper is not running: " +
	"sign in at the machine (or turn on automatic sign-in for the user Orquester paired it as) and try again"
