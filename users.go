package embyusers

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"go.uber.org/zap"

	"github.com/gtoxlili/caddy-emby-users/internal/jsonx"
	"github.com/gtoxlili/caddy-emby-users/internal/store"
)

const prefConfiguration = "configuration"

func (a *app) login(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	f := fields(rc.r.Header.Get("Content-Type"), readBody(rc.r))
	name := strings.TrimSpace(bodyString(f, "username"))
	pw := bodyString(f, "pw")
	if pw == "" {
		pw = bodyString(f, "password")
	}
	u, err := a.st.UserByName(rc.ctx(), name)
	if err != nil {
		return err
	}
	return a.signIn(w, rc, u, name, pw)
}

// loginByID serves clients that list users and sign in by id.
func (a *app) loginByID(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	f := fields(rc.r.Header.Get("Content-Type"), readBody(rc.r))
	pw := bodyString(f, "pw")
	if pw == "" {
		pw = bodyString(f, "password")
	}
	if pw == "" {
		pw = queryGet(rc.q, "pw")
	}
	u, err := a.st.UserByID(rc.ctx(), rc.segs[1])
	if err != nil {
		return err
	}
	name := rc.segs[1]
	if u != nil {
		name = u.Name
	}
	return a.signIn(w, rc, u, name, pw)
}

func (a *app) signIn(w http.ResponseWriter, rc *reqCtx, u *store.User, name, pw string) error {
	addr := clientIP(rc.r)
	if !a.limiter.allowAttempt(addr) || a.limiter.nameBlocked(name) {
		a.log.Warn("sign-in throttled", zap.String("user", name), zap.String("remote", addr))
		return writeText(w, http.StatusTooManyRequests, "Too many sign-in attempts. Try again later.")
	}
	if !a.st.CheckPassword(u, pw) {
		a.limiter.fail(name)
		a.log.Warn("sign-in failed", zap.String("user", name), zap.String("remote", addr),
			zap.String("client", rc.client.Name), zap.String("device", rc.client.Device))
		failed := store.Activity{Type: actSignInFailed, UserName: name}
		if u != nil {
			failed.UserID, failed.UserName = u.ID, u.Name
		}
		a.logActivity(rc, failed)
		return writeText(w, http.StatusUnauthorized, "Invalid username or password entered.")
	}
	if u.Disabled {
		a.logActivity(rc, store.Activity{Type: actSignInFailed, UserID: u.ID, UserName: u.Name, Detail: "account disabled"})
		return writeText(w, http.StatusUnauthorized, "This user account has been disabled.")
	}
	if err := a.up.ensure(rc.ctx()); err != nil {
		a.log.Error("upstream sign-in", zap.Error(err))
		return writeText(w, http.StatusBadGateway, "Upstream sign-in failed.")
	}
	token := store.RandomID()
	deviceID := rc.client.DeviceID
	if deviceID == "" {
		deviceID = store.RandomID()
	}
	now := store.Now()
	sess := &store.Session{
		UserID: u.ID, DeviceID: deviceID, DeviceName: rc.client.Device, Client: rc.client.Name,
		Version: rc.client.Version, RemoteAddr: addr, Created: now, Seen: now,
	}
	if err := a.st.CreateSession(rc.ctx(), token, sess); err != nil {
		return err
	}
	if err := a.st.TouchLogin(rc.ctx(), u.ID, now); err != nil {
		return err
	}
	u.LastLogin = now
	// The same device may have been signed in as someone else a moment ago.
	a.sessions.invalidate()
	a.log.Info("signed in", zap.String("user", u.Name), zap.String("remote", addr),
		zap.String("client", rc.client.Name), zap.String("device", rc.client.Device))
	a.logActivity(rc, store.Activity{Type: actSignedIn, UserID: u.ID, UserName: u.Name})

	dto, err := a.userDTO(rc.ctx(), u)
	if err != nil {
		return err
	}
	_, _, serverID := a.up.credentials()
	rc.token, rc.user = token, u
	return a.writeJSON(w, rc, http.StatusOK, obj(
		"User", dto,
		"SessionInfo", sessionInfo(&store.SessionWithUser{Session: *sess, UserName: u.Name}, serverID, nil),
		"AccessToken", token,
		"ServerId", serverID,
	))
}

