// Package store keeps accounts, sessions, preferences and per-user play state
// in SQLite.
package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
	_ "modernc.org/sqlite"
)

// ErrNameTaken is returned when a user name is already in use.
var ErrNameTaken = errors.New("user name is already taken")

const schema = `
CREATE TABLE IF NOT EXISTS meta (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
	id         TEXT PRIMARY KEY,
	name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
	password   TEXT NOT NULL DEFAULT '',
	admin      INTEGER NOT NULL DEFAULT 0,
	disabled   INTEGER NOT NULL DEFAULT 0,
	created    INTEGER NOT NULL,
	last_login INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
	token_hash  TEXT PRIMARY KEY,
	id          TEXT NOT NULL UNIQUE,
	user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	device_id   TEXT NOT NULL,
	device_name TEXT NOT NULL,
	client      TEXT NOT NULL,
	version     TEXT NOT NULL,
	remote_addr TEXT NOT NULL,
	created     INTEGER NOT NULL,
	seen        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_device ON sessions(device_id);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS prefs (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	key     TEXT NOT NULL,
	value   TEXT NOT NULL,
	PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS item_state (
	user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	item_id     TEXT NOT NULL,
	type        TEXT NOT NULL DEFAULT '',
	series_id   TEXT NOT NULL DEFAULT '',
	season_id   TEXT NOT NULL DEFAULT '',
	position    INTEGER NOT NULL DEFAULT 0,
	play_count  INTEGER NOT NULL DEFAULT 0,
	played      INTEGER NOT NULL DEFAULT 0,
	favorite    INTEGER NOT NULL DEFAULT 0,
	likes       INTEGER,
	last_played INTEGER NOT NULL DEFAULT 0,
	hide_before INTEGER NOT NULL DEFAULT 0,
	updated     INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS item_state_series ON item_state(user_id, series_id);
CREATE INDEX IF NOT EXISTS item_state_season ON item_state(user_id, season_id);
CREATE INDEX IF NOT EXISTS item_state_recent ON item_state(user_id, last_played);
`

// Store is a handle to the database. It is safe for concurrent use.
type Store struct {
	db *sql.DB
}

// Open opens or creates the database at path.
func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	// The file holds password and token hashes. SQLite gives its WAL and
	// shared-memory files the same mode as the database.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	f.Close()
	if err := os.Chmod(path, 0o600); err != nil {
		return nil, err
	}
	dsn := "file:" + path + "?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("create schema: %w", err)
	}
	return &Store{db: db}, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

// Now is the store's clock, in Unix milliseconds.
func Now() int64 { return time.Now().UnixMilli() }

// RandomID returns 32 lowercase hex characters, the shape Emby uses for user
// ids, session ids and access tokens.
func RandomID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

// ---- meta ----

// Meta returns the value stored under key, or "" when there is none.
func (s *Store) Meta(ctx context.Context, key string) (string, error) {
	var v string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}

