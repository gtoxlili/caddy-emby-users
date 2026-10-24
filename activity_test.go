package embyusers

import (
	"encoding/json"
	"net/http"
	"testing"
)

func entries(t *testing.T, h *harness, token, query string) ([]map[string]any, float64) {
	t.Helper()
	r := h.as(token, http.MethodGet, "/emby/System/ActivityLog/Entries"+query, "")
	if r.Status != http.StatusOK {
		t.Fatalf("activity log = %d %s", r.Status, r.Body)
	}
	m := r.json(t)
	var out []map[string]any
	for _, it := range m["Items"].([]any) {
		out = append(out, it.(map[string]any))
	}
	return out, m["TotalRecordCount"].(float64)
}

func countTypes(list []map[string]any) map[string]int {
	out := map[string]int{}
	for _, e := range list {
		out[e["Type"].(string)]++
	}
	return out
}

// The log uses the type names Emby 4.10 itself writes (observed on 4.10.2:
// user.authenticated, user.authenticationfailed with Severity Error,
// user.created, user.policyupdated, playback.start), so Emby's dashboard and
// other administration clients read it. An evening of one series is one entry.
func TestActivityLog(t *testing.T) {
	h := newHarness(t)
	admin := h.signIn("admin")
	if r := h.do(http.MethodPost, "/emby/Users/AuthenticateByName", `{"Username":"alice","Pw":"wrong"}`); r.Status != http.StatusUnauthorized {
		t.Fatalf("wrong password = %d", r.Status)
	}
	alice := h.signIn("alice")
	created := h.as(admin.Token, http.MethodPost, "/emby/Users/New", `{"Name":"carol","Password":"pw"}`).json(t)
	h.as(admin.Token, http.MethodPost, "/emby/Users/"+created["Id"].(string)+"/Policy", `{"IsDisabled":true}`)
	for _, item := range []string{"e01EP1", "e01EP2", "m01MOVIE"} {
		h.as(alice.Token, http.MethodPost, "/emby/Sessions/Playing", `{"ItemId":"`+item+`","PositionTicks":0}`)
	}

	if r := h.as(alice.Token, http.MethodGet, "/emby/System/ActivityLog/Entries", ""); r.Status != http.StatusForbidden {
		t.Errorf("a non-administrator read the log: %d", r.Status)
	}
	all, total := entries(t, h, admin.Token, "")
	got := countTypes(all)
	want := map[string]int{"user.authenticated": 2, "user.authenticationfailed": 1, "user.created": 1, "user.policyupdated": 1, "playback.start": 2}
	for k, n := range want {
		if got[k] != n {
			t.Errorf("%s entries = %d, want %d (all: %v)", k, got[k], n, got)
		}
	}
	if int(total) != len(all) {
		t.Errorf("TotalRecordCount = %v for %d entries", total, len(all))
	}
	for _, e := range all {
		switch e["Type"] {
		case "user.authenticationfailed":
			if e["Severity"] != "Error" || e["UserId"] != alice.UserID {
				t.Errorf("failed sign-in entry = %v", e)
			}
		case "user.policyupdated":
			if e["Detail"] != "disabled:on" || e["ByUserName"] != "admin" {
				t.Errorf("policy entry = %v", e)
			}
		case "playback.start":
			if e["ItemId"] != "e01EP2" && e["ItemId"] != "m01MOVIE" {
				t.Errorf("playback entry for %v; the second episode should have replaced the first", e["ItemId"])
			}
		}
	}
	if all[0]["Type"] != "playback.start" || all[0]["ItemId"] != "m01MOVIE" {
		t.Errorf("newest entry = %v, want the last playback", all[0])
	}

	mine, _ := entries(t, h, admin.Token, "?UserId="+alice.UserID)
	for _, e := range mine {
		if e["UserId"] != alice.UserID {
			t.Errorf("UserId filter let through %v", e)
		}
	}
	page, total := entries(t, h, admin.Token, "?StartIndex=1&Limit=2")
	if len(page) != 2 || int(total) != len(all) || page[0]["Id"] != all[1]["Id"] {
		t.Errorf("page = %d entries from %v, total %v", len(page), page[0]["Id"], total)
	}
}

// /Sessions shows how a client said it plays: transcoding is what an
// administrator looks for, and it was always reported as DirectStream.
func TestSessionsShowReportedPlayMethod(t *testing.T) {
	h := newHarness(t)
	admin := h.signIn("admin")
	alice := h.signIn("alice")
	bob := h.signIn("bob")
	h.as(alice.Token, http.MethodPost, "/emby/Sessions/Playing",
		`{"ItemId":"m01MOVIE","PlayMethod":"Transcode","MediaSourceId":"ms1","AudioStreamIndex":2,"PositionTicks":0}`)
	h.as(alice.Token, http.MethodPost, "/emby/Sessions/Playing/Progress", `{"ItemId":"m01MOVIE","PositionTicks":100}`)
	h.as(bob.Token, http.MethodPost, "/emby/Sessions/Playing", `{"ItemId":"m01MOVIE","PositionTicks":0}`)

	r := h.as(admin.Token, http.MethodGet, "/emby/Sessions", "")
	var list []map[string]any
	if err := json.Unmarshal(r.Body, &list); err != nil {
		t.Fatal(err)
	}
	states := map[string]map[string]any{}
	for _, s := range list {
		states[s["UserName"].(string)] = s["PlayState"].(map[string]any)
	}
	if s := states["alice"]; s["PlayMethod"] != "Transcode" || s["MediaSourceId"] != "ms1" || s["AudioStreamIndex"] != float64(2) {
		t.Errorf("alice's play state = %v", s)
	}
	if _, ok := states["bob"]["PlayMethod"]; ok {
		t.Errorf("bob never said how he plays, yet PlayMethod = %v", states["bob"]["PlayMethod"])
	}
}
