package embyusers

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"go.uber.org/zap"

	"github.com/gtoxlili/caddy-emby-users/internal/jsonx"
	"github.com/gtoxlili/caddy-emby-users/internal/store"
)

// Activity types are the ones Emby 4.10 writes itself, so Emby's dashboard and
// other administration clients read this log as they read Emby's. Renaming has
// no Emby counterpart.
const (
	actSignedIn     = "user.authenticated"
	actSignInFailed = "user.authenticationfailed"
	actCreated      = "user.created"
	actDeleted      = "user.deleted"
	actPassword     = "user.passwordchanged"
	actPolicy       = "user.policyupdated"
	actRenamed      = "user.renamed"
	actPlayback     = "playback.start"
)

// An evening of one series is one entry: starting the same film or series
// again within this window moves the latest entry forward.
const playbackWindow = 30 * time.Minute

// logActivity records an entry for an administrator to read later. The
// caller's request has been answered by then or is about to be; a failed write
// is logged, never returned.
func (a *app) logActivity(rc *reqCtx, e store.Activity) {
	if rc != nil {
		if e.Device == "" {
			e.Device, e.Client = rc.client.Device, rc.client.Name
			if rc.sess != nil {
				e.Device, e.Client = rc.sess.DeviceName, rc.sess.Client
			}
		}
		if e.Remote == "" {
			e.Remote = clientIP(rc.r)
		}
	}
	ctx := context.Background()
	if rc != nil {
		ctx = context.WithoutCancel(rc.ctx())
	}
	var err error
	if e.Type == actPlayback {
		err = a.st.AddPlayback(ctx, e, playbackWindow)
	} else {
		err = a.st.AddActivity(ctx, e)
	}
	if err != nil {
		a.log.Warn("recording activity", zap.String("type", e.Type), zap.Error(err))
	}
}

// actor names the administrator behind an account change; changes people make
// to their own account name no one.
func actor(rc *reqCtx, target *store.User) string {
	if rc.user == nil || rc.user.ID == target.ID {
		return ""
	}
	return rc.user.Name
}

// activityLog serves GET /System/ActivityLog/Entries with StartIndex, Limit,
// MinDate and, beyond Emby, UserId. Entries carry Emby's fields and, for this
// plugin's own web client, the names behind them.
func (a *app) activityLog(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	if !rc.user.Admin {
		return writeText(w, http.StatusForbidden, textForbidden)
	}
	q := store.ActivityQuery{Limit: 100, Since: parseDate(queryGet(rc.q, "MinDate"))}
	if n, err := strconv.Atoi(queryGet(rc.q, "StartIndex")); err == nil && n > 0 {
		q.Start = n
	}
	if n, err := strconv.Atoi(queryGet(rc.q, "Limit")); err == nil && n > 0 {
		q.Limit = min(n, 500)
	}
	if id := queryGet(rc.q, "UserId"); isLocalID(id) {
		q.UserID = id
	}
	rows, total, err := a.st.Activities(rc.ctx(), q)
	if err != nil {
		return err
	}
	items := make([]any, 0, len(rows))
	for _, e := range rows {
		items = append(items, activityDTO(e))
	}
	return a.writeJSON(w, rc, http.StatusOK, obj("Items", items, "TotalRecordCount", total))
}

func activityDTO(e store.Activity) *jsonx.Object {
	o := obj("Id", e.ID, "Name", activityName(e))
	if overview := activityOverview(e); overview != "" {
		o.Set("Overview", overview)
	}
	if e.Detail != "" && e.Type == actPlayback {
		o.Set("ShortOverview", e.Detail)
	}
	o.Set("Type", e.Type)
	if e.ItemID != "" {
		o.Set("ItemId", e.ItemID)
	}
	o.Set("Date", embyDate(e.At))
	if e.UserID != "" {
		o.Set("UserId", e.UserID)
	}
	severity := "Info"
	if e.Type == actSignInFailed {
		severity = "Error"
	}
	o.Set("Severity", severity)
	o.Set("UserName", e.UserName)
	if e.Title != "" {
		o.Set("ItemName", e.Title)
	}
	if e.Detail != "" {
		o.Set("Detail", e.Detail)
	}
	if e.Device != "" {
		o.Set("DeviceName", e.Device)
	}
	if e.ByName != "" {
		o.Set("ByUserName", e.ByName)
	}
	return o
}

// activityName is the entry's one line in English, for clients that only show
// Name. The plugin's web client writes its own from the fields.
func activityName(e store.Activity) string {
	by := ""
	if e.ByName != "" {
		by = " by " + e.ByName
	}
	switch e.Type {
	case actSignedIn:
		return fmt.Sprintf("%s signed in on %s", e.UserName, e.Device)
	case actSignInFailed:
		return fmt.Sprintf("Failed sign-in attempt as %s", e.UserName)
	case actPlayback:
		if e.Detail != "" {
			return fmt.Sprintf("%s is playing %s %s", e.UserName, e.Title, e.Detail)
		}
		return fmt.Sprintf("%s is playing %s", e.UserName, e.Title)
	case actCreated:
		return fmt.Sprintf("User %s was created%s", e.UserName, by)
	case actDeleted:
		return fmt.Sprintf("User %s was deleted%s", e.UserName, by)
	case actPassword:
		return fmt.Sprintf("Password of %s was changed%s", e.UserName, by)
	case actPolicy:
		return fmt.Sprintf("Policy of %s was updated%s: %s", e.UserName, by, e.Detail)
	case actRenamed:
		return fmt.Sprintf("%s was renamed to %s%s", e.Detail, e.UserName, by)
	}
	return e.Type
}

func activityOverview(e store.Activity) string {
	var parts []string
	for _, s := range []string{e.Device, e.Client, e.Remote} {
		if s != "" {
			parts = append(parts, s)
		}
	}
	if e.Type == actSignInFailed && e.Detail != "" {
		parts = append(parts, e.Detail)
	}
	return strings.Join(parts, ", ")
}

// policyChanges lists what a policy update changed, as on/off tokens the web
// client translates.
func policyChanges(before *store.User, admin, disabled bool) string {
	var out []string
	if before.Admin != admin {
		out = append(out, "admin:"+onOff(admin))
	}
	if before.Disabled != disabled {
		out = append(out, "disabled:"+onOff(disabled))
	}
	return strings.Join(out, ",")
}

func onOff(v bool) string {
	if v {
		return "on"
	}
	return "off"
}

// playbackTitle is what an entry says was played: a film's name, or a
// series' name with the episode as S01E02 and its title.
func playbackTitle(o *jsonx.Object) (title, detail string) {
	if o.String("Type") != "Episode" || o.String("SeriesName") == "" {
		return o.String("Name"), ""
	}
	season, _ := o.Int("ParentIndexNumber")
	episode, ok := o.Int("IndexNumber")
	if !ok {
		return o.String("SeriesName"), o.String("Name")
	}
	return o.String("SeriesName"), strings.TrimSpace(fmt.Sprintf("S%02dE%02d %s", season, episode, o.String("Name")))
}
