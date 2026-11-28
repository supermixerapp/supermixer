package store

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// OpenWait is Open, retried while the database isn't reachable yet, for up
// to wait: after a reboot Docker starts Supermixer and its database in no
// particular order. A database that answers with an error (a wrong
// password, a missing database) fails at once.
func OpenWait(ctx context.Context, databaseURL string, maxConns int, wait time.Duration, logger *slog.Logger) (*Store, error) {
	deadline := time.Now().Add(wait)
	delay := time.Second
	for {
		st, err := Open(ctx, databaseURL, maxConns, logger)
		if err == nil || !retryable(err) || time.Now().Add(delay).After(deadline) {
			return st, err
		}
		logger.Info("waiting for the database", "err", err)
		select {
		case <-ctx.Done():
			return nil, err
		case <-time.After(delay):
		}
		delay = min(delay*2, 10*time.Second)
	}
}

// retryable reports whether err is the database not being there yet,
// rather than refusing Supermixer.
func retryable(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		// 57P03: the database system is starting up.
		return pgErr.Code == "57P03"
	}
	return true
}
