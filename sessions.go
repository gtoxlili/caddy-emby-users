package embyusers

import (
	"bufio"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"go.uber.org/zap"

	"github.com/gtoxlili/caddy-emby-users/internal/jsonx"
	"github.com/gtoxlili/caddy-emby-users/internal/store"
)

// sessionInfo renders a session the way /Sessions and the sign-in response
// do. Numbers are never null and arrays never missing; Yamby and nextEmby
// deserialize strictly.
func sessionInfo(s *store.SessionWithUser, serverID string, playing *jsonx.Object) *jsonx.Object {
	state := obj("CanSeek", false, "IsPaused", false, "IsMuted", false, "RepeatMode", "RepeatNone")
	o := obj(
		"PlayState", state,
		"AdditionalUsers", []any{},
		"RemoteEndPoint", s.RemoteAddr,
		"Protocol", "HTTP/1.1",
		"PlayableMediaTypes", []any{"Audio", "Video"},
		"PlaylistIndex", 0,
		"PlaylistLength", 0,
		"Id", s.ID,
		"ServerId", serverID,
		"UserId", s.UserID,
		"UserName", s.UserName,
		"Client", s.Client,
		"DeviceName", s.DeviceName,
		"DeviceId", s.DeviceID,
		"ApplicationVersion", s.Version,
		"LastActivityDate", embyDate(s.Seen),
		"SupportedCommands", []any{},
		"SupportsRemoteControl", false,
	)
	if playing != nil {
		o.Set("NowPlayingItem", playing)
	}
	return o
}

// listSessions shows administrators every device active in the last hour
// and what it is playing; everyone else sees only their own devices.
func (a *app) listSessions(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	list, err := a.st.Sessions(rc.ctx(), store.Now()-int64(time.Hour/time.Millisecond))
	if err != nil {
		return err
	}
	_, _, serverID := a.up.credentials()
	out := []any{}
	for i := range list {
		s := &list[i]
		if !rc.user.Admin && s.UserID != rc.user.ID {
			continue
		}
		var item *jsonx.Object
		np, playing := a.playing.get(s.ID)
		if playing {
			if o, err := a.up.item(rc.ctx(), np.itemID); err == nil {
				if err := a.overlay(rc.ctx(), s.UserID, o); err == nil {
					item = o
				}
			}
		}
		info := sessionInfo(s, serverID, item)
		if item != nil {
			info.Set("PlayState", obj("PositionTicks", np.position, "CanSeek", true, "IsPaused", np.paused,
				"IsMuted", false, "RepeatMode", "RepeatNone", "PlayMethod", "DirectStream"))
		}
		out = append(out, info)
	}
	return a.writeJSON(w, rc, http.StatusOK, out)
}

func (a *app) logout(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	if err := a.st.DeleteSession(rc.ctx(), rc.token); err != nil {
		return err
	}
	a.playing.clear(rc.sess.ID)
	a.sessions.invalidate()
	return noContent(w)
}

// listDevices is the session table seen by device.
func (a *app) listDevices(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	if !rc.user.Admin {
		return writeText(w, http.StatusForbidden, textForbidden)
	}
	list, err := a.st.Sessions(rc.ctx(), 0)
	if err != nil {
		return err
	}
	items := make([]any, 0, len(list))
	for _, s := range list {
		items = append(items, obj(
			"Id", s.DeviceID,
			"Name", s.DeviceName,
			"AppName", s.Client,
			"AppVersion", s.Version,
			"LastUserName", s.UserName,
			"LastUserId", s.UserID,
			"DateLastActivity", embyDate(s.Seen),
		))
	}
	return a.writeJSON(w, rc, http.StatusOK, obj("Items", items, "TotalRecordCount", len(items)))
}

