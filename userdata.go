package embyusers

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"go.uber.org/zap"

	"github.com/gtoxlili/caddy-emby-users/internal/jsonx"
	"github.com/gtoxlili/caddy-emby-users/internal/store"
)

// itemMeta is what the plugin needs to file state under the right series.
type itemMeta struct {
	ID       string
	Type     string
	SeriesID string
	SeasonID string
	RunTime  int64
	Folder   bool
}

func metaOf(o *jsonx.Object) itemMeta {
	m := itemMeta{
		ID: o.String("Id"), Type: o.String("Type"), SeriesID: o.String("SeriesId"),
		SeasonID: o.String("SeasonId"), Folder: o.Bool("IsFolder"),
	}
	m.RunTime, _ = o.Int("RunTimeTicks")
	if m.Type == "Season" && m.SeriesID == "" {
		m.SeriesID = o.String("ParentId")
	}
	return m
}

// stateFor loads a user's row for an item and fills in where it belongs.
func (a *app) stateFor(ctx context.Context, owner string, m itemMeta) (store.ItemState, error) {
	st, err := a.st.State(ctx, owner, m.ID)
	if err != nil {
		return st, err
	}
	st.Type, st.SeriesID, st.SeasonID = m.Type, m.SeriesID, m.SeasonID
	return st, nil
}

// Emby's default resume rules: under 5% does not count as started; past 90%,
// or within the last second, counts as watched; anything shorter than five
// minutes counts as watched once started.
const (
	minResumePct      = 5.0
	maxResumePct      = 90.0
	minResumeDuration = int64(300 * time.Second / 100)
	ticksPerSecond    = int64(time.Second / 100)
)

// settle applies a stopped position to a row.
func settle(st *store.ItemState, pos, runtime int64) {
	if runtime <= 0 {
		if pos > 0 {
			st.Position = pos
		}
		return
	}
	pct := float64(pos) / float64(runtime) * 100
	switch {
	case pct < minResumePct:
		st.Position = 0
	case pct >= maxResumePct || pos >= runtime-ticksPerSecond || runtime < minResumeDuration:
		if !st.Played {
			st.PlayCount++
		}
		st.Played = true
		st.Position = 0
	default:
		st.Position = pos
		st.Played = false
	}
}

type playEvent int

const (
	playStart playEvent = iota
	playProgress
	playStop
)

// report handles /Sessions/Playing, /Progress and /Stopped. Reports stay
// here: forwarded, every friend's position would land in the shared account's
// history. Streams do not depend on them; transcodes are kept alive by
// /Sessions/Playing/Ping, which is forwarded.
func (a *app) report(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	event := playStart
	switch rc.segs[len(rc.segs)-1] {
	case "progress":
		event = playProgress
	case "stopped":
		event = playStop
	}
	f := fields("application/json", readBody(rc.r))
	itemID := bodyString(f, "itemid")
	if itemID == "" {
		if item, ok := f["nowplayingitem"].(map[string]any); ok {
			for key, value := range item {
				if strings.EqualFold(key, "Id") {
					itemID, _ = value.(string)
					break
				}
			}
		}
	}
	if itemID == "" {
		return noContent(w)
	}
	pos, hasPos := bodyInt(f, "positionticks")
	paused, _ := bodyBool(f, "ispaused")
	if err := a.record(rc, itemID, event, pos, hasPos, paused); err != nil && !errors.Is(err, errNotFound) {
		return err
	}
	return noContent(w)
}

// legacyReport handles /Users/{id}/PlayingItems/{item}[/Progress], which
// older clients use with the position in the query.
func (a *app) legacyReport(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	itemID := rc.raw[3]
	event := playStart
	switch {
	case len(rc.segs) == 5 && rc.segs[4] == "progress":
		event = playProgress
	case len(rc.segs) == 5 && rc.segs[4] == "delete", rc.r.Method == http.MethodDelete:
		event = playStop
	}
	pos, hasPos := int64(0), false
	if v := queryGet(rc.q, "PositionTicks"); v != "" {
		if n, ok := bodyInt(map[string]any{"p": v}, "p"); ok {
			pos, hasPos = n, true
		}
	}
	paused, _ := queryBool(rc.q, "IsPaused")
	if err := a.record(rc, itemID, event, pos, hasPos, paused); err != nil && !errors.Is(err, errNotFound) {
		return err
	}
	return noContent(w)
}

