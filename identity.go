package embyusers

import (
	"context"
	"fmt"
	"strings"

	"github.com/gtoxlili/caddy-emby-users/internal/store"
)

// identity is the fixed client and device reported to the upstream server.
// Its version is independent of the plugin version, including after upgrades.
type identity struct {
	Client    string `json:"client"`
	Device    string `json:"device"`
	DeviceID  string `json:"device_id"`
	Version   string `json:"version"`
	UserAgent string `json:"user_agent"`
}

// These are a fixed browser profile, not a claim about the latest releases.
const (
	defaultClientVersion = "4.8.11.0"
	defaultUserAgent     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

func (id identity) resolve(ctx context.Context, st *store.Store) (identity, error) {
	if id.Client == "" {
		id.Client = "Emby Web"
	}
	if id.Device == "" {
		id.Device = "Chrome"
	}
	if id.Version == "" {
		id.Version = defaultClientVersion
	}
	if id.UserAgent == "" {
		id.UserAgent = defaultUserAgent
	}
	for name, value := range map[string]string{
		"client_name": id.Client, "device_name": id.Device,
		"device_id": id.DeviceID, "client_version": id.Version, "user_agent": id.UserAgent,
	} {
		for _, c := range value {
			if c < 0x20 || c == 0x7f || (name != "user_agent" && (c == '"' || c == '\\')) {
				return identity{}, fmt.Errorf("emby_users: invalid character in %s", name)
			}
		}
	}
	if id.DeviceID == "" {
		deviceID, err := st.Meta(ctx, "upstream_device_id")
		if err != nil {
			return identity{}, fmt.Errorf("emby_users: loading device ID: %w", err)
		}
		if deviceID == "" {
			deviceID = store.RandomID()
			if err := st.SetMeta(ctx, "upstream_device_id", deviceID); err != nil {
				return identity{}, fmt.Errorf("emby_users: saving device ID: %w", err)
			}
		}
		id.DeviceID = deviceID
	}
	return id, nil
}

func (id identity) authHeader(token string) string {
	auth := fmt.Sprintf(`MediaBrowser Client="%s", Device="%s", DeviceId="%s", Version="%s"`, id.Client, id.Device, id.DeviceID, id.Version)
	if token != "" {
		auth += `, Token="` + token + `"`
	}
	return auth
}

func embyAuthorization(value string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	return strings.HasPrefix(value, "emby ") || strings.HasPrefix(value, "mediabrowser ")
}
