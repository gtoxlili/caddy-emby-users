package embyusers

import (
	"bytes"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/caddyserver/caddy/v2/caddyconfig/caddyfile"

	"github.com/gtoxlili/caddy-emby-users/internal/store"
)

// upstream: Emby AuthorizationContext and the clients' api code. Official apps
// send the token only in the query (api_key or X-Emby-Token), the legacy
// Android TV app in X-MediaBrowser-Token, third-party clients in
// X-Emby-Authorization, and some as ApiKey.
func TestEveryTokenPositionIsSwappedForTheUpstreamToken(t *testing.T) {
	h := newHarness(t)
	alice := h.signIn("alice")
	views := "/emby/Users/" + alice.UserID + "/Views"
	cases := map[string]func() response{
		"X-Emby-Token header":         func() response { return h.do("GET", views, "", "X-Emby-Token", alice.Token) },
		"X-MediaBrowser-Token header": func() response { return h.do("GET", views, "", "X-MediaBrowser-Token", alice.Token) },
		"X-Emby-Authorization header": func() response {
			return h.do("GET", views, "", "X-Emby-Authorization", `Emby Client="SenPlayer", Device="iPhone", DeviceId="y", Version="6", Token="`+alice.Token+`"`)
		},
		"api_key query":      func() response { return h.do("GET", views+"?api_key="+alice.Token, "") },
		"X-Emby-Token query": func() response { return h.do("GET", views+"?X-Emby-Token="+alice.Token, "") },
		"ApiKey query":       func() response { return h.do("GET", views+"?ApiKey="+alice.Token, "") },
	}
	for name, send := range cases {
		t.Run(name, func(t *testing.T) {
			h.up.reset()
			if r := send(); r.Status != http.StatusOK {
				t.Fatalf("status %d: %s", r.Status, r.Body)
			}
			for _, req := range h.up.seen() {
				if strings.Contains(fmt.Sprint(req), alice.Token) {
					t.Fatalf("upstream received the caller's token: %+v", req)
				}
				if !strings.Contains(req.Path, upUser) {
					t.Fatalf("upstream path names %q, want the upstream user %s", req.Path, upUser)
				}
			}
		})
	}
}

// A token the plugin did not issue must not reach the upstream server, where
// it might be valid (for example the upstream account's own token).
func TestUnknownTokenIsRefusedWithoutReachingUpstream(t *testing.T) {
	h := newHarness(t)
	h.signIn("alice") // the plugin now holds a valid upstream token
	stolen := h.up.currentToken()
	h.up.reset()
	r := h.do("GET", "/emby/Users/"+upUser+"/Views?api_key="+stolen, "")
	// upstream: real Emby's 401 text; clients return to sign-in on it.
	if r.Status != http.StatusUnauthorized || string(r.Body) != "Access token is invalid or expired." {
		t.Fatalf("got %d %q", r.Status, r.Body)
	}
	if n := len(h.up.seen()); n != 0 {
		t.Fatalf("upstream received %d requests", n)
	}
}

// upstream: Emby registers every route under /emby, /mediabrowser and no
// prefix, matched case-insensitively. AfuseKt sends //emby/... in lowercase;
// SenPlayer encodes the query's ? as %3F in the path.
func TestPathAliases(t *testing.T) {
	h := newHarness(t)
	alice := h.signIn("alice")
	for _, path := range []string{
		"/Users/Public",
		"/emby/Users/Public",
		"/mediabrowser/users/public",
		"//emby//users/public/",
	} {
		r := h.do("GET", path, "")
		if r.Status != http.StatusOK || strings.TrimSpace(string(r.Body)) != "[]" {
			t.Errorf("%s: %d %s", path, r.Status, r.Body)
		}
	}
	r := h.do("POST", "//emby/users/authenticatebyname", `{"username":"bob","pw":"bob-pw"}`)
	if r.Status != http.StatusOK {
		t.Errorf("lowercase sign-in: %d %s", r.Status, r.Body)
	}
	h.up.reset()
	r = h.do("GET", "/emby/Users/"+alice.UserID+"/Views%3Fapi_key="+alice.Token, "")
	if r.Status != http.StatusOK {
		t.Fatalf("smuggled query: %d %s", r.Status, r.Body)
	}
	if req := h.up.seen(); len(req) == 0 || !strings.Contains(req[0].Query, h.up.currentToken()) {
		t.Fatalf("smuggled token was not swapped: %+v", req)
	}
}

