package embyusers

import (
	"context"

	"github.com/gtoxlili/caddy-emby-users/internal/jsonx"
	"github.com/gtoxlili/caddy-emby-users/internal/store"
)

// overlay replaces the upstream account's UserData on every item in doc with
// the owner's own state. Items the owner never touched read as unplayed.
func (a *app) overlay(ctx context.Context, owner string, doc any) error {
	var items []*jsonx.Object
	jsonx.Walk(doc, func(o *jsonx.Object) {
		if o.Object("UserData") != nil && o.String("Id") != "" {
			items = append(items, o)
		}
	})
	if len(items) == 0 {
		return nil
	}
	ids := make([]string, 0, len(items))
	var series, seasons []string
	for _, it := range items {
		id := it.String("Id")
		ids = append(ids, id)
		switch it.String("Type") {
		case "Series":
			series = append(series, id)
		case "Season":
			seasons = append(seasons, id)
		}
	}
	states, err := a.st.States(ctx, owner, ids)
	if err != nil {
		return err
	}
	tallies := map[string]store.Tally{}
	for col, list := range map[string][]string{"series_id": series, "season_id": seasons} {
		if len(list) == 0 {
			continue
		}
		t, err := a.st.PlayedTallies(ctx, owner, col, list)
		if err != nil {
			return err
		}
		for k, v := range t {
			tallies[k] = v
		}
	}
	for _, it := range items {
		id := it.String("Id")
		st := states[id]
		st.ItemID = id
		it.Set("UserData", userData(it, st, tallies[id]))
	}
	return nil
}

// userData builds a UserItemDataDto for item from one user's state.
func userData(item *jsonx.Object, st store.ItemState, tally store.Tally) *jsonx.Object {
	ud := jsonx.NewObject()
	if up := item.Object("UserData"); up != nil {
		for _, k := range []string{"Key", "ItemId", "ServerId"} {
			if v, ok := up.Get(k); ok {
				ud.Set(k, v)
			}
		}
	}
	if ud.String("ItemId") == "" {
		ud.Set("Key", st.ItemID).Set("ItemId", st.ItemID)
		if sid := item.String("ServerId"); sid != "" {
			ud.Set("ServerId", sid)
		}
	}
	switch typ := item.String("Type"); {
	case typ == "Series" || typ == "Season":
		total, known := item.Int("RecursiveItemCount")
		if !known {
			total, known = item.Int("ChildCount")
			if typ == "Series" {
				// A series' ChildCount counts seasons, not episodes.
				known = false
			}
		}
		played := tally.Played
		if known {
			unplayed := total - played
			if unplayed < 0 {
				unplayed = 0
			}
			ud.Set("UnplayedItemCount", unplayed)
			if played > 0 && unplayed > 0 {
				ud.Set("PlayedPercentage", float64(played)/float64(total)*100)
			}
		}
		ud.Set("PlaybackPositionTicks", int64(0))
		ud.Set("PlayCount", st.PlayCount)
		ud.Set("IsFavorite", st.Favorite)
		ud.Set("Played", known && total > 0 && played >= total)
		if tally.LastPlayed > 0 {
			ud.Set("LastPlayedDate", embyDate(tally.LastPlayed))
		}
	case item.Bool("IsFolder"):
		ud.Set("PlaybackPositionTicks", int64(0))
		ud.Set("PlayCount", st.PlayCount)
		ud.Set("IsFavorite", st.Favorite)
		ud.Set("Played", st.Played)
	default:
		ud.Set("PlaybackPositionTicks", st.Position)
		ud.Set("PlayCount", st.PlayCount)
		ud.Set("IsFavorite", st.Favorite)
		ud.Set("Played", st.Played)
		if runtime, ok := item.Int("RunTimeTicks"); ok && runtime > 0 && st.Position > 0 {
			ud.Set("PlayedPercentage", float64(st.Position)/float64(runtime)*100)
		}
		if st.LastPlayed > 0 {
			ud.Set("LastPlayedDate", embyDate(st.LastPlayed))
		}
	}
	if st.Likes != nil {
		ud.Set("Likes", *st.Likes)
	}
	return ud
}
