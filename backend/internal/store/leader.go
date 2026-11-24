package store

import (
	"context"
	"log/slog"
	"net"
	"time"

	"github.com/jackc/pgx/v5"
)

// leaderLock is the Postgres advisory lock the instance doing background
// work holds ("supermixer" in ASCII, as a number).
const leaderLock int64 = 0x73757065726d6978

// RunAsLeader calls work while this instance is the leader, which is the
// one holding the leader lock: with several Supermixer replicas on one
// database, background work (backups, uploads, audit drains, watching
// stacks) runs on just one. Others wait, retrying every retry, and take
// over if the leader stops or loses its database connection; work's
// context is cancelled then. It returns when ctx is done.
func (s *Store) RunAsLeader(ctx context.Context, logger *slog.Logger, retry time.Duration, work func(context.Context)) {
	waiting := false
	for ctx.Err() == nil {
		// Its own connection, not the pool's: the lock lives as long as it
		// does, and closing the pool mustn't wait for it.
		cctx, ccancel := context.WithTimeout(ctx, 10*time.Second)
		conn, err := s.leaderConn(cctx)
		ccancel()
		if err != nil {
			sleep(ctx, retry)
			continue
		}
		var got bool
		if err := conn.QueryRow(ctx, "select pg_try_advisory_lock($1)", leaderLock).Scan(&got); err != nil || !got {
			_ = conn.Close(context.Background())
			if !waiting && err == nil {
				logger.Info("another Supermixer instance is doing the background work; this one will take over if it stops")
				waiting = true
			}
			sleep(ctx, retry)
			continue
		}
		waiting = false
		logger.Info("this instance does the background work (backups, audit drains, watching stacks)")
		wctx, cancel := context.WithCancel(ctx)
		done := make(chan struct{})
		go func() { defer close(done); work(wctx) }()

		// Check the connection, and with it the lock.
		t := time.NewTicker(retry / 2)
		lost := false
		for !lost && ctx.Err() == nil {
			select {
			case <-ctx.Done():
			case <-done:
				lost = true // work stopped by itself
			case <-t.C:
				pctx, pcancel := context.WithTimeout(ctx, 5*time.Second)
				if err := conn.Ping(pctx); err != nil && ctx.Err() == nil {
					logger.Warn("lost the database connection holding the leader lock; stopping background work", "err", err)
					lost = true
				}
				pcancel()
			}
		}
		t.Stop()
		cancel()
		<-done
		// Closing the connection lets go of the lock.
		cl, clcancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = conn.Close(cl)
		clcancel()
		if lost {
			sleep(ctx, retry)
		}
	}
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

// leaderConn connects for the leader lock, with keepalives both ways: if
// the leader's machine dies without closing the connection, Postgres
// notices within about half a minute and lets go of the lock (by default
// it could take hours).
func (s *Store) leaderConn(ctx context.Context) (*pgx.Conn, error) {
	cfg := s.Pool.Config().ConnConfig.Copy()
	d := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 10 * time.Second}
	cfg.DialFunc = d.DialContext
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	// Set after connecting, not as startup parameters, which a pooler in
	// between may refuse; it isn't fatal if they can't be set.
	for _, set := range []string{
		"SET tcp_keepalives_idle = 10", "SET tcp_keepalives_interval = 5", "SET tcp_keepalives_count = 3",
		"SET tcp_user_timeout = 30000",
	} {
		if _, err := conn.Exec(ctx, set); err != nil {
			s.logger.Debug("leader connection setting refused", "setting", set, "err", err)
		}
	}
	return conn, nil
}