// upstream: Emby clients. Official apps sign in with a form body, the legacy
// Java client with lowercase keys, third parties with JSON. The UserDto must
// be identical at sign-in and from GET /Users/{id}, with its array fields
// present: Emby Theater's home screen spins forever without
// LatestItemsExcludes.
func TestSignInResponse(t *testing.T) {
	h := newHarness(t)
	form := h.do("POST", "/emby/Users/authenticatebyname?X-Emby-Client=Emby%20for%20Android&X-Emby-Device-Name=Pixel&X-Emby-Device-Id=abc",
		"Username=alice&Pw=alice-pw", "Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
	if form.Status != http.StatusOK {
		t.Fatalf("form sign-in: %d %s", form.Status, form.Body)
	}
	res := form.json(t)
	tok, _ := res["AccessToken"].(string)
	if !isLocalID(tok) {
		t.Errorf("AccessToken %q is not 32 hex characters", tok)
	}
	if res["ServerId"] != upServer {
		t.Errorf("ServerId %v, want the upstream server's %q so items and session agree", res["ServerId"], upServer)
	}
	user := res["User"].(map[string]any)
	cfg := user["Configuration"].(map[string]any)
	for _, k := range []string{"LatestItemsExcludes", "MyMediaExcludes", "OrderedViews"} {
		if _, ok := cfg[k].([]any); !ok {
			t.Errorf("Configuration.%s is %v, want an array", k, cfg[k])
		}
	}
	session := res["SessionInfo"].(map[string]any)
	if session["DeviceId"] != "abc" || session["UserId"] != user["Id"] {
		t.Errorf("SessionInfo does not describe this device and user: %v", session)
	}
	again := h.as(tok, "GET", "/emby/Users/"+user["Id"].(string), "").json(t)
	if !reflect.DeepEqual(again, user) {
		t.Errorf("GET /Users/{id} differs from the sign-in UserDto:\n%v\n%v", again, user)
	}

	legacy := h.do("POST", "/emby/Users/AuthenticateByName?format=json", "username=bob&pw=bob-pw",
		"Content-Type", "application/x-www-form-urlencoded", "X-Emby-Authorization", `MediaBrowser Client="Android TV", Device="Shield", DeviceId="x", Version="2.1"`)
	if legacy.Status != http.StatusOK {
		t.Errorf("legacy sign-in: %d %s", legacy.Status, legacy.Body)
	}
	wrong := h.do("POST", "/emby/Users/AuthenticateByName", `{"Username":"alice","Pw":"nope"}`)
	if wrong.Status != http.StatusUnauthorized {
		t.Errorf("wrong password: %d", wrong.Status)
	}
}

// upstream: Emby playbackmanager.js plays DirectStreamUrl as given without
// adding a token, and the upstream server embeds its own token there.
func TestPlaybackURLsCarryTheCallersToken(t *testing.T) {
	h := newHarness(t)
	alice := h.signIn("alice")
	r := h.as(alice.Token, "POST", "/emby/Items/e01EP1/PlaybackInfo?UserId="+alice.UserID, `{"DeviceProfile":{}}`)
	if r.Status != http.StatusOK {
		t.Fatalf("PlaybackInfo: %d %s", r.Status, r.Body)
	}
	upTok := h.up.currentToken()
	if strings.Contains(string(r.Body), upTok) {
		t.Fatalf("response leaks the upstream token: %s", r.Body)
	}
	stream := r.json(t)["MediaSources"].([]any)[0].(map[string]any)["DirectStreamUrl"].(string)
	if !strings.Contains(stream, "api_key="+alice.Token) {
		t.Fatalf("DirectStreamUrl %q does not carry the caller's token", stream)
	}
	video := h.do("GET", stream, "")
	if video.Status != http.StatusOK || string(video.Body) != "video-bytes-e01EP1" {
		t.Fatalf("stream: %d %q", video.Status, video.Body)
	}
}

func position(t *testing.T, h *harness, s session, item string) (int64, bool) {
	t.Helper()
	ud := udOf(t, h.as(s.Token, "GET", "/emby/Users/"+s.UserID+"/Items/"+item, ""))
	return int64(ud["PlaybackPositionTicks"].(float64)), ud["Played"].(bool)
}

// The point of the plugin: friends share one upstream account but not their
// history. Nothing a friend does to their history reaches the upstream
// account either.
func TestPlayStateBelongsToEachUser(t *testing.T) {
	h := newHarness(t)
	alice, bob := h.signIn("alice"), h.signIn("bob")

	// Untouched items read as unplayed, not as the upstream account's state.
	if pos, played := position(t, h, alice, "e01EP1"); pos != 0 || played {
		t.Fatalf("fresh item reads pos=%d played=%v", pos, played)
	}

	h.up.reset()
	report := func(s session, path string, pos int64) {
		r := h.as(s.Token, "POST", "/emby/Sessions/Playing"+path, fmt.Sprintf(`{"ItemId":"e01EP1","PositionTicks":%d,"PlaySessionId":"ps1"}`, pos))
		if r.Status != http.StatusNoContent {
			t.Fatalf("report %s: %d %s", path, r.Status, r.Body)
		}
	}
	report(alice, "", 0)
	report(alice, "/Progress", hour/2)
	report(alice, "/Stopped", hour/2)

	if pos, played := position(t, h, alice, "e01EP1"); pos != hour/2 || played {
		t.Errorf("alice: pos=%d played=%v, want half way and unplayed", pos, played)
	}
	if pos, played := position(t, h, bob, "e01EP1"); pos != 0 || played {
		t.Errorf("bob sees alice's progress: pos=%d played=%v", pos, played)
	}
	if ids := itemIDs(t, h.as(alice.Token, "GET", "/emby/Users/"+alice.UserID+"/Items/Resume?MediaTypes=Video", "")); !reflect.DeepEqual(ids, []string{"e01EP1"}) {
		t.Errorf("alice resume = %v", ids)
	}
	if ids := itemIDs(t, h.as(bob.Token, "GET", "/emby/Users/"+bob.UserID+"/Items/Resume", "")); len(ids) != 0 {
		t.Errorf("bob resume = %v", ids)
	}

	r := h.as(bob.Token, "POST", "/emby/Users/"+bob.UserID+"/PlayedItems/m01SERIES", "")
	if r.Status != http.StatusOK {
		t.Fatalf("mark series played: %d %s", r.Status, r.Body)
	}
	series := udOf(t, h.as(bob.Token, "GET", "/emby/Users/"+bob.UserID+"/Items/m01SERIES", ""))
	if series["Played"] != true || series["UnplayedItemCount"] != 0.0 {
		t.Errorf("bob's series after marking it played: %v", series)
	}
	series = udOf(t, h.as(alice.Token, "GET", "/emby/Users/"+alice.UserID+"/Items/m01SERIES", ""))
	if series["Played"] != false || series["UnplayedItemCount"] != 3.0 {
		t.Errorf("alice's series changed with bob's: %v", series)
	}

	for _, req := range h.up.seen() {
		p := strings.ToLower(req.Path)
		if strings.Contains(p, "playeditems") || strings.Contains(p, "favoriteitems") {
			t.Errorf("a history write reached the upstream account: %s %s", req.Method, req.Path)
		}
	}
}

// upstream: Emby 4.9.1 and later apps ask Resume?ParentId={series}&Limit=1
// for a series' Play button, older ones NextUp?SeriesId=. After a finished
// episode both must name the next one.
func TestNextEpisodeAfterAFinishedOne(t *testing.T) {
	h := newHarness(t)
	alice := h.signIn("alice")
	h.as(alice.Token, "POST", "/emby/Sessions/Playing", `{"ItemId":"e01EP1","PositionTicks":0}`)
	h.as(alice.Token, "POST", "/emby/Sessions/Playing/Stopped", fmt.Sprintf(`{"ItemId":"e01EP1","PositionTicks":%d}`, hour*95/100))

	if _, played := position(t, h, alice, "e01EP1"); !played {
		t.Fatal("episode stopped at 95% is not played")
	}
	for name, path := range map[string]string{
		"Resume?ParentId": "/emby/Users/" + alice.UserID + "/Items/Resume?ParentId=m01SERIES&IncludeItemTypes=Episode&Limit=1",
		"NextUp?SeriesId": "/emby/Shows/NextUp?SeriesId=m01SERIES&UserId=" + alice.UserID,
		"NextUp":          "/emby/Shows/NextUp?UserId=" + alice.UserID + "&Limit=20",
	} {
		if ids := itemIDs(t, h.as(alice.Token, "GET", path, "")); !reflect.DeepEqual(ids, []string{"e01EP2"}) {
			t.Errorf("%s = %v, want [e01EP2]", name, ids)
		}
	}
	// Continue watching (no scope) only lists items with a resume point.
	if ids := itemIDs(t, h.as(alice.Token, "GET", "/emby/Users/"+alice.UserID+"/Items/Resume", "")); len(ids) != 0 {
		t.Errorf("resume = %v", ids)
	}
	hide := h.as(alice.Token, "POST", "/emby/Users/"+alice.UserID+"/Items/e01EP1/HideFromResume?Hide=true", "")
	if hide.Status != http.StatusOK {
		t.Fatalf("hide: %d", hide.Status)
	}
	if ids := itemIDs(t, h.as(alice.Token, "GET", "/emby/Shows/NextUp?UserId="+alice.UserID, "")); len(ids) != 0 {
		t.Errorf("next up after hiding the series = %v", ids)
	}
}

// Favorites and other history filters are answered from the user's own
// state; the upstream server ignores Ids and would answer for the shared
// account.
func TestHistoryFilters(t *testing.T) {
	h := newHarness(t)
	alice := h.signIn("alice")
	if r := h.as(alice.Token, "POST", "/emby/Users/"+alice.UserID+"/FavoriteItems/m01MOVIE", ""); r.Status != http.StatusOK || r.json(t)["IsFavorite"] != true {
		t.Fatalf("favorite: %d %s", r.Status, r.Body)
	}
	base := "/emby/Users/" + alice.UserID + "/Items?Recursive=true"
	if ids := itemIDs(t, h.as(alice.Token, "GET", base+"&Filters=IsFavorite", "")); !reflect.DeepEqual(ids, []string{"m01MOVIE"}) {
		t.Errorf("favorites = %v", ids)
	}
	h.as(alice.Token, "POST", "/emby/Users/"+alice.UserID+"/Items/e01EP2/Rating?Likes=true", "")
	if ids := itemIDs(t, h.as(alice.Token, "GET", base+"&Filters=IsFavoriteOrLikes&SortBy=SortName", "")); !reflect.DeepEqual(ids, []string{"e01EP2", "m01MOVIE"}) {
		t.Errorf("favorites or likes = %v", ids)
	}
	if ids := itemIDs(t, h.as(alice.Token, "GET", base+"&Filters=IsFavorite&ParentId=c01SHOWS", "")); len(ids) != 0 {
		t.Errorf("favorites in the shows library = %v", ids)
	}
	if ids := itemIDs(t, h.as(alice.Token, "GET", base+"&Ids=m01MOVIE,e01EP2", "")); !reflect.DeepEqual(ids, []string{"m01MOVIE", "e01EP2"}) {
		t.Errorf("Ids = %v", ids)
	}
	h.as(alice.Token, "POST", "/emby/Users/"+alice.UserID+"/PlayedItems/m01MOVIE", "")
	if ids := itemIDs(t, h.as(alice.Token, "GET", base+"&IsPlayed=false", "")); !reflect.DeepEqual(ids, []string{"m01SERIES"}) {
		t.Errorf("unplayed = %v", ids)
	}
	bob := h.signIn("bob")
	if ids := itemIDs(t, h.as(bob.Token, "GET", "/emby/Users/"+bob.UserID+"/Items?Filters=IsFavorite", "")); len(ids) != 0 {
		t.Errorf("bob's favorites = %v", ids)
	}
}

// Writes that would change the shared upstream account are answered
// locally or refused, never forwarded.
func TestWritesToTheSharedAccountStayLocal(t *testing.T) {
	h := newHarness(t)
	alice := h.signIn("alice")
	h.up.reset()
	for _, c := range []struct{ method, path string }{
		{"POST", "/emby/Users/" + alice.UserID + "/Configuration"},
		{"POST", "/emby/Users/" + alice.UserID + "/Items/e01EP1/Rating?Likes=true"},
		{"POST", "/emby/Users/" + alice.UserID + "/Images/Primary"},
		{"POST", "/emby/Users/" + alice.UserID + "/TypedSettings/x"},
		{"POST", "/emby/Library/Refresh"},
		{"DELETE", "/emby/Items/e01EP1"},
		{"POST", "/emby/Items/e01EP1"},
		{"POST", "/emby/Playlists?Name=x"},
		{"POST", "/emby/Sessions/Playing/Progress"},
	} {
		r := h.as(alice.Token, c.method, c.path, `{}`)
		if r.Status >= 500 || r.Status == http.StatusUnauthorized {
			t.Errorf("%s %s: %d", c.method, c.path, r.Status)
		}
	}
	for _, req := range h.up.seen() {
		if req.Method != http.MethodGet {
			t.Errorf("forwarded %s %s", req.Method, req.Path)
		}
	}
}

// upstream: Emby apps load UserSettings during sign-in with no error
// handling, so a failure hangs the sign-in. The upstream server has no such
// endpoint.
func TestUserSettingsAlwaysAnswer(t *testing.T) {
	h := newHarness(t)
	alice, bob := h.signIn("alice"), h.signIn("bob")
	path := "/emby/UserSettings/" + alice.UserID
	if r := h.as(alice.Token, "GET", path, ""); r.Status != http.StatusOK || len(r.json(t)) != 0 {
		t.Fatalf("empty settings: %d %s", r.Status, r.Body)
	}
	h.as(alice.Token, "POST", path, `{"a":"1","b":"2"}`)
	h.as(alice.Token, "POST", path+"/Partial", `{"b":"3"}`)
	if got := h.as(alice.Token, "GET", path, "").json(t); !reflect.DeepEqual(got, map[string]any{"a": "1", "b": "3"}) {
		t.Errorf("settings = %v", got)
	}
	if got := h.as(bob.Token, "GET", "/emby/UserSettings/"+bob.UserID, "").json(t); len(got) != 0 {
		t.Errorf("bob sees alice's settings: %v", got)
	}
}

func TestServerInfoAdvertisesThisServer(t *testing.T) {
	h := newHarness(t)
	info := h.do("GET", "/emby/System/Info/Public", "").json(t)
	want := h.srv.URL
	if info["LocalAddress"] != want || !reflect.DeepEqual(info["RemoteAddresses"], []any{want}) {
		t.Errorf("addresses point elsewhere: %v", info)
	}
}

// A valid local session never gets 401 because of the upstream side:
// clients would drop the user to the sign-in screen, and signing in again
// would not help.
func TestUpstreamTokenLoss(t *testing.T) {
	h := newHarness(t)
	alice := h.signIn("alice")
	views := "/emby/Users/" + alice.UserID + "/Views"
	if r := h.as(alice.Token, "GET", "/emby/Items/restricted", ""); r.Status != http.StatusForbidden {
		t.Fatalf("restricted item: %d %s", r.Status, r.Body)
	}
	h.up.revoke()
	if r := h.as(alice.Token, "GET", views, ""); r.Status != http.StatusOK {
		t.Fatalf("after the upstream token was revoked: %d %s", r.Status, r.Body)
	}
	h.up.mu.Lock()
	h.up.password = "changed"
	h.up.mu.Unlock()
	h.up.revoke()
	if r := h.as(alice.Token, "GET", views, ""); r.Status != http.StatusBadGateway {
		t.Fatalf("upstream refusing the account: %d %s", r.Status, r.Body)
	}
}

func TestAccountManagement(t *testing.T) {
	h := newHarness(t)
	admin, alice := h.signIn("admin"), h.signIn("alice")

	if r := h.as(alice.Token, "POST", "/emby/Users/New", `{"Name":"mallory","Password":"x"}`); r.Status != http.StatusForbidden {
		t.Errorf("non-admin created a user: %d", r.Status)
	}
	r := h.as(admin.Token, "POST", "/emby/Users/New", `{"Name":"carol","Password":"carol-pw"}`)
	if r.Status != http.StatusOK {
		t.Fatalf("create: %d %s", r.Status, r.Body)
	}
	carolID := r.json(t)["Id"].(string)
	carol := h.signIn("carol")

	// Users change their own password only with the current one.
	if r := h.as(carol.Token, "POST", "/emby/Users/"+carolID+"/Password", `{"CurrentPw":"wrong","NewPw":"n"}`); r.Status != http.StatusForbidden {
		t.Errorf("password change without the current password: %d", r.Status)
	}

	// Disabling signs the account out everywhere and blocks sign-in.
	if r := h.as(admin.Token, "POST", "/emby/Users/"+carolID+"/Policy", `{"IsDisabled":true}`); r.Status != http.StatusNoContent {
		t.Fatalf("disable: %d %s", r.Status, r.Body)
	}
	if r := h.as(carol.Token, "GET", "/emby/Users/"+carolID+"/Views", ""); r.Status != http.StatusUnauthorized {
		t.Errorf("disabled account still signed in: %d", r.Status)
	}
	if r := h.do("POST", "/emby/Users/AuthenticateByName", `{"Username":"carol","Pw":"carol-pw"}`); r.Status != http.StatusUnauthorized {
		t.Errorf("disabled account signed in: %d", r.Status)
	}

	if r := h.as(admin.Token, "DELETE", "/emby/Users/"+carolID, ""); r.Status != http.StatusNoContent {
		t.Fatalf("delete: %d", r.Status)
	}
	users := h.as(admin.Token, "GET", "/emby/Users", "")
	if strings.Contains(string(users.Body), "carol") {
		t.Errorf("deleted user still listed")
	}
	if strings.Contains(string(h.as(alice.Token, "GET", "/emby/Users", "").Body), "admin") {
		t.Errorf("a non-admin can list other users")
	}
}

func TestSignInThrottle(t *testing.T) {
	h := newHarness(t)
	var last int
	for i := 0; i <= attemptsPerAddress; i++ {
		last = h.do("POST", "/emby/Users/AuthenticateByName", `{"Username":"alice","Pw":"guess"}`).Status
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("attempt %d from one address: %d", attemptsPerAddress+1, last)
	}
}

func TestCaddyfile(t *testing.T) {
	d := caddyfile.NewTestDispenser(`emby_users {
		upstream https://emby.example.com
		username {env.EMBY_USERNAME}
		password {env.EMBY_PASSWORD}
		database /data/emby-users.db
		client_name Emby
		device_name Home
		device_id gateway
		client_version 9.8.7
		user_agent "ConfiguredPlayer/42"
		user_image /etc/caddy/avatar.jpg
	}`)
	var got Handler
	if err := got.UnmarshalCaddyfile(d); err != nil {
		t.Fatal(err)
	}
	want := Handler{Upstream: "https://emby.example.com", Username: "{env.EMBY_USERNAME}", Password: "{env.EMBY_PASSWORD}",
		Database: "/data/emby-users.db", ClientName: "Emby", DeviceName: "Home", DeviceID: "gateway",
		ClientVersion: "9.8.7", UserAgent: "ConfiguredPlayer/42", UserImage: "/etc/caddy/avatar.jpg"}
	if !reflect.DeepEqual(&got, &want) {
		t.Errorf("got %+v", &got)
	}
	if err := new(Handler).UnmarshalCaddyfile(caddyfile.NewTestDispenser("emby_users {\n bogus x\n}")); err == nil {
		t.Error("unknown option accepted")
	}
}

// upstream: Emby API, UserDto.PrimaryImageTag names the picture at
// GET /Users/{Id}/Images/Primary, which Emby serves without a token. Lenna
// 1.0.11 shows the signed-in user's picture as the server's icon.
func TestEveryAccountShowsTheConfiguredPicture(t *testing.T) {
	h := newHarness(t)
	alice := h.signIn("alice")
	if r := h.do("GET", "/emby/Users/"+alice.UserID+"/Images/Primary", ""); r.Status != http.StatusNotFound {
		t.Fatalf("picture without user_image: %d", r.Status)
	}
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 64)...)
	path := filepath.Join(t.TempDir(), "avatar.png")
	if err := os.WriteFile(path, png, 0o600); err != nil {
		t.Fatal(err)
	}
	var err error
	if h.app.avatar, err = loadAvatar(path); err != nil {
		t.Fatal(err)
	}
	bob := h.signIn("bob")
	r := h.do(http.MethodPost, "/emby/Users/AuthenticateByName", `{"Username":"bob","Pw":"bob-pw"}`)
	tag, _ := r.json(t)["User"].(map[string]any)["PrimaryImageTag"].(string)
	if got := h.as(bob.Token, "GET", "/emby/Users/"+bob.UserID, "").json(t)["PrimaryImageTag"]; tag == "" || got != tag {
		t.Fatalf("PrimaryImageTag at sign-in %q, from /Users/{id} %v", tag, got)
	}
	r = h.do("GET", "/emby/Users/"+alice.UserID+"/Images/Primary?tag="+tag+"&maxWidth=120", "")
	if r.Status != http.StatusOK || r.Header.Get("Content-Type") != "image/png" || !bytes.Equal(r.Body, png) {
		t.Fatalf("picture: %d %s, %d bytes", r.Status, r.Header.Get("Content-Type"), len(r.Body))
	}
}

