package embyusers

import (
	"context"
	"encoding/json"
	"math/rand/v2"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/caddyserver/caddy/v2/modules/caddyhttp"

	"github.com/gtoxlili/caddy-emby-users/internal/jsonx"
	"github.com/gtoxlili/caddy-emby-users/internal/store"
)

// maxCandidates caps how many items a state-driven list fetches one by one.
const maxCandidates = 500

// point is where a user would pick up: one per series, plus unfinished
// movies.
type point struct {
	id       string
	position int64
}

// continuePoints walks the user's history, newest first. For a series the
// most recently touched episode decides: unfinished, resume it; finished, the
// next unwatched episode after it; none left, nothing.
func (a *app) continuePoints(ctx context.Context, owner, onlySeries string) ([]point, error) {
	rows, err := a.st.Recent(ctx, owner, 2000)
	if err != nil {
		return nil, err
	}
	var seriesIDs []string
	for _, r := range rows {
		if r.SeriesID != "" {
			seriesIDs = append(seriesIDs, r.SeriesID)
		}
	}
	hidden, err := a.st.States(ctx, owner, seriesIDs)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var out []point
	for _, r := range rows {
		if r.Type == "Episode" && r.SeriesID != "" {
			s := r.SeriesID
			if (onlySeries != "" && s != onlySeries) || seen[s] {
				continue
			}
			seen[s] = true
			if hidden[s].HideBefore >= r.LastPlayed {
				continue
			}
			if !r.Played {
				out = append(out, point{id: r.ItemID, position: r.Position})
				continue
			}
			next, err := a.nextEpisode(ctx, owner, s, r.ItemID)
			if err != nil {
				continue
			}
			if next != "" {
				out = append(out, point{id: next})
			}
			continue
		}
		if onlySeries == "" && r.Type != "Series" && r.Type != "Season" && !r.Played && r.Position > 0 && r.HideBefore < r.LastPlayed {
			out = append(out, point{id: r.ItemID, position: r.Position})
		}
	}
	return out, nil
}

// nextEpisode is the first unwatched episode after `after`, skipping
// specials unless `after` is one.
func (a *app) nextEpisode(ctx context.Context, owner, seriesID, after string) (string, error) {
	eps, err := a.up.seriesEpisodes(ctx, seriesID)
	if err != nil {
		return "", err
	}
	at := -1
	for i, ep := range eps {
		if ep.ID == after {
			at = i
			break
		}
	}
	if at < 0 {
		return "", nil
	}
	rest := eps[at+1:]
	ids := make([]string, len(rest))
	for i, ep := range rest {
		ids[i] = ep.ID
	}
	states, err := a.st.States(ctx, owner, ids)
	if err != nil {
		return "", err
	}
	for _, ep := range rest {
		if ep.Season == 0 && eps[at].Season != 0 {
			continue
		}
		if !states[ep.ID].Played {
			return ep.ID, nil
		}
	}
	return "", nil
}

// seriesScope reports which series a ParentId names, if it names one. The
// official app's Play button on a series asks Resume?ParentId={series} from
// 4.9.1 on, and NextUp?SeriesId={series} before that.
func (a *app) seriesScope(ctx context.Context, parent string) (series string, isItem bool) {
	if parent == "" {
		return "", false
	}
	o, err := a.up.item(ctx, parent)
	if err != nil {
		return "", false
	}
	switch o.String("Type") {
	case "Series":
		return parent, true
	case "Season":
		return metaOf(o).SeriesID, true
	case "Episode", "Movie", "Video":
		return "", true
	}
	return "", false
}

func (a *app) resume(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	ctx := rc.ctx()
	parent := queryGet(rc.q, "ParentId")
	series, isItem := a.seriesScope(ctx, parent)
	if isItem && series == "" {
		return a.writeList(w, rc, nil, 0)
	}
	points, err := a.continuePoints(ctx, rc.owner.ID, series)
	if err != nil {
		return err
	}
	nextUp, _ := queryBool(rc.q, "IncludeNextUp")
	var ids []string
	for _, p := range points {
		// Scoped to a series, the next episode counts too: without it the
		// Play button starts the series over.
		if series != "" || nextUp || p.position > 0 {
			ids = append(ids, p.id)
		}
	}
	opts := listOptions(rc)
	if series != "" {
		opts.parent = ""
	}
	return a.collect(w, rc, ids, opts)
}

