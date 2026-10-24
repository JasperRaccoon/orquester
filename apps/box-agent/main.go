// orq-agent: the program Orquester runs in every box (spec
// docs/superpowers/specs/2026-10-19-ephemeral-ai-vms-design.md §5).
//
//	orq-agent run [--data-dir DIR]          serve in the foreground (containers, macOS job step)
//	orq-agent install-service [--data-dir]  systemd unit / Windows service, then start it
//	orq-agent token <claude|codex|grok> --account <id> [--min-valid SECONDS]
//	orq-agent git-credential <get|store|erase>
//	orq-agent mcp-bridge <serverId>
//	orq-agent rpc <method> [json]
//	orq-agent status
//	orq-agent version
//
// Config comes from env (ORQ_DAEMON_URL, ORQ_BOX_ID, ORQ_BOOTSTRAP_TOKEN[_FILE],
// ORQ_DATA_DIR, ORQ_GITHUB_OIDC, ORQ_WORK_USER), then `<dataDir>/agent.env`.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"orquester/box-agent/internal/agent"
	"orquester/box-agent/internal/wire"
)

// version is set at build time (-ldflags "-X main.version=…").
var version = "dev"

func main() {
	os.Exit(run(os.Args[1:]))
}

func usage() int {
	fmt.Fprintln(os.Stderr, "usage: orq-agent run|install-service|token|git-credential|mcp-bridge|rpc|status|version …")
	return 2
}

// flagValue extracts `--name value` / `--name=value` from args.
func flagValue(args []string, name string) (string, []string) {
	var rest []string
	value := ""
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--"+name && i+1 < len(args):
			value = args[i+1]
			i++
		case strings.HasPrefix(arg, "--"+name+"="):
			value = strings.TrimPrefix(arg, "--"+name+"=")
		default:
			rest = append(rest, arg)
		}
	}
	return value, rest
}

func run(args []string) int {
	if len(args) == 0 {
		return usage()
	}
	command, args := args[0], args[1:]
	switch command {
	case "run", "service":
		dataDir, _ := flagValue(args, "data-dir")
		return serve(dataDir, command == "service")
	case "install-service":
		dataDir, _ := flagValue(args, "data-dir")
		cfg, err := agent.LoadConfig(version, dataDir)
		if err != nil {
			return fail(err)
		}
		if err := agent.InstallService(cfg); err != nil {
			return fail(err)
		}
		return 0
	case "token":
		return tokenCommand(args)
	case "git-credential":
		return gitCredentialCommand(args)
	case "mcp-bridge":
		if len(args) != 1 || args[0] == "" {
			return usage()
		}
		if err := agent.ClientMCPBridge(args[0], os.Stdin, os.Stdout); err != nil {
			return fail(err)
		}
		return 0
	case "rpc":
		return rpcCommand(args)
	case "status":
		status, err := agent.ClientStatus()
		if err != nil {
			return fail(err)
		}
		out, _ := json.Marshal(status)
		fmt.Println(string(out))
		return 0
	case "version", "--version":
		fmt.Println(version)
		return 0
	}
	return usage()
}

func fail(err error) int {
	fmt.Fprintln(os.Stderr, "orq-agent:", err)
	return 1
}

