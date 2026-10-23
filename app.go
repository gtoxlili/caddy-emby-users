package embyusers

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"go.uber.org/zap"

	"github.com/gtoxlili/caddy-emby-users/internal/store"
)

// app is the runtime shared by every handler instance that uses one database.
type app struct {
	log      *zap.Logger
	st       *store.Store
	up       *upstream
	sessions *sessionCache
	limiter  *limiter
	playing  *nowPlaying
}

func newApp(st *store.Store, up *upstream, log *zap.Logger) *app {
	return &app{
		log:      log,
		st:       st,
		up:       up,
		sessions: &sessionCache{m: map[string]*cachedSession{}},
		limiter:  newLimiter(),
		playing:  &nowPlaying{m: map[string]playingEntry{}},
	}
}

// Destruct closes the database when the last config using it goes away.
func (a *app) Destruct() error { return a.st.Close() }

// reqCtx is one request as the plugin understands it.
type reqCtx struct {
	r *http.Request
	// segs is the path lowercased for routing; raw keeps the original case
	// for the ids in it.
	segs   []string
	raw    []string
	q      url.Values
	client client
	// token, sess and user describe the signed-in caller; all empty for an
	// anonymous request.
	token string
	sess  *store.Session
	user  *store.User
	// owner is whose play state the request reads and writes: the caller,
	// or the user an administrator names in the path.
	owner *store.User
}

func (rc *reqCtx) ctx() context.Context { return rc.r.Context() }

type handlerFunc func(a *app, w http.ResponseWriter, rc *reqCtx, next caddyhttp.Handler) error

func (a *app) serve(w http.ResponseWriter, r *http.Request, next caddyhttp.Handler) error {
	segs, raw, smuggled := splitPath(r.URL.EscapedPath())
	if smuggled != "" {
		// SenPlayer puts the query in the path as %3F; restore it so the
		// token in it is found and replaced.
		esc := r.URL.EscapedPath()
		i := strings.Index(strings.ToLower(esc), "%3f")
		r.URL.RawPath = esc[:i]
		if p, err := url.PathUnescape(esc[:i]); err == nil {
			r.URL.Path = p
		}
		if r.URL.RawQuery != "" {
			smuggled += "&" + r.URL.RawQuery
		}
		r.URL.RawQuery = smuggled
	}
	rc := &reqCtx{r: r, segs: segs, raw: raw, q: r.URL.Query()}
	rc.client = readClient(r, rc.q)

	if r.Method == http.MethodOptions {
		return next.ServeHTTP(w, r)
	}
	if h := publicRoute(rc); h != nil {
		return h(a, w, rc, next)
	}
	if rc.client.Token == "" {
		if sessionOnly(segs) {
			return writeText(w, http.StatusUnauthorized, textUnauthorized)
		}
		// Public resources (images, branding, server info) go through as
		// they are; anything else the upstream server refuses on its own.
		return next.ServeHTTP(w, r)
	}
	sess, user, err := a.sessions.lookup(rc.ctx(), a.st, rc.client.Token)
	if err != nil {
		return err
	}
	if sess == nil || user.Disabled {
		// A token the plugin did not issue never reaches the upstream server,
		// even if it happens to be valid there.
		return writeText(w, http.StatusUnauthorized, textUnauthorized)
	}
	rc.token, rc.sess, rc.user, rc.owner = rc.client.Token, sess, user, user
	if err := a.resolveOwner(rc); err != nil {
		return err
	}
	a.sessions.touch(a.st, rc.client.Token, sess, clientIP(r))
	return a.dispatch(w, rc, next)
}

// resolveOwner lets an administrator act on another user's state by naming
// that user's id in the path, as Emby does.
func (a *app) resolveOwner(rc *reqCtx) error {
	if !rc.user.Admin {
		return nil
	}
	id := pathUserID(rc.segs)
	if id == "" || strings.EqualFold(id, rc.user.ID) {
		return nil
	}
	u, err := a.st.UserByID(rc.ctx(), id)
	if err != nil {
		return err
	}
	if u != nil {
		rc.owner = u
	}
	return nil
}

func pathUserID(segs []string) string {
	if len(segs) >= 2 && (segs[0] == "users" || segs[0] == "usersettings") && isLocalID(segs[1]) {
		return segs[1]
	}
	return ""
}

// sessionOnly lists the paths the plugin answers itself. Without a token
// they are refused here rather than passed to the upstream server.
func sessionOnly(segs []string) bool {
	if len(segs) == 0 {
		return false
	}
	switch segs[0] {
	case "users", "sessions", "usersettings", "displaypreferences", "devices", "embywebsocket", "socket", "embyusers":
		return true
	case "shows":
		return len(segs) >= 2 && segs[1] == "nextup"
	case "items":
		return len(segs) >= 2 && segs[1] == "resume"
	}
	return false
}

