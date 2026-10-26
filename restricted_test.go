package embyusers

import (
	"encoding/json"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/encoding/unicode"
)

// These tests run against the fake upstream's restrictions, which mirror the
// server observed in 2026-10 behind its proxy (harness_test.go).

// upstream: the observed proxy answers 404 unless a path is spelled as in
// Emby's API, while Emby itself matches paths case-insensitively and Emby
// for Android TV 2.1.59g sends some lowercased. Expected spellings come from
// the OpenAPI document of the official Emby SDK.
func TestForwardedPathsUseOfficialSpelling(t *testing.T) {
	h := newHarness(t)
	alice := h.signIn("alice")
	for _, c := range []struct{ in, want string }{
		{"/emby/users/" + alice.UserID + "/items/m01MOVIE", "/emby/Users/" + upUser + "/Items/m01MOVIE"},
		{"/mediabrowser/videos/e01EP1/stream.mkv?static=true", "/emby/Videos/e01EP1/stream.mkv"},
		{"/emby/audio/e01EP1/universal", "/emby/Audio/e01EP1/universal"},
		{"/emby/items/e01EP1/images/primary", "/emby/Items/e01EP1/Images/primary"}, // parameters keep their text
		{"/emby/play/video/e01EP1", "/emby/play/video/e01EP1"},                     // not an Emby route: left alone
	} {
		h.up.reset()
		h.as(alice.Token, "GET", c.in, "")
		req := h.up.seen()
		if len(req) == 0 || req[len(req)-1].Path != c.want {
			t.Errorf("%s reached the upstream as %+v, want %s", c.in, req, c.want)
		}
	}
}

// invariant: the upstream token never reaches a client. The observed
// upstream redirects with an HTML body that repeats the Location, token
// included.
func TestRedirectBodiesDoNotCarryTheUpstreamToken(t *testing.T) {
	h := newHarness(t)
	alice := h.signIn("alice")
	// An image subtitle is not text cues, so the redirect goes to the client.
	h.up.files = map[string]string{"3": "\x00\x01PGS"}
	r := h.as(alice.Token, "GET", "/emby/Videos/m01MOVIE/ms1/Subtitles/3/Stream.vtt", "")
	if r.Status != http.StatusFound {
		t.Fatalf("status %d %s", r.Status, r.Body)
	}
	up := h.up.currentToken()
	if strings.Contains(string(r.Body), up) || strings.Contains(r.Header.Get("Location"), up) ||
		!strings.Contains(r.Header.Get("Location"), alice.Token) {
		t.Fatalf("redirect: Location %q, body %q", r.Header.Get("Location"), r.Body)
	}
}

// upstream: the observed proxy answers 404 for these reads. Clients call them
// without handling errors: Emby for Android TV leaves its language pickers
// empty, raises an error toast on every detail page, and spins a home row
// forever on /Sections/null/Items.
func TestRefusedReadsAnswerEmpty(t *testing.T) {
	h := newHarness(t)
	alice := h.signIn("alice")
	u := "/emby/Users/" + alice.UserID
	for _, c := range []struct{ path, want string }{
		{u + "/Items/m01MOVIE/SpecialFeatures", `[]`},
		{u + "/Items/m01MOVIE/LocalTrailers", `[]`},
		{u + "/Sections/null/Items", `{"Items":[],"TotalRecordCount":0}`},
	} {
		if r := h.as(alice.Token, "GET", c.path, ""); r.Status != http.StatusOK || strings.TrimSpace(string(r.Body)) != c.want {
			t.Errorf("%s: %d %s", c.path, r.Status, r.Body)
		}
	}

	// ISO 639-2 lists Chinese as chi (bibliographic) and zho (terminology).
	r := h.as(alice.Token, "GET", "/emby/Localization/Cultures", "")
	var cultures []map[string]any
	if err := json.Unmarshal(r.Body, &cultures); err != nil {
		t.Fatalf("cultures: %d %s", r.Status, r.Body)
	}
	i := slices.IndexFunc(cultures, func(c map[string]any) bool { return c["TwoLetterISOLanguageName"] == "zh" })
	if i < 0 || cultures[i]["ThreeLetterISOLanguageName"] != "chi" ||
		!reflect.DeepEqual(cultures[i]["ThreeLetterISOLanguageNames"], []any{"chi", "zho"}) {
		t.Fatalf("no Chinese culture in %d entries", len(cultures))
	}

	r = h.as(alice.Token, "GET", "/emby/DisplayPreferences/3ce5b65d?client=emby&userId="+alice.UserID, "")
	if m := r.json(t); r.Status != http.StatusOK || m["Id"] != "3ce5b65d" || m["Client"] != "emby" {
		t.Fatalf("display preferences: %d %s", r.Status, r.Body)
	}
}

