package agent

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"

	"orquester/box-agent/internal/wire"
)

// The GitHub CLI in the box, brokered by the host (wire.AgentConfig.Gh).
//
// gh reads its config from GH_CONFIG_DIR. The one written here holds no
// token: `http_unix_socket` makes gh send its API requests, as plain HTTP, to
// the socket below, and every connection to it becomes one `gh-api` channel
// to the daemon, which adds the account's token and forwards the request to
// GitHub. hosts.yml only names the login; gh refuses to run without a token
// there, so it gets a placeholder that GitHub would reject.

// ghPlaceholderToken stands where gh wants a token. The daemon replaces the
// Authorization header of every request it forwards.
const ghPlaceholderToken = "held-by-the-orquester-host"

// A host name or a login: nothing that needs more than quoting in YAML.
var ghName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// startGhAPI listens on the socket gh's config points at.
func (a *Agent) startGhAPI() (io.Closer, error) {
	path := localEndpoint(a.cfg.DataDir, "gh-api")
	ln, err := a.listenChannel(path, wire.GhAPISpec{Kind: "gh-api"})
	if err != nil {
		return nil, err
	}
	a.ghSocket = path
	return ln, nil
}

// applyGh makes the box's gh config match what the daemon welcomed: written
// for a login the host brokers, removed otherwise (a box whose workspace lost
// its account must not keep pointing gh at the host).
func (a *Agent) applyGh(cfg *wire.GhConfig) {
	dir := filepath.Join(a.cfg.DataDir, "gh")
	a.ghMu.Lock()
	defer a.ghMu.Unlock()
	a.ghConfigDir = ""
	if cfg == nil || a.ghSocket == "" || !ghName.MatchString(cfg.Host) || !ghName.MatchString(cfg.User) {
		_ = os.RemoveAll(dir)
		return
	}
	if err := a.writeGhConfig(dir, cfg); err != nil {
		a.log.Printf("gh config not written: %v", err)
		_ = os.RemoveAll(dir)
		return
	}
	a.ghConfigDir = dir
}

// ghDir is the GH_CONFIG_DIR of processes started now ("" = gh is left alone).
func (a *Agent) ghDir() string {
	a.ghMu.Lock()
	defer a.ghMu.Unlock()
	return a.ghConfigDir
}

func (a *Agent) writeGhConfig(dir string, cfg *wire.GhConfig) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	// `version: "1"` and the `users` map are gh's current layout: gh rewrites an older one.
	config := fmt.Sprintf("# Written by orq-agent. gh's API requests go to the Orquester host, which holds the login.\nversion: \"1\"\ngit_protocol: ssh\nhttp_unix_socket: %s\n", yamlString(a.ghSocket))
	hosts := fmt.Sprintf("%s:\n    users:\n        %s:\n            oauth_token: %s\n    oauth_token: %s\n    user: %s\n    git_protocol: ssh\n",
		yamlString(cfg.Host), yamlString(cfg.User), ghPlaceholderToken, ghPlaceholderToken, yamlString(cfg.User))
	files := []struct{ name, text string }{{"config.yml", config}, {"hosts.yml", hosts}}
	for _, file := range files {
		if err := writeFileAtomic(filepath.Join(dir, file.name), []byte(file.text), 0o600); err != nil {
			return err
		}
	}
	if a.work == nil {
		return nil
	}
	// gh runs as the working user.
	for _, path := range []string{dir, filepath.Join(dir, "config.yml"), filepath.Join(dir, "hosts.yml")} {
		if err := a.work.chown(path); err != nil {
			return err
		}
	}
	return nil
}

// yamlString quotes a value as a YAML double-quoted scalar (JSON's string form is one).
func yamlString(value string) string {
	out, _ := json.Marshal(value)
	return string(out)
}