// SetMeta stores value under key.
func (s *Store) SetMeta(ctx context.Context, key, value string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO meta(key, value) VALUES(?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

// ---- users ----

// User is a local account.
type User struct {
	ID          string
	Name        string
	Admin       bool
	Disabled    bool
	HasPassword bool
	Created     int64
	LastLogin   int64

	password string
}

const userColumns = `id, name, password, admin, disabled, created, last_login`

func scanUser(row interface{ Scan(...any) error }) (*User, error) {
	var u User
	if err := row.Scan(&u.ID, &u.Name, &u.password, &u.Admin, &u.Disabled, &u.Created, &u.LastLogin); err != nil {
		return nil, err
	}
	u.HasPassword = u.password != ""
	return &u, nil
}

// Users lists every account by name.
func (s *Store) Users(ctx context.Context) ([]*User, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+userColumns+` FROM users ORDER BY name COLLATE NOCASE`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// UserByID returns the account with id, or nil.
func (s *Store) UserByID(ctx context.Context, id string) (*User, error) {
	u, err := scanUser(s.db.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users WHERE id = ?`, strings.ToLower(id)))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return u, err
}

// UserByName returns the account with name (case-insensitive), or nil.
func (s *Store) UserByName(ctx context.Context, name string) (*User, error) {
	u, err := scanUser(s.db.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users WHERE name = ?`, name))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return u, err
}

// CreateUser adds an account. An empty password leaves the account unable to
// sign in until one is set.
func (s *Store) CreateUser(ctx context.Context, name, password string, admin bool) (*User, error) {
	hash, err := hashPassword(password)
	if err != nil {
		return nil, err
	}
	u := &User{ID: RandomID(), Name: name, Admin: admin, HasPassword: hash != "", Created: Now(), password: hash}
	_, err = s.db.ExecContext(ctx, `INSERT INTO users(id, name, password, admin, created) VALUES(?, ?, ?, ?, ?)`,
		u.ID, u.Name, hash, admin, u.Created)
	if isUniqueViolation(err) {
		return nil, ErrNameTaken
	}
	return u, err
}

// RenameUser changes an account's name.
func (s *Store) RenameUser(ctx context.Context, id, name string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET name = ? WHERE id = ?`, name, id)
	if isUniqueViolation(err) {
		return ErrNameTaken
	}
	return err
}

// DeleteUser removes an account with its sessions and play state.
func (s *Store) DeleteUser(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, id)
	return err
}

// SetPassword replaces an account's password. An empty password disables
// password sign-in.
func (s *Store) SetPassword(ctx context.Context, id, password string) error {
	hash, err := hashPassword(password)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `UPDATE users SET password = ? WHERE id = ?`, hash, id)
	return err
}

// SetFlags sets the administrator and disabled flags.
func (s *Store) SetFlags(ctx context.Context, id string, admin, disabled bool) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET admin = ?, disabled = ? WHERE id = ?`, admin, disabled, id)
	return err
}

// dummyHash is checked when the account does not exist, so a failed sign-in
// takes as long for an unknown name as for a wrong password.
var dummyHash, _ = hashPassword("caddy-emby-users")

// CheckPassword reports whether password matches the account's password.
// Missing accounts and accounts without a password never match.
func (s *Store) CheckPassword(u *User, password string) bool {
	if u == nil || u.password == "" {
		verifyPassword(dummyHash, password)
		return false
	}
	return verifyPassword(u.password, password)
}

// TouchLogin records a successful sign-in.
func (s *Store) TouchLogin(ctx context.Context, id string, at int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET last_login = ? WHERE id = ?`, at, id)
	return err
}

func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

// Argon2id with the parameters OWASP recommends for interactive logins.
const (
	argonTime    = 2
	argonMemory  = 19 * 1024
	argonThreads = 1
	argonKeyLen  = 32
)

func hashPassword(password string) (string, error) {
	if password == "" {
		return "", nil
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	enc := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads, enc.EncodeToString(salt), enc.EncodeToString(key)), nil
}

func verifyPassword(encoded, password string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false
	}
	var m, t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return false
	}
	enc := base64.RawStdEncoding
	salt, err := enc.DecodeString(parts[4])
	if err != nil {
		return false
	}
	want, err := enc.DecodeString(parts[5])
	if err != nil {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, t, m, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// ---- sessions ----

// Session is a signed-in device. The token itself is never stored.
type Session struct {
	// ID identifies the session in API responses; it is not the token.
	ID         string
	UserID     string
	DeviceID   string
	DeviceName string
	Client     string
	Version    string
	RemoteAddr string
	Created    int64
	Seen       int64
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// CreateSession stores a session for token. Emby keeps one session per
// device, so a sign-in replaces any earlier session of the same device, even
// one that belonged to another user.
func (s *Store) CreateSession(ctx context.Context, token string, sess *Session) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE device_id = ?`, sess.DeviceID); err != nil {
		return err
	}
	sess.ID = RandomID()
	if _, err := tx.ExecContext(ctx, `INSERT INTO sessions(token_hash, id, user_id, device_id, device_name, client, version, remote_addr, created, seen)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		tokenHash(token), sess.ID, sess.UserID, sess.DeviceID, sess.DeviceName, sess.Client, sess.Version, sess.RemoteAddr, sess.Created, sess.Seen); err != nil {
		return err
	}
	return tx.Commit()
}

const sessionColumns = `s.id, s.user_id, s.device_id, s.device_name, s.client, s.version, s.remote_addr, s.created, s.seen`

func scanSession(row interface{ Scan(...any) error }, extra ...any) (*Session, error) {
	var x Session
	dest := append([]any{&x.ID, &x.UserID, &x.DeviceID, &x.DeviceName, &x.Client, &x.Version, &x.RemoteAddr, &x.Created, &x.Seen}, extra...)
	if err := row.Scan(dest...); err != nil {
		return nil, err
	}
	return &x, nil
}

// SessionByToken returns the session and account for token, or nils.
func (s *Store) SessionByToken(ctx context.Context, token string) (*Session, *User, error) {
	var u User
	sess, err := scanSession(s.db.QueryRowContext(ctx, `SELECT `+sessionColumns+`, u.id, u.name, u.password, u.admin, u.disabled, u.created, u.last_login
		FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, tokenHash(token)),
		&u.ID, &u.Name, &u.password, &u.Admin, &u.Disabled, &u.Created, &u.LastLogin)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	u.HasPassword = u.password != ""
	return sess, &u, nil
}