// upstream: Emby API, POST /Users/{Id}/Configuration/Partial updates the
// fields given.
func TestPartialConfigurationMerges(t *testing.T) {
	h := newHarness(t)
	alice := h.signIn("alice")
	u := "/emby/Users/" + alice.UserID
	h.as(alice.Token, "POST", u+"/Configuration", `{"SubtitleMode":"Always","PlayDefaultAudioTrack":false}`)
	h.as(alice.Token, "POST", u+"/Configuration/Partial", `{"SubtitleLanguagePreference":"zh"}`)
	cfg := h.as(alice.Token, "GET", u, "").json(t)["Configuration"].(map[string]any)
	if cfg["SubtitleMode"] != "Always" || cfg["PlayDefaultAudioTrack"] != false || cfg["SubtitleLanguagePreference"] != "zh" {
		t.Fatalf("configuration = %v", cfg)
	}
}

// Sources as the observed upstream describes them: an external subtitle
// numbered between the video and audio streams, two-letter-less ISO 639-2
// tags, an untagged audio track named only by codec.
const englishFilm = `{"PlaySessionId":"ps1","MediaSources":[{"Id":"ms1","DefaultAudioStreamIndex":2,"DefaultSubtitleStreamIndex":4,"MediaStreams":[
{"Index":0,"Type":"Video","Codec":"hevc"},
{"Index":1,"Type":"Subtitle","Codec":"srt","Language":"chi","IsExternal":true},
{"Index":2,"Type":"Audio","Codec":"eac3","Language":"eng","IsDefault":true},
{"Index":3,"Type":"Audio","Codec":"aac","Language":"chi"},
{"Index":4,"Type":"Subtitle","Codec":"subrip","Language":"rus","IsDefault":true}]}]}`

// upstream: Emby computes each source's default streams in PlaybackInfo from
// the account's settings, and clients start playback with them. Clients
// store the subtitle language as a two-letter code since server 4.7.0.20.
// repro: 2026-10-14, a film started with Russian subtitles although the
// detail page had another stream selected.
func TestPlaybackDefaultsFollowTheCaller(t *testing.T) {
	h := newHarness(t)
	alice, bob := h.signIn("alice"), h.signIn("bob")
	h.up.playback = englishFilm
	defaults := func(s session, body string) (audio, subtitle float64) {
		t.Helper()
		r := h.as(s.Token, "POST", "/emby/Items/m01MOVIE/PlaybackInfo?UserId="+s.UserID, body)
		src := r.json(t)["MediaSources"].([]any)[0].(map[string]any)
		return src["DefaultAudioStreamIndex"].(float64), src["DefaultSubtitleStreamIndex"].(float64)
	}

	// Bob saved nothing: the upstream's picks stand.
	if a, s := defaults(bob, `{}`); a != 2 || s != 4 {
		t.Errorf("unsaved: audio %v subtitle %v", a, s)
	}
	// Streams named in the request become the defaults.
	if a, s := defaults(bob, `{"AudioStreamIndex":3,"SubtitleStreamIndex":-1}`); a != 3 || s != -1 {
		t.Errorf("chosen: audio %v subtitle %v", a, s)
	}

	// Smart mode with Chinese preferred: English audio gets the Chinese
	// subtitle, Chinese audio none.
	h.as(alice.Token, "POST", "/emby/Users/"+alice.UserID+"/Configuration", `{"SubtitleMode":"Smart","SubtitleLanguagePreference":"zh"}`)
	if _, s := defaults(alice, `{}`); s != 1 {
		t.Errorf("smart, English audio: subtitle %v", s)
	}
	if _, s := defaults(alice, `{"AudioStreamIndex":3}`); s != -1 {
		t.Errorf("smart, Chinese audio: subtitle %v", s)
	}
	if _, s := defaults(bob, `{}`); s != 4 {
		t.Errorf("alice's settings changed bob's subtitle: %v", s)
	}

	// Without PlayDefaultAudioTrack the preferred audio language wins over
	// the source's default track.
	h.as(alice.Token, "POST", "/emby/Users/"+alice.UserID+"/Configuration/Partial", `{"PlayDefaultAudioTrack":false,"AudioLanguagePreference":"chi"}`)
	if a, _ := defaults(alice, `{}`); a != 3 {
		t.Errorf("preferred audio: %v", a)
	}
}