func publicRoute(rc *reqCtx) handlerFunc {
	m := rc.r.Method
	switch s := rc.segs; {
	case m == http.MethodPost && match(s, "users/authenticatebyname"):
		return (*app).login
	case m == http.MethodPost && match(s, "users/*/authenticate"):
		return (*app).loginByID
	case match(s, "users/public"):
		return (*app).publicUsers
	case match(s, "system/info/public"):
		return (*app).systemInfo
	case match(s, "system/endpoint"):
		return (*app).systemEndpoint
	}
	return nil
}

func (a *app) dispatch(w http.ResponseWriter, rc *reqCtx, next caddyhttp.Handler) error {
	m := rc.r.Method
	get := m == http.MethodGet || m == http.MethodHead
	post := m == http.MethodPost
	del := m == http.MethodDelete
	s := rc.segs
	var h handlerFunc
	switch {
	case get && match(s, "system/info"):
		h = (*app).systemInfo
	case get && match(s, "system/activitylog/entries"):
		h = (*app).emptyResult

	// Accounts.
	case get && match(s, "users"):
		h = (*app).listUsers
	case get && match(s, "users/query"):
		h = (*app).queryUsers
	case get && match(s, "users/me"):
		h = (*app).getMe
	case post && match(s, "users/new"):
		h = (*app).createUser
	case get && match(s, "users/*"):
		h = (*app).getUser
	case post && match(s, "users/*"):
		h = (*app).updateUser
	case del && match(s, "users/*"), post && match(s, "users/*/delete"):
		h = (*app).deleteUser
	case post && match(s, "users/*/password"):
		h = (*app).changePassword
	case post && match(s, "users/*/policy"):
		h = (*app).setPolicy
	case post && match(s, "users/*/configuration"):
		h = (*app).setConfiguration
	case get && match(s, "users/*/images/*"), get && match(s, "users/*/images/*/*"):
		h = (*app).notFound

	// Play state.
	case (post || del) && match(s, "users/*/playeditems/*"), post && match(s, "users/*/playeditems/*/delete"):
		h = (*app).markPlayed
	case (post || del) && match(s, "users/*/favoriteitems/*"), post && match(s, "users/*/favoriteitems/*/delete"):
		h = (*app).markFavorite
	case (post || del) && match(s, "users/*/items/*/rating"), post && match(s, "users/*/items/*/rating/delete"):
		h = (*app).rate
	case match(s, "users/*/items/*/userdata"):
		h = (*app).itemUserData
	case post && match(s, "users/*/items/*/hidefromresume"):
		h = (*app).hideFromResume
	case (post || del) && match(s, "users/*/playingitems/*"), post && match(s, "users/*/playingitems/*/progress"),
		post && match(s, "users/*/playingitems/*/delete"):
		h = (*app).legacyReport
	case post && (match(s, "sessions/playing") || match(s, "sessions/playing/progress") || match(s, "sessions/playing/stopped")):
		h = (*app).report

	// Lists that depend on play state.
	case get && (match(s, "users/*/items/resume") || match(s, "items/resume")):
		h = (*app).resume
	case get && match(s, "shows/nextup"):
		h = (*app).nextUp
	case get && (match(s, "users/*/items/latest") || match(s, "items/latest")):
		h = (*app).latest
	case get && (match(s, "users/*/items") || match(s, "items") || match(s, "shows/*/episodes") || match(s, "shows/*/seasons")):
		h = (*app).items

	// Per-user preferences.
	case match(s, "usersettings/*"), match(s, "usersettings/*/partial"):
		h = (*app).userSettings
	case match(s, "displaypreferences/*"):
		h = (*app).displayPreferences

	// Sessions and devices.
	case get && match(s, "sessions"):
		h = (*app).listSessions
	case post && match(s, "sessions/logout"):
		h = (*app).logout
	case post && (match(s, "sessions/capabilities") || match(s, "sessions/capabilities/full")):
		h = (*app).accepted
	case get && match(s, "devices"):
		h = (*app).listDevices
	case del && match(s, "devices"), post && match(s, "devices/delete"):
		h = (*app).deleteDevice
	case get && (match(s, "embywebsocket") || match(s, "socket")):
		h = (*app).websocket
	case post && match(s, "embyusers/import"):
		h = (*app).importUpstream
	}
	if h != nil {
		return h(a, w, rc, next)
	}
	if len(s) > 0 && (s[0] == "users" || s[0] == "sessions") && !get && !forwardable(m, s) {
		// Every other write under /Users and /Sessions targets the shared
		// upstream account or another client's session. Accept and drop it.
		return noContent(w)
	}
	if !get && !forwardable(m, s) {
		return writeText(w, http.StatusForbidden, textForbidden)
	}
	return a.proxy(w, rc, next, nil)
}

