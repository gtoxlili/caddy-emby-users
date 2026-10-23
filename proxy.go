package embyusers

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"go.uber.org/zap"

	"github.com/gtoxlili/caddy-emby-users/internal/jsonx"
)

// maxRewrite caps the size of a response the plugin buffers to rewrite.
const maxRewrite = 128 << 20

// after post-processes a decoded upstream response before it is re-encoded.
type after func(ctx context.Context, rc *reqCtx, doc any) (any, error)

// proxy hands the request to the next handler (the reverse proxy to the
// upstream server) with the caller's credentials replaced by the upstream
// account's, then rewrites what comes back for the caller.
func (a *app) proxy(w http.ResponseWriter, rc *reqCtx, next caddyhttp.Handler, post after) error {
	r := rc.r
	var body []byte
	if r.Body != nil && r.Body != http.NoBody {
		body = readBody(r)
	}
	saved := w.Header().Clone()
	for attempt := 0; attempt < 2; attempt++ {
		tok, uid, _ := a.up.credentials()
		if tok == "" {
			if err := a.up.ensure(r.Context()); err != nil {
				a.log.Error("upstream sign-in", zap.Error(err))
				return writeText(w, http.StatusBadGateway, "Upstream sign-in failed.")
			}
			tok, uid, _ = a.up.credentials()
		}
		out := r.Clone(r.Context())
		if body != nil {
			rewritten := swapBodyIdentity(body, uid, a.up.config().id.DeviceID)
			out.Body = io.NopCloser(bytes.NewReader(rewritten))
			out.ContentLength = int64(len(rewritten))
		}
		swapCredentials(out, tok, uid)
		a.up.disguise(out, tok)
		// Not every Emby-compatible server reads the token from every place
		// clients put it; all of them read this header.
		out.Header.Set("X-Emby-Token", tok)
		// Responses the plugin rewrites must arrive uncompressed and must not
		// be answered from a validator another user's request produced.
		out.Header.Set("Accept-Encoding", "identity")
		if !isMedia(rc.segs) {
			out.Header.Del("If-None-Match")
			out.Header.Del("If-Modified-Since")
		}
		cw := &capture{w: w, rc: rc, upToken: tok}
		err := next.ServeHTTP(cw, out)
		if cw.rejected {
			for k := range w.Header() {
				delete(w.Header(), k)
			}
			for k, v := range saved {
				w.Header()[k] = v
			}
			if attempt == 0 {
				// A 401 for something the account may not do (an admin page,
				// say) is not a dead token. Signing in again for each one would
				// churn the upstream session.
				if a.up.tokenValid(r.Context(), tok) {
					return writeText(w, http.StatusForbidden, textForbidden)
				}
				if lerr := a.up.relogin(r.Context(), tok); lerr != nil {
					a.log.Error("upstream sign-in", zap.Error(lerr))
					break
				}
				continue
			}
			break
		}
		if cw.buffering {
			if err != nil {
				return err
			}
			return a.finish(w, rc, cw, post)
		}
		return err
	}
	// A valid local session never answers 401: clients drop the user back to
	// the sign-in screen on it, and signing in again would not help.
	return writeText(w, http.StatusBadGateway, "Upstream rejected the configured account.")
}

// PlaybackInfo and live-stream requests may also name the user and device
// in their JSON body. Keep codec profiles and all other playback options.
func swapBodyIdentity(body []byte, userID, deviceID string) []byte {
	v, err := jsonx.Decode(body)
	if err != nil {
		return body
	}
	o, ok := v.(*jsonx.Object)
	if !ok {
		return body
	}
	changed := false
	for _, key := range o.Keys() {
		switch strings.ToLower(key) {
		case "userid":
			o.Set(key, userID)
			changed = true
		case "deviceid":
			o.Set(key, deviceID)
			changed = true
		}
	}
	if changed {
		if out, err := jsonx.Encode(o); err == nil {
			return out
		}
	}
	return body
}

func isMedia(segs []string) bool {
	if len(segs) == 0 {
		return false
	}
	switch segs[0] {
	case "videos", "audio", "play", "hls", "livestreamfiles":
		return true
	case "items":
		return len(segs) >= 3 && (segs[2] == "images" || segs[2] == "download" || segs[2] == "file")
	}
	return false
}

func rewritableType(ct string) bool {
	ct = strings.ToLower(ct)
	return strings.Contains(ct, "json") || strings.Contains(ct, "mpegurl")
}

