package embyusers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/caddyserver/caddy/v2"
	"github.com/caddyserver/caddy/v2/caddyconfig"
	_ "github.com/caddyserver/caddy/v2/modules/filestorage"
	"github.com/gtoxlili/caddy-emby-users/internal/store"
)

// These tests run actual Caddy configuration transactions. The protocol
// harness cannot establish lifecycle, rollback, transport or streaming behavior.
func gatewayAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	t.Cleanup(func() {
		if err := caddy.Stop(); err != nil {
			t.Error(err)
		}
	})
	return address
}

func gatewayConfig(t *testing.T, address string, h *Handler) []byte {
	t.Helper()
	raw, err := json.Marshal(h)
	if err != nil {
		t.Fatal(err)
	}
	var handler map[string]any
	json.Unmarshal(raw, &handler)
	handler["handler"] = "emby_users"
	config := map[string]any{
		"admin":   map[string]any{"disabled": true, "config": map[string]any{"persist": false}},
		"storage": map[string]any{"module": "file_system", "root": filepath.Join(t.TempDir(), "caddy")},
		"logging": map[string]any{"logs": map[string]any{"default": map[string]any{"level": "ERROR"}}},
		"apps": map[string]any{"http": map[string]any{"servers": map[string]any{"gateway": map[string]any{
			"listen": []string{address}, "automatic_https": map[string]any{"disable": true},
			"routes": []any{map[string]any{"handle": []any{handler}}},
		}}}},
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func loadGateway(t *testing.T, cfg []byte) {
	t.Helper()
	if err := caddy.Load(cfg, true); err != nil {
		t.Fatal(err)
	}
}

func gatewayRequest(t *testing.T, address, method, path, body, token string) response {
	t.Helper()
	r, err := http.NewRequest(method, "http://"+address+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Content-Type", "application/json")
	if token != "" {
		r.Header.Set("X-Emby-Token", token)
	}
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response{Status: res.StatusCode, Header: res.Header, Body: raw}
}

func validateGateway(raw []byte) error {
	var cfg caddy.Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return err
	}
	return caddy.Validate(&cfg)
}

// Exercise the published terminal-handler syntax through Caddy's adapter,
// child transport loader and application lifecycle, not just our parser.
func TestStandaloneCaddyfile(t *testing.T) {
	up := newFakeUpstream(t)
	address := gatewayAddress(t)
	database := filepath.Join(t.TempDir(), "users.db")
	t.Setenv("EMBY_PLUGIN_TEST_USER", "owner")
	t.Setenv("EMBY_PLUGIN_TEST_PASSWORD", upPassword)
	input := fmt.Sprintf(`{
	admin off
	persist_config off
}
http://%s {
	emby_users {
		upstream %s
		username {env.EMBY_PLUGIN_TEST_USER}
		password {env.EMBY_PLUGIN_TEST_PASSWORD}
		database %q
		transport http {
			dial_timeout 1s
		}
	}
}`, address, up.srv.URL, database)
	raw, _, err := caddyconfig.GetAdapter("caddyfile").Adapt([]byte(input), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateGateway(raw); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(database); !os.IsNotExist(err) {
		t.Fatal("Caddyfile validation created database")
	}
	loadGateway(t, raw)
	if r := gatewayRequest(t, address, "GET", "/emby/System/Info/Public", "", ""); r.Status != 200 {
		t.Fatalf("standalone handler: %d %s", r.Status, r.Body)
	}
}

// upstream: Caddy provisions modules even for validation, which may never be
// activated. https://caddyserver.com/docs/extending-caddy#provisioning
func TestValidationDoesNotCreateState(t *testing.T) {
	up := newFakeUpstream(t)
	address := gatewayAddress(t)
	database := filepath.Join(t.TempDir(), "not-created", "users.db")
	h := Handler{Upstream: up.srv.URL, Username: "owner", Password: upPassword, Database: database}
	if err := validateGateway(gatewayConfig(t, address, &h)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Dir(database)); !os.IsNotExist(err) {
		t.Fatalf("validation created application state: %v", err)
	}
	if len(up.seen()) != 0 {
		t.Fatal("validation contacted upstream")
	}
	h.DeviceName = "bad\ndevice"
	if err := validateGateway(gatewayConfig(t, address, &h)); err == nil {
		t.Fatal("invalid identity accepted")
	}
	if _, err := os.Stat(filepath.Dir(database)); !os.IsNotExist(err) {
		t.Fatal("failed validation created state")
	}
}

// contract: one upstream device survives real reloads and restarts. A saved
// login belongs to its device identity as well as its server and account.
func TestUpstreamIdentityLifecycle(t *testing.T) {
	up := newFakeUpstream(t)
	address := gatewayAddress(t)
	database := filepath.Join(t.TempDir(), "users.db")
	h := Handler{Upstream: up.srv.URL, Username: "owner", Password: upPassword, Database: database}
	load := func() {
		t.Helper()
		loadGateway(t, gatewayConfig(t, address, &h))
		if r := gatewayRequest(t, address, "GET", "/emby/System/Info/Public", "", ""); r.Status != http.StatusOK {
			t.Fatalf("public info: %d %s", r.Status, r.Body)
		}
	}
	loginCount := func() int {
		n := 0
		for _, req := range up.seen() {
			if strings.HasSuffix(req.Path, "/Users/AuthenticateByName") {
				n++
			}
		}
		return n
	}
	load()
	first := up.seen()[0]
	fields := authFields(first.Header)
	deviceID := fields["deviceid"]
	if fields["client"] != "Emby Web" || fields["device"] != "Chrome" || fields["version"] != "4.8.11.0" || len(deviceID) != 32 {
		t.Fatalf("unexpected default identity: %s", first.Header.Get("X-Emby-Authorization"))
	}
	if ua := first.Header.Get("User-Agent"); !strings.Contains(ua, "Chrome/") || strings.Contains(ua, "caddy") {
		t.Fatalf("User-Agent: %q", ua)
	}
	if err := caddy.Stop(); err != nil {
		t.Fatal(err)
	}
	load() // cold restart
	load() // overlapping config reload
	if loginCount() != 1 {
		t.Fatal("restart or reload created a new upstream login")
	}
	t.Setenv("EMBY_TEST_VERSION", "9.9.9")
	t.Setenv("EMBY_TEST_UA", "PersonalPlayer/9.9.9")
	h.ClientVersion, h.UserAgent = "{env.EMBY_TEST_VERSION}", "{env.EMBY_TEST_UA}"
	load()
	requests := up.seen()
	last := requests[len(requests)-1]
	fields = authFields(last.Header)
	if loginCount() != 2 || fields["deviceid"] != deviceID || fields["version"] != "9.9.9" || last.Header.Get("User-Agent") != "PersonalPlayer/9.9.9" {
		t.Fatalf("changed identity did not create a matching login: %+v", last)
	}
	if err := caddy.Stop(); err != nil {
		t.Fatal(err)
	}
	load()
	if loginCount() != 2 {
		t.Fatal("matching identity was not reused")
	}
	if err := caddy.Stop(); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(database)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := st.Meta(t.Context(), "upstream")
	if err != nil {
		t.Fatal(err)
	}
	var legacy map[string]json.RawMessage
	json.Unmarshal([]byte(raw), &legacy)
	delete(legacy, "identity")
	encoded, _ := json.Marshal(legacy)
	if err := st.SetMeta(t.Context(), "upstream", string(encoded)); err != nil {
		t.Fatal(err)
	}
	st.Close()
	load()
	if loginCount() != 3 {
		t.Fatal("legacy login was reused without matching identity")
	}
	requests = up.seen()
	if got := authFields(requests[len(requests)-1].Header)["deviceid"]; got != deviceID {
		t.Fatalf("device ID changed: %q", got)
	}
}

// upstream: new module instances are provisioned before old ones stop, even
// when a proposed configuration is only validated and never activated.
func TestStagedConfigurationCannotRetargetActiveRequests(t *testing.T) {
	one, two := newFakeUpstream(t), newFakeUpstream(t)
	address := gatewayAddress(t)
	h := Handler{Upstream: one.srv.URL, Username: "owner", Password: upPassword, Database: filepath.Join(t.TempDir(), "users.db")}
	loadGateway(t, gatewayConfig(t, address, &h))
	gatewayRequest(t, address, "GET", "/emby/System/Info/Public", "", "")
	h.Upstream = two.srv.URL
	if err := validateGateway(gatewayConfig(t, address, &h)); err != nil {
		t.Fatal(err)
	}
	if r := gatewayRequest(t, address, "GET", "/emby/System/Info/Public", "", ""); r.Status != 200 {
		t.Fatalf("active config failed: %d", r.Status)
	}
	if len(two.seen()) != 0 {
		t.Fatal("staged config changed the active upstream")
	}
	before := len(one.seen())
	loadGateway(t, gatewayConfig(t, address, &h))
	gatewayRequest(t, address, "GET", "/emby/System/Info/Public", "", "")
	if len(two.seen()) == 0 || len(one.seen()) != before {
		t.Fatal("new config did not exclusively use its own upstream")
	}
}

// The configured Caddy TLS transport must handle internal API calls as well
// as proxied media. A second default http.Client cannot trust this backend.
func TestCaddyTransportAndLocalStateSurviveReload(t *testing.T) {
	up := newFakeUpstream(t)
	up.srv.Close()
	up.srv = httptest.NewTLSServer(http.HandlerFunc(up.serve))
	t.Cleanup(up.srv.Close)
	address := gatewayAddress(t)
	database := filepath.Join(t.TempDir(), "users.db")
	st, err := store.Open(database)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateUser(t.Context(), "alice", "password", false); err != nil {
		t.Fatal(err)
	}
	st.Close()
	h := Handler{Upstream: up.srv.URL, Username: "owner", Password: upPassword, Database: database,
		TransportRaw: json.RawMessage(`{"protocol":"http","tls":{"insecure_skip_verify":true}}`)}
	cfg := gatewayConfig(t, address, &h)
	loadGateway(t, cfg)
	r := gatewayRequest(t, address, "POST", "/emby/Users/AuthenticateByName", `{"Username":"alice","Pw":"password"}`, "")
	if r.Status != 200 {
		t.Fatalf("login through configured TLS transport: %d %s", r.Status, r.Body)
	}
	token := r.json(t)["AccessToken"].(string)
	r = gatewayRequest(t, address, "GET", "/play/video/e01EP1", "", token)
	if r.Status != 200 || !bytes.Equal(r.Body, []byte("video-bytes-e01EP1")) {
		t.Fatalf("media: %d %s", r.Status, r.Body)
	}
	r = gatewayRequest(t, address, "POST", "/emby/Sessions/Playing", `{"ItemId":"e01EP1","PositionTicks":1}`, token)
	if r.Status != 204 {
		t.Fatalf("playing: %d %s", r.Status, r.Body)
	}
	loadGateway(t, cfg)
	r = gatewayRequest(t, address, "GET", "/emby/Sessions", "", token)
	if r.Status != 200 || !bytes.Contains(r.Body, []byte(`"NowPlayingItem"`)) {
		t.Fatalf("reload lost live session: %d %s", r.Status, r.Body)
	}
	for _, req := range up.seen() {
		if req.Host != strings.TrimPrefix(up.srv.URL, "https://") {
			t.Errorf("upstream Host: %q", req.Host)
		}
		for key := range req.Header {
			if strings.HasPrefix(strings.ToLower(key), "x-forwarded-") || strings.EqualFold(key, "Via") {
				t.Errorf("Caddy forwarding header reached upstream: %s", key)
			}
		}
	}
	// A hijacked local WebSocket is outside net/http's Shutdown handling.
	// Reload must close it rather than wait indefinitely for its read loop.
	conn, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fmt.Fprintf(conn, "GET /emby/EmbyWebSocket?api_key=%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n", token, address)
	reader := bufio.NewReader(conn)
	status, err := reader.ReadString('\n')
	if err != nil || !strings.Contains(status, "101") {
		t.Fatalf("WebSocket handshake: %s %v", status, err)
	}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if line == "\r\n" {
			break
		}
	}
	reloaded := make(chan error, 1)
	go func() { reloaded <- caddy.Load(cfg, true) }()
	select {
	case err := <-reloaded:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("reload waited for a hijacked WebSocket")
	}
}

// Native Caddy must preserve byte ranges and flush media before EOF. A
// downstream disconnect must cancel the upstream request, including reloads.
func TestCaddyMediaStreamingAndCancellation(t *testing.T) {
	cancelled := make(chan struct{})
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		if r.URL.Path == "/range" {
			if r.Header.Get("Range") != "bytes=2-4" {
				t.Error("Range was dropped")
			}
			w.Header().Set("Content-Range", "bytes 2-4/8")
			w.Header().Set("Content-Length", "3")
			w.WriteHeader(http.StatusPartialContent)
			w.Write([]byte("cde"))
			return
		}
		w.Write([]byte("start"))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(cancelled)
	}))
	t.Cleanup(backend.Close)
	address := gatewayAddress(t)
	h := Handler{Upstream: backend.URL, Username: "owner", Database: filepath.Join(t.TempDir(), "users.db")}
	loadGateway(t, gatewayConfig(t, address, &h))
	r, _ := http.NewRequest("GET", "http://"+address+"/range", nil)
	r.Header.Set("Range", "bytes=2-4")
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil || res.StatusCode != 206 || res.Header.Get("Content-Range") != "bytes 2-4/8" || string(body) != "cde" {
		t.Fatalf("range response: %d %s %v", res.StatusCode, body, err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	r, _ = http.NewRequestWithContext(ctx, "GET", "http://"+address+"/stream", nil)
	res, err = http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	prefix := make([]byte, 5)
	if _, err := io.ReadFull(res.Body, prefix); err != nil || string(prefix) != "start" {
		t.Fatalf("media did not stream before EOF: %q %v", prefix, err)
	}
	res.Body.Close()
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("disconnect did not cancel upstream")
	}
}
