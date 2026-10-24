package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Activity is one entry of the activity log administrators read: sign-ins,
// failed sign-ins, playback and account changes. Names are copied in, so an
// entry still reads right after the account is renamed or deleted.
type Activity struct {
	ID   int64
	At   int64
	Type string
	// UserID and UserName are the account the entry is about; a failed sign-in
	// has only the name that was tried.
	UserID   string
	UserName string
	ItemID   string
	// Title is what was played: the film, or the series of an episode. Detail
	// names the episode.
	Title    string
	Detail   string
	SeriesID string
	Device   string
	Client   string
	Remote   string
	// ByName is the administrator who made an account change.
	ByName string
}

// Activity entries older than this are removed as new ones arrive.
const activityKeep = 90 * 24 * time.Hour

const activityColumns = `id, at, type, user_id, user_name, item_id, title, detail, series_id, device, client, remote, by_name`

// AddActivity appends an entry and drops entries past the retention period.
func (s *Store) AddActivity(ctx context.Context, a Activity) error {
	if a.At == 0 {
		a.At = Now()
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `INSERT INTO activity(at, type, user_id, user_name, item_id, title, detail, series_id, device, client, remote, by_name)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.At, a.Type, a.UserID, a.UserName, a.ItemID, a.Title, a.Detail, a.SeriesID, a.Device, a.Client, a.Remote, a.ByName); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM activity WHERE at < ?`, a.At-int64(activityKeep/time.Millisecond)); err != nil {
		return err
	}
	return tx.Commit()
}

// AddPlayback records a playback start. Starting the same film or series
// again within window, as one does episode after episode in an evening,
// moves the latest entry forward instead of adding another.
func (s *Store) AddPlayback(ctx context.Context, a Activity, window time.Duration) error {
	if a.At == 0 {
		a.At = Now()
	}
	key, col := a.ItemID, "item_id"
	if a.SeriesID != "" {
		key, col = a.SeriesID, "series_id"
	}
	var id int64
	err := s.db.QueryRowContext(ctx, `SELECT id FROM activity WHERE type = ? AND user_id = ? AND `+col+` = ? AND at >= ?
		ORDER BY at DESC LIMIT 1`, a.Type, a.UserID, key, a.At-int64(window/time.Millisecond)).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return s.AddActivity(ctx, a)
	}
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `UPDATE activity SET at = ?, user_name = ?, item_id = ?, title = ?, detail = ?, device = ?, client = ?, remote = ?
		WHERE id = ?`, a.At, a.UserName, a.ItemID, a.Title, a.Detail, a.Device, a.Client, a.Remote, id)
	return err
}

// ActivityQuery selects entries, newest first.
type ActivityQuery struct {
	Since  int64
	UserID string
	Start  int
	Limit  int
}

// Activities returns one page of entries and how many match in total.
func (s *Store) Activities(ctx context.Context, q ActivityQuery) ([]Activity, int, error) {
	where, args := `WHERE at >= ?`, []any{q.Since}
	if q.UserID != "" {
		where += ` AND user_id = ?`
		args = append(args, q.UserID)
	}
	var total int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM activity `+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+activityColumns+` FROM activity `+where+` ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`,
		append(args, q.Limit, q.Start)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []Activity
	for rows.Next() {
		var a Activity
		if err := rows.Scan(&a.ID, &a.At, &a.Type, &a.UserID, &a.UserName, &a.ItemID, &a.Title, &a.Detail, &a.SeriesID,
			&a.Device, &a.Client, &a.Remote, &a.ByName); err != nil {
			return nil, 0, err
		}
		out = append(out, a)
	}
	return out, total, rows.Err()
}
