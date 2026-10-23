package embyusers

import (
	"net/http"
	"strings"

	"github.com/caddyserver/caddy/v2/caddyconfig"
	"github.com/caddyserver/caddy/v2/caddyconfig/caddyfile"
	"github.com/caddyserver/caddy/v2/caddyconfig/httpcaddyfile"
	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
)

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
//		client_version <version>
//		user_agent <value>
//		transport http { ... }
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
		if key == "transport" {
			if h.TransportRaw != nil || !d.NextArg() {
				return d.Err("transport must be specified once")
			}
			name := d.Val()
			mod, err := caddyfile.UnmarshalModule(d, "http.reverse_proxy.transport."+name)
			if err != nil {
				return err
			}
			if _, ok := mod.(http.RoundTripper); !ok {
				return d.Err("transport must implement http.RoundTripper")
			}
			h.TransportRaw = caddyconfig.JSONModuleObject(mod, "protocol", name, nil)
			continue
		}
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
		case "client_version":
			h.ClientVersion = val
		case "user_agent":
			h.UserAgent = val
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

var _ caddyfile.Unmarshaler = (*Handler)(nil)