// publicUsers lists no one: the server is on the internet and the sign-in
// screen falls back to a name field.
func (a *app) publicUsers(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	return a.writeJSON(w, rc, http.StatusOK, []any{})
}

// systemInfo serves /System/Info and /System/Info/Public from the upstream
// server with its addresses replaced by this one. Clients try the advertised
// local address first, and the upstream server's is not reachable for them.
func (a *app) systemInfo(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	path := "/System/Info"
	if len(rc.segs) == 3 {
		path = "/System/Info/Public"
	}
	raw, err := a.serverInfo(rc.ctx(), path)
	if err != nil {
		a.log.Error("fetching server info", zap.Error(err))
		return writeText(w, http.StatusBadGateway, "Upstream server is unavailable.")
	}
	v, err := jsonx.Decode(raw)
	if err != nil {
		return err
	}
	info, ok := v.(*jsonx.Object)
	if !ok {
		return writeText(w, http.StatusBadGateway, "Upstream server is unavailable.")
	}
	base := externalBase(rc.r)
	for _, k := range []string{"LocalAddress", "WanAddress"} {
		if _, ok := info.Get(k); ok {
			info.Set(k, base)
		}
	}
	for _, k := range []string{"LocalAddresses", "RemoteAddresses"} {
		if _, ok := info.Get(k); ok {
			info.Set(k, []any{base})
		}
	}
	return a.writeJSON(w, rc, http.StatusOK, info)
}

// systemEndpoint tells clients they are remote, so they stream through the
// server instead of trying a local file path.
func (a *app) systemEndpoint(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	return a.writeJSON(w, rc, http.StatusOK, obj("IsLocal", false, "IsInNetwork", false))
}

// userDTO renders a local account. The same object goes out at sign-in and
// from GET /Users/{id}; clients compare the two.
func (a *app) userDTO(ctx context.Context, u *store.User) (*jsonx.Object, error) {
	if err := a.up.ensure(ctx); err != nil {
		return nil, err
	}
	_, _, serverID := a.up.credentials()
	cfg := defaultConfiguration()
	policy := defaultPolicy(u)
	if up, err := a.up.user(ctx); err == nil {
		if c := up.Object("Configuration"); c != nil {
			mergeObject(cfg, c)
		}
		if p := up.Object("Policy"); p != nil {
			if v, ok := p.Get("EnableContentDownloading"); ok {
				policy.Set("EnableContentDownloading", v)
			}
		}
	} else {
		a.log.Debug("fetching upstream user", zap.Error(err))
	}
	if raw, err := a.st.Pref(ctx, u.ID, prefConfiguration); err != nil {
		return nil, err
	} else if raw != "" {
		if v, err := jsonx.Decode([]byte(raw)); err == nil {
			if o, ok := v.(*jsonx.Object); ok {
				mergeObject(cfg, o)
			}
		}
	}
	dto := obj(
		"Name", u.Name,
		"ServerId", serverID,
		"Id", u.ID,
		"DateCreated", embyDate(u.Created),
		"HasPassword", u.HasPassword,
		"HasConfiguredPassword", u.HasPassword,
		"HasConfiguredEasyPassword", false,
		"EnableAutoLogin", false,
	)
	last := u.Created
	if u.LastLogin > 0 {
		dto.Set("LastLoginDate", embyDate(u.LastLogin))
		last = u.LastLogin
	}
	dto.Set("LastActivityDate", embyDate(last))
	dto.Set("Configuration", cfg)
	dto.Set("Policy", policy)
	return dto, nil
}

// mergeObject copies src's non-null keys into dst.
func mergeObject(dst, src *jsonx.Object) {
	for _, k := range src.Keys() {
		if v, _ := src.Get(k); v != nil {
			dst.Set(k, v)
		}
	}
}

// defaultConfiguration lists every field clients read without a null check.
// The home screen calls LatestItemsExcludes.includes() directly and spins
// forever when it is missing.
func defaultConfiguration() *jsonx.Object {
	return obj(
		"PlayDefaultAudioTrack", true,
		"SubtitleLanguagePreference", "",
		"DisplayMissingEpisodes", false,
		"SubtitleMode", "Smart",
		"OrderedViews", []any{},
		"LatestItemsExcludes", []any{},
		"MyMediaExcludes", []any{},
		"HidePlayedInLatest", true,
		"HidePlayedInMoreLikeThis", false,
		"HidePlayedInSuggestions", false,
		"RememberAudioSelections", true,
		"RememberSubtitleSelections", true,
		"EnableNextEpisodeAutoPlay", true,
		"ResumeRewindSeconds", 0,
		"IntroSkipMode", "ShowButton",
		"EnableLocalPassword", false,
	)
}

