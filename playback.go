package embyusers

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/caddyserver/caddy/v2/modules/caddyhttp"

	"github.com/gtoxlili/caddy-emby-users/internal/jsonx"
)

// playbackInfo forwards PlaybackInfo, which starts a stream and changes
// nothing the account keeps, and settles each source's default audio and
// subtitle stream for the caller. The server picks them from the account's
// language settings, and the upstream only knows the shared account's; once a
// user saves their own, the plugin picks along Emby's rules from those.
// Streams the client asked for by index win, as on Emby: clients start
// playback with the source's defaults.
func (a *app) playbackInfo(w http.ResponseWriter, rc *reqCtx, next caddyhttp.Handler) error {
	c := readChoice(rc)
	return a.proxy(w, rc, next, func(ctx context.Context, rc *reqCtx, doc any) (any, error) {
		o, ok := doc.(*jsonx.Object)
		if !ok {
			return doc, nil
		}
		prefs, err := a.streamPrefs(ctx, rc)
		if err != nil {
			return nil, err
		}
		for _, src := range objects(o, "MediaSources") {
			applyChoice(src, c)
			if prefs != nil {
				prefs.pick(src, c)
			}
		}
		return doc, nil
	})
}

// choice is what the client fixed in its request; nil when it did not.
type choice struct{ audio, subtitle *int64 }

// readChoice reads AudioStreamIndex and SubtitleStreamIndex from the query or
// the body, where clients put them when starting playback (-1 turns
// subtitles off).
func readChoice(rc *reqCtx) choice {
	var c choice
	get := func(f map[string]any, key string) *int64 {
		if v, ok := bodyInt(f, key); ok {
			return &v
		}
		return nil
	}
	q := map[string]any{}
	for k := range rc.q {
		q[strings.ToLower(k)] = queryGet(rc.q, k)
	}
	c.audio, c.subtitle = get(q, "AudioStreamIndex"), get(q, "SubtitleStreamIndex")
	if rc.r.Method == http.MethodPost && rc.r.Body != nil {
		// The body goes on to the upstream whole; proxy enforces its size.
		raw, _ := io.ReadAll(io.LimitReader(rc.r.Body, maxBody+1))
		rc.r.Body = struct {
			io.Reader
			io.Closer
		}{io.MultiReader(bytes.NewReader(raw), rc.r.Body), rc.r.Body}
		f := fields(rc.r.Header.Get("Content-Type"), raw)
		if v := get(f, "AudioStreamIndex"); v != nil {
			c.audio = v
		}
		if v := get(f, "SubtitleStreamIndex"); v != nil {
			c.subtitle = v
		}
	}
	return c
}

func applyChoice(src *jsonx.Object, c choice) {
	streams := objects(src, "MediaStreams")
	if c.audio != nil && findStream(streams, "Audio", *c.audio) != nil {
		src.Set("DefaultAudioStreamIndex", jsonInt(*c.audio))
	}
	if c.subtitle != nil && (*c.subtitle == -1 || findStream(streams, "Subtitle", *c.subtitle) != nil) {
		src.Set("DefaultSubtitleStreamIndex", jsonInt(*c.subtitle))
	}
}

// streamPrefKeys are the settings the server picks default streams from.
var streamPrefKeys = []string{"AudioLanguagePreference", "PlayDefaultAudioTrack", "SubtitleLanguagePreference", "SubtitleMode"}

type streamPrefs struct {
	audioLang, subLang, mode string
	playDefaultAudio         bool
}

