package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// serviceEnvKeys are persisted into `<dataDir>/agent.env` by install-service
// (the service manager starts orq-agent without the bootstrap's env).
var serviceEnvKeys = []string{"ORQ_DAEMON_URL", "ORQ_BOX_ID", "ORQ_WORK_USER", "ORQ_GITHUB_OIDC", "ORQ_PROXY"}

// writeServiceEnv stores the non-secret config, and the bootstrap token (if
// any) in its own 0600 file that orq-agent deletes after the first connect.
func writeServiceEnv(cfg Config) error {
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return err
	}
	env, token, err := serviceEnv(cfg)
	if err != nil {
		return err
	}
	if token != "" {
		tokenFile := filepath.Join(cfg.DataDir, "bootstrap-token")
		if err := writeFileAtomic(tokenFile, []byte(token+"\n"), 0o600); err != nil {
			return err
		}
		if cfg.BootstrapTokenFile != "" && cfg.BootstrapTokenFile != tokenFile {
			_ = os.Remove(cfg.BootstrapTokenFile)
		}
	}
	return writeFileAtomic(filepath.Join(cfg.DataDir, "agent.env"), []byte(env), 0o600)
}

// serviceEnv renders agent.env and returns the bootstrap token to store beside
// it in `<dataDir>/bootstrap-token` ("" when there is none). It writes nothing,
// so install-service --dry-run can show agent.env.
func serviceEnv(cfg Config) (string, string, error) {
	values := map[string]string{"ORQ_DATA_DIR": cfg.DataDir}
	for _, key := range serviceEnvKeys {
		if value := os.Getenv(key); value != "" {
			values[key] = value
		}
	}
	values["ORQ_DAEMON_URL"] = cfg.DaemonURL
	if cfg.BoxID != "" {
		values["ORQ_BOX_ID"] = cfg.BoxID
	}
	token := cfg.BootstrapToken
	if token == "" && cfg.BootstrapTokenFile != "" {
		if data, err := os.ReadFile(cfg.BootstrapTokenFile); err == nil {
			token = strings.TrimSpace(string(data))
		}
	}
	if token != "" {
		values["ORQ_BOOTSTRAP_TOKEN_FILE"] = filepath.Join(cfg.DataDir, "bootstrap-token")
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString("# Written by `orq-agent install-service`.\n")
	for _, key := range keys {
		if strings.ContainsAny(values[key], "\r\n") {
			return "", "", fmt.Errorf("%s contains a newline", key)
		}
		fmt.Fprintf(&b, "%s=%s\n", key, values[key])
	}
	return b.String(), token, nil
}