// forwardable lists the writes that may reach the upstream server: they
// start or stop a stream and change nothing the account keeps.
func forwardable(method string, s []string) bool {
	switch {
	case match(s, "items/*/playbackinfo"), match(s, "livestreams/open"), match(s, "livestreams/close"), match(s, "livestreams/mediainfo"):
		return method == http.MethodPost
	case match(s, "videos/activeencodings"):
		return method == http.MethodDelete
	case match(s, "videos/activeencodings/delete"), match(s, "sessions/playing/ping"):
		return method == http.MethodPost
	}
	return false
}

func (a *app) notFound(w http.ResponseWriter, _ *reqCtx, _ caddyhttp.Handler) error {
	return writeText(w, http.StatusNotFound, textNotFound)
}

func (a *app) accepted(w http.ResponseWriter, _ *reqCtx, _ caddyhttp.Handler) error {
	return noContent(w)
}

func (a *app) emptyResult(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	return a.writeJSON(w, rc, http.StatusOK, obj("Items", []any{}, "TotalRecordCount", 0))
}

// sessionCache keeps recent token lookups so most requests skip the database.
type sessionCache struct {
	mu sync.Mutex
	m  map[string]*cachedSession
}

type cachedSession struct {
	sess    *store.Session
	user    *store.User
	exp     time.Time
	touched time.Time
}

func (c *sessionCache) lookup(ctx context.Context, st *store.Store, token string) (*store.Session, *store.User, error) {
	c.mu.Lock()
	e, ok := c.m[token]
	c.mu.Unlock()
	if ok && time.Now().Before(e.exp) {
		return e.sess, e.user, nil
	}
	sess, user, err := st.SessionByToken(ctx, token)
	if err != nil || sess == nil {
		return nil, nil, err
	}
	c.mu.Lock()
	if len(c.m) > 10000 {
		c.m = map[string]*cachedSession{}
	}
	c.m[token] = &cachedSession{sess: sess, user: user, exp: time.Now().Add(30 * time.Second)}
	c.mu.Unlock()
	return sess, user, nil
}

// touch records activity at most once a minute per session.
func (c *sessionCache) touch(st *store.Store, token string, sess *store.Session, remote string) {
	now := time.Now()
	c.mu.Lock()
	e := c.m[token]
	due := e == nil || now.Sub(e.touched) > time.Minute
	if e != nil && due {
		e.touched = now
	}
	c.mu.Unlock()
	if !due {
		return
	}
	go st.TouchSession(context.Background(), token, now.UnixMilli(), remote)
}

// invalidate forgets every cached lookup after an account or session change.
func (c *sessionCache) invalidate() {
	c.mu.Lock()
	c.m = map[string]*cachedSession{}
	c.mu.Unlock()
}

// limiter throttles sign-in attempts per client address and per user name.
type limiter struct {
	mu   sync.Mutex
	hits map[string]*window
}

type window struct {
	start time.Time
	n     int
}

func newLimiter() *limiter { return &limiter{hits: map[string]*window{}} }

// Sign-in attempts allowed per minute from one address, and failures allowed
// per quarter hour for one user name.
const (
	attemptsPerAddress = 10
	failuresPerName    = 10
)

func (l *limiter) take(key string, limit int, span time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if len(l.hits) > 50000 {
		l.hits = map[string]*window{}
	}
	w := l.hits[key]
	if w == nil || now.Sub(w.start) > span {
		w = &window{start: now}
		l.hits[key] = w
	}
	w.n++
	return w.n <= limit
}

func (l *limiter) peek(key string, limit int, span time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	w := l.hits[key]
	return w == nil || time.Since(w.start) > span || w.n < limit
}

func (l *limiter) allowAttempt(addr string) bool {
	return l.take("addr:"+addr, attemptsPerAddress, time.Minute)
}

func (l *limiter) nameBlocked(name string) bool {
	return !l.peek("name:"+strings.ToLower(name), failuresPerName, 15*time.Minute)
}

func (l *limiter) fail(name string) {
	l.take("name:"+strings.ToLower(name), failuresPerName, 15*time.Minute)
}

// nowPlaying remembers what each session last reported, for /Sessions.
type nowPlaying struct {
	mu sync.Mutex
	m  map[string]playingEntry
}

type playingEntry struct {
	itemID   string
	position int64
	paused   bool
	at       time.Time
}

func (n *nowPlaying) set(sessionID string, e playingEntry) {
	n.mu.Lock()
	n.m[sessionID] = e
	n.mu.Unlock()
}

func (n *nowPlaying) clear(sessionID string) {
	n.mu.Lock()
	delete(n.m, sessionID)
	n.mu.Unlock()
}

func (n *nowPlaying) get(sessionID string) (playingEntry, bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	e, ok := n.m[sessionID]
	if !ok || time.Since(e.at) > 2*time.Minute {
		return playingEntry{}, false
	}
	return e, true
}