// streamPrefs returns the caller's own language settings, or nil while they
// have saved none and the upstream's picks already follow what they see.
func (a *app) streamPrefs(ctx context.Context, rc *reqCtx) (*streamPrefs, error) {
	raw, err := a.st.Pref(ctx, rc.owner.ID, prefConfiguration)
	if err != nil || raw == "" {
		return nil, err
	}
	v, err := jsonx.Decode([]byte(raw))
	saved, _ := v.(*jsonx.Object)
	if err != nil || saved == nil {
		return nil, nil
	}
	own := false
	for _, k := range streamPrefKeys {
		if _, ok := saved.Get(k); ok {
			own = true
		}
	}
	if !own {
		return nil, nil
	}
	cfg, err := a.effectiveConfiguration(ctx, rc.owner)
	if err != nil {
		return nil, err
	}
	p := &streamPrefs{
		audioLang: cfg.String("AudioLanguagePreference"),
		subLang:   cfg.String("SubtitleLanguagePreference"),
		mode:      cfg.String("SubtitleMode"),
	}
	if v, ok := cfg.Get("PlayDefaultAudioTrack"); ok {
		p.playDefaultAudio, _ = v.(bool)
	}
	return p, nil
}

// pick sets src's default audio and subtitle stream. Without
// PlayDefaultAudioTrack the first audio stream in the preferred language
// wins. Subtitle modes: None shows none; OnlyForced only forced ones; Always
// the preferred language; Smart the preferred language only when the audio is
// in another one; Default the source's default or forced streams, preferred
// language first.
func (p *streamPrefs) pick(src *jsonx.Object, c choice) {
	streams := objects(src, "MediaStreams")
	audioIdx, _ := src.Int("DefaultAudioStreamIndex")
	if c.audio == nil && !p.playDefaultAudio && p.audioLang != "" {
		for _, s := range streams {
			if s.String("Type") == "Audio" && langMatches(p.audioLang, s) {
				audioIdx = streamIndex(s)
				src.Set("DefaultAudioStreamIndex", jsonInt(audioIdx))
				break
			}
		}
	}
	if c.subtitle != nil {
		return
	}
	src.Set("DefaultSubtitleStreamIndex", jsonInt(chooseSubtitle(streams, p.mode, p.subLang, findStream(streams, "Audio", audioIdx))))
}

func chooseSubtitle(streams []*jsonx.Object, mode, pref string, audio *jsonx.Object) int64 {
	first := func(ok func(*jsonx.Object) bool) int64 {
		for _, s := range streams {
			if s.String("Type") == "Subtitle" && ok(s) {
				return streamIndex(s)
			}
		}
		return -1
	}
	matches := func(s *jsonx.Object) bool { return pref != "" && langMatches(pref, s) }
	forced := func() int64 {
		if i := first(func(s *jsonx.Object) bool { return s.Bool("IsForced") && matches(s) }); i >= 0 {
			return i
		}
		return first(func(s *jsonx.Object) bool { return s.Bool("IsForced") })
	}
	flagged := func(s *jsonx.Object) bool { return s.Bool("IsDefault") || s.Bool("IsForced") }
	switch mode {
	case "None":
		return -1
	case "OnlyForced":
		return forced()
	case "Always":
		if i := first(matches); i >= 0 {
			return i
		}
		return first(flagged)
	case "Smart":
		if audio != nil && matches(audio) {
			return forced()
		}
		return first(func(s *jsonx.Object) bool { return matches(s) && !s.Bool("IsForced") })
	default:
		if i := first(func(s *jsonx.Object) bool { return flagged(s) && matches(s) }); i >= 0 {
			return i
		}
		return first(flagged)
	}
}

// Clients store the preference as a two-letter code (zh) since server
// 4.7.0.20; sources tag streams with ISO 639-2 codes (chi, sometimes zho).
// Both normalize to the bibliographic code of the culture list. Files also
// use tags outside ISO 639-2 for Chinese.
var langCodes = func() map[string]string {
	var cultures []struct {
		TwoLetterISOLanguageName    string
		ThreeLetterISOLanguageNames []string
	}
	if err := json.Unmarshal(culturesJSON, &cultures); err != nil {
		panic(err)
	}
	m := map[string]string{"chs": "chi", "cht": "chi", "cmn": "chi", "yue": "chi", "can": "chi"}
	for _, c := range cultures {
		bib := c.ThreeLetterISOLanguageNames[0]
		m[c.TwoLetterISOLanguageName] = bib
		for _, n := range c.ThreeLetterISOLanguageNames {
			m[n] = bib
		}
	}
	return m
}()