func (a *app) nextUp(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	series := queryGet(rc.q, "SeriesId")
	points, err := a.continuePoints(rc.ctx(), rc.owner.ID, series)
	if err != nil {
		return err
	}
	var ids []string
	for _, p := range points {
		if series != "" || p.position == 0 {
			ids = append(ids, p.id)
		}
	}
	return a.collect(w, rc, ids, listOptions(rc))
}

// latest hides what the user has watched when their settings ask for it.
// The upstream server applies the shared account's history, which is not
// this user's.
func (a *app) latest(w http.ResponseWriter, rc *reqCtx, next caddyhttp.Handler) error {
	played, filter := queryBool(rc.q, "IsPlayed")
	if !filter {
		cfg, err := a.effectiveConfiguration(rc.ctx(), rc.owner)
		if err != nil {
			return err
		}
		filter = cfg.Bool("HidePlayedInLatest")
		played = false
	}
	return a.proxy(w, withoutUserFilters(rc), next, func(_ context.Context, _ *reqCtx, doc any) (any, error) {
		if !filter {
			return doc, nil
		}
		list, ok := doc.([]any)
		if !ok {
			return doc, nil
		}
		out := list[:0]
		for _, it := range list {
			o, _ := it.(*jsonx.Object)
			if o != nil && o.Object("UserData") != nil && o.Object("UserData").Bool("Played") != played {
				continue
			}
			out = append(out, it)
		}
		return out, nil
	})
}

// effectiveConfiguration is the user's Configuration as their UserDto shows it.
func (a *app) effectiveConfiguration(ctx context.Context, u *store.User) (*jsonx.Object, error) {
	dto, err := a.userDTO(ctx, u)
	if err != nil {
		return nil, err
	}
	return dto.Object("Configuration"), nil
}

// userFilters are the parts of an item query that depend on play state.
type userFilters struct {
	favorite        *bool
	favoriteOrLikes bool
	likes           *bool
	resumable       bool
	played          *bool
	byHistory       bool
}

func parseUserFilters(rc *reqCtx) userFilters {
	var f userFilters
	t, ff := true, false
	for _, v := range queryList(rc.q, "Filters") {
		switch v {
		case "isfavorite":
			f.favorite = &t
		case "isfavoriteorlikes":
			f.favoriteOrLikes = true
		case "likes":
			f.likes = &t
		case "dislikes":
			f.likes = &ff
		case "isresumable":
			f.resumable = true
		case "isplayed":
			f.played = &t
		case "isunplayed":
			f.played = &ff
		}
	}
	if v, ok := queryBool(rc.q, "IsFavorite"); ok {
		f.favorite = &v
	}
	if v, ok := queryBool(rc.q, "IsPlayed"); ok {
		f.played = &v
	}
	for _, k := range queryList(rc.q, "SortBy") {
		if k == "dateplayed" || k == "playcount" {
			f.byHistory = true
		}
	}
	return f
}

// selective means the result is a subset of the user's own history, so it
// can be built from local state.
func (f userFilters) selective() bool {
	return f.favoriteOrLikes || (f.favorite != nil && *f.favorite) || (f.likes != nil) || f.resumable ||
		(f.played != nil && *f.played) || f.byHistory
}

// excluding means the result is the upstream listing minus some of the
// user's history.
func (f userFilters) excluding() bool {
	return !f.selective() && ((f.played != nil && !*f.played) || (f.favorite != nil && !*f.favorite))
}

// keep applies the filters to an item's overlaid UserData.
func (f userFilters) keep(o *jsonx.Object) bool {
	ud := o.Object("UserData")
	if ud == nil {
		return false
	}
	if f.favorite != nil && ud.Bool("IsFavorite") != *f.favorite {
		return false
	}
	if f.favoriteOrLikes && !ud.Bool("IsFavorite") && !ud.Bool("Likes") {
		return false
	}
	if f.likes != nil {
		v, ok := ud.Get("Likes")
		if b, isBool := v.(bool); !ok || !isBool || b != *f.likes {
			return false
		}
	}
	if f.played != nil && ud.Bool("Played") != *f.played {
		return false
	}
	if f.resumable {
		pos, _ := ud.Int("PlaybackPositionTicks")
		if pos <= 0 || ud.Bool("Played") {
			return false
		}
	}
	return true
}

