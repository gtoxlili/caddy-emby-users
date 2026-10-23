package embyusers

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/caddyserver/caddy/v2/modules/caddyhttp"

	"github.com/gtoxlili/caddy-emby-users/internal/jsonx"
)

// splitPath turns a request path into segments: lowercase ones for routing
// and the original ones, whose item ids are case-sensitive.
// Emby registers every route under four prefixes (none, /emby,
// /mediabrowser, /emby/emby) and matches case-insensitively; some clients
// send `//emby/...` or encode the query's `?` as `%3F` in the path. The
// returned query is whatever was smuggled in after `%3F`.
func splitPath(escaped string) (segs, raw []string, smuggled string) {
	if i := strings.Index(strings.ToLower(escaped), "%3f"); i >= 0 {
		escaped, smuggled = escaped[:i], escaped[i+3:]
	}
	for _, s := range strings.Split(escaped, "/") {
		if s == "" {
			continue
		}
		if u, err := url.PathUnescape(s); err == nil {
			s = u
		}
		raw = append(raw, s)
		segs = append(segs, strings.ToLower(s))
	}
	for len(segs) > 0 && (segs[0] == "emby" || segs[0] == "mediabrowser") {
		segs, raw = segs[1:], raw[1:]
	}
	return segs, raw, smuggled
}

// match reports whether segs equals pattern, where "*" matches any one
// segment.
func match(segs []string, pattern string) bool {
	parts := strings.Split(pattern, "/")
	if len(parts) != len(segs) {
		return false
	}
	for i, p := range parts {
		if p != "*" && p != segs[i] {
			return false
		}
	}
	return true
}

// queryGet returns the first non-empty value of key, ignoring key case.
func queryGet(q url.Values, key string) string {
	for k, vs := range q {
		if strings.EqualFold(k, key) {
			for _, v := range vs {
				if v != "" {
					return v
				}
			}
		}
	}
	return ""
}

// queryList splits a comma-separated parameter, lowercased.
func queryList(q url.Values, key string) []string {
	var out []string
	for _, p := range strings.Split(queryGet(q, key), ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, strings.ToLower(p))
		}
	}
	return out
}

// queryBool reads a boolean parameter; ok is false when it is absent.
func queryBool(q url.Values, key string) (value, ok bool) {
	switch strings.ToLower(queryGet(q, key)) {
	case "true", "1":
		return true, true
	case "false", "0":
		return false, true
	}
	return false, false
}

// editQuery rewrites a raw query string in place. fn sees each decoded key
// and value and returns the replacement value, or keep=false to drop the
// pair. Pairs it leaves alone keep their exact original encoding.
func editQuery(raw string, fn func(key, value string) (string, bool, bool)) string {
	if raw == "" {
		return raw
	}
	parts := strings.Split(raw, "&")
	out := parts[:0]
	for _, p := range parts {
		k, v, _ := strings.Cut(p, "=")
		dk, err1 := url.QueryUnescape(k)
		dv, err2 := url.QueryUnescape(v)
		if err1 != nil || err2 != nil {
			out = append(out, p)
			continue
		}
		nv, changed, keep := fn(dk, dv)
		switch {
		case !keep:
		case changed:
			out = append(out, k+"="+url.QueryEscape(nv))
		default:
			out = append(out, p)
		}
	}
	return strings.Join(out, "&")
}

// tokenQueryKeys are the query parameters that carry an access token. Official
// Emby apps send the token only here, never in a header.
var tokenQueryKeys = []string{"api_key", "x-emby-token", "apikey"}

func isTokenKey(k string) bool {
	for _, t := range tokenQueryKeys {
		if strings.EqualFold(k, t) {
			return true
		}
	}
	return false
}

// client is what a request says about its caller.
type client struct {
	Token    string
	Name     string
	Device   string
	DeviceID string
	Version  string
}

var authField = regexp.MustCompile(`(?i)([a-z]+)\s*=\s*("[^"]*"|[^,]*)`)

// authFields parses `Emby UserId="", Client="x", Device="y", DeviceId="z",
// Version="1", Token="t"`. The prefix may be Emby or MediaBrowser, quotes are
// optional, and values may be URL-encoded (browsers cannot send non-ASCII
// header values).
func authFields(h http.Header) map[string]string {
	raw := h.Get("X-Emby-Authorization")
	if raw == "" {
		raw = h.Get("Authorization")
		lower := strings.ToLower(raw)
		if !strings.HasPrefix(lower, "emby ") && !strings.HasPrefix(lower, "mediabrowser ") {
			return nil
		}
	}
	out := map[string]string{}
	for _, m := range authField.FindAllStringSubmatch(raw, -1) {
		v := strings.Trim(strings.TrimSpace(m[2]), `"`)
		if u, err := url.QueryUnescape(v); err == nil {
			v = u
		}
		out[strings.ToLower(m[1])] = v
	}
	return out
}

func readClient(r *http.Request, q url.Values) client {
	fields := authFields(r.Header)
	pick := func(field, header, query string) string {
		if v := fields[field]; v != "" {
			return v
		}
		if header != "" {
			if v := r.Header.Get(header); v != "" {
				return v
			}
		}
		return queryGet(q, query)
	}
	c := client{
		Name:     pick("client", "X-Emby-Client", "X-Emby-Client"),
		Device:   pick("device", "X-Emby-Device-Name", "X-Emby-Device-Name"),
		DeviceID: pick("deviceid", "X-Emby-Device-Id", "X-Emby-Device-Id"),
		Version:  pick("version", "X-Emby-Client-Version", "X-Emby-Client-Version"),
	}
	if c.DeviceID == "" {
		c.DeviceID = queryGet(q, "DeviceId")
	}
	switch {
	case r.Header.Get("X-Emby-Token") != "":
		c.Token = r.Header.Get("X-Emby-Token")
	case r.Header.Get("X-MediaBrowser-Token") != "":
		c.Token = r.Header.Get("X-MediaBrowser-Token")
	case fields["token"] != "":
		c.Token = fields["token"]
	default:
		for _, k := range tokenQueryKeys {
			if v := queryGet(q, k); v != "" {
				c.Token = v
				break
			}
		}
	}
	if c.Name == "" {
		c.Name = "Unknown"
	}
	if c.Device == "" {
		c.Device = "Unknown"
	}
	return c
}

