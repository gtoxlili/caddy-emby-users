package embyusers

import (
	_ "embed"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

// Emby matches API paths case-insensitively, and some clients send them
// lowercased (Emby for Android TV asks for /emby/system/info/public). A proxy
// in front of the upstream may accept only the official spelling, so every
// forwarded path is respelled along the API's own templates. Parameters keep
// their exact text; paths that match no template are left alone.

//go:embed routes.txt
var routesTxt string

var apiRoutes = compileRoutes(routesTxt)

type routeTable map[string][]*route // first segment, lowercased → templates, most literal text first

type route struct {
	re       *regexp.Regexp // case-insensitive, one group per parameter
	pieces   []string       // literal text in official spelling; "" stands for a parameter
	literals int
}

var templateParam = regexp.MustCompile(`\{[^}]+\}`)

func compileRoutes(txt string) routeTable {
	t := routeTable{}
	for _, line := range strings.Split(txt, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		r := &route{}
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

// spell returns p, an escaped API path without prefix, in official spelling.
func (t routeTable) spell(p string) (string, bool) {
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
		return b.String(), true
	}
	return "", false
}

// canonicalize respells u's path as /emby plus the official template
// spelling, whatever prefix the client used.
func canonicalize(u *url.URL) {
	segs := strings.FieldsFunc(u.EscapedPath(), func(r rune) bool { return r == '/' })
	for len(segs) > 0 && (strings.EqualFold(segs[0], "emby") || strings.EqualFold(segs[0], "mediabrowser")) {
		segs = segs[1:]
	}
	spelled, ok := apiRoutes.spell("/" + strings.Join(segs, "/"))
	if !ok {
		return
	}
	escaped := "/emby" + spelled
	p, err := url.PathUnescape(escaped)
	if err != nil {
		return
	}
	u.Path, u.RawPath = p, escaped
}
