// Package embyusers is a Caddy HTTP handler that gives an Emby server its
// own user accounts. Friends sign in with accounts the plugin manages; every
// request reaches the real server through one upstream account, and each
// friend keeps separate watch history, resume points and favorites.
package embyusers

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"sync"

	"github.com/caddyserver/caddy/v2"
	"github.com/caddyserver/caddy/v2/caddyconfig/httpcaddyfile"
	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"github.com/caddyserver/caddy/v2/modules/caddyhttp/reverseproxy"
	"go.uber.org/zap"
)

func init() {
	caddy.RegisterModule(new(Handler))
	httpcaddyfile.RegisterHandlerDirective("emby_users", parseCaddyfile)
	httpcaddyfile.RegisterDirectiveOrder("emby_users", httpcaddyfile.Before, "respond")
}

// Handler terminates the Emby route and delegates upstream I/O to Caddy's
// reverse proxy. Its configuration is immutable after provisioning.
type Handler struct {
	Upstream      string `json:"upstream"`
	Username      string `json:"username"`
	Password      string `json:"password"`
	Database      string `json:"database,omitempty"`
	ClientName    string `json:"client_name,omitempty"`
	DeviceName    string `json:"device_name,omitempty"`
	DeviceID      string `json:"device_id,omitempty"`
	ClientVersion string `json:"client_version,omitempty"`
	UserAgent     string `json:"user_agent,omitempty"`
	// Transport is a standard Caddy reverse-proxy transport. Both internal
	// API calls and proxied media use this same provisioned instance.
	TransportRaw json.RawMessage `json:"transport,omitempty" caddy:"namespace=http.reverse_proxy.transport inline_key=protocol"`

	base      *url.URL
	id        identity
	transport http.RoundTripper
	proxy     *reverseproxy.Handler
	ctx       context.Context
	cancel    context.CancelFunc
	log       *zap.Logger

	mu       sync.Mutex
	active   sync.WaitGroup
	closed   bool
	app      *app
	key      string
	ready    chan struct{}
	startErr error
}

// CaddyModule returns the Caddy module information.
func (*Handler) CaddyModule() caddy.ModuleInfo {
	return caddy.ModuleInfo{
		ID:  "http.handlers.emby_users",
		New: func() caddy.Module { return new(Handler) },
	}
}

// The database and local session state survive overlapping configurations;
// upstream clients and proxy transports belong to their own configuration.
var pool = caddy.NewUsagePool()

func defaultDatabase() string { return filepath.Join(caddy.AppDataDir(), "emby-users.db") }

func (h *Handler) Provision(ctx caddy.Context) error {
	repl := caddy.NewReplacer()
	for _, value := range []*string{&h.Upstream, &h.Username, &h.Password, &h.Database,
		&h.ClientName, &h.DeviceName, &h.DeviceID, &h.ClientVersion, &h.UserAgent} {
		*value = repl.ReplaceAll(*value, "")
	}
	if h.Database == "" {
		h.Database = defaultDatabase()
	}
	var err error
	h.Database, err = filepath.Abs(h.Database)
	if err != nil {
		return fmt.Errorf("emby_users: database path: %w", err)
	}
	h.base, err = url.Parse(h.Upstream)
	if err != nil {
		return fmt.Errorf("emby_users: upstream: %w", err)
	}
	h.id = (identity{Client: h.ClientName, Device: h.DeviceName, DeviceID: h.DeviceID,
		Version: h.ClientVersion, UserAgent: h.UserAgent}).defaults()
	if err := h.Validate(); err != nil {
		return err
	}
	if h.TransportRaw == nil {
		h.TransportRaw = json.RawMessage(`{"protocol":"http","response_header_timeout":30000000000}`)
	}
	// Match reverse_proxy's HTTPS behavior before the transport is provisioned.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(h.TransportRaw, &raw); err != nil {
		return fmt.Errorf("emby_users: transport: %w", err)
	}
	if string(raw["protocol"]) == `"http"` && h.base.Scheme == "https" && raw["tls"] == nil {
		raw["tls"] = json.RawMessage(`{}`)
		h.TransportRaw, _ = json.Marshal(raw)
	}
	mod, err := ctx.LoadModule(h, "TransportRaw")
	if err != nil {
		return fmt.Errorf("emby_users: loading transport: %w", err)
	}
	h.transport = mod.(http.RoundTripper)
	dial := h.base.Host
	if h.base.Port() == "" {
		port := "80"
		if h.base.Scheme == "https" {
			port = "443"
		}
		dial = net.JoinHostPort(h.base.Hostname(), port)
	}
	h.proxy = &reverseproxy.Handler{
		Upstreams: reverseproxy.UpstreamPool{&reverseproxy.Upstream{Dial: dial}},
		Transport: &upstreamTransport{base: h.transport},
	}
	if err := h.proxy.Provision(ctx); err != nil {
		return fmt.Errorf("emby_users: provisioning reverse proxy: %w", err)
	}
	h.ctx, h.cancel = context.WithCancel(ctx)
	h.log = ctx.Logger()
	h.ready = make(chan struct{})
	owner, err := ctx.App("emby_users")
	if err != nil {
		return fmt.Errorf("emby_users: loading lifecycle app: %w", err)
	}
	owner.(*App).handlers = append(owner.(*App).handlers, h)
	return nil
}

// Validate is read-only. In particular, caddy validate must not create or
// migrate the account database, generate a device ID, or authenticate upstream.
func (h *Handler) Validate() error {
	if h.base == nil || h.base.Hostname() == "" || (h.base.Scheme != "http" && h.base.Scheme != "https") ||
		(h.base.Path != "" && h.base.Path != "/") || h.base.User != nil || h.base.RawQuery != "" || h.base.Fragment != "" {
		return fmt.Errorf("emby_users: upstream must be an http(s) origin without credentials, path, query or fragment")
	}
	if h.Username == "" {
		return fmt.Errorf("emby_users: username is required")
	}
	return h.id.validate()
}

var (
	_ caddy.Validator             = (*Handler)(nil)
	_ caddy.Provisioner           = (*Handler)(nil)
	_ caddy.CleanerUpper          = (*Handler)(nil)
	_ caddyhttp.MiddlewareHandler = (*Handler)(nil)
)
