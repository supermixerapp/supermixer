// Package store owns Supermixer's own PostgreSQL database: the connection
// pool, schema migrations (embedded, run on startup) and sqlc-generated
// queries in package db.
package store

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"supermixer/internal/store/db"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Store bundles the pool and the typed queries.
type Store struct {
	Pool    *pgxpool.Pool
	Queries *db.Queries

	sqlDB  *sql.DB
	goose  *goose.Provider
	logger *slog.Logger
}

// Open connects to databaseURL and verifies the connection. maxConns 0
// keeps pgx's default pool size.
func Open(ctx context.Context, databaseURL string, maxConns int, logger *slog.Logger) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parsing database.url: %w", err)
	}
	if maxConns > 0 {
		cfg.MaxConns = int32(maxConns)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("creating connection pool: %w", err)
	}

	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("connecting to %s@%s/%s: %w", cfg.ConnConfig.User, cfg.ConnConfig.Host, cfg.ConnConfig.Database, err)
	}

	sqlDB := stdlib.OpenDBFromPool(pool)
	closeAll := func() {
		_ = sqlDB.Close()
		pool.Close()
	}
	migrations, err := fs.Sub(migrationsFS, "migrations")
	if err != nil {
		closeAll()
		return nil, err
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, migrations)
	if err != nil {
		closeAll()
		return nil, fmt.Errorf("loading migrations: %w", err)
	}

	return &Store{
		Pool:    pool,
		Queries: db.New(pool),
		sqlDB:   sqlDB,
		goose:   provider,
		logger:  logger,
	}, nil
}

// Migrate applies all pending migrations.
func (s *Store) Migrate(ctx context.Context) error {
	results, err := s.goose.Up(ctx)
	for _, r := range results {
		s.logger.Info("applied migration", "version", r.Source.Version, "file", r.Source.Path, "duration", r.Duration)
	}
	if err != nil {
		return fmt.Errorf("running migrations: %w", err)
	}
	return nil
}

// SchemaVersion returns the latest applied migration version.
func (s *Store) SchemaVersion(ctx context.Context) (int64, error) {
	return s.goose.GetDBVersion(ctx)
}

// Ping checks the database connection.
func (s *Store) Ping(ctx context.Context) error { return s.Pool.Ping(ctx) }

// InstalledAt is when this Supermixer database was first initialised.
func (s *Store) InstalledAt(ctx context.Context) (time.Time, error) {
	return s.Queries.GetInstalledAt(ctx)
}

// Close releases all connections.
func (s *Store) Close() {
	_ = s.sqlDB.Close()
	s.Pool.Close()
}

// InTx runs fn in a transaction, committing if it returns nil.
func (s *Store) InTx(ctx context.Context, fn func(q *db.Queries) error) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err := fn(s.Queries.WithTx(tx)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
