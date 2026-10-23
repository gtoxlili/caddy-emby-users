package embyusers

import (
	"net/http"

	"github.com/caddyserver/caddy/v2/modules/caddyhttp"

	"github.com/gtoxlili/caddy-emby-users/internal/jsonx"
)

const prefUserSettings = "usersettings"

// userSettings serves /UserSettings/{id} (GET, POST) and its /Partial
// variant from the user's own copy. Clients load it during sign-in without
// error handling, so it always answers, with {} when nothing is stored.
func (a *app) userSettings(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	owner := rc.owner.ID
	stored, err := a.st.Pref(rc.ctx(), owner, prefUserSettings)
	if err != nil {
		return err
	}
	current := jsonx.NewObject()
	if stored != "" {
		if v, err := jsonx.Decode([]byte(stored)); err == nil {
			if o, ok := v.(*jsonx.Object); ok {
				current = o
			}
		}
	}
	if rc.r.Method == http.MethodGet || rc.r.Method == http.MethodHead {
		return a.writeJSON(w, rc, http.StatusOK, current)
	}
	if rc.r.Method != http.MethodPost {
		return writeText(w, http.StatusMethodNotAllowed, "Method Not Allowed")
	}
	v, err := jsonx.Decode(readBody(rc.r))
	if err != nil {
		return writeText(w, http.StatusBadRequest, "Body must be a JSON object.")
	}
	in, ok := v.(*jsonx.Object)
	if !ok {
		return writeText(w, http.StatusBadRequest, "Body must be a JSON object.")
	}
	next := in
	if rc.segs[len(rc.segs)-1] == "partial" {
		next = current
		for _, k := range in.Keys() {
			val, _ := in.Get(k)
			if val == nil {
				next.Delete(k)
			} else {
				next.Set(k, val)
			}
		}
	}
	raw, err := jsonx.Encode(next)
	if err != nil {
		return err
	}
	if err := a.st.SetPref(rc.ctx(), owner, prefUserSettings, string(raw)); err != nil {
		return err
	}
	return noContent(w)
}

// displayPreferences keeps each user's view settings (sort order, layout)
// per client. Until a user saves their own, they see the upstream account's.
func (a *app) displayPreferences(w http.ResponseWriter, rc *reqCtx, next caddyhttp.Handler) error {
	key := "displayprefs/" + queryGet(rc.q, "Client") + "/" + rc.raw[1]
	switch rc.r.Method {
	case http.MethodGet, http.MethodHead:
		stored, err := a.st.Pref(rc.ctx(), rc.owner.ID, key)
		if err != nil {
			return err
		}
		if stored == "" {
			return a.proxy(w, rc, next, nil)
		}
		v, err := jsonx.Decode([]byte(stored))
		if err != nil {
			return a.proxy(w, rc, next, nil)
		}
		return a.writeJSON(w, rc, http.StatusOK, v)
	case http.MethodPost:
		v, err := jsonx.Decode(readBody(rc.r))
		if err != nil {
			return writeText(w, http.StatusBadRequest, "Body must be a JSON object.")
		}
		raw, err := jsonx.Encode(v)
		if err != nil {
			return err
		}
		if err := a.st.SetPref(rc.ctx(), rc.owner.ID, key, string(raw)); err != nil {
			return err
		}
		return noContent(w)
	}
	return writeText(w, http.StatusMethodNotAllowed, "Method Not Allowed")
}
