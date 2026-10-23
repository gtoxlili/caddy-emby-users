package embyusers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"

	"github.com/gtoxlili/caddy-emby-users/internal/jsonx"
	"github.com/gtoxlili/caddy-emby-users/internal/store"
)

var errNotFound = errors.New("not found upstream")

// upstream is the plugin's own client for the real Emby server. Every
// request it makes, and every request it lets through, uses the one account
// configured in the Caddyfile.
type upstream struct {
	base     *url.URL
	hc       *http.Client
	username string
	password string
	id       identity
	log      *zap.Logger
	st       *store.Store

	mu       sync.RWMutex
	token    string
	userID   string
	serverID string
	loginMu  sync.Mutex

	items    *ttlCache[[]byte]
	episodes *ttlCache[[]episode]
	members  *ttlCache[map[string]bool]
	userDTO  *ttlCache[[]byte]
	info     *ttlCache[[]byte]
	valid    *ttlCache[bool]
}

// identity is how the upstream server sees the plugin: one client on one
// device, whoever is watching.
type identity struct {
	Client   string
	Device   string
	DeviceID string
}

// episode is the slice of an Episode the plugin needs to find the next one.
type episode struct {
	ID       string
	SeasonID string
	Season   int64
	Index    int64
	RunTime  int64
}

func newUpstream(base *url.URL, username, password string, id identity, st *store.Store, log *zap.Logger) *upstream {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.ResponseHeaderTimeout = 30 * time.Second
	return &upstream{
		base:     base,
		hc:       &http.Client{Transport: tr, Timeout: 60 * time.Second},
		username: username,
		password: password,
		id:       id,
		log:      log,
		st:       st,
		items:    newTTLCache[[]byte](2*time.Minute, 2000),
		episodes: newTTLCache[[]episode](10*time.Minute, 1000),
		members:  newTTLCache[map[string]bool](30*time.Minute, 50),
		valid:    newTTLCache[bool](time.Minute, 4),
		userDTO:  newTTLCache[[]byte](10*time.Minute, 1),
		info:     newTTLCache[[]byte](time.Minute, 2),
	}
}

// configure applies the Caddyfile settings. Pointing the plugin at another
// server or account drops the saved sign-in and every cached item.
func (u *upstream) configure(base *url.URL, username, password string, id identity) {
	u.mu.Lock()
	changed := u.base.String() != base.String() || u.username != username || u.password != password || u.id != id
	u.base, u.username, u.password, u.id = base, username, password, id
	if changed {
		u.token, u.userID, u.serverID = "", "", ""
	}
	u.mu.Unlock()
	if changed {
		u.items.clear()
		u.episodes.clear()
		u.members.clear()
		u.userDTO.clear()
		u.info.clear()
	}
}

type upstreamConfig struct {
	base     url.URL
	username string
	password string
	id       identity
}

func (u *upstream) config() upstreamConfig {
	u.mu.RLock()
	defer u.mu.RUnlock()
	return upstreamConfig{base: *u.base, username: u.username, password: u.password, id: u.id}
}

// credentials returns the upstream token, user id and server id.
func (u *upstream) credentials() (token, userID, serverID string) {
	u.mu.RLock()
	defer u.mu.RUnlock()
	return u.token, u.userID, u.serverID
}

// account identifies the configured upstream account, so a saved token is
// only reused for the same server and user.
func (c upstreamConfig) account() string { return c.username + "@" + c.base.String() }

type savedLogin struct {
	Account  string `json:"account"`
	Token    string `json:"token"`
	UserID   string `json:"user_id"`
	ServerID string `json:"server_id"`
}

// ensure makes sure there is an upstream token. A token saved by an earlier
// run is reused: signing in again would add another device on the upstream
// server each restart.
func (u *upstream) ensure(ctx context.Context) error {
	if tok, _, _ := u.credentials(); tok != "" {
		return nil
	}
	u.loginMu.Lock()
	defer u.loginMu.Unlock()
	if tok, _, _ := u.credentials(); tok != "" {
		return nil
	}
	if raw, err := u.st.Meta(ctx, "upstream"); err == nil && raw != "" {
		var s savedLogin
		if json.Unmarshal([]byte(raw), &s) == nil && s.Account == u.config().account() && s.Token != "" {
			u.set(s.Token, s.UserID, s.ServerID)
			return nil
		}
	}
	return u.loginLocked(ctx)
}

