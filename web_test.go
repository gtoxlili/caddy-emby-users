package embyusers

import (
	"bytes"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

var assetRef = regexp.MustCompile(`(?:src|href)="(/web/[^"]+)"`)

// needsWebBuild skips tests of the web client in a checkout where ui/ has not
// been built. CI builds it before running them.
func needsWebBuild(t *testing.T) {
	t.Helper()
	if !webBuilt() {
		t.Skip("ui/dist holds no build; run pnpm build in ui/")
	}
}

// The web client owns /web/: the entry page answers every client route, and
// every file it references is served from the embedded build.
func TestWebClientIsServed(t *testing.T) {
	needsWebBuild(t)
	h := newHarness(t)

	noFollow := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	root, err := noFollow.Get(h.srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	root.Body.Close()
	if root.StatusCode != http.StatusFound || root.Header.Get("Location") != "/web/" {
		t.Fatalf("/ = %d %q, want a redirect to /web/", root.StatusCode, root.Header.Get("Location"))
	}

	entry := h.do(http.MethodGet, "/web/", "")
	if entry.Status != http.StatusOK || !strings.HasPrefix(entry.Header.Get("Content-Type"), "text/html") {
		t.Fatalf("/web/ = %d %s", entry.Status, entry.Header.Get("Content-Type"))
	}
	if entry.Header.Get("Cache-Control") != "no-cache" {
		t.Errorf("entry page Cache-Control = %q; a stale entry page would reference assets of an old build", entry.Header.Get("Cache-Control"))
	}
	for _, route := range []string{"/web/item/m01MOVIE", "/web/manage/users/x", "/web/login"} {
		if r := h.do(http.MethodGet, route, "", "Accept", "text/html,application/xhtml+xml"); r.Status != http.StatusOK || !bytes.Equal(r.Body, entry.Body) {
			t.Errorf("%s = %d, want the entry page", route, r.Status)
		}
	}

	refs := assetRef.FindAllStringSubmatch(string(entry.Body), -1)
	if len(refs) == 0 {
		t.Fatal("the entry page references no files under /web/")
	}
	for _, m := range refs {
		path := m[1]
		if path == "/web/manifest.json" {
			continue
		}
		r := h.do(http.MethodGet, path, "")
		if r.Status != http.StatusOK || strings.HasPrefix(r.Header.Get("Content-Type"), "text/html") {
			t.Errorf("%s = %d %s, want the file itself", path, r.Status, r.Header.Get("Content-Type"))
		}
		if strings.HasPrefix(path, "/web/assets/") && !strings.Contains(r.Header.Get("Cache-Control"), "immutable") {
			t.Errorf("%s Cache-Control = %q; hashed assets are immutable", path, r.Header.Get("Cache-Control"))
		}
	}
	if len(h.up.seen()) != 0 {
		t.Errorf("serving the web client reached the upstream server: %+v", h.up.seen())
	}
}

// Official Emby apps fetch web/manifest.json, web/index.html and
// web/strings/en-US.json before connecting and give up when one fails
// (connectionmanager.js, resolveIfAvailable). The handler answers the first
// two; the strings file stays the upstream server's.
func TestEmbyAppProbesStillAnswer(t *testing.T) {
	needsWebBuild(t)
	h := newHarness(t)

	m := h.do(http.MethodGet, "/emby/web/manifest.json", "")
	if m.Status != http.StatusOK {
		t.Fatalf("manifest = %d", m.Status)
	}
	if name := m.json(t)["name"]; name != "Media" {
		t.Errorf("manifest name = %v, want the upstream server's name", name)
	}
	if bytes.Contains(bytes.ToLower(m.Body), []byte("jellyfin")) {
		t.Error("the manifest mentions jellyfin; Emby apps then refuse the server")
	}

	if r := h.do(http.MethodGet, "/emby/web/index.html", ""); r.Status != http.StatusOK || !strings.HasPrefix(r.Header.Get("Content-Type"), "text/html") {
		t.Errorf("index.html = %d %s", r.Status, r.Header.Get("Content-Type"))
	}

	// Emby also answers API calls under /web/; an HTML 200 there breaks the
	// clients that parse it (SenPlayer reports lost data).
	for _, path := range []string{"/emby/web/strings/en-US.json", "/emby/web/ConfigurationPages?PageType=PluginConfiguration"} {
		h.up.reset()
		r := h.do(http.MethodGet, path, "", "Accept", "application/json")
		seen := h.up.seen()
		if len(seen) != 1 || !strings.EqualFold(seen[0].Path, strings.Split(path, "?")[0]) {
			t.Errorf("%s went to %+v, want the upstream server", path, seen)
		}
		if strings.HasPrefix(r.Header.Get("Content-Type"), "text/html") && r.Status == http.StatusOK {
			t.Errorf("%s answered with an HTML page", path)
		}
	}
}

// Precompressed files go to clients that accept brotli, with a matching
// Content-Length, and revalidation by ETag costs no body.
func TestWebAssetsNegotiateEncodingAndRevalidate(t *testing.T) {
	needsWebBuild(t)
	h := newHarness(t)
	var target string
	for name, f := range webFiles() {
		if strings.HasPrefix(name, "assets/") && strings.HasSuffix(name, ".js") && f.br != nil {
			target = "/web/" + name
			break
		}
	}
	if target == "" {
		t.Fatal("no precompressed script in the build")
	}
	plain := h.do(http.MethodGet, target, "")
	br := h.do(http.MethodGet, target, "", "Accept-Encoding", "gzip, br")
	if plain.Header.Get("Content-Encoding") != "" || br.Header.Get("Content-Encoding") != "br" {
		t.Fatalf("encodings = %q / %q", plain.Header.Get("Content-Encoding"), br.Header.Get("Content-Encoding"))
	}
	if len(br.Body) >= len(plain.Body) {
		t.Errorf("brotli body %d >= plain %d", len(br.Body), len(plain.Body))
	}
	for _, r := range []response{plain, br} {
		if n, _ := strconv.Atoi(r.Header.Get("Content-Length")); n != len(r.Body) {
			t.Errorf("Content-Length %d for a %d byte body", n, len(r.Body))
		}
	}
	if refused := h.do(http.MethodGet, target, "", "Accept-Encoding", "br;q=0, gzip"); refused.Header.Get("Content-Encoding") != "" {
		t.Error("brotli sent to a client that refused it")
	}
	again := h.do(http.MethodGet, target, "", "If-None-Match", plain.Header.Get("ETag"))
	if again.Status != http.StatusNotModified || len(again.Body) != 0 {
		t.Errorf("revalidation = %d with %d bytes", again.Status, len(again.Body))
	}
}
