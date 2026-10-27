// Package agent is orq-agent: the program Orquester runs in every box. It
// dials the daemon (`/api/boxes/connect`), authenticates, and serves the
// requests and channels of packages/api/src/box-protocol.ts. Processes it
// starts with `detach` outlive the link; everything else ends with it.
//
// Logging rule (box-protocol.ts "Secrets"): log method names, channel kinds
// and sizes only — never params, env, results or tokens.
package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"orquester/box-agent/internal/wire"
)

// Config is orq-agent's configuration: env vars, then `<dataDir>/agent.env`.
type Config struct {
	DaemonURL          string
	BoxID              string
	DataDir            string
	BootstrapToken     string
	BootstrapTokenFile string
	GithubOIDC         bool
	// WorkUser: when orq-agent runs as root, the account processes run as
	// and paths are given to (ORQ_WORK_USER). Empty = orq-agent's own user.
	WorkUser string
	// Proxy (ORQ_PROXY): an HTTP proxy for every daemon connection (the
	// connect WebSocket, build downloads) — tailscaled's userspace proxy in
	// containers.
	Proxy   string
	Version string
	// Service: running under the OS service manager (restart by exiting).
	Service bool
}

// secretEnv are never inherited by processes orq-agent starts.
var secretEnv = []string{
	"ORQ_BOOTSTRAP_TOKEN",
	"ORQ_BOOTSTRAP_TOKEN_FILE",
	"ACTIONS_ID_TOKEN_REQUEST_TOKEN",
	"ACTIONS_ID_TOKEN_REQUEST_URL",
	// Container boxes get the Tailscale auth key in env (the bootstrap unsets
	// it in its own shell, but orq-agent's env is what children inherit).
	"ORQ_TAILSCALE_AUTHKEY",
}

// LoadConfig reads the configuration. `dataDir` overrides ORQ_DATA_DIR.
func LoadConfig(version, dataDir string) (Config, error) {
	if dataDir == "" {
		dataDir = os.Getenv("ORQ_DATA_DIR")
	}
	if dataDir == "" {
		dataDir = DefaultDataDir()
	}
	fileEnv := readEnvFile(filepath.Join(dataDir, "agent.env"))
	get := func(key string) string {
		if value, ok := os.LookupEnv(key); ok {
			return value
		}
		return fileEnv[key]
	}
	cfg := Config{
		DaemonURL:          strings.TrimRight(get("ORQ_DAEMON_URL"), "/"),
		BoxID:              get("ORQ_BOX_ID"),
		DataDir:            dataDir,
		BootstrapToken:     strings.TrimSpace(get("ORQ_BOOTSTRAP_TOKEN")),
		BootstrapTokenFile: get("ORQ_BOOTSTRAP_TOKEN_FILE"),
		GithubOIDC:         get("ORQ_GITHUB_OIDC") == "1",
		WorkUser:           get("ORQ_WORK_USER"),
		Proxy:              get("ORQ_PROXY"),
		Version:            version,
	}
	if cfg.DaemonURL == "" {
		return cfg, errors.New("ORQ_DAEMON_URL is not set")
	}
	if _, err := connectURL(cfg.DaemonURL); err != nil {
		return cfg, err
	}
	if cfg.Proxy != "" {
		if u, err := url.Parse(cfg.Proxy); err != nil || u.Host == "" {
			return cfg, fmt.Errorf("bad ORQ_PROXY %q", cfg.Proxy)
		}
	}
	return cfg, nil
}

// daemonClient is the HTTP client for daemon traffic: through ORQ_PROXY when
// set, else Go's default (which honours HTTPS_PROXY/NO_PROXY). It never
// follows a redirect: requests carry the box's credential or bootstrap token,
// and the daemon never redirects them, so a 3xx is answered as is (and fails)
// instead of replaying the request — and its Authorization — elsewhere.
func daemonClient(cfg Config) *http.Client {
	client := &http.Client{CheckRedirect: refuseRedirect}
	if cfg.Proxy == "" {
		return client
	}
	proxy, _ := url.Parse(cfg.Proxy)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = http.ProxyURL(proxy)
	client.Transport = transport
	return client
}

