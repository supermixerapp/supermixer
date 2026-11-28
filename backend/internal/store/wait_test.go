package store

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestRetryable(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want bool
	}{
		{errors.New("dial tcp: lookup db: no such host"), true},
		{fmt.Errorf("connecting: %w", &pgconn.PgError{Code: "57P03"}), true},  // starting up
		{fmt.Errorf("connecting: %w", &pgconn.PgError{Code: "28P01"}), false}, // wrong password
		{fmt.Errorf("connecting: %w", &pgconn.PgError{Code: "3D000"}), false}, // no such database
	} {
		if got := retryable(tc.err); got != tc.want {
			t.Errorf("%v: %v, want %v", tc.err, got, tc.want)
		}
	}
}

func TestOpenWaitGivesUp(t *testing.T) {
	start := time.Now()
	// Nothing listens on port 1.
	_, err := OpenWait(context.Background(), "postgres://u@127.0.0.1:1/db?connect_timeout=1", 0, 1500*time.Millisecond, slog.New(slog.DiscardHandler))
	if err == nil {
		t.Fatal("connected to nothing")
	}
	if d := time.Since(start); d < time.Second || d > 10*time.Second {
		t.Fatalf("gave up after %s", d)
	}
}

func TestPrune(t *testing.T) {
	dir := t.TempDir()
	// Schema versions differ; the time decides which are newest.
	names := []string{
		"supermixer-schema-9-20260101T000000Z.dump",
		"supermixer-schema-10-20260102T000000Z.dump",
		"supermixer-schema-11-20260103T000000Z.dump",
		"supermixer-schema-12-20260104T000000Z.dump",
		"other.txt",
	}
	for _, n := range names {
		_ = os.WriteFile(filepath.Join(dir, n), nil, 0o600)
	}
	prune(dir, 2, t.Errorf)
	left, _ := filepath.Glob(filepath.Join(dir, "*"))
	want := []string{"other.txt", names[2], names[3]}
	if len(left) != 3 {
		t.Fatalf("left %v", left)
	}
	for _, n := range want {
		if _, err := os.Stat(filepath.Join(dir, n)); err != nil {
			t.Errorf("%s removed", n)
		}
	}
}