// capture sits between the reverse proxy and the client. It buffers bodies
// the plugin rewrites, swallows an upstream 401 so the request can be
// retried, and streams everything else straight through.
type capture struct {
	w       http.ResponseWriter
	rc      *reqCtx
	upToken string

	status    int
	wrote     bool
	rejected  bool
	buffering bool
	buf       bytes.Buffer
	tooBig    bool
}

func (c *capture) Header() http.Header { return c.w.Header() }

func (c *capture) WriteHeader(code int) {
	if c.wrote {
		return
	}
	if code >= 100 && code < 200 {
		c.w.WriteHeader(code)
		return
	}
	c.wrote = true
	c.status = code
	switch {
	case code == http.StatusUnauthorized:
		c.rejected = true
	case rewritableType(c.w.Header().Get("Content-Type")):
		c.buffering = true
	default:
		for _, h := range []string{"Location", "Content-Location"} {
			if v := c.w.Header().Get(h); v != "" && c.upToken != "" {
				c.w.Header().Set(h, strings.ReplaceAll(v, c.upToken, c.rc.token))
			}
		}
		c.w.WriteHeader(code)
	}
}

func (c *capture) Write(b []byte) (int, error) {
	if !c.wrote {
		c.WriteHeader(http.StatusOK)
	}
	switch {
	case c.rejected:
		return len(b), nil
	case c.buffering:
		if c.buf.Len()+len(b) > maxRewrite {
			c.tooBig = true
			return 0, errors.New("response too large to rewrite")
		}
		return c.buf.Write(b)
	}
	return c.w.Write(b)
}

func (c *capture) Flush() {
	if c.wrote && !c.rejected && !c.buffering {
		_ = http.NewResponseController(c.w).Flush()
	}
}

func (c *capture) Unwrap() http.ResponseWriter { return c.w }

// finish rewrites a buffered upstream response for the caller.
func (a *app) finish(w http.ResponseWriter, rc *reqCtx, cw *capture, post after) error {
	h := w.Header()
	body := cw.buf.Bytes()
	if strings.EqualFold(h.Get("Content-Encoding"), "gzip") {
		zr, err := gzip.NewReader(bytes.NewReader(body))
		if err == nil {
			if plain, err := io.ReadAll(io.LimitReader(zr, maxRewrite)); err == nil {
				body = plain
				h.Del("Content-Encoding")
			}
		}
	}
	body = a.localize(rc, body)
	if cw.status == http.StatusOK && strings.Contains(strings.ToLower(h.Get("Content-Type")), "json") &&
		(post != nil || bytes.Contains(body, []byte(`"UserData"`))) {
		if doc, err := jsonx.Decode(body); err == nil {
			if err := a.overlay(rc.r.Context(), rc.owner.ID, doc); err != nil {
				return err
			}
			if post != nil {
				if doc, err = post(rc.r.Context(), rc, doc); err != nil {
					return err
				}
			}
			if out, err := jsonx.Encode(doc); err == nil {
				body = out
			}
		}
	}
	for _, k := range []string{"Content-Length", "ETag", "Last-Modified"} {
		h.Del(k)
	}
	return writeBody(w, rc.r, cw.status, body)
}

// localize swaps the upstream token and user id in a body for the caller's.
// Playback URLs carry the token as api_key; clients reuse them verbatim.
func (a *app) localize(rc *reqCtx, body []byte) []byte {
	tok, uid, _ := a.up.credentials()
	if tok != "" && rc.token != "" {
		body = bytes.ReplaceAll(body, []byte(tok), []byte(rc.token))
	}
	if uid != "" && rc.user != nil {
		body = bytes.ReplaceAll(body, []byte(uid), []byte(rc.user.ID))
	}
	return body
}

// writeJSON sends a document the plugin built itself.
func (a *app) writeJSON(w http.ResponseWriter, rc *reqCtx, status int, v any) error {
	body, err := jsonx.Encode(v)
	if err != nil {
		return err
	}
	body = a.localize(rc, body)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	return writeBody(w, rc.r, status, body)
}

func writeBody(w http.ResponseWriter, r *http.Request, status int, body []byte) error {
	h := w.Header()
	if len(body) > 1024 && h.Get("Content-Encoding") == "" && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.DefaultCompression)
		zw.Write(body)
		zw.Close()
		body = buf.Bytes()
		h.Set("Content-Encoding", "gzip")
		h.Add("Vary", "Accept-Encoding")
	}
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	if r.Method == http.MethodHead {
		return nil
	}
	_, err := w.Write(body)
	return err
}
