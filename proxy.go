package embyusers

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"github.com/gtoxlili/caddy-emby-users/internal/jsonx"
)

// Rewritten API responses are bounded; media bodies remain streamed by Caddy.
const maxRewrite = 16 << 20

type after func(ctx context.Context, rc *reqCtx, doc any) (any, error)
type forwardKey struct{}
type forwardCall struct {
	a    *app
	rc   *reqCtx
	post after
}

func (a *app) proxy(w http.ResponseWriter, rc *reqCtx, next caddyhttp.Handler, post after) error {
	if err := a.up.ensure(rc.ctx()); err != nil {
		return writeText(w, http.StatusBadGateway, "Upstream sign-in failed.")
	}
	out := rc.r.Clone(rc.ctx())
	if out.Body != nil && out.Body != http.NoBody {
		body, err := io.ReadAll(io.LimitReader(out.Body, maxBody+1))
		out.Body.Close()
		if err != nil {
			return writeText(w, http.StatusBadRequest, "Cannot read request body.")
		}
		if len(body) > maxBody {
			return writeText(w, http.StatusRequestEntityTooLarge, "Request body too large.")
		}
		out.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(body)), nil }
		out.Body, _ = out.GetBody()
		out.ContentLength = int64(len(body))
	}
	call := &forwardCall{a: a, rc: rc, post: post}
	out = out.WithContext(context.WithValue(out.Context(), forwardKey{}, call))
	return next.ServeHTTP(w, out)
}

// upstreamTransport transforms HTTP messages before Caddy writes any headers.
// Caddy retains ownership of streaming, Range, cancellation and connection I/O.
type upstreamTransport struct{ base http.RoundTripper }

func (t *upstreamTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	call, ok := r.Context().Value(forwardKey{}).(*forwardCall)
	if !ok {
		return nil, errors.New("emby_users: missing upstream request context")
	}
	a, rc := call.a, call.rc
	if r.Body != nil {
		defer r.Body.Close()
	}
	for attempt := 0; ; attempt++ {
		tok, uid := "", ""
		if rc.user != nil {
			tok, uid, _ = a.up.credentials()
		}
		out := r.Clone(r.Context())
		canonicalize(out.URL)
		if r.GetBody != nil {
			body, err := r.GetBody()
			if err != nil {
				return nil, err
			}
			raw, err := io.ReadAll(body)
			body.Close()
			if err != nil {
				return nil, err
			}
			raw = swapBodyIdentity(raw, uid, a.up.cfg.id.DeviceID)
			out.Body = io.NopCloser(bytes.NewReader(raw))
			out.ContentLength = int64(len(raw))
		}
		if rc.user != nil {
			swapCredentials(out, tok, uid)
			out.Header.Set("X-Emby-Token", tok)
			out.Header.Set("Accept-Encoding", "identity")
			if !isMedia(rc.segs) {
				out.Header.Del("If-None-Match")
				out.Header.Del("If-Modified-Since")
			}
		}
		a.up.disguise(out, tok)
		resp, err := t.base.RoundTrip(out)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode == http.StatusUnauthorized && rc.user != nil {
			resp.Body.Close()
			if attempt == 0 {
				if a.up.tokenValid(r.Context(), tok) {
					return textResponse(out, http.StatusForbidden, textForbidden), nil
				}
				if err := a.up.relogin(r.Context(), tok); err == nil {
					continue
				}
			}
			return textResponse(out, http.StatusBadGateway, "Upstream rejected the configured account."), nil
		}
		if (out.Method == http.MethodGet || out.Method == http.MethodHead) && rc.user != nil &&
			(resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusMethodNotAllowed) {
			if body := refusedRead(rc); body != nil {
				resp.Body.Close()
				return jsonResponse(out, body), nil
			}
		}
		if err := call.rewrite(resp, tok, uid); err != nil {
			resp.Body.Close()
			return nil, err
		}
		return resp, nil
	}
}