// langCode normalizes a language tag (zh, zho, zh-CN, zh_TW) to its ISO
// 639-2/B code; unknown tags come back lowercased.
func langCode(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if i := strings.IndexAny(s, "-_"); i > 0 {
		s = s[:i]
	}
	if code, ok := langCodes[s]; ok {
		return code
	}
	return s
}

// Untagged streams name their language in the title, if anywhere.
var langTitleWords = map[string][]string{"chi": {"中", "简", "繁", "chinese", "chs", "cht"}}

func langMatches(pref string, s *jsonx.Object) bool {
	pref = langCode(pref)
	if lang := s.String("Language"); lang != "" {
		return langCode(lang) == pref
	}
	title := strings.ToLower(s.String("DisplayTitle") + " " + s.String("Title"))
	for _, w := range langTitleWords[pref] {
		if strings.Contains(title, w) {
			return true
		}
	}
	return false
}

// fillMediaTitles names sources and streams that came without one, as Emby
// would. Some upstreams leave MediaSource.Name and MediaStream.DisplayTitle
// empty, and Emby for Android TV builds its version menu from them without a
// null check: opening a detail page crashes the app.
func fillMediaTitles(doc any) {
	jsonx.Walk(doc, func(o *jsonx.Object) {
		for _, src := range objects(o, "MediaSources") {
			videoTitle := ""
			for _, s := range objects(src, "MediaStreams") {
				if s.String("DisplayTitle") == "" {
					if t := streamTitle(s); t != "" {
						s.Set("DisplayTitle", t)
					}
				}
				if s.String("Type") == "Video" && videoTitle == "" {
					videoTitle = s.String("DisplayTitle")
				}
			}
			if src.String("Name") == "" {
				if videoTitle == "" {
					videoTitle = strings.ToUpper(src.String("Container"))
				}
				if videoTitle != "" {
					src.Set("Name", videoTitle)
				}
			}
		}
	})
}

// streamTitle spells a stream's title the way Emby does: "1080p HEVC",
// "chi AAC stereo", "chi SRT".
func streamTitle(s *jsonx.Object) string {
	codec := strings.ToUpper(s.String("Codec"))
	switch s.String("Type") {
	case "Video":
		w, _ := s.Int("Width")
		h, _ := s.Int("Height")
		res := ""
		switch {
		case w >= 3800 || h >= 2100:
			res = "4K"
		case h > 0:
			res = strconv.FormatInt(h, 10) + "p"
		}
		return strings.TrimSpace(res + " " + codec)
	case "Audio", "Subtitle":
		var parts []string
		if t := s.String("Title"); t != "" {
			parts = append(parts, t)
		} else if l := s.String("Language"); l != "" {
			parts = append(parts, l)
		}
		if codec != "" {
			parts = append(parts, codec)
		}
		if l := s.String("ChannelLayout"); s.String("Type") == "Audio" && l != "" {
			parts = append(parts, l)
		}
		return strings.Join(parts, " ")
	}
	return ""
}

// objects returns the objects in the array under key.
func objects(o *jsonx.Object, key string) []*jsonx.Object {
	arr, _ := o.Get(key)
	list, _ := arr.([]any)
	out := make([]*jsonx.Object, 0, len(list))
	for _, v := range list {
		if e, ok := v.(*jsonx.Object); ok {
			out = append(out, e)
		}
	}
	return out
}

// jsonInt keeps a value written into a document readable by Object.Int.
func jsonInt(i int64) json.Number { return json.Number(strconv.FormatInt(i, 10)) }

func streamIndex(s *jsonx.Object) int64 {
	i, _ := s.Int("Index")
	return i
}

func findStream(streams []*jsonx.Object, kind string, index int64) *jsonx.Object {
	for _, s := range streams {
		if s.String("Type") == kind && streamIndex(s) == index {
			return s
		}
	}
	return nil
}