// TouchSession records activity on the session for token.
func (s *Store) TouchSession(ctx context.Context, token string, at int64, remote string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE sessions SET seen = ?, remote_addr = ? WHERE token_hash = ?`, at, remote, tokenHash(token))
	return err
}

// DeleteSession signs out the session for token.
func (s *Store) DeleteSession(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, tokenHash(token))
	return err
}

// DeleteDevice signs out every session of a device and reports how many
// there were.
func (s *Store) DeleteDevice(ctx context.Context, deviceID string) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE device_id = ?`, deviceID)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// DeleteUserSessions signs out every device of an account except the one
// holding keepToken (which may be empty).
func (s *Store) DeleteUserSessions(ctx context.Context, userID, keepToken string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?`, userID, tokenHash(keepToken))
	return err
}

// SessionWithUser pairs a session with its account name.
type SessionWithUser struct {
	Session
	UserName string
}

// Sessions lists sessions seen at or after since, newest first.
func (s *Store) Sessions(ctx context.Context, since int64) ([]SessionWithUser, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+sessionColumns+`, u.name FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.seen >= ? ORDER BY s.seen DESC`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SessionWithUser
	for rows.Next() {
		var name string
		sess, err := scanSession(rows, &name)
		if err != nil {
			return nil, err
		}
		out = append(out, SessionWithUser{Session: *sess, UserName: name})
	}
	return out, rows.Err()
}

// ---- preferences ----

// Pref returns the JSON stored under key for a user, or "".
func (s *Store) Pref(ctx context.Context, userID, key string) (string, error) {
	var v string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM prefs WHERE user_id = ? AND key = ?`, userID, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}