func (a *app) record(rc *reqCtx, itemID string, event playEvent, pos int64, hasPos, paused bool) error {
	ctx := rc.ctx()
	o, err := a.up.item(ctx, itemID)
	if err != nil {
		return err
	}
	m := metaOf(o)
	st, err := a.stateFor(ctx, rc.owner.ID, m)
	if err != nil {
		return err
	}
	now := store.Now()
	st.LastPlayed = now
	switch event {
	case playProgress:
		if hasPos && pos > 0 {
			st.Position = pos
		}
		a.playing.set(rc.sess.ID, playingEntry{itemID: m.ID, position: pos, paused: paused, at: time.Now()})
	case playStart:
		a.playing.set(rc.sess.ID, playingEntry{itemID: m.ID, position: pos, at: time.Now()})
	case playStop:
		// A stop without a position says nothing about how far the user got;
		// real Emby marks it watched, which loses a resume point on clients
		// that omit the field.
		if hasPos {
			settle(&st, pos, m.RunTime)
		}
		a.playing.clear(rc.sess.ID)
	}
	return a.st.PutStates(ctx, rc.owner.ID, []store.ItemState{st})
}

// markPlayed handles POST (played) and DELETE (unplayed) on PlayedItems. A
// series or season marks every episode in it.
func (a *app) markPlayed(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	ctx := rc.ctx()
	played := rc.r.Method == http.MethodPost && rc.segs[len(rc.segs)-1] != "delete"
	o, m, ok := a.target2(w, rc, rc.raw[3])
	if !ok {
		return nil
	}
	when := store.Now()
	if t := parseDate(queryGet(rc.q, "DatePlayed")); t > 0 {
		when = t
	}
	var rows []store.ItemState
	if m.Type == "Series" || m.Type == "Season" {
		seriesID := m.ID
		if m.Type == "Season" {
			seriesID = m.SeriesID
		}
		eps, err := a.up.seriesEpisodes(ctx, seriesID)
		if err != nil {
			return err
		}
		ids := make([]string, 0, len(eps))
		for _, ep := range eps {
			if m.Type == "Season" && ep.SeasonID != m.ID {
				continue
			}
			ids = append(ids, ep.ID)
		}
		states, err := a.st.States(ctx, rc.owner.ID, ids)
		if err != nil {
			return err
		}
		for _, ep := range eps {
			if m.Type == "Season" && ep.SeasonID != m.ID {
				continue
			}
			st := states[ep.ID]
			st.ItemID, st.Type, st.SeriesID, st.SeasonID = ep.ID, "Episode", seriesID, ep.SeasonID
			setPlayed(&st, played, when)
			rows = append(rows, st)
		}
	} else {
		st, err := a.stateFor(ctx, rc.owner.ID, m)
		if err != nil {
			return err
		}
		setPlayed(&st, played, when)
		rows = append(rows, st)
	}
	if err := a.st.PutStates(ctx, rc.owner.ID, rows); err != nil {
		return err
	}
	return a.writeUserData(w, rc, o)
}

func setPlayed(st *store.ItemState, played bool, when int64) {
	if played && !st.Played {
		st.PlayCount++
	}
	st.Played = played
	st.Position = 0
	if played {
		st.LastPlayed = when
	}
}

func (a *app) markFavorite(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	fav := rc.r.Method == http.MethodPost && rc.segs[len(rc.segs)-1] != "delete"
	return a.update(w, rc, rc.raw[3], func(st *store.ItemState) { st.Favorite = fav })
}