// relogin signs in again unless another request already replaced stale.
func (u *upstream) relogin(ctx context.Context, stale string) error {
	u.loginMu.Lock()
	defer u.loginMu.Unlock()
	if tok, _, _ := u.credentials(); tok != stale && tok != "" {
		return nil
	}
	return u.loginLocked(ctx)
}

func (u *upstream) set(token, userID, serverID string) {
	u.mu.Lock()
	u.token, u.userID, u.serverID = token, userID, serverID
	u.mu.Unlock()
}

func (u *upstream) authHeader() string {
	id := u.config().id
	return fmt.Sprintf(`MediaBrowser Client="%s", Device="%s", DeviceId="%s", Version="%s"`, id.Client, id.Device, id.DeviceID, version)
}

func (u *upstream) userAgent() string { return u.config().id.Client + "/" + version }

// disguise makes a request look like it comes from the plugin's own device.
// Clients name themselves in the authorization header, in query parameters
// and in User-Agent; left alone, the upstream server would see one device
// per friend behind the one account.
func (u *upstream) disguise(r *http.Request, token string) {
	id := u.config().id
	auth := u.authHeader()
	if token != "" {
		auth += `, Token="` + token + `"`
	}
	r.Header.Set("X-Emby-Authorization", auth)
	if lower := strings.ToLower(r.Header.Get("Authorization")); strings.HasPrefix(lower, "emby ") || strings.HasPrefix(lower, "mediabrowser ") {
		r.Header.Del("Authorization")
	}
	for _, h := range []string{"X-Emby-Client", "X-Emby-Device-Name", "X-Emby-Device-Id", "X-Emby-Client-Version"} {
		r.Header.Del(h)
	}
	r.Header.Set("User-Agent", u.userAgent())
	r.URL.RawQuery = editQuery(r.URL.RawQuery, func(k, v string) (string, bool, bool) {
		switch strings.ToLower(k) {
		case "x-emby-client":
			return id.Client, true, true
		case "x-emby-device-name":
			return id.Device, true, true
		case "x-emby-device-id", "deviceid":
			return id.DeviceID, true, true
		case "x-emby-client-version":
			return version, true, true
		}
		return v, false, true
	})
}

func (u *upstream) loginLocked(ctx context.Context) error {
	cfg := u.config()
	body, _ := json.Marshal(map[string]string{"Username": cfg.username, "Pw": cfg.password})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.url("/Users/AuthenticateByName", nil), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Emby-Authorization", u.authHeader())
	req.Header.Set("User-Agent", u.userAgent())
	resp, err := u.hc.Do(req)
	if err != nil {
		return fmt.Errorf("upstream sign-in: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("upstream sign-in: status %d", resp.StatusCode)
	}
	var res struct {
		AccessToken string
		ServerID    string `json:"ServerId"`
		User        struct {
			ID string `json:"Id"`
		}
	}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return fmt.Errorf("upstream sign-in: %w", err)
	}
	if res.AccessToken == "" || res.User.ID == "" {
		return errors.New("upstream sign-in: response has no token")
	}
	u.set(res.AccessToken, res.User.ID, res.ServerID)
	saved, _ := json.Marshal(savedLogin{Account: cfg.account(), Token: res.AccessToken, UserID: res.User.ID, ServerID: res.ServerID})
	if err := u.st.SetMeta(ctx, "upstream", string(saved)); err != nil {
		u.log.Warn("saving upstream token", zap.Error(err))
	}
	u.log.Info("signed in to upstream", zap.String("server", cfg.base.Host))
	return nil
}

// url builds an API URL. The plugin's own calls use the /emby prefix, which
// every Emby server accepts.
func (u *upstream) url(path string, q url.Values) string {
	ref := u.config().base
	prefix := strings.TrimSuffix(ref.Path, "/")
	if !strings.HasSuffix(strings.ToLower(prefix), "/emby") {
		prefix += "/emby"
	}
	ref.Path = prefix + path
	ref.RawPath = ""
	ref.RawQuery = ""
	if q != nil {
		ref.RawQuery = q.Encode()
	}
	return ref.String()
}

