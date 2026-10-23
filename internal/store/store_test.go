package store

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// The database holds password and token hashes, so it and the files SQLite
// keeps beside it are readable by the owner only, including a database that
// an older version created with the default mode.
func TestDatabaseFilesArePrivate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permissions")
	}
	path := filepath.Join(t.TempDir(), "users.db")
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateUser(t.Context(), "alice", "pw", false); err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, f := range []string{path, path + "-wal", path + "-shm"} {
		fi, err := os.Stat(f)
		if err != nil {
			continue
		}
		if mode := fi.Mode().Perm(); mode != 0o600 {
			t.Errorf("%s has mode %o", filepath.Base(f), mode)
		}
	}
}
