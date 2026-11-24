// Command supermixer runs the Supermixer management plane: REST API, theme
// assets and the embedded web UI, backed by its own PostgreSQL database.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"supermixer/internal/bootstrap"
	"supermixer/internal/config"
	"supermixer/internal/httpapi"
	"supermixer/internal/metrics"
	"supermixer/internal/secrets"
	"supermixer/internal/stack"
	"supermixer/internal/store"
	"supermixer/internal/theme"
	"supermixer/internal/version"
	"supermixer/internal/webui"
)

func main() {
	configFile := flag.String("config", "", "TOML config file (default: $SUPERMIXER_CONFIG, else ./.env.toml)")
	flag.Parse()

	if err := run(*configFile); err != nil {
		fmt.Fprintln(os.Stderr, "supermixer:", err)
		os.Exit(1)
	}
}

// configPath picks the config file. A path given explicitly must exist; the
// default may be missing when everything comes from the environment.
func configPath(flagValue string) (path string, required bool) {
	switch {
	case flagValue != "":
		return flagValue, true
	case os.Getenv("SUPERMIXER_CONFIG") != "":
		return os.Getenv("SUPERMIXER_CONFIG"), true
	default:
		return ".env.toml", false
	}
}

func run(configFile string) error {
	path, required := configPath(configFile)
	cfg, err := config.Load(path, required)
	if err != nil {
		return fmt.Errorf("configuration: %w", err)
	}
	level, _ := cfg.SlogLevel()
	opts := &slog.HandlerOptions{Level: level}
	var handler slog.Handler = slog.NewTextHandler(os.Stderr, opts)
	if cfg.Log.Format == "json" {
		handler = slog.NewJSONHandler(os.Stderr, opts)
	}
	logger := slog.New(handler)
	slog.SetDefault(logger)
	for _, n := range cfg.Notes {
		logger.Warn(n)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	palette, err := theme.Derive(cfg.Appearance.BrandColor)
	if err != nil {
		return err
	}

	st, err := store.Open(ctx, cfg.Database.URL, cfg.Database.MaxConnections, logger)
	if err != nil {
		return err
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		return err
	}
	if err := bootstrap.EnsureAdmin(ctx, st, cfg, logger); err != nil {
		return err
	}
	box, err := secrets.New(cfg.Security.EncryptionKey)
	if err != nil {
		return err
	}
	go cleanupSessions(ctx, st, logger)
	pools := stack.NewPools(cfg.Projects.DBPoolSize) // connections to projects' databases
	defer pools.Close()

	// Prometheus metrics, on their own address.
	var m *metrics.Metrics
	var metricsSrv *http.Server
	if cfg.Metrics.Listen != "" {
		m = metrics.New(httpapi.MetricsState(st))
		mux := http.NewServeMux()
		mux.Handle("GET /metrics", m.Handler())
		metricsSrv = &http.Server{Addr: cfg.Metrics.Listen, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
		// Bound now, so a port in use stops start-up instead of leaving
		// Supermixer running without metrics.
		ln, err := net.Listen("tcp", cfg.Metrics.Listen)
		if err != nil {
			return fmt.Errorf("metrics.listen: %w", err)
		}
		go func() {
			logger.Info("metrics listening", "addr", cfg.Metrics.Listen)
			if err := metricsSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
				logger.Error("metrics server stopped", "err", err)
			}
		}()
	}

	var pending sync.WaitGroup // emails still being sent, and the like
	srv := &http.Server{
		Addr: cfg.Server.Listen,
		Handler: httpapi.New(httpapi.Deps{
			Config:     cfg,
			DB:         st,
			Store:      st,
			Box:        box,
			Palette:    palette,
			Logger:     logger,
			WebUI:      webui.FS(),
			Pools:      pools,
			Background: ctx,
			Pending:    &pending,
			Metrics:    m,
		}),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errc := make(chan error, 1)
	go func() {
		logger.Info("supermixer listening", "addr", cfg.Server.Listen, "public_url", cfg.Server.PublicURL, "version", version.Version, "brand_color", palette.Brand.Hex())
		errc <- srv.ListenAndServe()
	}()

	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		logger.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			return err
		}
		if metricsSrv != nil {
			_ = metricsSrv.Shutdown(shutdownCtx)
		}
		done := make(chan struct{})
		go func() { pending.Wait(); close(done) }()
		select {
		case <-done:
		case <-shutdownCtx.Done():
			logger.Warn("stopped before every email was sent")
		}
	}
	return nil
}

// cleanupSessions deletes expired sessions hourly.
func cleanupSessions(ctx context.Context, st *store.Store, logger *slog.Logger) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		if err := st.Queries.DeleteExpiredSessions(ctx); err != nil && ctx.Err() == nil {
			logger.Warn("deleting expired sessions", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