// deleteDevice signs a device out; it has to sign in again.
func (a *app) deleteDevice(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	if !rc.user.Admin {
		return writeText(w, http.StatusForbidden, textForbidden)
	}
	id := queryGet(rc.q, "Id")
	if id == "" {
		return writeText(w, http.StatusBadRequest, "Id is required.")
	}
	n, err := a.st.DeleteDevice(rc.ctx(), id)
	if err != nil {
		return err
	}
	a.sessions.invalidate()
	if n > 0 {
		a.log.Info("device signed out", zap.String("device", id), zap.String("by", rc.user.Name))
	}
	return noContent(w)
}

// websocket keeps the connection alive and nothing more. Without it the web
// client logs an error and Emby Theater falls back to polling; with the
// upstream socket, every user would receive the shared account's events.
func (a *app) websocket(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	r := rc.r
	key := r.Header.Get("Sec-WebSocket-Key")
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || key == "" {
		return writeText(w, http.StatusBadRequest, "Expected a WebSocket upgrade.")
	}
	conn, brw, err := http.NewResponseController(w).Hijack()
	if err != nil {
		return writeText(w, http.StatusBadRequest, "WebSocket is not available on this connection.")
	}
	defer conn.Close()
	sum := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	fmt.Fprintf(brw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n",
		base64.StdEncoding.EncodeToString(sum[:]))
	if err := brw.Flush(); err != nil {
		return nil
	}
	ws := &wsConn{conn: conn, r: brw.Reader}
	if err := ws.writeJSON(map[string]any{"MessageType": "ForceKeepAlive", "Data": 60}); err != nil {
		return nil
	}
	for {
		conn.SetReadDeadline(time.Now().Add(3 * time.Minute))
		msg, err := ws.read()
		if err != nil {
			return nil
		}
		var m struct{ MessageType string }
		if json.Unmarshal(msg, &m) != nil {
			continue
		}
		var reply map[string]any
		switch {
		case m.MessageType == "KeepAlive":
			reply = map[string]any{"MessageType": "KeepAlive"}
		case strings.HasSuffix(m.MessageType, "Start"):
			reply = map[string]any{"MessageType": strings.TrimSuffix(m.MessageType, "Start"), "Data": []any{}}
		}
		if reply != nil {
			if err := ws.writeJSON(reply); err != nil {
				return nil
			}
		}
	}
}

// wsConn is the server side of RFC 6455, enough for text messages, ping
// and close.
type wsConn struct {
	conn net.Conn
	r    *bufio.Reader
}

const (
	wsContinuation = 0x0
	wsText         = 0x1
	wsBinary       = 0x2
	wsClose        = 0x8
	wsPing         = 0x9
	wsPong         = 0xA
)

// read returns the next complete data message.
func (c *wsConn) read() ([]byte, error) {
	var msg []byte
	for {
		fin, op, payload, err := c.frame()
		if err != nil {
			return nil, err
		}
		switch op {
		case wsPing:
			if err := c.write(wsPong, payload); err != nil {
				return nil, err
			}
			continue
		case wsPong:
			continue
		case wsClose:
			c.write(wsClose, payload)
			return nil, io.EOF
		case wsText, wsBinary, wsContinuation:
			msg = append(msg, payload...)
			if len(msg) > 1<<20 {
				return nil, errors.New("websocket message too large")
			}
			if fin {
				return msg, nil
			}
		default:
			return nil, fmt.Errorf("websocket opcode %d", op)
		}
	}
}