// repro: 2026-10-14, Emby for Android TV crashed opening a detail page whose
// source had no Name (MediaSelectorBar.getOptionStrings). Expected titles
// follow Emby's spelling.
func TestMissingMediaTitlesAreFilled(t *testing.T) {
	h := newHarness(t)
	alice := h.signIn("alice")
	r := h.as(alice.Token, "GET", "/emby/Users/"+alice.UserID+"/Items/m01BARE", "")
	src := r.json(t)["MediaSources"].([]any)[0].(map[string]any)
	var got []string
	for _, s := range src["MediaStreams"].([]any) {
		got = append(got, s.(map[string]any)["DisplayTitle"].(string))
	}
	if src["Name"] != "4K HEVC" || !reflect.DeepEqual(got, []string{"4K HEVC", "chi AAC stereo", "简体中文"}) {
		t.Fatalf("source %v, streams %q", src["Name"], got)
	}
}

// upstream: Emby converts external subtitles to the format named in
// Stream.{Format}; the observed upstream redirects to the original file.
// Emby's JSON format is {"TrackEvents":[{Id,Text,StartPositionTicks,
// EndPositionTicks}]}; Emby for Android TV shows Text through Html.fromHtml,
// so lines break with <br>. Chinese SRT files are often GBK.
func TestExternalSubtitlesAreConverted(t *testing.T) {
	h := newHarness(t)
	alice := h.signIn("alice")
	gbk, _ := simplifiedchinese.GBK.NewEncoder().String("1\r\n00:00:01,000 --> 00:00:02,500\r\n第一行\r\n第二行\r\n\r\n")
	h.up.files = map[string]string{"2": gbk}

	r := h.as(alice.Token, "GET", "/emby/videos/m01MOVIE/ms1/subtitles/2/stream.json", "")
	want := `{"TrackEvents":[{"Id":"1","Text":"第一行<br>第二行","StartPositionTicks":10000000,"EndPositionTicks":25000000}]}`
	if r.Status != http.StatusOK || strings.TrimSpace(string(r.Body)) != want {
		t.Fatalf("json: %d %s", r.Status, r.Body)
	}
	r = h.as(alice.Token, "GET", "/emby/Videos/m01MOVIE/ms1/Subtitles/2/0/Stream.vtt", "")
	want = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\n第一行\n第二行\n\n"
	if r.Status != http.StatusOK || string(r.Body) != want || !strings.HasPrefix(r.Header.Get("Content-Type"), "text/vtt") {
		t.Fatalf("vtt: %d %q", r.Status, r.Body)
	}
}

// Subtitle files as found in the wild: SSA field order, commas in dialogue,
// drawings; WebVTT notes, identifiers, tags and escapes; SRT without blank
// lines and with a BOM; UTF-16.
func TestSubtitleFileFormats(t *testing.T) {
	utf16, err := unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewEncoder().String("1\n00:00:01,000 --> 00:00:02,000\n中文\n")
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, file string
		want       []cue
	}{
		{"SSA", "[Script Info]\nTitle: x\n\n[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
			"Comment: Marked=0,0:00:00.00,0:00:01.00,Default,,0000,0000,0000,,note\n" +
			"Dialogue: Marked=0,0:00:02.50,0:00:04.00,Default,,0000,0000,0000,,{\\pos(10,20)}你好, 世界\\N<再见>\n" +
			"Dialogue: Marked=0,0:00:05.00,0:00:06.00,Default,,0000,0000,0000,,{\\p1}m 0 0 l 1 1{\\p0}\n",
			[]cue{{25_000_000, 40_000_000, "你好, 世界\n&lt;再见&gt;"}}},
		{"WebVTT", "WEBVTT\n\nNOTE note\n\nintro\n00:01.000 --> 00:02.000 align:start\n<v Tom>Tom &amp; Jerry</v>\n<c.yellow>&lt;3</c>\n\n" +
			"00:00:03.000 --> 00:00:04.000\n<b>bold</b>\n",
			[]cue{{10_000_000, 20_000_000, "Tom &amp; Jerry\n&lt;3"}, {30_000_000, 40_000_000, "<b>bold</b>"}}},
		{"SRT", "\uFEFF1\n00:00:01,000 --> 00:00:02,000\nA\n2\n00:00:03,000 --> 00:00:04,000\nB\n",
			[]cue{{10_000_000, 20_000_000, "A"}, {30_000_000, 40_000_000, "B"}}},
		{"UTF-16", utf16, []cue{{10_000_000, 20_000_000, "中文"}}},
	}
	for _, c := range cases {
		got, err := parseSubtitleFile([]byte(c.file))
		if err != nil || !slices.Equal(got, c.want) {
			t.Errorf("%s: got %+v, %v", c.name, got, err)
		}
	}
}