// upstream: Jellyfin UserDataManager.UpdatePlayState, which keeps Emby's
// defaults MinResumePct 5, MaxResumePct 90, MinResumeDurationSeconds 300.
func TestSettle(t *testing.T) {
	long, short := hour, int64(120*ticksPerSecond)
	for _, c := range []struct {
		name     string
		pos, run int64
		wantPos  int64
		played   bool
	}{
		{"under 5% does not count", long * 2 / 100, long, 0, false},
		{"middle keeps the position", long / 2, long, long / 2, false},
		{"past 90% is watched", long * 91 / 100, long, 0, true},
		{"last second is watched", long - ticksPerSecond/2, long, 0, true},
		{"short items are watched once started", short / 2, short, 0, true},
		{"unknown runtime keeps the position", 12345, 0, 12345, false},
	} {
		var row store.ItemState
		settle(&row, c.pos, c.run)
		if row.Position != c.wantPos || row.Played != c.played {
			t.Errorf("%s: pos=%d played=%v", c.name, row.Position, row.Played)
		}
	}
}

func TestSwapCredentialsKeepsOtherQueryParameters(t *testing.T) {
	r, _ := http.NewRequest("GET", "http://x/emby/Users/0123456789abcdef0123456789abcdef/Items?SortBy=SortName%2CProductionYear&api_key=old&UserId=0123456789abcdef0123456789abcdef", nil)
	swapCredentials(r, "new", upUser)
	q, _ := url.ParseQuery(r.URL.RawQuery)
	if q.Get("api_key") != "new" || q.Get("UserId") != upUser || q.Get("SortBy") != "SortName,ProductionYear" {
		t.Errorf("query = %s", r.URL.RawQuery)
	}
	if !strings.HasPrefix(r.URL.RawQuery, "SortBy=SortName%2CProductionYear&") {
		t.Errorf("untouched parameters were re-encoded or moved: %s", r.URL.RawQuery)
	}
	if r.URL.Path != "/emby/Users/"+upUser+"/Items" {
		t.Errorf("path = %s", r.URL.Path)
	}
}

