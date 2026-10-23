// Package embyusers is a Caddy HTTP handler that gives an Emby server its
// own user accounts. Friends sign in with accounts the plugin manages; every
// request reaches the real server through one upstream account, and each
// friend keeps separate watch history, resume points and favorites.
package embyusers

import (
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"

	"github.com/caddyserver/caddy/v2"
	"github.com/caddyserver/caddy/v2/caddyconfig/caddyfile"
	"github.com/caddyserver/caddy/v2/caddyconfig/httpcaddyfile"
	"github.com/caddyserver/caddy/v2/modules/caddyhttp"

	"github.com/gtoxlili/caddy-emby-users/internal/store"
)

// version is reported to the upstream server as the client version.
const version = "0.1.0"

func init() {
	caddy.RegisterModule(Handler{})
	httpcaddyfile.RegisterHandlerDirective("emby_users", parseCaddyfile)
	httpcaddyfile.RegisterDirectiveOrder("emby_users", httpcaddyfile.Before, "reverse_proxy")
}

// Handler sits in front of a reverse_proxy to an Emby server.
type Handler struct {
	// Upstream is the base URL of the Emby server, the same one the
	// reverse_proxy after this handler points at.
	Upstream string `json:"upstream"`
	// Username and Password sign in to the upstream server. Placeholders
	// such as {env.EMBY_PASSWORD} are expanded.
	Username string `json:"username"`
	Password string `json:"password"`
	// Database is the SQLite file for accounts and play state. Defaults to
	// emby-users.db in Caddy's data directory.
	Database string `json:"database,omitempty"`
	// ClientName, DeviceName and DeviceID are what the upstream server sees
	// on every request, whoever makes it. They default to
	// "caddy-emby-users".
	ClientName string `json:"client_name,omitempty"`
	DeviceName string `json:"device_name,omitempty"`
	DeviceID   string `json:"device_id,omitempty"`

	app *app
	key string
}

// CaddyModule returns the Caddy module information.
func (Handler) CaddyModule() caddy.ModuleInfo {
	return caddy.ModuleInfo{
		ID:  "http.handlers.emby_users",
		New: func() caddy.Module { return new(Handler) },
	}
}

// pool shares one runtime per database across config reloads, so a reload
// keeps the session cache and the upstream sign-in.
var pool = caddy.NewUsagePool()

// defaultDatabase is where accounts live unless the config says otherwise.
func defaultDatabase() string { return filepath.Join(caddy.AppDataDir(), "emby-users.db") }

// Provision opens the database and prepares the upstream client.
func (h *Handler) Provision(ctx caddy.Context) error {
	repl := caddy.NewReplacer()
	upstreamURL := repl.ReplaceAll(h.Upstream, "")
	username := repl.ReplaceAll(h.Username, "")
	password := repl.ReplaceAll(h.Password, "")
	database := repl.ReplaceAll(h.Database, "")
	if database == "" {
		database = defaultDatabase()
	}
	id := identity{Client: h.ClientName, Device: h.DeviceName, DeviceID: h.DeviceID}
	for _, f := range []*string{&id.Client, &id.Device, &id.DeviceID} {
		if *f == "" {
			*f = "caddy-emby-users"
		}
	}
	base, err := url.Parse(upstreamURL)
	if err != nil || base.Host == "" || (base.Scheme != "http" && base.Scheme != "https") {
		return fmt.Errorf("emby_users: upstream must be an http(s) URL, got %q", upstreamURL)
	}
	if username == "" {
		return fmt.Errorf("emby_users: username is required")
	}
	h.key = database
	log := ctx.Logger()
	val, _, err := pool.LoadOrNew(h.key, func() (caddy.Destructor, error) {
		st, err := store.Open(database)
		if err != nil {
			return nil, fmt.Errorf("emby_users: opening %s: %w", database, err)
		}
		return newApp(st, newUpstream(base, username, password, id, st, log), log), nil
	})
	if err != nil {
		return err
	}
	a := val.(*app)
	// A reload may change the upstream account; the shared runtime follows.
	a.up.configure(base, username, password, id)
	h.app = a
	return nil
}

// Cleanup releases the shared runtime when no config uses it.
func (h *Handler) Cleanup() error {
	if h.key == "" {
		return nil
	}
	_, err := pool.Delete(h.key)
	return err
}

// ServeHTTP implements caddyhttp.MiddlewareHandler.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request, next caddyhttp.Handler) error {
	return h.app.serve(w, r, next)
}

// UnmarshalCaddyfile parses
//
//	emby_users {
//		upstream <url>
//		username <name>
//		password <password>
//		database <path>
//		client_name <name>
//		device_name <name>
//		device_id <id>
//	}
func (h *Handler) UnmarshalCaddyfile(d *caddyfile.Dispenser) error {
	d.Next()
	if d.NextArg() {
		h.Upstream = d.Val()
	}
	if d.NextArg() {
		return d.ArgErr()
	}
	for d.NextBlock(0) {
		key := d.Val()
		if !d.NextArg() {
			return d.ArgErr()
		}
		val := d.Val()
		if d.NextArg() {
			return d.ArgErr()
		}
		switch strings.ToLower(key) {
		case "upstream":
			h.Upstream = val
		case "username":
			h.Username = val
		case "password":
			h.Password = val
		case "database":
			h.Database = val
		case "client_name":
			h.ClientName = val
		case "device_name":
			h.DeviceName = val
		case "device_id":
			h.DeviceID = val
		default:
			return d.Errf("unknown emby_users option %q", key)
		}
	}
	return nil
}

func parseCaddyfile(hh httpcaddyfile.Helper) (caddyhttp.MiddlewareHandler, error) {
	var h Handler
	err := h.UnmarshalCaddyfile(hh.Dispenser)
	return &h, err
}

var (
	_ caddy.Provisioner           = (*Handler)(nil)
	_ caddy.CleanerUpper          = (*Handler)(nil)
	_ caddyhttp.MiddlewareHandler = (*Handler)(nil)
	_ caddyfile.Unmarshaler       = (*Handler)(nil)
)
