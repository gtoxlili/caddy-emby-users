package embyusers

import (
	_ "embed"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

// Emby matches API paths and query parameter names case-insensitively, and
// some clients send them lowercased (Emby for Android TV asks for
// /emby/system/info/public and plays a series with recursive=true). A proxy in
// front of the upstream may accept only the official spelling: it answers 404
// for a misspelled path and ignores a misspelled query parameter, so playing a
// series gets its seasons instead of its episodes. Every forwarded path is
// respelled along the API's own templates, and the query parameters a template
// documents along with it. Path parameters and query values keep their exact
// text; paths that match no template and parameters a template does not
// document are left alone.

//go:embed routes.txt
var routesTxt string

var apiRoutes = compileRoutes(routesTxt)

type routeTable map[string][]*route // first segment, lowercased → templates, most literal text first

type route struct {
	re       *regexp.Regexp // case-insensitive, one group per parameter
	pieces   []string       // literal text in official spelling; "" stands for a parameter
	literals int
	query    map[string]string // query parameter names, lowercased → official spelling
}

var templateParam = regexp.MustCompile(`\{[^}]+\}`)

func compileRoutes(txt string) routeTable {
	t := routeTable{}
	for _, line := range strings.Split(txt, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || strings.HasPrefix(fields[0], "#") {
			continue
		}
		line = fields[0]
		r := &route{query: map[string]string{}}
		for _, name := range fields[1:] {
			r.query[strings.ToLower(name)] = name
		}
		var pat strings.Builder
		pat.WriteString(`(?i)^`)
		literal := func(s string) {
			if s != "" {
				r.pieces = append(r.pieces, s)
				r.literals += len(s)
				pat.WriteString(regexp.QuoteMeta(s))
			}
		}
		last := 0
		for _, m := range templateParam.FindAllStringIndex(line, -1) {
			literal(line[last:m[0]])
			r.pieces = append(r.pieces, "")
			pat.WriteString(`([^/]+?)`)
			last = m[1]
		}
		literal(line[last:])
		pat.WriteString(`$`)
		r.re = regexp.MustCompile(pat.String())
		first := firstSegment(line)
		t[first] = append(t[first], r)
	}
	for _, rs := range t {
		sort.SliceStable(rs, func(i, j int) bool { return rs[i].literals > rs[j].literals })
	}
	return t
}

func firstSegment(p string) string {
	p = strings.TrimPrefix(p, "/")
	if i := strings.IndexByte(p, '/'); i >= 0 {
		p = p[:i]
	}
	return strings.ToLower(p)
}

// spell returns p, an escaped API path without prefix, in official spelling,
// and the template it matched.
func (t routeTable) spell(p string) (string, *route) {
	for _, r := range t[firstSegment(p)] {
		sub := r.re.FindStringSubmatch(p)
		if sub == nil {
			continue
		}
		var b strings.Builder
		g := 1
		for _, piece := range r.pieces {
			if piece == "" {
				piece = sub[g]
				g++
			}
			b.WriteString(piece)
		}
		return b.String(), r
	}
	return "", nil
}

// spellQuery respells the names in raw, an encoded query string, that r
// documents. Values and every other pair keep their exact encoding.
func (r *route) spellQuery(raw string) string {
	if raw == "" {
		return raw
	}
	parts := strings.Split(raw, "&")
	for i, p := range parts {
		k, v, hasValue := strings.Cut(p, "=")
		dk, err := url.QueryUnescape(k)
		if err != nil {
			continue
		}
		if name, ok := r.query[strings.ToLower(dk)]; ok && name != dk {
			parts[i] = url.QueryEscape(name)
			if hasValue {
				parts[i] += "=" + v
			}
		}
	}
	return strings.Join(parts, "&")
}

// canonicalize respells u's path as /emby plus the official template
// spelling, whatever prefix the client used, and the query parameter names
// the template documents.
func canonicalize(u *url.URL) {
	segs := strings.FieldsFunc(u.EscapedPath(), func(r rune) bool { return r == '/' })
	for len(segs) > 0 && (strings.EqualFold(segs[0], "emby") || strings.EqualFold(segs[0], "mediabrowser")) {
		segs = segs[1:]
	}
	spelled, r := apiRoutes.spell("/" + strings.Join(segs, "/"))
	if r == nil {
		return
	}
	escaped := "/emby" + spelled
	p, err := url.PathUnescape(escaped)
	if err != nil {
		return
	}
	u.Path, u.RawPath = p, escaped
	u.RawQuery = r.spellQuery(u.RawQuery)
}
