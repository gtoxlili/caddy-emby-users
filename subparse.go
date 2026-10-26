package embyusers

import (
	"cmp"
	"errors"
	"html"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

// Cue text keeps only <i>, <b> and <u>, which both WebVTT and the Html.fromHtml
// of Emby's Android clients render. &, < and > are escaped, line breaks are
// \n, and ASS override tags and vector drawings are dropped.

var (
	newlines   = strings.NewReplacer("\r\n", "\n", "\r", "\n")
	escapeText = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
	timingRe   = regexp.MustCompile(`^\s*(\S+)\s*-->\s*(\S+)`)
	clockRe    = regexp.MustCompile(`^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d+))?$`)
	// ASS override tags that SRT files carry too, such as {\an8}.
	overrideRe = regexp.MustCompile(`\{\\[^{}]*\}`)
	// Tags: <i>, </font>, <c.yellow>, <v name>, <br/> and WebVTT timestamps
	// such as <00:01.000>. "<3" is text.
	tagRe       = regexp.MustCompile(`<(/?)([a-zA-Z][a-zA-Z0-9]*|\d+:[\d:.]+)(?:[\s.][^<>]*)?/?>`)
	formatTagRe = regexp.MustCompile(`</?[ibu]>`)
	// From \p1 on, ASS text is vector drawing commands until \p0.
	drawingRe = regexp.MustCompile(`\\p(\d+)`)
)

// cue is one subtitle: times in ticks (100 ns), text as described above.
type cue struct {
	Start, End int64
	Text       string
}

// parseSubtitleFile reads an external subtitle file. Files with an [Events]
// section are ASS or SSA, files starting with WEBVTT are WebVTT, the rest SRT.
func parseSubtitleFile(raw []byte) ([]cue, error) {
	text := decodeText(raw)
	var cues []cue
	if strings.Contains(strings.ToLower(text), "[events]") {
		cues = parseASS(text)
	} else {
		cues = parseCues(text, strings.HasPrefix(strings.TrimSpace(text), "WEBVTT"))
	}
	if len(cues) == 0 {
		return nil, errors.New("no subtitle cues in file")
	}
	slices.SortStableFunc(cues, func(a, b cue) int { return cmp.Compare(a.Start, b.Start) })
	return cues, nil
}

// decodeText honors a UTF-8 or UTF-16 byte order mark, then takes valid UTF-8
// as is and anything else as GB18030: Chinese SRT files are often GBK, which
// GB18030 contains.
func decodeText(b []byte) string {
	var fallback transform.Transformer = unicode.UTF8.NewDecoder()
	if !utf8.Valid(b) {
		fallback = simplifiedchinese.GB18030.NewDecoder()
	}
	out, _, err := transform.Bytes(unicode.BOMOverride(fallback), b)
	if err != nil {
		return strings.ToValidUTF8(string(b), "�")
	}
	return string(out)
}

// parseCues reads SRT and WebVTT: a timing line, then text lines up to a blank
// line. The SRT counter or WebVTT identifier before the timing line is dropped,
// including a counter stuck to the previous cue when an SRT file lacks the
// blank line.
func parseCues(text string, vtt bool) []cue {
	var cues []cue
	var cur *cue
	var lines []string
	flush := func() {
		if cur != nil {
			if cur.Text = markupText(strings.Join(lines, "\n"), vtt); visible(cur.Text) {
				cues = append(cues, *cur)
			}
		}
		cur, lines = nil, nil
	}
	for _, line := range strings.Split(newlines.Replace(text), "\n") {
		if m := timingRe.FindStringSubmatch(line); m != nil {
			start, ok1 := parseClock(m[1])
			end, ok2 := parseClock(m[2])
			if ok1 && ok2 {
				if n := len(lines); n > 0 && isDigits(lines[n-1]) {
					lines = lines[:n-1]
				}
				flush()
				cur = &cue{Start: start, End: end}
				continue
			}
		}
		switch {
		case strings.TrimSpace(line) == "":
			flush()
		case cur != nil:
			lines = append(lines, line)
		}
	}
	flush()
	return cues
}

// parseASS reads the [Events] section of ASS and SSA. The Format line orders
// the fields, which differ between the two; Text is last and may hold commas.
func parseASS(text string) []cue {
	var cues []cue
	inEvents := false
	format := strings.Split("layer,start,end,style,name,marginl,marginr,marginv,effect,text", ",")
	for _, line := range strings.Split(newlines.Replace(text), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") {
			inEvents = strings.EqualFold(line, "[events]")
			continue
		}
		key, val, ok := strings.Cut(line, ":")
		if !inEvents || !ok {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "format":
			format = strings.Split(strings.ToLower(strings.ReplaceAll(val, " ", "")), ",")
		case "dialogue":
			values := strings.SplitN(val, ",", len(format))
			if len(values) != len(format) {
				continue
			}
			field := func(name string) string {
				if i := slices.Index(format, name); i >= 0 {
					return values[i]
				}
				return ""
			}
			start, ok1 := parseClock(field("start"))
			end, ok2 := parseClock(field("end"))
			if t := assText(field("text")); ok1 && ok2 && visible(t) {
				cues = append(cues, cue{Start: start, End: end, Text: t})
			}
		}
	}
	return cues
}