func refuseRedirect(*http.Request, []*http.Request) error {
	return http.ErrUseLastResponse
}

// DefaultDataDir: `/var/lib/orq-agent` as root, `~/.orq-agent` otherwise, `C:\orq\agent` on Windows.
func DefaultDataDir() string {
	if isWindows {
		return `C:\orq\agent`
	}
	if os.Geteuid() == 0 {
		return "/var/lib/orq-agent"
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "/tmp/orq-agent"
	}
	return filepath.Join(home, ".orq-agent")
}

func readEnvFile(path string) map[string]string {
	out := map[string]string{}
	data, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if ok {
			out[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	return out
}

// connectURL turns the daemon origin (http/https, optionally with a path
// prefix) into the connect WebSocket URL.
func connectURL(daemonURL string) (string, error) {
	u, err := url.Parse(daemonURL)
	if err != nil {
		return "", fmt.Errorf("bad ORQ_DAEMON_URL: %w", err)
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", fmt.Errorf("ORQ_DAEMON_URL must be http(s) or ws(s), got %q", u.Scheme)
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/api/boxes/connect"
	u.RawQuery = ""
	return u.String(), nil
}

// httpBase is the daemon's HTTP base URL (with any path prefix).
func httpBase(daemonURL string) string {
	u, err := url.Parse(daemonURL)
	if err != nil {
		return daemonURL
	}
	switch u.Scheme {
	case "ws":
		u.Scheme = "http"
	case "wss":
		u.Scheme = "https"
	}
	u.RawQuery = ""
	return strings.TrimRight(u.String(), "/")
}

// daemonOrigin is `scheme://host[:port]`: the OIDC audience.
func daemonOrigin(daemonURL string) string {
	u, err := url.Parse(httpBase(daemonURL))
	if err != nil {
		return daemonURL
	}
	return u.Scheme + "://" + u.Host
}

// Agent is one running orq-agent.
type Agent struct {
	cfg Config
	log *log.Logger

	sysMu sync.Mutex
	sys   wire.SysInfo

	procs *procRegistry
	work  *workUser

	linkMu sync.Mutex
	link   *Link
	linkUp chan struct{} // closed while a link is up; replaced when it drops

	authMu             sync.Mutex
	boxID              string
	credential         string
	bootstrapToken     string
	credentialRejected bool

	stopOnce sync.Once
	stop     chan struct{}
	exitCode int
	restart  bool

	updateMu      sync.Mutex
	pendingUpdate *wire.UpdateParams

	sshSocket   string
	controlPath string
	statsPrev   cpuSample
	client      *http.Client
}

// New prepares an agent (data dir, credentials, sys info).
func New(cfg Config, logger *log.Logger) (*Agent, error) {
	a := &Agent{
		cfg:    cfg,
		log:    logger,
		procs:  newProcRegistry(),
		linkUp: make(chan struct{}),
		stop:   make(chan struct{}),
		client: daemonClient(cfg),
	}
	work, err := resolveWorkUser(cfg.WorkUser)
	if err != nil {
		return nil, err
	}
	a.work = work
	if err := a.prepareDataDir(); err != nil {
		return nil, err
	}
	for _, key := range secretEnv {
		_ = os.Unsetenv(key)
	}
	a.boxID = cfg.BoxID
	if a.boxID == "" {
		if data, err := os.ReadFile(filepath.Join(cfg.DataDir, "box-id")); err == nil {
			a.boxID = strings.TrimSpace(string(data))
		}
	}
	if data, err := os.ReadFile(filepath.Join(cfg.DataDir, "credential")); err == nil {
		a.credential = strings.TrimSpace(string(data))
	}
	a.bootstrapToken = cfg.BootstrapToken
	if a.bootstrapToken == "" && cfg.BootstrapTokenFile != "" {
		if data, err := os.ReadFile(cfg.BootstrapTokenFile); err == nil {
			a.bootstrapToken = strings.TrimSpace(string(data))
		}
	}
	cleanupOldExecutable()
	a.procs.recoverFrom(filepath.Join(cfg.DataDir, procStateFile), logger)
	a.sys = detectSysInfo(a)
	return a, nil
}

func (a *Agent) prepareDataDir() error {
	mode := os.FileMode(0o700)
	if a.work != nil {
		// The working user reaches control.sock inside; the credential stays 0600 root.
		mode = 0o711
	}
	if err := os.MkdirAll(a.cfg.DataDir, mode); err != nil {
		return fmt.Errorf("creating data dir: %w", err)
	}
	return os.Chmod(a.cfg.DataDir, mode)
}

// Run serves until shutdown. It returns the exit code and whether the caller
// should restart the (updated) executable.
func (a *Agent) Run(ctx context.Context) (int, bool) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		select {
		case <-ctx.Done():
			a.stopWith(0, false)
		case <-a.stop:
		}
		// Unblock the serving link so the loop below sees the stop.
		if link := a.currentLink(); link != nil {
			_ = link.conn.Close(websocket.StatusNormalClosure, "shutting down")
			link.cancel()
		}
	}()
	control, err := a.startControl()
	if err != nil {
		a.log.Printf("control socket unavailable: %v", err)
	} else {
		defer control.Close()
	}
	ssh, err := a.startSSHAgent()
	if err != nil {
		a.log.Printf("ssh-agent socket unavailable: %v", err)
	} else {
		defer ssh.Close()
	}

	attempt := 0
	for {
		if a.stopped() {
			break
		}
		welcomed, err := a.connectOnce(ctx)
		if a.stopped() {
			break
		}
		if welcomed {
			attempt = 0
		} else {
			attempt++
			if err != nil {
				a.log.Printf("connect failed: %v", err)
			}
		}
		select {
		case <-time.After(backoff(attempt)):
		case <-a.stop:
		}
	}
	return a.exitCode, a.restart
}

func backoff(attempt int) time.Duration {
	if attempt <= 0 {
		return 200 * time.Millisecond
	}
	d := 500 * time.Millisecond << min(attempt, 6)
	if d > 30*time.Second {
		d = 30 * time.Second
	}
	return d/2 + time.Duration(rand.Int64N(int64(d/2)+1))
}

func (a *Agent) stopped() bool {
	select {
	case <-a.stop:
		return true
	default:
		return false
	}
}

func (a *Agent) stopWith(code int, restart bool) {
	a.stopOnce.Do(func() {
		a.exitCode = code
		a.restart = restart
		close(a.stop)
	})
}

// shutdown ends orq-agent for good: detached processes are killed. With `uninstall` (the owner
// removed this machine) its credentials and service go too, so nothing starts it again.
func (a *Agent) shutdown(reason string, uninstall bool) {
	a.log.Printf("shutting down: %s", reason)
	a.procs.killAll()
	if uninstall {
		a.uninstall()
	}
	a.stopWith(0, false)
}

// persistProcs records the running detached processes for the next orq-agent (procstate.go).
func (a *Agent) persistProcs() {
	if err := a.procs.persist(); err != nil {
		a.log.Printf("recording the detached processes: %v", err)
	}
}

func (a *Agent) currentLink() *Link {
	a.linkMu.Lock()
	defer a.linkMu.Unlock()
	return a.link
}

// waitLink returns the live link, waiting for a reconnect until ctx ends.
func (a *Agent) waitLink(ctx context.Context) (*Link, error) {
	for {
		a.linkMu.Lock()
		link, up := a.link, a.linkUp
		a.linkMu.Unlock()
		if link != nil && link.ctx.Err() == nil {
			return link, nil
		}
		select {
		case <-up:
		case <-ctx.Done():
			return nil, &wire.RPCError{Code: "BOX_DISCONNECTED", Message: "orq-agent is not connected to the daemon"}
		case <-a.stop:
			return nil, &wire.RPCError{Code: "SHUTDOWN", Message: "orq-agent is shutting down"}
		}
	}
}

func (a *Agent) chooseAuth(ctx context.Context) (wire.Auth, error) {
	a.authMu.Lock()
	defer a.authMu.Unlock()
	if a.cfg.GithubOIDC {
		if a.boxID == "" {
			return wire.Auth{}, errors.New("ORQ_GITHUB_OIDC=1 needs ORQ_BOX_ID")
		}
		jwt, err := fetchGithubOIDC(ctx, daemonOrigin(a.cfg.DaemonURL))
		if err != nil {
			return wire.Auth{}, err
		}
		return wire.Auth{Kind: "github-oidc", BoxID: a.boxID, JWT: jwt}, nil
	}
	hasCredential := a.credential != "" && a.boxID != ""
	if hasCredential && (!a.credentialRejected || a.bootstrapToken == "") {
		return wire.Auth{Kind: "credential", BoxID: a.boxID, Credential: a.credential}, nil
	}
	if a.bootstrapToken != "" {
		return wire.Auth{Kind: "bootstrap", Token: a.bootstrapToken}, nil
	}
	return wire.Auth{}, errors.New("no box credential and no bootstrap token (ORQ_BOOTSTRAP_TOKEN[_FILE])")
}

// fetchGithubOIDC asks the Actions runtime for an OIDC token with `audience`.
func fetchGithubOIDC(ctx context.Context, audience string) (string, error) {
	requestURL := os.Getenv("ACTIONS_ID_TOKEN_REQUEST_URL")
	requestToken := os.Getenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
	if requestURL == "" || requestToken == "" {
		requestURL, requestToken = oidcEnv.url, oidcEnv.token
	}
	if requestURL == "" || requestToken == "" {
		return "", errors.New("ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN missing (does the job have `id-token: write`?)")
	}
	u, err := url.Parse(requestURL)
	if err != nil {
		return "", fmt.Errorf("bad ACTIONS_ID_TOKEN_REQUEST_URL: %w", err)
	}
	q := u.Query()
	q.Set("audience", audience)
	u.RawQuery = q.Encode()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+requestToken)
	req.Header.Set("Accept", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("requesting the GitHub OIDC token: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GitHub OIDC token request answered %d", res.StatusCode)
	}
	var body struct {
		Value string `json:"value"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil || body.Value == "" {
		return "", errors.New("GitHub OIDC token response had no value")
	}
	return body.Value, nil
}

// oidcEnv keeps the Actions token-request env after it is scrubbed from the
// process env (so children never inherit it).
var oidcEnv = struct{ url, token string }{
	url:   os.Getenv("ACTIONS_ID_TOKEN_REQUEST_URL"),
	token: os.Getenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN"),
}

// connectOnce dials, authenticates and serves one link. `welcomed` reports
// whether the handshake succeeded (resets the backoff).
func (a *Agent) connectOnce(ctx context.Context) (bool, error) {
	target, err := connectURL(a.cfg.DaemonURL)
	if err != nil {
		return false, err
	}
	auth, err := a.chooseAuth(ctx)
	if err != nil {
		return false, err
	}
	dialCtx, cancelDial := context.WithTimeout(ctx, 30*time.Second)
	conn, _, err := websocket.Dial(dialCtx, target, &websocket.DialOptions{
		HTTPClient: a.client,
		HTTPHeader: http.Header{"User-Agent": {"orq-agent/" + a.cfg.Version}},
	})
	cancelDial()
	if err != nil {
		return false, fmt.Errorf("dialing the daemon: %w", err)
	}
	conn.SetReadLimit(64 * 1024 * 1024)

	hello := wire.Hello{
		T:            "hello",
		Protocol:     wire.ProtocolVersion,
		AgentVersion: a.cfg.Version,
		Auth:         auth,
		Sys:          a.sysInfo(),
		Procs:        a.procs.list(),
	}
	data, err := json.Marshal(hello)
	if err != nil {
		_ = conn.CloseNow()
		return false, err
	}
	helloCtx, cancelHello := context.WithTimeout(ctx, 90*time.Second)
	defer cancelHello()
	if err := conn.Write(helloCtx, websocket.MessageText, data); err != nil {
		_ = conn.CloseNow()
		return false, fmt.Errorf("sending hello: %w", err)
	}
	kind, data, err := conn.Read(helloCtx)
	if err != nil {
		_ = conn.CloseNow()
		return false, fmt.Errorf("waiting for welcome: %w", err)
	}
	if kind != websocket.MessageText {
		_ = conn.Close(websocket.StatusProtocolError, "expected welcome")
		return false, errors.New("daemon sent a binary frame before welcome")
	}
	msg, err := wire.DecodeControl(data, false)
	if err != nil {
		_ = conn.Close(websocket.StatusProtocolError, "malformed frame")
		return false, err
	}
	switch m := msg.(type) {
	case *wire.Reject:
		_ = conn.CloseNow()
		if m.Code == "AUTH_FAILED" {
			a.authMu.Lock()
			if auth.Kind == "credential" {
				a.credentialRejected = true
			} else if auth.Kind == "bootstrap" {
				a.credentialRejected = false
			}
			a.authMu.Unlock()
		}
		a.handleReject(m)
		return false, fmt.Errorf("rejected: %s", m.Code)
	case *wire.Welcome:
		if err := a.acceptWelcome(auth, m); err != nil {
			_ = conn.Close(websocket.StatusInternalError, "could not store credential")
			return false, err
		}
		link := newLink(a, conn, m.BoxID, m.Config)
		a.setLink(link)
		a.log.Printf("connected to the daemon as box %s", m.BoxID)
		for _, f := range m.Config.Forwards {
			if err := link.listenForward(f); err != nil {
				a.log.Printf("forward on box port %d failed: %v", f.BoxPort, err)
			}
		}
		link.serve()
		a.clearLink(link)
		a.log.Printf("link to the daemon dropped")
		return true, nil
	default:
		_ = conn.Close(websocket.StatusProtocolError, "expected welcome")
		return false, errors.New("daemon sent something other than welcome")
	}
}

func (a *Agent) acceptWelcome(auth wire.Auth, m *wire.Welcome) error {
	a.authMu.Lock()
	defer a.authMu.Unlock()
	if m.BoxID != "" && m.BoxID != a.boxID {
		a.boxID = m.BoxID
		if err := writeFileAtomic(filepath.Join(a.cfg.DataDir, "box-id"), []byte(m.BoxID+"\n"), 0o600); err != nil {
			return err
		}
	}
	if m.Credential != "" {
		if err := writeFileAtomic(filepath.Join(a.cfg.DataDir, "credential"), []byte(m.Credential+"\n"), 0o600); err != nil {
			return err
		}
		a.credential = m.Credential
		a.credentialRejected = false
	}
	if auth.Kind == "bootstrap" {
		// Single-use: forget it, and remove the file it came from.
		a.bootstrapToken = ""
		if a.cfg.BootstrapTokenFile != "" {
			_ = os.Remove(a.cfg.BootstrapTokenFile)
		}
	}
	return nil
}

func (a *Agent) setLink(link *Link) {
	a.linkMu.Lock()
	a.link = link
	close(a.linkUp)
	a.linkMu.Unlock()
}

func (a *Agent) clearLink(link *Link) {
	a.linkMu.Lock()
	if a.link == link {
		a.link = nil
		a.linkUp = make(chan struct{})
	}
	a.linkMu.Unlock()
}

func (a *Agent) handleReject(m *wire.Reject) {
	a.log.Printf("daemon rejected the connection: %s", m.Code)
	switch m.Code {
	case "BOX_DESTROYED":
		// The box is gone for good: its credential is dead and the service would only start
		// orq-agent again to be refused once more. Uninstall it, so nothing starts it again.
		a.shutdown("the daemon reports this box destroyed", true)
	case "AGENT_OUTDATED":
		if m.UpgradeURL != "" {
			go func() {
				if err := a.selfUpdate(context.Background(), m.UpgradeURL, ""); err != nil {
					a.log.Printf("self-update failed: %v", err)
				}
			}()
		}
	}
}

func (a *Agent) sysInfo() wire.SysInfo {
	a.sysMu.Lock()
	defer a.sysMu.Unlock()
	return a.sys
}

func (a *Agent) refreshSysInfo() wire.SysInfo {
	info := detectSysInfo(a)
	a.sysMu.Lock()
	a.sys = info
	a.sysMu.Unlock()
	return info
}

// writeFileAtomic writes via a temp file + rename in the same directory.
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(mode); err != nil && !isWindows {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