// upstream: Emby keeps one session per device. Signing in on a device
// replaces whoever was signed in there before.
func TestOneSessionPerDevice(t *testing.T) {
	h := newHarness(t)
	signIn := func(name string) string {
		r := h.do("POST", "/emby/Users/AuthenticateByName", fmt.Sprintf(`{"Username":%q,"Pw":%q}`, name, name+"-pw"),
			"X-Emby-Authorization", `MediaBrowser Client="TV", Device="Living room", DeviceId="tv-1", Version="1"`)
		return r.json(t)["AccessToken"].(string)
	}
	alice := signIn("alice")
	bob := signIn("bob")
	if r := h.as(alice, "GET", "/emby/Users/Me", ""); r.Status != http.StatusUnauthorized {
		t.Errorf("alice is still signed in on the device bob took over: %d", r.Status)
	}
	if r := h.as(bob, "GET", "/emby/Users/Me", ""); r.Status != http.StatusOK || r.json(t)["Name"] != "bob" {
		t.Errorf("bob: %d %s", r.Status, r.Body)
	}
}

// Some servers answer 401 to a valid token for items the account may not
// see. Repeated requests must not cost an upstream sign-in.
func TestForbiddenUpstreamItemsDoNotSignInAgain(t *testing.T) {
	h := newHarness(t)
	alice := h.signIn("alice")
	h.up.mu.Lock()
	before := h.up.logins
	h.up.mu.Unlock()
	for i := 0; i < 3; i++ {
		if r := h.as(alice.Token, "GET", "/emby/Items/restricted", ""); r.Status != http.StatusForbidden {
			t.Fatalf("restricted item: %d %s", r.Status, r.Body)
		}
	}
	h.up.mu.Lock()
	after := h.up.logins
	h.up.mu.Unlock()
	if after != before {
		t.Errorf("upstream sign-ins went from %d to %d", before, after)
	}
}