// defaultPolicy describes what the account may do. Every array is present:
// strict clients fail to parse a Policy with a missing one.
func defaultPolicy(u *store.User) *jsonx.Object {
	return obj(
		"IsAdministrator", u.Admin,
		"IsHidden", true,
		"IsHiddenRemotely", true,
		"IsHiddenFromUnusedDevices", true,
		"IsDisabled", u.Disabled,
		"BlockedTags", []any{},
		"IncludeTags", []any{},
		"AccessSchedules", []any{},
		"BlockUnratedItems", []any{},
		"EnableUserPreferenceAccess", true,
		"EnableRemoteControlOfOtherUsers", false,
		"EnableSharedDeviceControl", false,
		"EnableRemoteAccess", true,
		"EnableMediaPlayback", true,
		"EnableAudioPlaybackTranscoding", true,
		"EnableVideoPlaybackTranscoding", true,
		"EnablePlaybackRemuxing", true,
		"EnableContentDeletion", false,
		"EnableContentDeletionFromFolders", []any{},
		"EnableContentDownloading", false,
		"EnableSubtitleDownloading", false,
		"EnableSubtitleManagement", false,
		"EnableSyncTranscoding", false,
		"EnableMediaConversion", false,
		"EnableLiveTvAccess", false,
		"EnableLiveTvManagement", false,
		"EnablePublicSharing", false,
		"EnableAllFolders", true,
		"EnabledFolders", []any{},
		"EnableAllChannels", true,
		"EnabledChannels", []any{},
		"EnableAllDevices", true,
		"EnabledDevices", []any{},
		"ExcludedSubFolders", []any{},
		"RestrictedFeatures", []any{},
		"SimultaneousStreamLimit", 0,
		"RemoteClientBitrateLimit", 0,
		"InvalidLoginAttemptCount", 0,
	)
}

// ---- account management, all on Emby's own endpoints ----

func (a *app) listUsers(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	list, err := a.visibleUsers(rc)
	if err != nil {
		return err
	}
	return a.writeJSON(w, rc, http.StatusOK, list)
}

func (a *app) queryUsers(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	list, err := a.visibleUsers(rc)
	if err != nil {
		return err
	}
	return a.writeJSON(w, rc, http.StatusOK, obj("Items", list, "TotalRecordCount", len(list)))
}

// visibleUsers is everyone for an administrator and the caller otherwise.
func (a *app) visibleUsers(rc *reqCtx) ([]any, error) {
	users := []*store.User{rc.user}
	if rc.user.Admin {
		var err error
		if users, err = a.st.Users(rc.ctx()); err != nil {
			return nil, err
		}
	}
	out := make([]any, 0, len(users))
	for _, u := range users {
		dto, err := a.userDTO(rc.ctx(), u)
		if err != nil {
			return nil, err
		}
		out = append(out, dto)
	}
	return out, nil
}

func (a *app) getMe(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	dto, err := a.userDTO(rc.ctx(), rc.user)
	if err != nil {
		return err
	}
	return a.writeJSON(w, rc, http.StatusOK, dto)
}

// getUser returns the named user to an administrator. Anyone else gets their
// own account whatever id they ask for, which is what clients that cached an
// old id expect.
func (a *app) getUser(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	u := rc.user
	if rc.user.Admin {
		found, err := a.st.UserByID(rc.ctx(), rc.segs[1])
		if err != nil {
			return err
		}
		if found == nil {
			return writeText(w, http.StatusNotFound, textNotFound)
		}
		u = found
	}
	dto, err := a.userDTO(rc.ctx(), u)
	if err != nil {
		return err
	}
	return a.writeJSON(w, rc, http.StatusOK, dto)
}

func validName(name string) bool {
	if name == "" || utf8.RuneCountInString(name) > 64 || strings.TrimSpace(name) != name {
		return false
	}
	for _, r := range name {
		if unicode.IsControl(r) || r == '/' || r == '\\' {
			return false
		}
	}
	return true
}

