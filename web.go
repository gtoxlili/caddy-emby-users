package embyusers

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"sync"

	"github.com/caddyserver/caddy/v2/modules/caddyhttp"

	"github.com/gtoxlili/caddy-emby-users/internal/jsonx"
)

// The web client (ui/) is built into ui/dist and compiled into the module, so
// xcaddy builds need no Node toolchain. It takes over /web/, where Emby keeps
// its own web app, and / redirects there as on Emby.
//
//go:embed all:ui/dist
var dist embed.FS

type webFile struct {
	body  []byte
	br    []byte // Vite's precompressed sibling, kept only when it was smaller
	etag  string
	ctype string
}

var webFiles = sync.OnceValue(func() map[string]*webFile {
	root, err := fs.Sub(dist, "ui/dist")
	if err != nil {
		panic(err)
	}
	files := map[string]*webFile{}
	fs.WalkDir(root, ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || strings.HasSuffix(name, ".br") {
			return err
		}
		body, err := fs.ReadFile(root, name)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(body)
		f := &webFile{body: body, etag: `"` + hex.EncodeToString(sum[:8]) + `"`, ctype: contentType(name)}
		if br, err := fs.ReadFile(root, name+".br"); err == nil {
			f.br = br
		}
		files[name] = f
		return nil
	})
	return files
})

func contentType(name string) string {
	switch path.Ext(name) {
	case ".html":
		return "text/html; charset=utf-8"
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".json":
		return "application/json"
	case ".svg":
		return "image/svg+xml"
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".woff2":
		return "font/woff2"
	case ".txt":
		return "text/plain; charset=utf-8"
	}
	return "application/octet-stream"
}

const (
	cacheImmutable  = "public, max-age=31536000, immutable"
	cacheDaily      = "public, max-age=86400"
	cacheRevalidate = "no-cache"
)

// webRoute answers the web client's paths. Under /web/, files of the build are
// served as they are, and a page load of any other path gets the entry page,
// which routes on the client. Everything else under /web/ is left to the
// upstream server: official Emby apps check /web/strings/en-US.json, alongside
// index.html and manifest.json, before they connect, and Emby answers API calls
// such as /web/ConfigurationPages there, which must never get an HTML 200.
func webRoute(rc *reqCtx) handlerFunc {
	if m := rc.r.Method; m != http.MethodGet && m != http.MethodHead {
		return nil
	}
	if len(rc.segs) == 0 {
		return func(_ *app, w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
			http.Redirect(w, rc.r, "/web/", http.StatusFound)
			return nil
		}
	}
	if rc.segs[0] != "web" {
		return nil
	}
	name := strings.Join(rc.raw[1:], "/")
	if strings.EqualFold(name, "manifest.json") {
		return (*app).webManifest
	}
	if f := webFiles()[name]; f != nil && name != "index.html" {
		cache := cacheDaily
		if strings.HasPrefix(name, "assets/") {
			// Vite puts a content hash in every file name under assets/.
			cache = cacheImmutable
		}
		return func(_ *app, w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
			return serveWebFile(w, rc.r, f, cache)
		}
	}
	if name == "" || strings.EqualFold(name, "index.html") || (path.Ext(name) == "" && pageLoad(rc.r)) {
		return func(_ *app, w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
			return serveWebFile(w, rc.r, webFiles()["index.html"], cacheRevalidate)
		}
	}
	return nil
}

// pageLoad tells a browser opening a page from a script or app fetching data.
func pageLoad(r *http.Request) bool {
	if dest := r.Header.Get("Sec-Fetch-Dest"); dest != "" {
		return dest == "document"
	}
	return strings.Contains(r.Header.Get("Accept"), "text/html")
}

func serveWebFile(w http.ResponseWriter, r *http.Request, f *webFile, cache string) error {
	h := w.Header()
	h.Set("Cache-Control", cache)
	h.Set("ETag", f.etag)
	h.Set("Vary", "Accept-Encoding")
	h.Set("X-Content-Type-Options", "nosniff")
	if etagMatches(r.Header.Get("If-None-Match"), f.etag) {
		w.WriteHeader(http.StatusNotModified)
		return nil
	}
	h.Set("Content-Type", f.ctype)
	body := f.body
	if f.br != nil && acceptsBrotli(r.Header.Get("Accept-Encoding")) {
		body = f.br
		h.Set("Content-Encoding", "br")
	}
	return writeBody(w, r, http.StatusOK, body)
}

func acceptsBrotli(header string) bool {
	for _, part := range strings.Split(header, ",") {
		enc, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if strings.EqualFold(strings.TrimSpace(enc), "br") {
			return strings.ReplaceAll(strings.TrimSpace(params), " ", "") != "q=0"
		}
	}
	return false
}

func etagMatches(header, etag string) bool {
	for _, t := range strings.Split(header, ",") {
		t = strings.TrimSpace(t)
		if t == "*" || strings.TrimPrefix(t, "W/") == etag {
			return true
		}
	}
	return false
}

// webManifest names the installed app after the upstream server, as the
// sign-in page does.
func (a *app) webManifest(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	name := "Emby"
	if raw, err := a.serverInfo(rc.ctx(), "/System/Info/Public"); err == nil {
		if v, err := jsonx.Decode(raw); err == nil {
			if o, ok := v.(*jsonx.Object); ok && o.String("ServerName") != "" {
				name = o.String("ServerName")
			}
		}
	}
	icon := func(src, size, purpose string) *jsonx.Object {
		return obj("src", src, "sizes", size, "type", "image/png", "purpose", purpose)
	}
	body, err := jsonx.Encode(obj(
		"id", "/web/",
		"name", name,
		"short_name", name,
		"start_url", "/web/",
		"scope", "/web/",
		"display", "standalone",
		"background_color", "#060608",
		"theme_color", "#060608",
		"categories", []any{"entertainment"},
		// The icon keeps its subject inside the maskable safe zone and its dark
		// background reaches every edge, so one image serves both purposes.
		"icons", []any{
			icon("/web/icon-192.png", "192x192", "any"),
			icon("/web/icon-512.png", "512x512", "any"),
			icon("/web/icon-512.png", "512x512", "maskable"),
		},
	))
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/manifest+json")
	w.Header().Set("Cache-Control", cacheRevalidate)
	return writeBody(w, rc.r, http.StatusOK, body)
}

// serverInfo is one of the upstream server's /System/Info documents, cached
// briefly.
func (a *app) serverInfo(ctx context.Context, path string) ([]byte, error) {
	if raw, ok := a.up.info.get(path); ok {
		return raw, nil
	}
	raw, err := a.up.get(ctx, path, nil)
	if err != nil {
		return nil, err
	}
	a.up.info.set(path, raw)
	return raw, nil
}