// do sends an authenticated request, signing in again once if the token was
// rejected.
func (u *upstream) do(ctx context.Context, method, path string, q url.Values, body []byte) (*http.Response, error) {
	if err := u.ensure(ctx); err != nil {
		return nil, err
	}
	for attempt := 0; ; attempt++ {
		tok, _, _ := u.credentials()
		req, err := http.NewRequestWithContext(ctx, method, u.url(path, q), bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("X-Emby-Token", tok)
		req.Header.Set("X-Emby-Authorization", u.authHeader()+`, Token="`+tok+`"`)
		req.Header.Set("User-Agent", u.userAgent())
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := u.hc.Do(req)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != http.StatusUnauthorized || attempt > 0 {
			return resp, nil
		}
		resp.Body.Close()
		if err := u.relogin(ctx, tok); err != nil {
			return nil, err
		}
	}
}

// tokenValid reports whether the upstream server still accepts tok, by
// asking for the account itself.
func (u *upstream) tokenValid(ctx context.Context, tok string) bool {
	if ok, cached := u.valid.get(tok); cached {
		return ok
	}
	_, uid, _ := u.credentials()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.url("/Users/"+uid, nil), nil)
	if err != nil {
		return false
	}
	req.Header.Set("X-Emby-Token", tok)
	req.Header.Set("X-Emby-Authorization", u.authHeader())
	req.Header.Set("User-Agent", u.userAgent())
	resp, err := u.hc.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	ok := resp.StatusCode == http.StatusOK
	if ok {
		u.valid.set(tok, true)
	}
	return ok
}

// get fetches a JSON document.
func (u *upstream) get(ctx context.Context, path string, q url.Values) ([]byte, error) {
	resp, err := u.do(ctx, http.MethodGet, path, q, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return nil, errNotFound
	case resp.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("upstream %s: status %d", path, resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 64<<20))
}

// item fetches one item as the upstream account sees it.
func (u *upstream) item(ctx context.Context, id string) (*jsonx.Object, error) {
	raw, ok := u.items.get(id)
	if !ok {
		if err := u.ensure(ctx); err != nil {
			return nil, err
		}
		_, uid, _ := u.credentials()
		var err error
		raw, err = u.get(ctx, "/Users/"+uid+"/Items/"+url.PathEscape(id), nil)
		if err != nil {
			return nil, err
		}
		u.items.set(id, raw)
	}
	v, err := jsonx.Decode(raw)
	if err != nil {
		return nil, err
	}
	o, ok := v.(*jsonx.Object)
	if !ok || o.String("Id") == "" {
		return nil, errNotFound
	}
	return o, nil
}

// itemsByID fetches items concurrently. Upstream servers do not all honour
// the Ids query parameter, so each item is its own request; the cache keeps
// repeat lists cheap. Items that no longer exist are left out.
func (u *upstream) itemsByID(ctx context.Context, ids []string) map[string]*jsonx.Object {
	out := make(map[string]*jsonx.Object, len(ids))
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for _, id := range ids {
		wg.Add(1)
		sem <- struct{}{}
		go func(id string) {
			defer wg.Done()
			defer func() { <-sem }()
			o, err := u.item(ctx, id)
			if err != nil {
				if !errors.Is(err, errNotFound) {
					u.log.Debug("fetching item", zap.String("id", id), zap.Error(err))
				}
				return
			}
			mu.Lock()
			out[id] = o
			mu.Unlock()
		}(id)
	}
	wg.Wait()
	return out
}

// seriesEpisodes lists a series' episodes in airing order.
func (u *upstream) seriesEpisodes(ctx context.Context, seriesID string) ([]episode, error) {
	if eps, ok := u.episodes.get(seriesID); ok {
		return eps, nil
	}
	if err := u.ensure(ctx); err != nil {
		return nil, err
	}
	_, uid, _ := u.credentials()
	raw, err := u.get(ctx, "/Shows/"+url.PathEscape(seriesID)+"/Episodes", url.Values{
		"UserId": {uid}, "Fields": {"RunTimeTicks"}, "EnableImages": {"false"}, "EnableUserData": {"false"},
	})
	if err != nil {
		return nil, err
	}
	var res struct {
		Items []struct {
			ID                string `json:"Id"`
			SeasonID          string `json:"SeasonId"`
			ParentIndexNumber int64
			IndexNumber       int64
			RunTimeTicks      int64
			LocationType      string
		}
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, err
	}
	eps := make([]episode, 0, len(res.Items))
	for _, it := range res.Items {
		if it.LocationType == "Virtual" {
			continue
		}
		eps = append(eps, episode{ID: it.ID, SeasonID: it.SeasonID, Season: it.ParentIndexNumber, Index: it.IndexNumber, RunTime: it.RunTimeTicks})
	}
	u.episodes.set(seriesID, eps)
	return eps, nil
}

