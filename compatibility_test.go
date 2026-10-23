package embyusers

import (
	"encoding/json"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"testing"
)

// upstream: Emby's PlaybackInfoRequest carries UserId in its JSON body.
// https://dev.emby.media/reference/RestAPI/MediaInfoService/postItemsByIdPlaybackinfo.html
func TestPlaybackBodyUsesUpstreamIdentity(t *testing.T) {
	h := newHarness(t)
	alice := h.signIn("alice")
	h.up.reset()
	body := `{"UserId":"` + alice.UserID + `","DeviceId":"alice-phone","StartTimeTicks":123456789012345678,"DeviceProfile":{"Name":"My Player","DirectPlayProfiles":[{"Container":"mkv"}]}}`
	if r := h.as(alice.Token, "POST", "/emby/Items/e01EP1/PlaybackInfo", body); r.Status != http.StatusOK {
		t.Fatalf("playback info: %d %s", r.Status, r.Body)
	}
	reqs := h.up.seen()
	if len(reqs) != 1 {
		t.Fatalf("upstream requests: %d", len(reqs))
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal([]byte(reqs[0].Body), &got); err != nil {
		t.Fatal(err)
	}
	if string(got["UserId"]) != `"`+upUser+`"` || string(got["DeviceId"]) != `"test-device"` {
		t.Fatalf("upstream received local identity: %s", reqs[0].Body)
	}
	if string(got["StartTimeTicks"]) != "123456789012345678" || !strings.Contains(string(got["DeviceProfile"]), `"My Player"`) {
		t.Fatalf("playback options changed: %s", reqs[0].Body)
	}
}

// contract: an admin can inspect a friend's state using query UserId, as
// hongguo-emby's Authed extractor does. A normal user always sees their own.
func TestQueryUserIDSelectsLocalStateForAdmins(t *testing.T) {
	h := newHarness(t)
	admin, alice, bob := h.signIn("admin"), h.signIn("alice"), h.signIn("bob")
	h.as(alice.Token, "POST", "/emby/Users/"+alice.UserID+"/FavoriteItems/m01MOVIE", "")
	path := "/emby/Items?Filters=IsFavorite&UserId=" + alice.UserID
	if ids := itemIDs(t, h.as(admin.Token, "GET", path, "")); !reflect.DeepEqual(ids, []string{"m01MOVIE"}) {
		t.Fatalf("admin inspecting alice: %v", ids)
	}
	if ids := itemIDs(t, h.as(bob.Token, "GET", path, "")); len(ids) != 0 {
		t.Fatalf("bob read alice's favorites: %v", ids)
	}
}

// contract: filtering is performed on local UserData. An upstream filter
// would remove items according to the shared account before the overlay.
func TestSharedAccountFiltersAreNotForwarded(t *testing.T) {
	h := newHarness(t)
	alice := h.signIn("alice")
	h.up.reset()
	r := h.as(alice.Token, "GET", "/emby/Users/"+alice.UserID+"/Items?Filters=IsUnplayed,IsFolder&IsPlayed=false&IsFavorite=false&SortBy=SortName", "")
	if r.Status != http.StatusOK {
		t.Fatalf("unplayed: %d %s", r.Status, r.Body)
	}
	for _, req := range h.up.seen() {
		q, _ := url.ParseQuery(req.Query)
		if queryGet(q, "IsPlayed") != "" || queryGet(q, "IsFavorite") != "" || strings.Contains(strings.ToLower(queryGet(q, "Filters")), "isunplayed") {
			t.Fatalf("upstream received local state filters: %s", req.Query)
		}
		if queryGet(q, "Filters") != "IsFolder" || queryGet(q, "SortBy") != "SortName" {
			t.Fatalf("non-state filters changed: %s", req.Query)
		}
	}
}

// contract: local admins manage local accounts, not the upstream server.
// The upstream account's administrative permissions must not be inherited.
func TestUpstreamManagementIsNotExposed(t *testing.T) {
	h := newHarness(t)
	for _, name := range []string{"alice", "admin"} {
		s := h.signIn(name)
		h.up.reset()
		for _, path := range []string{"System/Configuration", "System/Logs", "Auth/Keys", "Environment/DirectoryContents", "ScheduledTasks", "Packages", "Plugins", "Library/VirtualFolders"} {
			if r := h.as(s.Token, "GET", "/emby/"+path, ""); r.Status != http.StatusForbidden {
				t.Errorf("%s accessing %s: %d", name, path, r.Status)
			}
		}
		if reqs := h.up.seen(); len(reqs) != 0 {
			t.Errorf("%s accessed upstream management: %+v", name, reqs)
		}
	}
}

// contract: hongguo-emby accepts reports identifying the item using
// NowPlayingItem.Id, as well as the usual ItemId.
func TestPlaybackReportAcceptsNowPlayingItem(t *testing.T) {
	h := newHarness(t)
	alice := h.signIn("alice")
	if r := h.as(alice.Token, "POST", "/emby/Sessions/Playing/Stopped", `{"NowPlayingItem":{"Id":"e01EP1"},"PositionTicks":18000000000}`); r.Status != http.StatusNoContent {
		t.Fatalf("stopped: %d %s", r.Status, r.Body)
	}
	if pos, played := position(t, h, alice, "e01EP1"); pos != hour/2 || played {
		t.Fatalf("resume point: pos=%d played=%v", pos, played)
	}
}
