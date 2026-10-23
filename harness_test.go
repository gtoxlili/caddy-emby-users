package embyusers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"go.uber.org/zap"

	"github.com/gtoxlili/caddy-emby-users/internal/store"
)

// The fake upstream mirrors the Emby-compatible server this plugin was first
// deployed against (observed 2026-10): 26-character mixed-case ids, a short
// ServerId, Ids and played filters ignored, streams under /play/video, no
// /UserSettings, no WebSocket.
const (
	upUser     = "01UPSTREAMUSER000000000000"
	upServer   = "SRV"
	upPassword = "upstream-secret"
	hour       = int64(36000000000)
)

type recorded struct {
	Method, Path, Query string
	Header              http.Header
	Body                string
}

type fakeUpstream struct {
	t   *testing.T
	srv *httptest.Server

	mu       sync.Mutex
	token    string
	logins   int
	password string
	requests []recorded
}

var catalog = map[string]map[string]any{
	"m01SERIES": {"Id": "m01SERIES", "Name": "Series", "Type": "Series", "IsFolder": true, "RecursiveItemCount": 3, "ChildCount": 1},
	"s01SEASON": {"Id": "s01SEASON", "Name": "Season 1", "Type": "Season", "IsFolder": true, "ParentId": "m01SERIES", "SeriesId": "m01SERIES", "ChildCount": 3, "IndexNumber": 1},
	"e01EP1":    episodeFixture("e01EP1", 1),
	"e01EP2":    episodeFixture("e01EP2", 2),
	"e01EP3":    episodeFixture("e01EP3", 3),
	"m01MOVIE":  {"Id": "m01MOVIE", "Name": "Movie", "Type": "Movie", "IsFolder": false, "MediaType": "Video", "RunTimeTicks": 2 * hour},
	"c01SHOWS":  {"Id": "c01SHOWS", "Name": "Shows", "Type": "CollectionFolder", "CollectionType": "tvshows", "IsFolder": true},
	"c01FILMS":  {"Id": "c01FILMS", "Name": "Films", "Type": "CollectionFolder", "CollectionType": "movies", "IsFolder": true},
}

var libraries = map[string][]string{
	"c01SHOWS": {"m01SERIES"},
	"c01FILMS": {"m01MOVIE"},
}

func episodeFixture(id string, n int) map[string]any {
	return map[string]any{
		"Id": id, "Name": fmt.Sprintf("Episode %d", n), "Type": "Episode", "IsFolder": false, "MediaType": "Video",
		"SeriesId": "m01SERIES", "SeasonId": "s01SEASON", "ParentId": "s01SEASON",
		"ParentIndexNumber": 1, "IndexNumber": n, "RunTimeTicks": hour,
	}
}

// dto renders a catalog item with the upstream account's own UserData, which
// the plugin must never pass on: it says everything was half watched.
func dto(id string) map[string]any {
	src := catalog[id]
	out := map[string]any{"ServerId": upServer}
	for k, v := range src {
		out[k] = v
	}
	out["UserData"] = map[string]any{
		"Key": id, "ItemId": id, "ServerId": upServer,
		"PlaybackPositionTicks": 999, "PlayCount": 7, "IsFavorite": true, "Played": true,
	}
	return out
}

func newFakeUpstream(t *testing.T) *fakeUpstream {
	f := &fakeUpstream{t: t, password: upPassword, token: "0000000000000000000000000000dead"}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeUpstream) currentToken() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.token
}

// revoke invalidates the upstream token, as a server restart or a sign-in
// elsewhere would.
func (f *fakeUpstream) revoke() {
	f.mu.Lock()
	f.token = "revoked"
	f.mu.Unlock()
}

func (f *fakeUpstream) seen() []recorded {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]recorded(nil), f.requests...)
}

func (f *fakeUpstream) reset() {
	f.mu.Lock()
	f.requests = nil
	f.mu.Unlock()
}

