package embyusers

import (
	"bytes"
	_ "embed"
	"io"
	"net/http"
	"strconv"

	"github.com/gtoxlili/caddy-emby-users/internal/jsonx"
)

// An upstream may sit behind a proxy that refuses parts of the read API. The
// one observed in 2026-10 answers 404 for the language list, special
// features, local trailers, home section items, every display preferences id
// but usersettings, upcoming and missing episodes, theme media, critic
// reviews, intros, instant mixes, channels and live TV. Clients load these
// without handling the error: the language pickers stay empty, every detail
// page raises an error toast (a series page says "Error retrieving upcoming
// items"), a home row spins forever (Emby for Android TV asks for
// /Sections/null/Items on servers before 4.10). A refused read is answered the
// way a server without such data answers. Reads every server has data for
// (ancestors, filters) stay refused rather than answer something untrue.

//go:embed cultures.json
var culturesJSON []byte

func refusedRead(rc *reqCtx) []byte {
	s := rc.segs
	switch {
	case match(s, "localization/cultures"):
		return culturesJSON
	case match(s, "users/*/items/*/specialfeatures"), match(s, "users/*/items/*/localtrailers"):
		return []byte("[]")
	case match(s, "users/*/sections/*/items"), match(s, "shows/upcoming"), match(s, "shows/missing"),
		match(s, "items/*/criticreviews"), match(s, "users/*/items/*/intros"), match(s, "items/*/instantmix"),
		match(s, "channels"):
		return []byte(`{"Items":[],"TotalRecordCount":0}`)
	case match(s, "items/*/themesongs"), match(s, "items/*/themevideos"):
		return []byte(`{"Items":[],"TotalRecordCount":0,"OwnerId":0}`)
	case match(s, "items/*/thememedia"):
		none := `{"Items":[],"TotalRecordCount":0,"OwnerId":0}`
		return []byte(`{"ThemeVideosResult":` + none + `,"ThemeSongsResult":` + none + `,"SoundtrackSongsResult":` + none + `}`)
	case match(s, "livetv/info"):
		return []byte(`{"IsEnabled":false,"EnabledUsers":[]}`)
	case match(s, "displaypreferences/*"):
		body, _ := jsonx.Encode(obj(
			"Id", rc.raw[1],
			"SortBy", "SortName",
			"SortOrder", "Ascending",
			"RememberIndexing", false,
			"RememberSorting", false,
			"PrimaryImageHeight", 250,
			"PrimaryImageWidth", 250,
			"ScrollDirection", "Horizontal",
			"ShowBackdrop", true,
			"ShowSidebar", false,
			"CustomPrefs", jsonx.NewObject(),
			"Client", queryGet(rc.q, "Client"),
		))
		return body
	}
	return nil
}

func jsonResponse(r *http.Request, body []byte) *http.Response {
	return &http.Response{
		StatusCode: http.StatusOK, Status: "200 OK",
		Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1, Request: r,
		Header: http.Header{
			"Content-Type":   {"application/json; charset=utf-8"},
			"Content-Length": {strconv.Itoa(len(body))},
		},
		Body: io.NopCloser(bytes.NewReader(body)), ContentLength: int64(len(body)),
	}
}