// items serves item queries. Most pass through with the user's state laid
// over them; queries the upstream server cannot answer for this user are
// built here.
func (a *app) items(w http.ResponseWriter, rc *reqCtx, next caddyhttp.Handler) error {
	f := parseUserFilters(rc)
	opts := listOptions(rc)
	opts.filters = f
	switch {
	case len(opts.ids) > 0:
		// Not every upstream server honours Ids; answer it from single items.
		opts.keepOrder = len(opts.sortBy) == 0
		return a.collect(w, rc, opts.ids, opts)
	case f.selective():
		ids, err := a.candidates(rc.ctx(), rc.owner.ID, f)
		if err != nil {
			return err
		}
		return a.collect(w, rc, ids, opts)
	case f.excluding():
		return a.proxy(w, withoutUserFilters(rc), next, func(_ context.Context, _ *reqCtx, doc any) (any, error) {
			return dropItems(doc, f.keep), nil
		})
	}
	return a.proxy(w, rc, next, nil)
}

// Only local state can filter by played/favorite status. Preserve the
// caller's other query parameters when fetching candidates upstream.
func withoutUserFilters(rc *reqCtx) *reqCtx {
	out := *rc
	out.r = rc.r.Clone(rc.ctx())
	out.r.URL.RawQuery = editQuery(rc.r.URL.RawQuery, func(k, v string) (string, bool, bool) {
		switch strings.ToLower(k) {
		case "isplayed", "isfavorite":
			return "", true, false
		case "filters":
			var kept []string
			for _, filter := range strings.Split(v, ",") {
				switch strings.ToLower(strings.TrimSpace(filter)) {
				case "isplayed", "isunplayed", "isfavorite", "isfavoriteorlikes", "isresumable", "likes", "dislikes":
				default:
					kept = append(kept, filter)
				}
			}
			return strings.Join(kept, ","), true, len(kept) > 0
		}
		return v, false, true
	})
	return &out
}

// dropItems removes items from a QueryResult and lowers its total to match.
// The total is exact for the page and an estimate beyond it.
func dropItems(doc any, keep func(*jsonx.Object) bool) any {
	res, _ := doc.(*jsonx.Object)
	if res == nil {
		return doc
	}
	v, _ := res.Get("Items")
	list, _ := v.([]any)
	out := make([]any, 0, len(list))
	for _, it := range list {
		if o, _ := it.(*jsonx.Object); o != nil && !keep(o) {
			continue
		}
		out = append(out, it)
	}
	res.Set("Items", out)
	if total, ok := res.Int("TotalRecordCount"); ok {
		res.Set("TotalRecordCount", max(total-int64(len(list)-len(out)), int64(len(out))))
	}
	return res
}