func (f *fakeUpstream) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	f.requests = append(f.requests, recorded{Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery, Header: r.Header.Clone(), Body: string(body)})
	f.mu.Unlock()

	path := strings.TrimPrefix(r.URL.Path, "/emby")
	segs := strings.Split(strings.Trim(path, "/"), "/")
	low := strings.ToLower(path)

	if low == "/users/authenticatebyname" {
		var in struct{ Username, Pw string }
		json.Unmarshal(body, &in)
		f.mu.Lock()
		ok := in.Pw == f.password
		if ok {
			f.logins++
			f.token = fmt.Sprintf("%032x", f.logins)
		}
		tok := f.token
		f.mu.Unlock()
		if !ok {
			http.Error(w, "bad credentials", http.StatusUnauthorized)
			return
		}
		writeFakeJSON(w, map[string]any{"AccessToken": tok, "ServerId": upServer, "User": map[string]any{"Id": upUser}})
		return
	}
	if low == "/system/info/public" {
		writeFakeJSON(w, map[string]any{"ServerName": "Media", "Version": "4.9.3.0", "Id": upServer,
			"LocalAddress": "http://upstream.internal", "LocalAddresses": []string{"http://upstream.internal"},
			"RemoteAddresses": []string{"http://upstream.internal"}, "WanAddress": "http://upstream.internal"})
		return
	}
	tok := r.Header.Get("X-Emby-Token")
	if tok == "" {
		tok = r.URL.Query().Get("api_key")
	}
	if tok == "" {
		if m := authField.FindAllStringSubmatch(r.Header.Get("X-Emby-Authorization"), -1); m != nil {
			for _, kv := range m {
				if strings.EqualFold(kv[1], "token") {
					tok = strings.Trim(kv[2], `"`)
				}
			}
		}
	}
	if tok != f.currentToken() {
		http.Error(w, "Access token is invalid or expired.", http.StatusUnauthorized)
		return
	}
	switch {
	case low == "/users/"+strings.ToLower(upUser):
		writeFakeJSON(w, map[string]any{"Id": upUser, "Name": "owner", "ServerId": upServer,
			"Configuration": map[string]any{"HidePlayedInLatest": true, "IntroSkipMode": "ShowButton"},
			"Policy":        map[string]any{"IsAdministrator": false, "EnableContentDownloading": true}})
	case len(segs) == 3 && strings.EqualFold(segs[0], "users") && segs[1] == upUser && strings.EqualFold(segs[2], "views"):
		writeFakeJSON(w, map[string]any{"Items": []any{dto("c01SHOWS"), dto("c01FILMS")}, "TotalRecordCount": 2})
	case len(segs) == 4 && strings.EqualFold(segs[0], "users") && segs[1] == upUser && strings.EqualFold(segs[2], "items") && strings.EqualFold(segs[3], "latest"):
		writeFakeJSON(w, []any{dto("e01EP1"), dto("m01MOVIE")})
	case len(segs) == 4 && strings.EqualFold(segs[0], "users") && segs[1] == upUser && strings.EqualFold(segs[2], "items"):
		if _, ok := catalog[segs[3]]; !ok {
			http.NotFound(w, r)
			return
		}
		writeFakeJSON(w, dto(segs[3]))
	case len(segs) == 3 && strings.EqualFold(segs[0], "users") && segs[1] == upUser && strings.EqualFold(segs[2], "items"):
		// Ids is ignored, as on the real upstream.
		ids := []string{"m01SERIES", "m01MOVIE"}
		if p := r.URL.Query().Get("ParentId"); p != "" {
			ids = libraries[p]
		}
		items := []any{}
		for _, id := range ids {
			items = append(items, dto(id))
		}
		writeFakeJSON(w, map[string]any{"Items": items, "TotalRecordCount": len(items)})
	case len(segs) == 3 && strings.EqualFold(segs[0], "shows") && strings.EqualFold(segs[2], "episodes"):
		writeFakeJSON(w, map[string]any{"Items": []any{dto("e01EP1"), dto("e01EP2"), dto("e01EP3")}, "TotalRecordCount": 3})
	case len(segs) == 3 && strings.EqualFold(segs[0], "items") && strings.EqualFold(segs[2], "playbackinfo"):
		writeFakeJSON(w, map[string]any{"PlaySessionId": "ps1", "MediaSources": []any{map[string]any{
			"Id": "ms1", "Protocol": "File", "Path": "Episode 1",
			"DirectStreamUrl": "/play/video/" + segs[1] + "?api_key=" + tok,
		}}})
	case len(segs) == 3 && segs[0] == "play" && segs[1] == "video":
		w.Header().Set("Content-Type", "video/mp4")
		w.Write([]byte("video-bytes-" + segs[2]))
	case strings.HasPrefix(low, "/sessions/playing"):
		w.WriteHeader(http.StatusNoContent)
	case low == "/system/configuration", low == "/items/restricted":
		// Admin-only on a real server; the shared account is not an admin.
		http.Error(w, "Access token is invalid or expired.", http.StatusUnauthorized)
	case strings.HasPrefix(low, "/displaypreferences/"):
		writeFakeJSON(w, map[string]any{"Id": segs[1], "SortBy": "SortName", "CustomPrefs": map[string]any{}})
	default:
		// /UserSettings and others are missing upstream; nginx answers.
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte("<html>404 Not Found</html>"))
	}
}

func writeFakeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(v)
}

// harness runs the handler in front of a reverse proxy to the fake
// upstream, the way a Caddyfile wires it.
type harness struct {
	t   *testing.T
	up  *fakeUpstream
	app *app
	srv *httptest.Server
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	up := newFakeUpstream(t)
	st, err := store.Open(filepath.Join(t.TempDir(), "users.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	base, _ := url.Parse(up.srv.URL)
	a := newApp(st, newUpstream(base, "owner", upPassword, identity{
		Client: "gateway", Device: "gateway", DeviceID: "test-device", Version: "9.8.7", UserAgent: "ConfiguredPlayer/42",
	}, st, zap.NewNop()), zap.NewNop())
	rp := httputil.NewSingleHostReverseProxy(base)
	next := caddyhttp.HandlerFunc(func(w http.ResponseWriter, r *http.Request) error {
		rp.ServeHTTP(w, r)
		return nil
	})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := a.serve(w, r, next); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
	}))
	t.Cleanup(srv.Close)
	h := &harness{t: t, up: up, app: a, srv: srv}
	for _, u := range []struct {
		name  string
		admin bool
	}{{"admin", true}, {"alice", false}, {"bob", false}} {
		if _, err := st.CreateUser(t.Context(), u.name, u.name+"-pw", u.admin); err != nil {
			t.Fatal(err)
		}
	}
	return h
}

type response struct {
	Status int
	Header http.Header
	Body   []byte
}

func (r response) json(t *testing.T) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(r.Body, &m); err != nil {
		t.Fatalf("body is not a JSON object: %s", r.Body)
	}
	return m
}

// do sends a request; headers are alternating name, value pairs.
func (h *harness) do(method, path, body string, headers ...string) response {
	h.t.Helper()
	req, err := http.NewRequest(method, h.srv.URL+path, strings.NewReader(body))
	if err != nil {
		h.t.Fatal(err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return response{Status: resp.StatusCode, Header: resp.Header, Body: b}
}

// as sends a request with the token in the X-Emby-Token header.
func (h *harness) as(token, method, path, body string) response {
	h.t.Helper()
	return h.do(method, path, body, "X-Emby-Token", token)
}

type session struct {
	Token  string
	UserID string
}

func (h *harness) signIn(name string) session {
	h.t.Helper()
	r := h.do(http.MethodPost, "/emby/Users/AuthenticateByName", fmt.Sprintf(`{"Username":%q,"Pw":%q}`, name, name+"-pw"),
		"X-Emby-Authorization", fmt.Sprintf(`MediaBrowser Client="Test", Device="d-%s", DeviceId="dev-%s", Version="1"`, name, name))
	if r.Status != http.StatusOK {
		h.t.Fatalf("sign-in %s: %d %s", name, r.Status, r.Body)
	}
	m := r.json(h.t)
	return session{Token: m["AccessToken"].(string), UserID: m["User"].(map[string]any)["Id"].(string)}
}

func udOf(t *testing.T, r response) map[string]any {
	t.Helper()
	if r.Status != http.StatusOK {
		t.Fatalf("status %d: %s", r.Status, r.Body)
	}
	ud, ok := r.json(t)["UserData"].(map[string]any)
	if !ok {
		t.Fatalf("no UserData in %s", r.Body)
	}
	return ud
}

func itemIDs(t *testing.T, r response) []string {
	t.Helper()
	if r.Status != http.StatusOK {
		t.Fatalf("status %d: %s", r.Status, r.Body)
	}
	items, _ := r.json(t)["Items"].([]any)
	ids := []string{}
	for _, it := range items {
		ids = append(ids, it.(map[string]any)["Id"].(string))
	}
	return ids
}
