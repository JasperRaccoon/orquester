package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// downloadUpdate fetches a build from the daemon with the box's own
// authentication, verifies its sha256 (`expected`, or the daemon's
// X-Orq-Agent-Sha256 header when none was given), and stages it next to the
// running executable. Returns the staged path.
func (a *Agent) downloadUpdate(ctx context.Context, rawURL, expected string) (string, error) {
	target := rawURL
	if strings.HasPrefix(target, "/") {
		target = httpBase(a.cfg.DaemonURL) + target
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return "", rpcErr("BAD_REQUEST", "bad update url")
	}
	if err := a.authorizeDownload(ctx, req); err != nil {
		return "", err
	}
	res, err := a.client.Do(req)
	if err != nil {
		return "", rpcErr("DOWNLOAD_FAILED", err.Error())
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", rpcErr("DOWNLOAD_FAILED", fmt.Sprintf("the daemon answered %d", res.StatusCode))
	}
	if expected == "" {
		expected = res.Header.Get("X-Orq-Agent-Sha256")
	}
	expected = strings.ToLower(strings.TrimSpace(expected))
	if len(expected) != 64 {
		return "", rpcErr("DOWNLOAD_FAILED", "no sha256 to verify the build against")
	}
	exe, err := executablePath()
	if err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(filepath.Dir(exe), "."+filepath.Base(exe)+".update-*")
	if err != nil {
		return "", rpcErr("UPDATE_FAILED", "cannot stage the update next to the executable: "+err.Error())
	}
	staged := tmp.Name()
	hash := sha256.New()
	_, copyErr := io.Copy(io.MultiWriter(tmp, hash), res.Body)
	closeErr := tmp.Close()
	if copyErr != nil || closeErr != nil {
		os.Remove(staged)
		return "", rpcErr("DOWNLOAD_FAILED", "download interrupted")
	}
	if got := hex.EncodeToString(hash.Sum(nil)); got != expected {
		os.Remove(staged)
		return "", rpcErr("CHECKSUM_MISMATCH", "the downloaded build does not match its sha256")
	}
	if err := os.Chmod(staged, 0o755); err != nil && !isWindows {
		os.Remove(staged)
		return "", err
	}
	return staged, nil
}

// authorizeDownload: the box credential, or a fresh GitHub OIDC token.
func (a *Agent) authorizeDownload(ctx context.Context, req *http.Request) error {
	a.authMu.Lock()
	credential, boxID := a.credential, a.boxID
	a.authMu.Unlock()
	if a.cfg.GithubOIDC {
		jwt, err := fetchGithubOIDC(ctx, daemonOrigin(a.cfg.DaemonURL))
		if err != nil {
			return rpcErr("DOWNLOAD_FAILED", err.Error())
		}
		req.Header.Set("Authorization", "GitHubOIDC "+jwt)
		req.Header.Set("X-Orq-Box-Id", boxID)
		return nil
	}
	if credential == "" {
		return rpcErr("DOWNLOAD_FAILED", "no box credential to download with")
	}
	req.Header.Set("Authorization", "Bearer "+credential)
	return nil
}

func executablePath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return exe, nil
}

// installAndRestart moves the staged build over the executable and stops the
// agent with a restart request (main re-executes it).
func (a *Agent) installAndRestart(staged string) {
	exe, err := executablePath()
	if err == nil {
		err = replaceExecutable(staged, exe)
	}
	if err != nil {
		os.Remove(staged)
		a.log.Printf("installing the update failed: %v", err)
		return
	}
	a.log.Printf("update installed; restarting")
	a.stopWith(0, true)
}

// selfUpdate downloads, installs and restarts in one go.
func (a *Agent) selfUpdate(ctx context.Context, url, sha string) error {
	if a.procs.runningCount() > 0 {
		return errors.New("detached processes are running; not updating now")
	}
	staged, err := a.downloadUpdate(ctx, url, sha)
	if err != nil {
		return err
	}
	a.installAndRestart(staged)
	return nil
}

// applyPendingUpdate runs an update deferred by BUSY once nothing would be orphaned.
func (a *Agent) applyPendingUpdate() {
	a.updateMu.Lock()
	pending := a.pendingUpdate
	if pending == nil || a.procs.runningCount() > 0 {
		a.updateMu.Unlock()
		return
	}
	a.pendingUpdate = nil
	a.updateMu.Unlock()
	go func() {
		if err := a.selfUpdate(context.Background(), pending.URL, pending.SHA256); err != nil {
			a.log.Printf("deferred update failed: %v", err)
		}
	}()
}

// RestartEnv is the environment for the re-executed agent: the current one
// plus the secrets this process scrubbed but may still need (an unused
// bootstrap token, the Actions OIDC request env).
func (a *Agent) RestartEnv() []string {
	env := newEnvMap(os.Environ())
	a.authMu.Lock()
	if a.bootstrapToken != "" {
		env.set("ORQ_BOOTSTRAP_TOKEN", a.bootstrapToken)
	}
	a.authMu.Unlock()
	if oidcEnv.url != "" {
		env.set("ACTIONS_ID_TOKEN_REQUEST_URL", oidcEnv.url)
		env.set("ACTIONS_ID_TOKEN_REQUEST_TOKEN", oidcEnv.token)
	}
	return env.list()
}

// cleanupOldExecutable removes what a Windows update renamed aside.
func cleanupOldExecutable() {
	if exe, err := executablePath(); err == nil {
		_ = os.Remove(exe + ".old")
	}
}