// parseClock reads 00:01:02,345 (SRT), 01:02.345 (WebVTT) or 0:01:02.34 (ASS)
// as ticks.
func parseClock(s string) (int64, bool) {
	m := clockRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0, false
	}
	var v [3]int64
	for i, part := range m[1:4] {
		v[i], _ = strconv.ParseInt(part, 10, 64) // hours are optional
	}
	frac, _ := strconv.ParseInt((m[4] + "0000000")[:7], 10, 64)
	return ((v[0]*60+v[1])*60+v[2])*10_000_000 + frac, true
}

// markupText cleans SRT and WebVTT text. WebVTT text arrives escaped and is
// unescaped first.
func markupText(s string, vtt bool) string {
	s = overrideRe.ReplaceAllString(newlines.Replace(s), "")
	var b strings.Builder
	plain := func(t string) {
		if vtt {
			t = html.UnescapeString(t)
		}
		b.WriteString(escapeText.Replace(t))
	}
	last := 0
	for _, m := range tagRe.FindAllStringSubmatchIndex(s, -1) {
		plain(s[last:m[0]])
		switch name := strings.ToLower(s[m[4]:m[5]]); name {
		case "i", "b", "u":
			b.WriteString("<" + s[m[2]:m[3]] + name + ">")
		case "br":
			b.WriteString("\n")
		}
		last = m[1]
	}
	plain(s[last:])
	return tidyLines(b.String())
}

// assText cleans ASS dialogue: override blocks go, \N and \n break lines, \h
// is a space, and everything between {\p1} and {\p0} is a drawing.
func assText(s string) string {
	var b strings.Builder
	drawing := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '{' {
			if end := strings.IndexByte(s[i:], '}'); end > 0 {
				for _, m := range drawingRe.FindAllStringSubmatch(s[i:i+end], -1) {
					drawing = m[1] != "0"
				}
				i += end
				continue
			}
		}
		if drawing {
			continue
		}
		if c == '\\' && i+1 < len(s) {
			switch s[i+1] {
			case 'N', 'n':
				b.WriteByte('\n')
				i++
				continue
			case 'h':
				b.WriteByte(' ')
				i++
				continue
			}
		}
		b.WriteByte(c)
	}
	return tidyLines(escapeText.Replace(b.String()))
}

func tidyLines(s string) string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			out = append(out, l)
		}
	}
	return strings.Join(out, "\n")
}

// visible reports whether s has text besides format tags.
func visible(s string) bool {
	return strings.TrimSpace(formatTagRe.ReplaceAllString(s, "")) != ""
}

func isDigits(s string) bool {
	s = strings.TrimSpace(s)
	return s != "" && strings.Trim(s, "0123456789") == ""
}