// membersOf returns the ids of every item under a folder, such as a library.
// Upstream servers do not always report an item's library in its own
// ParentId, so membership is read from the folder's side.
func (u *upstream) membersOf(ctx context.Context, parentID string) (map[string]bool, error) {
	if m, ok := u.members.get(parentID); ok {
		return m, nil
	}
	if err := u.ensure(ctx); err != nil {
		return nil, err
	}
	_, uid, _ := u.credentials()
	m := map[string]bool{}
	const page = 500
	for start := 0; start < 50000; start += page {
		raw, err := u.get(ctx, "/Users/"+uid+"/Items", url.Values{
			"ParentId": {parentID}, "Recursive": {"true"}, "StartIndex": {strconv.Itoa(start)}, "Limit": {strconv.Itoa(page)},
			"EnableImages": {"false"}, "EnableUserData": {"false"}, "Fields": {"SeriesId"},
		})
		if err != nil {
			return nil, err
		}
		var res struct {
			Items []struct {
				ID       string `json:"Id"`
				SeriesID string `json:"SeriesId"`
			}
			TotalRecordCount int
		}
		if err := json.Unmarshal(raw, &res); err != nil {
			return nil, err
		}
		for _, it := range res.Items {
			m[it.ID] = true
			if it.SeriesID != "" {
				m[it.SeriesID] = true
			}
		}
		if len(res.Items) < page || start+page >= res.TotalRecordCount {
			break
		}
	}
	u.members.set(parentID, m)
	return m, nil
}

// user returns the upstream account's UserDto.
func (u *upstream) user(ctx context.Context) (*jsonx.Object, error) {
	raw, ok := u.userDTO.get("")
	if !ok {
		if err := u.ensure(ctx); err != nil {
			return nil, err
		}
		_, uid, _ := u.credentials()
		var err error
		raw, err = u.get(ctx, "/Users/"+uid, nil)
		if err != nil {
			return nil, err
		}
		u.userDTO.set("", raw)
	}
	v, err := jsonx.Decode(raw)
	if err != nil {
		return nil, err
	}
	o, _ := v.(*jsonx.Object)
	if o == nil {
		return nil, errors.New("upstream user is not an object")
	}
	return o, nil
}

// ttlCache is a small map whose entries expire.
type ttlCache[V any] struct {
	mu  sync.Mutex
	ttl time.Duration
	max int
	m   map[string]ttlEntry[V]
}

type ttlEntry[V any] struct {
	v   V
	exp time.Time
}

func newTTLCache[V any](ttl time.Duration, max int) *ttlCache[V] {
	return &ttlCache[V]{ttl: ttl, max: max, m: map[string]ttlEntry[V]{}}
}

func (c *ttlCache[V]) get(k string) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[k]
	if !ok || time.Now().After(e.exp) {
		var zero V
		return zero, false
	}
	return e.v, true
}

func (c *ttlCache[V]) set(k string, v V) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.m) >= c.max {
		now := time.Now()
		for key, e := range c.m {
			if now.After(e.exp) {
				delete(c.m, key)
			}
		}
		for key := range c.m {
			if len(c.m) < c.max {
				break
			}
			delete(c.m, key)
		}
	}
	c.m[k] = ttlEntry[V]{v: v, exp: time.Now().Add(c.ttl)}
}

func (c *ttlCache[V]) del(k string) {
	c.mu.Lock()
	delete(c.m, k)
	c.mu.Unlock()
}

func (c *ttlCache[V]) clear() {
	c.mu.Lock()
	c.m = map[string]ttlEntry[V]{}
	c.mu.Unlock()
}
