package embyusers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
)

// Emby converts an external text subtitle into the format the client names:
// Stream.json (Emby's TrackEvents), Stream.srt or Stream.vtt. The upstream
// observed in 2026-10 answers every format with a redirect to the original
// file instead, so a client asking for JSON or WebVTT receives SRT or ASS it
// cannot read. When the upstream redirects to the file, the plugin fetches
// and converts it; when it answers itself, or the file is not text cues, the
// client gets the upstream's answer.

const maxSubtitleFile = 32 << 20

var subtitleTypes = map[string]string{
	"json": "application/json; charset=utf-8",
	"srt":  "application/x-subrip; charset=utf-8",
	"vtt":  "text/vtt; charset=utf-8",
}

// isSubtitleStream matches
// /Videos|Items/{Id}/{MediaSourceId}/Subtitles/{Index}[/{StartPositionTicks}]/Stream.{Format}.
func isSubtitleStream(s []string) bool {
	return (len(s) == 6 || len(s) == 7) && (s[0] == "videos" || s[0] == "items") && s[3] == "subtitles" &&
		strings.HasPrefix(s[len(s)-1], "stream.")
}

func (a *app) subtitleStream(w http.ResponseWriter, rc *reqCtx, next caddyhttp.Handler) error {
	format := strings.TrimPrefix(rc.segs[len(rc.segs)-1], "stream.")
	ctype, ok := subtitleTypes[format]
	if !ok {
		return a.proxy(w, rc, next, nil)
	}
	file, err := a.up.subtitleFile(rc.ctx(), rc)
	if err != nil {
		return a.proxy(w, rc, next, nil)
	}
	cues, err := parseSubtitleFile(file)
	if err != nil {
		return a.proxy(w, rc, next, nil)
	}
	var start int64
	if len(rc.segs) == 7 {
		start, _ = strconv.ParseInt(rc.segs[5], 10, 64)
	}
	end, _ := strconv.ParseInt(queryGet(rc.q, "EndPositionTicks"), 10, 64)
	copyTimes, _ := queryBool(rc.q, "CopyTimestamps")
	w.Header().Set("Content-Type", ctype)
	return writeBody(w, rc.r, http.StatusOK, renderCues(clipCues(cues, start, end, copyTimes), format))
}

var errNoFile = errors.New("upstream serves this subtitle itself")

// subtitleFile fetches the original file a subtitle stream request redirects
// to. Requests keep to the upstream origin (disguise pins it), so a redirect
// elsewhere finds nothing there and the client gets the redirect instead.
func (u *upstream) subtitleFile(ctx context.Context, rc *reqCtx) ([]byte, error) {
	target := u.url("/"+strings.Join(rc.raw, "/"), nil)
	ref, _ := url.Parse(target)
	canonicalize(ref)
	q := url.Values{}
	for k, vs := range rc.q {
		if !isTokenKey(k) {
			q[k] = vs
		}
	}
	ref.RawQuery = q.Encode()
	resp, err := u.send(ctx, http.MethodGet, ref.String(), nil)
	if err != nil {
		return nil, err
	}
	redirected := false
	for hops := 0; resp.StatusCode/100 == 3; hops++ {
		loc, from := resp.Header.Get("Location"), resp.Request.URL
		resp.Body.Close()
		if loc == "" || hops == 3 {
			return nil, errNoFile
		}
		next, err := from.Parse(loc)
		if err != nil {
			return nil, err
		}
		if resp, err = u.send(ctx, http.MethodGet, next.String(), nil); err != nil {
			return nil, err
		}
		redirected = true
	}
	defer resp.Body.Close()
	if !redirected || resp.StatusCode != http.StatusOK {
		return nil, errNoFile
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxSubtitleFile+1))
	if err == nil && len(body) > maxSubtitleFile {
		err = errors.New("subtitle file too large")
	}
	return body, err
}

// clipCues keeps the cues starting within [start, end] and, unless the
// client asked to copy timestamps, shifts them to start at zero, as Emby does.
func clipCues(cues []cue, start, end int64, copyTimes bool) []cue {
	if start == 0 && end <= 0 {
		return cues
	}
	var out []cue
	for _, c := range cues {
		if c.Start < start || (end > 0 && c.Start > end) {
			continue
		}
		if !copyTimes {
			c.Start -= start
			c.End -= start
		}
		out = append(out, c)
	}
	return out
}

var unescapeText = strings.NewReplacer("&lt;", "<", "&gt;", ">", "&amp;", "&")

// renderCues writes cues as Emby's SubtitleTrackInfo (ids from 1), SRT or
// WebVTT. The Android clients show JSON text through Html.fromHtml, where \n
// is a space, so JSON breaks lines with <br>. SRT has no escapes.
func renderCues(cues []cue, format string) []byte {
	var b bytes.Buffer
	switch format {
	case "json":
		type trackEvent struct {
			Id                                   string
			Text                                 string
			StartPositionTicks, EndPositionTicks int64
		}
		out := struct{ TrackEvents []trackEvent }{TrackEvents: []trackEvent{}}
		for i, c := range cues {
			out.TrackEvents = append(out.TrackEvents, trackEvent{strconv.Itoa(i + 1), strings.ReplaceAll(c.Text, "\n", "<br>"), c.Start, c.End})
		}
		enc := json.NewEncoder(&b)
		enc.SetEscapeHTML(false)
		enc.Encode(out)
	case "srt":
		for i, c := range cues {
			fmt.Fprintf(&b, "%d\n%s --> %s\n%s\n\n", i+1, clock(c.Start, ','), clock(c.End, ','), unescapeText.Replace(c.Text))
		}
	case "vtt":
		b.WriteString("WEBVTT\n\n")
		for i, c := range cues {
			fmt.Fprintf(&b, "%d\n%s --> %s\n%s\n\n", i+1, clock(c.Start, '.'), clock(c.End, '.'), c.Text)
		}
	}
	return b.Bytes()
}

// clock writes ticks as 01:02:03,456 (SRT) or 01:02:03.456 (WebVTT).
func clock(ticks int64, sep byte) string {
	ms := max(ticks, 0) / 10_000
	return fmt.Sprintf("%02d:%02d:%02d%c%03d", ms/3_600_000, ms/60_000%60, ms/1000%60, sep, ms%1000)
}
