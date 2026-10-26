package embyusers

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/caddyserver/caddy/v2"
	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"github.com/gtoxlili/caddy-emby-users/internal/store"
)

// App starts account runtimes only when Caddy actually starts a configuration.
// During reload, acquiring the new leases before old handlers are cleaned up
// preserves local session caches, login throttles and now-playing state.
type App struct {
	handlers []*Handler
}

func init() { caddy.RegisterModule(App{}) }

func (App) CaddyModule() caddy.ModuleInfo {
	return caddy.ModuleInfo{ID: "emby_users", New: func() caddy.Module { return new(App) }}
}

func (a *App) Start() error {
	for _, h := range a.handlers {
		if err := h.start(); err != nil {
			return err
		}
	}
	return nil
}

// Handler Cleanup releases leases after Caddy stops the HTTP configuration.
func (*App) Stop() error { return nil }

var _ caddy.App = (*App)(nil)

func (h *Handler) start() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return errors.New("emby_users: handler stopped")
	}
	h.startErr = h.initApp(h.ctx)
	close(h.ready)
	return h.startErr
}

// initApp acquires the database during App.Start, never during validation.
// The caller holds h.mu to serialize initialization and cleanup.
func (h *Handler) initApp(ctx context.Context) error {
	if h.app != nil {
		return nil
	}
	value, _, err := pool.LoadOrNew(h.Database, func() (caddy.Destructor, error) {
		st, err := store.Open(h.Database)
		if err != nil {
			return nil, err
		}
		return newLocalState(st), nil
	})
	if err != nil {
		return fmt.Errorf("emby_users: opening database: %w", err)
	}
	local := value.(*localState)
	local.identityMu.Lock()
	id, err := h.id.resolve(ctx, local.st)
	local.identityMu.Unlock()
	if err != nil {
		pool.Delete(h.Database)
		return err
	}
	up := newUpstream(upstreamConfig{base: *h.base, username: h.Username, password: h.Password, id: id}, local.st, h.log, h.transport)
	up.loginMu = &local.loginMu
	h.app = &app{localState: local, up: up, log: h.log, avatar: h.avatar}
	h.key = h.Database
	return nil
}

func (h *Handler) Cleanup() error {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return nil
	}
	h.closed = true
	if h.cancel != nil {
		h.cancel()
	}
	h.mu.Unlock()
	var err error
	if h.proxy != nil {
		err = h.proxy.Cleanup()
	}
	h.active.Wait()
	if h.key != "" {
		_, dbErr := pool.Delete(h.key)
		err = errors.Join(err, dbErr)
	}
	return err
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request, _ caddyhttp.Handler) error {
	ctx, cancel := context.WithCancel(r.Context())
	stop := context.AfterFunc(h.ctx, cancel)
	defer stop()
	defer cancel()
	select {
	case <-h.ready:
	case <-ctx.Done():
		return ctx.Err()
	}
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return caddyhttp.Error(http.StatusServiceUnavailable, errors.New("emby_users: handler stopped"))
	}
	h.active.Add(1)
	err := h.startErr
	h.mu.Unlock()
	defer h.active.Done()
	if err != nil {
		return caddyhttp.Error(http.StatusInternalServerError, err)
	}
	r = r.WithContext(ctx)
	forward := caddyhttp.HandlerFunc(func(w http.ResponseWriter, r *http.Request) error {
		if r.Context().Value(forwardKey{}) == nil {
			r = r.WithContext(context.WithValue(r.Context(), forwardKey{}, &forwardCall{a: h.app, rc: &reqCtx{r: r}}))
		}
		return h.proxy.ServeHTTP(w, r, nil)
	})
	return h.app.serve(w, r, forward)
}