func serve(dataDir string, asService bool) int {
	logger := log.New(os.Stderr, "orq-agent ", log.LstdFlags)
	cfg, err := agent.LoadConfig(version, dataDir)
	if err != nil {
		return fail(err)
	}
	cfg.Service = asService
	if err := agent.ProtectService(); err != nil {
		logger.Printf("could not keep package upgrades from restarting orq-agent: %v", err)
	}
	a, err := agent.New(cfg, logger)
	if err != nil {
		return fail(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runAgent := func() int {
		code, restart := a.Run(ctx)
		if !restart {
			return code
		}
		if asService {
			// The service's recovery action starts the new executable.
			return 3
		}
		if err := agent.Reexec(a.RestartEnv()); err != nil {
			logger.Printf("restart after update failed: %v", err)
			return 1
		}
		return 0
	}
	if asService {
		agent.SetServiceStop(cancel)
		ok, err := agent.RunService(runAgent)
		if err != nil {
			return fail(err)
		}
		if ok {
			return 0
		}
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-signals
		cancel()
	}()
	return runAgent()
}

func tokenCommand(args []string) int {
	account, args := flagValue(args, "account")
	minValid, args := flagValue(args, "min-valid")
	if len(args) != 1 || account == "" {
		fmt.Fprintln(os.Stderr, "usage: orq-agent token <claude|codex|grok> --account <accountId> [--min-valid SECONDS]")
		return 2
	}
	cli := args[0]
	if cli != "claude" && cli != "codex" && cli != "grok" {
		return fail(fmt.Errorf("unknown agent %q", cli))
	}
	params := wire.TokenGetParams{Agent: cli, AccountID: account}
	if minValid != "" {
		n, err := strconv.ParseInt(minValid, 10, 64)
		if err != nil || n < 0 {
			return fail(errors.New("--min-valid takes seconds"))
		}
		params.MinValidSeconds = &n
	} else if cli == "grok" && os.Getenv("GROK_AUTH_EXPIRED") == "1" {
		// Grok re-runs its auth command when the token was refused: ask for one
		// that is good for a while rather than the cached near-expiry one.
		n := int64(30 * 60)
		params.MinValidSeconds = &n
	}
	raw, _ := json.Marshal(params)
	result, err := agent.ClientRPC("token.get", raw, 2*time.Minute)
	if err != nil {
		return fail(err)
	}
	var grant wire.TokenGetResult
	if err := json.Unmarshal(result, &grant); err != nil || grant.AccessToken == "" {
		return fail(errors.New("the daemon returned no access token"))
	}
	var out []byte
	if cli == "grok" {
		// Grok's auth_provider_command contract.
		expiresIn := int64(300)
		if grant.ExpiresAt != nil {
			expiresIn = max((*grant.ExpiresAt-time.Now().UnixMilli())/1000, 0)
		}
		out, _ = json.Marshal(struct {
			AccessToken string `json:"access_token"`
			ExpiresIn   int64  `json:"expires_in"`
		}{grant.AccessToken, expiresIn})
	} else {
		out, _ = json.Marshal(grant)
	}
	os.Stdout.Write(append(out, '\n'))
	return 0
}

// gitCredentialCommand is a git credential helper: git writes key=value
// lines on stdin; for `get` the answer's key=value lines go to stdout.
func gitCredentialCommand(args []string) int {
	if len(args) != 1 || (args[0] != "get" && args[0] != "store" && args[0] != "erase") {
		fmt.Fprintln(os.Stderr, "usage: orq-agent git-credential <get|store|erase>")
		return 2
	}
	input, err := io.ReadAll(io.LimitReader(os.Stdin, 1<<20))
	if err != nil {
		return fail(err)
	}
	raw, _ := json.Marshal(wire.GitCredentialParams{Operation: args[0], Input: string(input)})
	result, err := agent.ClientRPC("git.credential", raw, 2*time.Minute)
	if err != nil {
		return fail(err)
	}
	var out wire.GitCredentialResult
	if err := json.Unmarshal(result, &out); err != nil {
		return fail(errors.New("malformed git.credential answer"))
	}
	os.Stdout.WriteString(out.Output)
	return 0
}

func rpcCommand(args []string) int {
	if len(args) < 1 || len(args) > 2 {
		fmt.Fprintln(os.Stderr, "usage: orq-agent rpc <method> [json]")
		return 2
	}
	params := json.RawMessage("{}")
	if len(args) == 2 {
		if !json.Valid([]byte(args[1])) {
			return fail(errors.New("params are not valid JSON"))
		}
		params = json.RawMessage(args[1])
	}
	result, err := agent.ClientRPC(args[0], params, 5*time.Minute)
	if err != nil {
		return fail(err)
	}
	if len(result) == 0 {
		result = json.RawMessage("null")
	}
	os.Stdout.Write(append(result, '\n'))
	return 0
}