// swapCredentials replaces the access token everywhere the request carries
// one, and points path and query user ids at the upstream account.
func swapCredentials(r *http.Request, token, upstreamUser string) {
	for _, h := range []string{"X-Emby-Token", "X-MediaBrowser-Token"} {
		if r.Header.Get(h) != "" {
			r.Header.Set(h, token)
		}
	}
	for _, h := range []string{"X-Emby-Authorization", "Authorization"} {
		v := r.Header.Get(h)
		if v == "" || !strings.Contains(strings.ToLower(v), "token") {
			continue
		}
		r.Header.Set(h, authField.ReplaceAllStringFunc(v, func(m string) string {
			k, _, _ := strings.Cut(m, "=")
			if strings.EqualFold(strings.TrimSpace(k), "token") {
				return `Token="` + token + `"`
			}
			return m
		}))
	}
	r.URL.RawQuery = editQuery(r.URL.RawQuery, func(k, v string) (string, bool, bool) {
		switch {
		case isTokenKey(k) && v != "":
			return token, true, true
		case strings.EqualFold(k, "userid") && v != "":
			return upstreamUser, true, true
		}
		return v, false, true
	})
	if upstreamUser == "" {
		return
	}
	parts := strings.Split(r.URL.EscapedPath(), "/")
	changed := false
	for i := 0; i+1 < len(parts); i++ {
		if strings.EqualFold(parts[i], "users") && isLocalID(parts[i+1]) {
			parts[i+1] = upstreamUser
			changed = true
		}
	}
	if changed {
		p := strings.Join(parts, "/")
		r.URL.RawPath = p
		if u, err := url.PathUnescape(p); err == nil {
			r.URL.Path = u
		}
	}
}

// isLocalID reports whether s has the shape of the ids this plugin issues.
func isLocalID(s string) bool {
	if len(s) != 32 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

// clientIP is the address Caddy resolved for the caller, which honours the
// server's trusted_proxies setting.
func clientIP(r *http.Request) string {
	if v, ok := caddyhttp.GetVar(r.Context(), caddyhttp.ClientIPVarKey).(string); ok && v != "" {
		return v
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// externalBase is the URL clients use to reach this server.
func externalBase(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

// embyDate formats Unix milliseconds the way Emby does.
func embyDate(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.0000000Z")
}

// parseDate reads the date formats Emby servers emit.
func parseDate(s string) int64 {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.0000000Z", "2006-01-02T15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UnixMilli()
		}
	}
	return 0
}

// Error bodies are plain text. Clients act on the status code, and the 401
// text is real Emby's: some clients return to the sign-in screen on it.
const (
	textUnauthorized = "Access token is invalid or expired."
	textForbidden    = "Forbidden"
	textNotFound     = "Not Found"
)

func writeText(w http.ResponseWriter, status int, text string) error {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Del("Content-Length")
	w.WriteHeader(status)
	_, err := w.Write([]byte(text))
	return err
}

func noContent(w http.ResponseWriter) error {
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// maxBody caps request bodies the plugin reads itself. Emby API bodies are
// small JSON documents; media uploads never reach these handlers.
const maxBody = 1 << 20

// readBody reads at most maxBody bytes of the request body.
func readBody(r *http.Request) []byte {
	if r.Body == nil {
		return nil
	}
	b, _ := io.ReadAll(io.LimitReader(r.Body, maxBody))
	return b
}

// fields decodes a JSON or form body into a map with lowercase keys. Emby
// clients send the same fields as JSON, as forms, and in lowercase.
func fields(contentType string, raw []byte) map[string]any {
	out := map[string]any{}
	if strings.Contains(strings.ToLower(contentType), "form") {
		vals, _ := url.ParseQuery(string(raw))
		for k, vs := range vals {
			if len(vs) > 0 {
				out[strings.ToLower(k)] = vs[0]
			}
		}
		return out
	}
	var m map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if dec.Decode(&m) == nil {
		for k, v := range m {
			out[strings.ToLower(k)] = v
		}
	}
	return out
}

func bodyString(b map[string]any, key string) string {
	switch v := b[strings.ToLower(key)].(type) {
	case string:
		return v
	case json.Number:
		return v.String()
	}
	return ""
}

func bodyBool(b map[string]any, key string) (value, ok bool) {
	switch v := b[strings.ToLower(key)].(type) {
	case bool:
		return v, true
	case string:
		switch strings.ToLower(v) {
		case "true":
			return true, true
		case "false":
			return false, true
		}
	}
	return false, false
}

func bodyInt(b map[string]any, key string) (int64, bool) {
	switch v := b[strings.ToLower(key)].(type) {
	case json.Number:
		if i, err := v.Int64(); err == nil {
			return i, true
		}
		if f, err := v.Float64(); err == nil {
			return int64(f), true
		}
	case string:
		n := json.Number(v)
		if i, err := n.Int64(); err == nil {
			return i, true
		}
	}
	return 0, false
}

// obj builds an ordered object from alternating keys and values.
func obj(kv ...any) *jsonx.Object {
	o := jsonx.NewObject()
	for i := 0; i+1 < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
	return o
}