// SetPref stores JSON under key for a user.
func (s *Store) SetPref(ctx context.Context, userID, key, value string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO prefs(user_id, key, value) VALUES(?, ?, ?)
		ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`, userID, key, value)
	return err
}

// ---- play state ----

// ItemState is one user's state for one item. Missing rows read as the zero
// value: never played, not a favorite.
type ItemState struct {
	ItemID   string
	Type     string
	SeriesID string
	SeasonID string
	// Position is the resume point in ticks (1 tick = 100ns).
	Position  int64
	PlayCount int64
	Played    bool
	Favorite  bool
	// Likes is nil when the user has not rated the item.
	Likes *bool
	// LastPlayed is Unix milliseconds, 0 when never played.
	LastPlayed int64
	// HideBefore hides a series from continue watching until something in it
	// is played after this time (Unix milliseconds).
	HideBefore int64
	Updated    int64
}

const stateColumns = `item_id, type, series_id, season_id, position, play_count, played, favorite, likes, last_played, hide_before, updated`

func scanState(row interface{ Scan(...any) error }) (ItemState, error) {
	var st ItemState
	var likes sql.NullBool
	err := row.Scan(&st.ItemID, &st.Type, &st.SeriesID, &st.SeasonID, &st.Position, &st.PlayCount,
		&st.Played, &st.Favorite, &likes, &st.LastPlayed, &st.HideBefore, &st.Updated)
	if likes.Valid {
		v := likes.Bool
		st.Likes = &v
	}
	return st, err
}

func (s *Store) states(ctx context.Context, query string, args ...any) ([]ItemState, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ItemState
	for rows.Next() {
		st, err := scanState(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

// States returns the stored rows for ids, keyed by item id.
func (s *Store) States(ctx context.Context, userID string, ids []string) (map[string]ItemState, error) {
	out := make(map[string]ItemState, len(ids))
	for _, chunk := range chunks(ids, 500) {
		args := append([]any{userID}, toAny(chunk)...)
		rows, err := s.states(ctx, `SELECT `+stateColumns+` FROM item_state WHERE user_id = ? AND item_id IN (`+placeholders(len(chunk))+`)`, args...)
		if err != nil {
			return nil, err
		}
		for _, st := range rows {
			out[st.ItemID] = st
		}
	}
	return out, nil
}

// State returns one row, or the zero state for an item the user never touched.
func (s *Store) State(ctx context.Context, userID, itemID string) (ItemState, error) {
	m, err := s.States(ctx, userID, []string{itemID})
	if err != nil {
		return ItemState{}, err
	}
	st, ok := m[itemID]
	if !ok {
		st.ItemID = itemID
	}
	return st, nil
}

// PutStates writes rows in one transaction.
func (s *Store) PutStates(ctx context.Context, userID string, rows []ItemState) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx, `INSERT INTO item_state(user_id, `+stateColumns+`) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, item_id) DO UPDATE SET type = excluded.type, series_id = excluded.series_id, season_id = excluded.season_id,
			position = excluded.position, play_count = excluded.play_count, played = excluded.played, favorite = excluded.favorite,
			likes = excluded.likes, last_played = excluded.last_played, hide_before = excluded.hide_before, updated = excluded.updated`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	now := Now()
	for _, st := range rows {
		var likes any
		if st.Likes != nil {
			likes = *st.Likes
		}
		if _, err := stmt.ExecContext(ctx, userID, st.ItemID, st.Type, st.SeriesID, st.SeasonID, st.Position, st.PlayCount,
			st.Played, st.Favorite, likes, st.LastPlayed, st.HideBefore, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Recent lists rows the user has played, most recent first.
func (s *Store) Recent(ctx context.Context, userID string, limit int) ([]ItemState, error) {
	return s.states(ctx, `SELECT `+stateColumns+` FROM item_state WHERE user_id = ? AND last_played > 0
		ORDER BY last_played DESC LIMIT ?`, userID, limit)
}

// Favorites lists the user's favorites, most recently changed first.
func (s *Store) Favorites(ctx context.Context, userID string, limit int) ([]ItemState, error) {
	return s.states(ctx, `SELECT `+stateColumns+` FROM item_state WHERE user_id = ? AND favorite = 1
		ORDER BY updated DESC LIMIT ?`, userID, limit)
}

// Rated lists items the user liked (likes true) or disliked.
func (s *Store) Rated(ctx context.Context, userID string, likes bool, limit int) ([]ItemState, error) {
	return s.states(ctx, `SELECT `+stateColumns+` FROM item_state WHERE user_id = ? AND likes = ?
		ORDER BY updated DESC LIMIT ?`, userID, likes, limit)
}

// Played lists played items, most recently played first.
func (s *Store) Played(ctx context.Context, userID string, limit int) ([]ItemState, error) {
	return s.states(ctx, `SELECT `+stateColumns+` FROM item_state WHERE user_id = ? AND played = 1
		ORDER BY last_played DESC, updated DESC LIMIT ?`, userID, limit)
}

// Resumable lists unfinished items with a resume point, most recent first.
func (s *Store) Resumable(ctx context.Context, userID string, limit int) ([]ItemState, error) {
	return s.states(ctx, `SELECT `+stateColumns+` FROM item_state WHERE user_id = ? AND position > 0 AND played = 0
		ORDER BY last_played DESC LIMIT ?`, userID, limit)
}

// SeriesState lists the rows of every episode of a series the user touched.
func (s *Store) SeriesStates(ctx context.Context, userID, seriesID string) ([]ItemState, error) {
	return s.states(ctx, `SELECT `+stateColumns+` FROM item_state WHERE user_id = ? AND series_id = ?`, userID, seriesID)
}

// Tally summarizes a user's played episodes under one series or season.
type Tally struct {
	Played     int64
	LastPlayed int64
}

// PlayedTallies counts played episodes per series (column "series_id") or per
// season (column "season_id") for the given ids.
func (s *Store) PlayedTallies(ctx context.Context, userID, column string, ids []string) (map[string]Tally, error) {
	if column != "series_id" && column != "season_id" {
		return nil, fmt.Errorf("store: cannot tally by %q", column)
	}
	out := map[string]Tally{}
	for _, chunk := range chunks(ids, 500) {
		args := append([]any{userID}, toAny(chunk)...)
		rows, err := s.db.QueryContext(ctx, `SELECT `+column+`, SUM(played), MAX(last_played) FROM item_state
			WHERE user_id = ? AND type = 'Episode' AND `+column+` IN (`+placeholders(len(chunk))+`) GROUP BY `+column, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id string
			var t Tally
			if err := rows.Scan(&id, &t.Played, &t.LastPlayed); err != nil {
				rows.Close()
				return nil, err
			}
			out[id] = t
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func chunks(ids []string, n int) [][]string {
	var out [][]string
	for len(ids) > n {
		out = append(out, ids[:n])
		ids = ids[n:]
	}
	if len(ids) > 0 {
		out = append(out, ids)
	}
	return out
}

func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

func toAny(ss []string) []any {
	out := make([]any, len(ss))
	for i, s := range ss {
		out[i] = s
	}
	return out
}