// candidates are the items in the user's own history that can match f,
// newest first.
func (a *app) candidates(ctx context.Context, owner string, f userFilters) ([]string, error) {
	var rows []store.ItemState
	var err error
	switch {
	case f.favoriteOrLikes:
		rows, err = a.st.Favorites(ctx, owner, maxCandidates)
		if err == nil {
			var liked []store.ItemState
			liked, err = a.st.Rated(ctx, owner, true, maxCandidates)
			rows = append(rows, liked...)
			sort.SliceStable(rows, func(i, j int) bool { return rows[i].Updated > rows[j].Updated })
		}
	case f.favorite != nil && *f.favorite:
		rows, err = a.st.Favorites(ctx, owner, maxCandidates)
	case f.likes != nil:
		rows, err = a.st.Rated(ctx, owner, *f.likes, maxCandidates)
	case f.resumable:
		rows, err = a.st.Resumable(ctx, owner, maxCandidates)
	case f.played != nil && *f.played:
		rows, err = a.st.Played(ctx, owner, maxCandidates)
	default:
		rows, err = a.st.Recent(ctx, owner, maxCandidates)
	}
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var ids []string
	add := func(id string) {
		if id != "" && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	for _, r := range rows {
		add(r.ItemID)
		// A series or season is played when all of its episodes are, so any
		// played episode makes its parents candidates.
		if f.played != nil && *f.played {
			add(r.SeasonID)
			add(r.SeriesID)
		}
	}
	return ids, nil
}

// options is an item query the plugin answers itself.
type options struct {
	ids        []string
	parent     string
	types      []string
	exclude    []string
	media      []string
	folder     *bool
	search     string
	startsWith string
	sortBy     []string
	sortOrder  []string
	start      int
	limit      int
	totalCount bool
	keepOrder  bool
	filters    userFilters
}

func listOptions(rc *reqCtx) options {
	q := rc.q
	o := options{
		parent:     queryGet(q, "ParentId"),
		types:      queryList(q, "IncludeItemTypes"),
		exclude:    queryList(q, "ExcludeItemTypes"),
		media:      queryList(q, "MediaTypes"),
		search:     strings.ToLower(queryGet(q, "SearchTerm")),
		startsWith: strings.ToLower(queryGet(q, "NameStartsWith")),
		sortBy:     queryList(q, "SortBy"),
		sortOrder:  queryList(q, "SortOrder"),
		limit:      -1,
		totalCount: true,
	}
	if s := queryGet(q, "SeriesId"); s != "" && o.parent == "" && len(rc.segs) > 0 && rc.segs[0] != "shows" {
		o.parent = s
	}
	if len(rc.segs) == 3 && rc.segs[0] == "shows" {
		// /Shows/{id}/Episodes and /Seasons scope to the series.
		o.parent = rc.raw[1]
		if s := queryGet(q, "SeasonId"); s != "" {
			o.parent = s
		}
	}
	for _, id := range strings.Split(queryGet(q, "Ids"), ",") {
		if id = strings.TrimSpace(id); id != "" {
			o.ids = append(o.ids, id)
		}
	}
	if v, ok := queryBool(q, "IsFolder"); ok {
		o.folder = &v
	}
	for _, f := range queryList(q, "Filters") {
		t, ff := true, false
		switch f {
		case "isfolder":
			o.folder = &t
		case "isnotfolder":
			o.folder = &ff
		}
	}
	if n, err := strconv.Atoi(queryGet(q, "StartIndex")); err == nil && n > 0 {
		o.start = n
	}
	if n, err := strconv.Atoi(queryGet(q, "Limit")); err == nil && n >= 0 {
		o.limit = n
	}
	if v, ok := queryBool(q, "EnableTotalRecordCount"); ok {
		o.totalCount = v
	}
	return o
}

// collect fetches ids from the upstream server, keeps those that match the
// query, lays the user's state over them, then sorts and pages the result.
func (a *app) collect(w http.ResponseWriter, rc *reqCtx, ids []string, o options) error {
	ctx := rc.ctx()
	if len(ids) > maxCandidates {
		ids = ids[:maxCandidates]
	}
	fetched := a.up.itemsByID(ctx, ids)
	var members map[string]bool
	items := make([]*jsonx.Object, 0, len(fetched))
	for _, id := range ids {
		it, ok := fetched[id]
		if !ok || !o.matches(it) {
			continue
		}
		if o.parent != "" && !inParent(it, o.parent) {
			if members == nil {
				m, err := a.up.membersOf(ctx, o.parent)
				if err != nil {
					m = map[string]bool{}
				}
				members = m
			}
			if !members[it.String("Id")] && !members[it.String("SeriesId")] {
				continue
			}
		}
		items = append(items, it)
	}
	list := make([]any, len(items))
	for i, it := range items {
		list[i] = it
	}
	if err := a.overlay(ctx, rc.owner.ID, list); err != nil {
		return err
	}
	kept := items[:0]
	for _, it := range items {
		if o.filters.keep(it) || !o.filters.any() {
			kept = append(kept, it)
		}
	}
	items = kept
	if len(o.sortBy) > 0 && !o.keepOrder {
		sortItems(items, o.sortBy, o.sortOrder)
	}
	total := len(items)
	if o.start >= len(items) {
		items = nil
	} else {
		items = items[o.start:]
	}
	if o.limit >= 0 && o.limit < len(items) {
		items = items[:o.limit]
	}
	if !o.totalCount {
		total = 0
	}
	return a.writeList(w, rc, items, total)
}

func (f userFilters) any() bool {
	return f.favorite != nil || f.favoriteOrLikes || f.likes != nil || f.resumable || f.played != nil
}

func (a *app) writeList(w http.ResponseWriter, rc *reqCtx, items []*jsonx.Object, total int) error {
	list := make([]any, len(items))
	for i, it := range items {
		list[i] = it
	}
	return a.writeJSON(w, rc, http.StatusOK, obj("Items", list, "TotalRecordCount", total))
}

// inParent is the cheap check: the item names the folder itself.
func inParent(it *jsonx.Object, parent string) bool {
	return it.String("ParentId") == parent || it.String("SeasonId") == parent || it.String("SeriesId") == parent
}

// matches applies the parts of the query that only look at the item.
func (o options) matches(it *jsonx.Object) bool {
	typ := strings.ToLower(it.String("Type"))
	if len(o.types) > 0 && !contains(o.types, typ) {
		return false
	}
	if contains(o.exclude, typ) {
		return false
	}
	if len(o.media) > 0 && !contains(o.media, strings.ToLower(it.String("MediaType"))) {
		return false
	}
	if o.folder != nil && it.Bool("IsFolder") != *o.folder {
		return false
	}
	name := strings.ToLower(it.String("Name"))
	if o.search != "" && !strings.Contains(name, o.search) {
		return false
	}
	if o.startsWith != "" && !strings.HasPrefix(name, o.startsWith) {
		return false
	}
	return true
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// sortItems orders items by Emby SortBy keys. Ties keep their current order,
// which is most recent first for history-driven lists.
func sortItems(items []*jsonx.Object, by, order []string) {
	if contains(by, "random") {
		rand.Shuffle(len(items), func(i, j int) { items[i], items[j] = items[j], items[i] })
		return
	}
	desc := func(i int) bool {
		switch {
		case i < len(order):
			return order[i] == "descending"
		case len(order) > 0:
			return order[len(order)-1] == "descending"
		}
		return false
	}
	sort.SliceStable(items, func(i, j int) bool {
		for k, key := range by {
			c := compareBy(items[i], items[j], key)
			if c == 0 {
				continue
			}
			if desc(k) {
				return c > 0
			}
			return c < 0
		}
		return false
	})
}

func compareBy(a, b *jsonx.Object, key string) int {
	switch key {
	case "sortname", "name", "seriessortname":
		return strings.Compare(sortName(a, key), sortName(b, key))
	case "datecreated", "premieredate", "datelastcontentadded":
		field := map[string]string{"datecreated": "DateCreated", "premieredate": "PremiereDate", "datelastcontentadded": "DateLastMediaAdded"}[key]
		return cmp64(parseDate(a.String(field)), parseDate(b.String(field)))
	case "dateplayed":
		return cmp64(parseDate(userField(a, "LastPlayedDate")), parseDate(userField(b, "LastPlayedDate")))
	case "playcount":
		x, _ := a.Object("UserData").Int("PlayCount")
		y, _ := b.Object("UserData").Int("PlayCount")
		return cmp64(x, y)
	case "productionyear", "runtime", "indexnumber", "parentindexnumber":
		field := map[string]string{"productionyear": "ProductionYear", "runtime": "RunTimeTicks", "indexnumber": "IndexNumber", "parentindexnumber": "ParentIndexNumber"}[key]
		x, _ := a.Int(field)
		y, _ := b.Int(field)
		return cmp64(x, y)
	case "communityrating", "criticrating":
		field := map[string]string{"communityrating": "CommunityRating", "criticrating": "CriticRating"}[key]
		return cmpFloat(number(a, field), number(b, field))
	}
	return 0
}

func sortName(o *jsonx.Object, key string) string {
	if key == "seriessortname" {
		if s := o.String("SeriesName"); s != "" {
			return strings.ToLower(s)
		}
	}
	if s := o.String("SortName"); s != "" && key != "name" {
		return strings.ToLower(s)
	}
	return strings.ToLower(o.String("Name"))
}

func userField(o *jsonx.Object, k string) string {
	if ud := o.Object("UserData"); ud != nil {
		return ud.String(k)
	}
	return ""
}

func number(o *jsonx.Object, k string) float64 {
	v, _ := o.Get(k)
	n, _ := v.(json.Number)
	f, _ := n.Float64()
	return f
}

func cmp64(a, b int64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

func cmpFloat(a, b float64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}