// Everyone reaches the upstream server as one client on one device: friends'
// device names, device ids and user agents never leave the gateway.
func TestUpstreamSeesOneDevice(t *testing.T) {
	h := newHarness(t)
	alice := h.signIn("alice")
	bob := h.signIn("bob")
	friendAuth := `Emby UserId="", Client="Infuse", Device="Alice's iPad", DeviceId="ipad-of-alice", Version="7.8", Token="` + alice.Token + `"`
	friend := []string{
		"User-Agent", "Infuse-Direct/7.8",
		"X-Emby-Authorization", friendAuth,
		"Authorization", friendAuth,
		"X-MediaBrowser-Authorization", friendAuth,
		"X-Emby-Device-Name", "Alice's iPad",
		"X-Requested-With", "com.mb.android",
		"Sec-CH-UA-Platform", `"iOS"`,
		"Sec-CH-UA-Mobile", "?1",
	}
	h.do("GET", "/emby/Users/"+alice.UserID+"/Views?X-Emby-Client=Infuse&X-Emby-Device-Id=ipad-of-alice&DeviceId=ipad-of-alice&deviceid=ipad-of-alice&X-Emby-Client-Version=7.8&X-Emby-Authorization="+url.QueryEscape(friendAuth)+"&Authorization="+url.QueryEscape(friendAuth), "", friend...)
	h.do("GET", "/emby/Items/e01EP1/Images/Primary?X-Emby-Device-Id=ipad-of-alice", "", "User-Agent", "Infuse-Direct/7.8")
	h.do("GET", "/play/video/e01EP1?api_key="+alice.Token+"&DeviceId=ipad-of-alice", "", "User-Agent", "Infuse-Direct/7.8")
	h.do("OPTIONS", "/emby/Items/e01EP1?X-Emby-Client=Infuse", "", friend...)
	h.do("GET", "/emby/Users/"+bob.UserID+"/Views?DeviceId=bob-tv", "", "X-Emby-Token", bob.Token, "User-Agent", "SenPlayer/6")
	// Exercise both the token probe and the reauthentication paths.
	h.up.revoke()
	if r := h.as(alice.Token, "GET", "/emby/Users/"+alice.UserID+"/Views", ""); r.Status != http.StatusOK {
		t.Fatalf("request after token revocation: %d %s", r.Status, r.Body)
	}
	h.as(alice.Token, "GET", "/emby/Items/restricted", "")
	reqs := h.up.seen()
	if len(reqs) < 3 {
		t.Fatalf("upstream saw %d requests", len(reqs))
	}
	for _, req := range reqs {
		query, err := url.QueryUnescape(req.Query)
		if err != nil {
			t.Fatal(err)
		}
		all := fmt.Sprint(req.Header) + query
		for _, leak := range []string{"ipad-of-alice", "Alice", "Infuse", "bob-tv", "SenPlayer", "com.mb.android", "iOS"} {
			if strings.Contains(all, leak) {
				t.Errorf("%s %s carries %q: %s", req.Method, req.Path, leak, all)
			}
		}
		if ua := req.Header.Get("User-Agent"); ua != "ConfiguredPlayer/42" {
			t.Errorf("%s: User-Agent %q", req.Path, ua)
		}
		if a := req.Header.Get("X-Emby-Authorization"); !strings.HasPrefix(a, `MediaBrowser Client="gateway", Device="gateway", DeviceId="test-device", Version="9.8.7"`) {
			t.Errorf("%s: X-Emby-Authorization %q", req.Path, a)
		}
	}
}
