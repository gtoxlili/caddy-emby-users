package embyusers

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/caddyserver/caddy/v2"
)

// contract: one upstream device survives reloads and restarts. A saved
// login belongs to its device identity as well as its server and account.
func TestUpstreamIdentityLifecycle(t *testing.T) {
	up := newFakeUpstream(t)
	database := filepath.Join(t.TempDir(), "users.db")
	ctx, cancel := caddy.NewContext(caddy.Context{Context: t.Context()})
	t.Cleanup(cancel)
	load := func(h Handler) (*Handler, func()) {
		t.Helper()
		h.Upstream, h.Username, h.Password, h.Database = up.srv.URL, "owner", upPassword, database
		if err := h.Provision(ctx); err != nil {
			t.Fatal(err)
		}
		closed := false
		closeHandler := func() {
			if !closed {
				closed = true
				if err := h.Cleanup(); err != nil {
					t.Error(err)
				}
			}
		}
		t.Cleanup(closeHandler)
		return &h, closeHandler
	}
	ensure := func(h *Handler) {
		t.Helper()
		if err := h.app.up.ensure(t.Context()); err != nil {
			t.Fatal(err)
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

	first, closeFirst := load(Handler{})
	ensure(first)
	req := up.seen()[0]
	fields := authFields(req.Header)
	deviceID := fields["deviceid"]
	if fields["client"] != "Emby Web" || fields["device"] != "Chrome" || fields["version"] != "4.8.11.0" || len(deviceID) != 32 {
		t.Fatalf("unexpected default identity: %s", req.Header.Get("X-Emby-Authorization"))
	}
	if ua := req.Header.Get("User-Agent"); !strings.Contains(ua, "Chrome/") || strings.Contains(ua, "caddy") {
		t.Fatalf("unexpected default User-Agent: %q", ua)
	}
	closeFirst()

	restarted, closeRestarted := load(Handler{})
	ensure(restarted)
	reloaded, closeReloaded := load(Handler{})
	ensure(reloaded)
	closeRestarted()
	if _, err := reloaded.app.up.get(t.Context(), "/System/Info/Public", nil); err != nil {
		t.Fatal(err)
	}
	requests := up.seen()
	lastFields := authFields(requests[len(requests)-1].Header)
	if loginCount() != 1 || lastFields["deviceid"] != deviceID || lastFields["client"] != "Emby Web" || lastFields["version"] != "4.8.11.0" {
		t.Fatal("restart or reload changed the upstream login or device")
	}

	// Placeholders apply to the entire profile. Changing it must invalidate
	// both the live login and the one saved in SQLite.
	t.Setenv("EMBY_TEST_VERSION", "9.9.9")
	t.Setenv("EMBY_TEST_UA", "PersonalPlayer/9.9.9")
	custom := Handler{ClientVersion: "{env.EMBY_TEST_VERSION}", UserAgent: "{env.EMBY_TEST_UA}"}
	changed, closeChanged := load(custom)
	ensure(changed)
	requests = up.seen()
	last := requests[len(requests)-1]
	fields = authFields(last.Header)
	if loginCount() != 2 || fields["deviceid"] != deviceID || fields["version"] != "9.9.9" || last.Header.Get("User-Agent") != "PersonalPlayer/9.9.9" {
		t.Fatalf("identity change did not create a matching login: %+v", last)
	}
	closeReloaded()
	closeChanged()

	matching, closeMatching := load(custom)
	ensure(matching)
	if loginCount() != 2 {
		t.Fatal("matching persisted identity was not reused")
	}
	// Simulate a login saved by the old plugin, which did not record identity.
	raw, err := matching.app.st.Meta(t.Context(), "upstream")
	if err != nil {
		t.Fatal(err)
	}
	var legacy map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &legacy); err != nil {
		t.Fatal(err)
	}
	delete(legacy, "identity")
	encoded, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err := matching.app.st.SetMeta(t.Context(), "upstream", string(encoded)); err != nil {
		t.Fatal(err)
	}
	closeMatching()
	migrated, _ := load(custom)
	ensure(migrated)
	if loginCount() != 3 {
		t.Fatal("legacy login was reused without checking its device identity")
	}
	requests = up.seen()
	if got := authFields(requests[len(requests)-1].Header)["deviceid"]; got != deviceID {
		t.Fatalf("migration changed device ID from %q to %q", deviceID, got)
	}
}