func textResponse(r *http.Request, code int, message string) *http.Response {
	return &http.Response{
		StatusCode: code, Status: fmt.Sprintf("%d %s", code, http.StatusText(code)),
		Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1, Request: r,
		Header: http.Header{"Content-Type": {"text/plain; charset=utf-8"}},
		Body:   io.NopCloser(strings.NewReader(message)), ContentLength: int64(len(message)),
	}
}

func (c *forwardCall) localize(body []byte, token, userID string) []byte {
	if token != "" && c.rc.token != "" {
		body = bytes.ReplaceAll(body, []byte(token), []byte(c.rc.token))
	}
	if userID != "" && c.rc.user != nil {
		body = bytes.ReplaceAll(body, []byte(userID), []byte(c.rc.user.ID))
	}
	origin := c.a.up.cfg.base.Scheme + "://" + c.a.up.cfg.base.Host
	return bytes.ReplaceAll(body, []byte(origin), []byte(externalBase(c.rc.r)))
}

func (c *forwardCall) rewrite(resp *http.Response, token, userID string) error {
	for _, key := range []string{"Location", "Content-Location"} {
		if value := resp.Header.Get(key); value != "" {
			resp.Header.Set(key, string(c.localize([]byte(value), token, userID)))
		}
	}
	if resp.StatusCode/100 == 3 && resp.Header.Get("Location") != "" {
		// The body of a redirect repeats its target, upstream origin and token
		// included (an HTML "Found" link). Clients follow the header alone.
		resp.Body.Close()
		resp.Body, resp.ContentLength = http.NoBody, 0
		resp.Header.Set("Content-Length", "0")
		resp.Header.Del("Content-Type")
		return nil
	}
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	if c.rc.user == nil || c.rc.r.Method == http.MethodHead ||
		(!strings.Contains(ct, "json") && !strings.Contains(ct, "mpegurl")) {
		return nil
	}
	defer resp.Body.Close()
	var reader io.Reader = resp.Body
	switch strings.ToLower(resp.Header.Get("Content-Encoding")) {
	case "", "identity":
	case "gzip":
		zr, err := gzip.NewReader(resp.Body)
		if err != nil {
			return err
		}
		defer zr.Close()
		reader = zr
	default:
		return errors.New("emby_users: unsupported upstream response encoding")
	}
	body, err := io.ReadAll(io.LimitReader(reader, maxRewrite+1))
	if err != nil {
		return err
	}
	if len(body) > maxRewrite {
		return errors.New("emby_users: response too large to rewrite")
	}
	body = c.localize(body, token, userID)
	if resp.StatusCode == http.StatusOK && strings.Contains(ct, "json") {
		doc, err := jsonx.Decode(body)
		if err != nil {
			return fmt.Errorf("emby_users: invalid upstream JSON: %w", err)
		}
		if err := c.a.overlay(c.rc.ctx(), c.rc.owner.ID, doc); err != nil {
			return err
		}
		fillMediaTitles(doc)
		if c.post != nil {
			doc, err = c.post(c.rc.ctx(), c.rc, doc)
			if err != nil {
				return err
			}
		}
		body, err = jsonx.Encode(doc)
		if err != nil {
			return err
		}
	}
	for _, key := range []string{"Content-Encoding", "ETag", "Last-Modified", "Content-MD5", "Digest"} {
		resp.Header.Del(key)
	}
	resp.Header.Set("Content-Length", strconv.Itoa(len(body)))
	resp.ContentLength = int64(len(body))
	resp.TransferEncoding = nil
	resp.Body = io.NopCloser(bytes.NewReader(body))
	return nil
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

// localize swaps the upstream token and user id in a body for the caller's.
// Playback URLs carry the token as api_key; clients reuse them verbatim.
func (a *app) localize(rc *reqCtx, body []byte) []byte {
	token, userID, _ := a.up.credentials()
	return (&forwardCall{a: a, rc: rc}).localize(body, token, userID)
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
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	if r.Method == http.MethodHead {
		return nil
	}
	_, err := w.Write(body)
	return err
}