func (a *app) rate(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	remove := rc.r.Method == http.MethodDelete || rc.segs[len(rc.segs)-1] == "delete"
	likes, _ := queryBool(rc.q, "Likes")
	return a.update(w, rc, rc.raw[3], func(st *store.ItemState) {
		if remove {
			st.Likes = nil
		} else {
			st.Likes = &likes
		}
	})
}

// itemUserData reads or replaces a UserItemDataDto.
func (a *app) itemUserData(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	if rc.r.Method != http.MethodPost {
		o, _, ok := a.target2(w, rc, rc.raw[3])
		if !ok {
			return nil
		}
		return a.writeUserData(w, rc, o)
	}
	f := fields("application/json", readBody(rc.r))
	return a.update(w, rc, rc.raw[3], func(st *store.ItemState) {
		if v, ok := bodyBool(f, "played"); ok {
			setPlayed(st, v, store.Now())
		}
		if v, ok := bodyBool(f, "isfavorite"); ok {
			st.Favorite = v
		}
		if v, ok := bodyInt(f, "playbackpositionticks"); ok {
			st.Position = v
		}
		if v, ok := bodyInt(f, "playcount"); ok {
			st.PlayCount = v
		}
		if v, ok := bodyBool(f, "likes"); ok {
			st.Likes = &v
		}
		if t := parseDate(bodyString(f, "lastplayeddate")); t > 0 {
			st.LastPlayed = t
		}
	})
}

// hideFromResume removes an item from continue watching until it is played
// again. For an episode the whole series goes, because continue watching
// shows one entry per series.
func (a *app) hideFromResume(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	hide, ok := queryBool(rc.q, "Hide")
	if !ok {
		hide = true
	}
	o, m, found := a.target2(w, rc, rc.raw[3])
	if !found {
		return nil
	}
	key := m
	if m.Type == "Episode" && m.SeriesID != "" {
		key = itemMeta{ID: m.SeriesID, Type: "Series"}
	}
	st, err := a.stateFor(rc.ctx(), rc.owner.ID, key)
	if err != nil {
		return err
	}
	st.HideBefore = 0
	if hide {
		st.HideBefore = store.Now()
	}
	if err := a.st.PutStates(rc.ctx(), rc.owner.ID, []store.ItemState{st}); err != nil {
		return err
	}
	return a.writeUserData(w, rc, o)
}

// update changes one row and answers with the item's new UserItemDataDto.
func (a *app) update(w http.ResponseWriter, rc *reqCtx, id string, change func(*store.ItemState)) error {
	o, m, ok := a.target2(w, rc, id)
	if !ok {
		return nil
	}
	st, err := a.stateFor(rc.ctx(), rc.owner.ID, m)
	if err != nil {
		return err
	}
	change(&st)
	if err := a.st.PutStates(rc.ctx(), rc.owner.ID, []store.ItemState{st}); err != nil {
		return err
	}
	return a.writeUserData(w, rc, o)
}

// target2 fetches the item a state change is about, answering 404 itself
// when it does not exist.
func (a *app) target2(w http.ResponseWriter, rc *reqCtx, id string) (*jsonx.Object, itemMeta, bool) {
	o, err := a.up.item(rc.ctx(), id)
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeText(w, http.StatusNotFound, textNotFound)
		} else {
			a.log.Warn("fetching item", zap.String("id", id), zap.Error(err))
			writeText(w, http.StatusBadGateway, "Upstream server is unavailable.")
		}
		return nil, itemMeta{}, false
	}
	return o, metaOf(o), true
}

// writeUserData answers with the item's UserItemDataDto for the owner.
// Filmly needs Key and ItemId in it to resume.
func (a *app) writeUserData(w http.ResponseWriter, rc *reqCtx, o *jsonx.Object) error {
	if err := a.overlay(rc.ctx(), rc.owner.ID, o); err != nil {
		return err
	}
	ud := o.Object("UserData")
	if ud == nil {
		ud = jsonx.NewObject()
	}
	return a.writeJSON(w, rc, http.StatusOK, ud)
}