// createUser takes {Name, Password}. Password is optional; an account without
// one cannot sign in until an administrator sets it.
func (a *app) createUser(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	if !rc.user.Admin {
		return writeText(w, http.StatusForbidden, textForbidden)
	}
	f := fields(rc.r.Header.Get("Content-Type"), readBody(rc.r))
	name := bodyString(f, "name")
	if !validName(name) {
		return writeText(w, http.StatusBadRequest, "Name must be 1 to 64 characters without slashes or surrounding spaces.")
	}
	u, err := a.st.CreateUser(rc.ctx(), name, bodyString(f, "password"), false)
	if errors.Is(err, store.ErrNameTaken) {
		return writeText(w, http.StatusBadRequest, "A user with that name already exists.")
	}
	if err != nil {
		return err
	}
	a.log.Info("user created", zap.String("user", name), zap.String("by", rc.user.Name))
	a.logActivity(rc, store.Activity{Type: actCreated, UserID: u.ID, UserName: u.Name, ByName: rc.user.Name})
	dto, err := a.userDTO(rc.ctx(), u)
	if err != nil {
		return err
	}
	return a.writeJSON(w, rc, http.StatusOK, dto)
}

// updateUser renames an account. Other UserDto fields are ignored.
func (a *app) updateUser(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	target, ok := a.target(w, rc)
	if !ok {
		return nil
	}
	f := fields("application/json", readBody(rc.r))
	name := bodyString(f, "name")
	if name == "" || name == target.Name {
		return noContent(w)
	}
	if !validName(name) {
		return writeText(w, http.StatusBadRequest, "Name must be 1 to 64 characters without slashes or surrounding spaces.")
	}
	if err := a.st.RenameUser(rc.ctx(), target.ID, name); errors.Is(err, store.ErrNameTaken) {
		return writeText(w, http.StatusBadRequest, "A user with that name already exists.")
	} else if err != nil {
		return err
	}
	a.sessions.invalidate()
	a.log.Info("user renamed", zap.String("from", target.Name), zap.String("to", name), zap.String("by", rc.user.Name))
	a.logActivity(rc, store.Activity{Type: actRenamed, UserID: target.ID, UserName: name, Detail: target.Name, ByName: actor(rc, target)})
	return noContent(w)
}

// target is the account a self-or-admin request acts on: the path id for an
// administrator, the caller for anyone else.
func (a *app) target(w http.ResponseWriter, rc *reqCtx) (*store.User, bool) {
	if !rc.user.Admin {
		return rc.user, true
	}
	if rc.owner != rc.user {
		return rc.owner, true
	}
	if id := rc.segs[1]; !strings.EqualFold(id, rc.user.ID) {
		writeText(w, http.StatusNotFound, textNotFound)
		return nil, false
	}
	return rc.user, true
}

func (a *app) deleteUser(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	if !rc.user.Admin {
		return writeText(w, http.StatusForbidden, textForbidden)
	}
	u, err := a.st.UserByID(rc.ctx(), rc.segs[1])
	if err != nil {
		return err
	}
	if u == nil {
		return writeText(w, http.StatusNotFound, textNotFound)
	}
	if u.ID == rc.user.ID {
		return writeText(w, http.StatusBadRequest, "You cannot delete your own account.")
	}
	if err := a.st.DeleteUser(rc.ctx(), u.ID); err != nil {
		return err
	}
	a.sessions.invalidate()
	a.log.Info("user deleted", zap.String("user", u.Name), zap.String("by", rc.user.Name))
	a.logActivity(rc, store.Activity{Type: actDeleted, UserID: u.ID, UserName: u.Name, ByName: rc.user.Name})
	return noContent(w)
}