func (c *wsConn) frame() (fin bool, op byte, payload []byte, err error) {
	var head [2]byte
	if _, err = io.ReadFull(c.r, head[:]); err != nil {
		return
	}
	fin = head[0]&0x80 != 0
	op = head[0] & 0x0F
	masked := head[1]&0x80 != 0
	n := uint64(head[1] & 0x7F)
	switch n {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(c.r, ext[:]); err != nil {
			return
		}
		n = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(c.r, ext[:]); err != nil {
			return
		}
		n = binary.BigEndian.Uint64(ext[:])
	}
	if n > 1<<20 {
		err = errors.New("websocket frame too large")
		return
	}
	var mask [4]byte
	if masked {
		if _, err = io.ReadFull(c.r, mask[:]); err != nil {
			return
		}
	}
	payload = make([]byte, n)
	if _, err = io.ReadFull(c.r, payload); err != nil {
		return
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return
}

func (c *wsConn) write(op byte, payload []byte) error {
	head := []byte{0x80 | op}
	switch n := len(payload); {
	case n < 126:
		head = append(head, byte(n))
	case n <= 0xFFFF:
		head = append(head, 126, byte(n>>8), byte(n))
	default:
		head = append(head, 127)
		head = binary.BigEndian.AppendUint64(head, uint64(n))
	}
	c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if _, err := c.conn.Write(append(head, payload...)); err != nil {
		return err
	}
	return nil
}

func (c *wsConn) writeJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.write(wsText, b)
}

// importUpstream copies the upstream account's own resume points and
// favorites into one local user. Run it once for the person whose upstream
// account this is, so their history carries over.
func (a *app) importUpstream(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	if !rc.user.Admin {
		return writeText(w, http.StatusForbidden, textForbidden)
	}
	target := rc.user
	if id := queryGet(rc.q, "UserId"); id != "" {
		u, err := a.st.UserByID(rc.ctx(), id)
		if err != nil {
			return err
		}
		if u == nil {
			return writeText(w, http.StatusNotFound, textNotFound)
		}
		target = u
	}
	n, err := a.importFrom(rc.ctx(), target.ID)
	if err != nil {
		a.log.Error("importing upstream state", zap.Error(err))
		return writeText(w, http.StatusBadGateway, "Upstream server is unavailable.")
	}
	a.log.Info("imported upstream state", zap.String("user", target.Name), zap.Int("items", n))
	return a.writeJSON(w, rc, http.StatusOK, obj("UserId", target.ID, "ImportedItems", n))
}

func (a *app) importFrom(ctx context.Context, userID string) (int, error) {
	if err := a.up.ensure(ctx); err != nil {
		return 0, err
	}
	_, uid, _ := a.up.credentials()
	sources := []struct {
		path string
		q    map[string][]string
	}{
		{"/Users/" + uid + "/Items/Resume", map[string][]string{"Limit": {"500"}, "Recursive": {"true"}}},
		{"/Users/" + uid + "/Items", map[string][]string{"Filters": {"IsFavorite"}, "Recursive": {"true"}, "Limit": {"2000"}}},
	}
	byID := map[string]store.ItemState{}
	for _, src := range sources {
		raw, err := a.up.get(ctx, src.path, src.q)
		if err != nil {
			return 0, err
		}
		v, err := jsonx.Decode(raw)
		if err != nil {
			return 0, err
		}
		doc, _ := v.(*jsonx.Object)
		if doc == nil {
			continue
		}
		list, _ := doc.Get("Items")
		items, _ := list.([]any)
		for _, it := range items {
			o, _ := it.(*jsonx.Object)
			if o == nil || o.String("Id") == "" || o.Object("UserData") == nil {
				continue
			}
			ud := o.Object("UserData")
			m := metaOf(o)
			st, ok := byID[m.ID]
			if !ok {
				st = store.ItemState{ItemID: m.ID, Type: m.Type, SeriesID: m.SeriesID, SeasonID: m.SeasonID}
			}
			if pos, ok := ud.Int("PlaybackPositionTicks"); ok && pos > 0 {
				st.Position = pos
			}
			if n, ok := ud.Int("PlayCount"); ok {
				st.PlayCount = n
			}
			st.Played = st.Played || ud.Bool("Played")
			st.Favorite = st.Favorite || ud.Bool("IsFavorite")
			if t := parseDate(ud.String("LastPlayedDate")); t > 0 {
				st.LastPlayed = t
			}
			byID[m.ID] = st
		}
	}
	rows := make([]store.ItemState, 0, len(byID))
	for _, st := range byID {
		rows = append(rows, st)
	}
	return len(rows), a.st.PutStates(ctx, userID, rows)
}
