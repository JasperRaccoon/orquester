//go:build windows

package agent

import (
	"fmt"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const windowsServiceName = "OrqAgent"

// InstallService registers orq-agent as an automatic Windows service
// (LocalSystem) that restarts on failure, and starts it.
func InstallService(cfg Config) error {
	if err := writeServiceEnv(cfg); err != nil {
		return err
	}
	exe, err := executablePath()
	if err != nil {
		return err
	}
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connecting to the service manager: %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(windowsServiceName)
	if err == nil {
		// Reinstall: stop and replace the old registration.
		_, _ = s.Control(svc.Stop)
		deadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			status, err := s.Query()
			if err != nil || status.State == svc.Stopped {
				break
			}
			time.Sleep(500 * time.Millisecond)
		}
		if err := s.Delete(); err != nil {
			s.Close()
			return fmt.Errorf("removing the old service: %w", err)
		}
		s.Close()
	}
	s, err = m.CreateService(windowsServiceName, exe, mgr.Config{
		DisplayName:  "Orquester box agent",
		Description:  "Connects this machine to the Orquester daemon (orq-agent).",
		StartType:    mgr.StartAutomatic,
		ErrorControl: mgr.ErrorNormal,
	}, "service", "--data-dir", cfg.DataDir)
	if err != nil {
		return fmt.Errorf("creating the service: %w", err)
	}
	defer s.Close()
	// Any non-zero exit (crash, or an update asking for a restart) restarts it.
	if err := s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 2 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 10 * time.Second},
	}, 86400); err != nil {
		return fmt.Errorf("setting recovery actions: %w", err)
	}
	if err := s.SetRecoveryActionsOnNonCrashFailures(true); err != nil {
		return fmt.Errorf("setting recovery actions: %w", err)
	}
	return s.Start()
}

type serviceHandler struct {
	run  func() int
	code int
}

func (h *serviceHandler) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	done := make(chan int, 1)
	go func() { done <- h.run() }()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case code := <-done:
			h.code = code
			status <- svc.Status{State: svc.StopPending}
			// A non-zero service exit code makes the recovery actions restart us.
			return code != 0, uint32(code)
		case req := <-requests:
			switch req.Cmd {
			case svc.Interrogate:
				status <- req.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				serviceStop()
			}
		}
	}
}

// serviceStop is set by main to stop the running agent.
var serviceStop = func() {}

// SetServiceStop installs the function a service stop request calls.
func SetServiceStop(stop func()) { serviceStop = stop }

// RunService runs `run` under the service control manager. ok is false when
// the process was not started by the SCM.
func RunService(run func() int) (bool, error) {
	isService, err := svc.IsWindowsService()
	if err != nil || !isService {
		return false, err
	}
	return true, svc.Run(windowsServiceName, &serviceHandler{run: run})
}

// ProtectService is only meaningful on Linux.
func ProtectService() error { return nil }