// changePassword takes {CurrentPw, NewPw, ResetPassword}. Users changing
// their own password must give the current one; administrators setting
// someone else's do not. Every other session of the account is signed out.
func (a *app) changePassword(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	target, ok := a.target(w, rc)
	if !ok {
		return nil
	}
	f := fields(rc.r.Header.Get("Content-Type"), readBody(rc.r))
	self := target.ID == rc.user.ID
	if reset, _ := bodyBool(f, "resetpassword"); reset {
		if self {
			return writeText(w, http.StatusBadRequest, "You cannot reset your own password.")
		}
		if err := a.st.SetPassword(rc.ctx(), target.ID, ""); err != nil {
			return err
		}
		if err := a.st.DeleteUserSessions(rc.ctx(), target.ID, ""); err != nil {
			return err
		}
		a.sessions.invalidate()
		a.log.Info("password cleared", zap.String("user", target.Name), zap.String("by", rc.user.Name))
		a.logActivity(rc, store.Activity{Type: actPassword, UserID: target.ID, UserName: target.Name, Detail: "cleared", ByName: actor(rc, target)})
		return noContent(w)
	}
	next := bodyString(f, "newpw")
	if next == "" {
		next = bodyString(f, "newpassword")
	}
	if next == "" {
		return writeText(w, http.StatusBadRequest, "New password is required.")
	}
	if self && target.HasPassword {
		current := bodyString(f, "currentpw")
		if current == "" {
			current = bodyString(f, "currentpassword")
		}
		if !a.st.CheckPassword(target, current) {
			return writeText(w, http.StatusForbidden, "Current password is incorrect.")
		}
	}
	if err := a.st.SetPassword(rc.ctx(), target.ID, next); err != nil {
		return err
	}
	keep := ""
	if self {
		keep = rc.token
	}
	if err := a.st.DeleteUserSessions(rc.ctx(), target.ID, keep); err != nil {
		return err
	}
	a.sessions.invalidate()
	a.log.Info("password changed", zap.String("user", target.Name), zap.String("by", rc.user.Name))
	a.logActivity(rc, store.Activity{Type: actPassword, UserID: target.ID, UserName: target.Name, ByName: actor(rc, target)})
	return noContent(w)
}

// setPolicy honours IsAdministrator and IsDisabled. Disabling an account
// signs it out everywhere.
func (a *app) setPolicy(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	if !rc.user.Admin {
		return writeText(w, http.StatusForbidden, textForbidden)
	}
	u, err := a.st.UserByID(rc.ctx(), rc.segs[1])
	if err != nil {
		return err
	}
	if u == nil {
		return writeText(w, http.StatusNotFound, textNotFound)
	}
	f := fields("application/json", readBody(rc.r))
	admin, disabled := u.Admin, u.Disabled
	if v, ok := bodyBool(f, "isadministrator"); ok {
		admin = v
	}
	if v, ok := bodyBool(f, "isdisabled"); ok {
		disabled = v
	}
	if u.ID == rc.user.ID && (!admin || disabled) {
		return writeText(w, http.StatusBadRequest, "You cannot remove your own administrator rights.")
	}
	if err := a.st.SetFlags(rc.ctx(), u.ID, admin, disabled); err != nil {
		return err
	}
	if changes := policyChanges(u, admin, disabled); changes != "" {
		a.logActivity(rc, store.Activity{Type: actPolicy, UserID: u.ID, UserName: u.Name, Detail: changes, ByName: actor(rc, u)})
	}
	if disabled {
		if err := a.st.DeleteUserSessions(rc.ctx(), u.ID, ""); err != nil {
			return err
		}
	}
	a.sessions.invalidate()
	a.log.Info("policy changed", zap.String("user", u.Name), zap.Bool("admin", admin), zap.Bool("disabled", disabled), zap.String("by", rc.user.Name))
	return noContent(w)
}

// setConfiguration stores the account's display settings (autoplay, subtitle
// mode, home screen order) for that account alone.
func (a *app) setConfiguration(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	target, ok := a.target(w, rc)
	if !ok {
		return nil
	}
	v, err := jsonx.Decode(readBody(rc.r))
	if err != nil {
		return writeText(w, http.StatusBadRequest, "Body must be a JSON object.")
	}
	o, ok := v.(*jsonx.Object)
	if !ok {
		return writeText(w, http.StatusBadRequest, "Body must be a JSON object.")
	}
	clean := jsonx.NewObject()
	mergeObject(clean, o)
	raw, err := jsonx.Encode(clean)
	if err != nil {
		return err
	}
	if err := a.st.SetPref(rc.ctx(), target.ID, prefConfiguration, string(raw)); err != nil {
		return err
	}
	return noContent(w)
}
