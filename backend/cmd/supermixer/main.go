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
	"supermixer/internal/tlscert"
	"supermixer/internal/version"
	"supermixer/internal/webui"
)

// databaseWait is how long start-up waits for the database to be
// reachable.
const databaseWait = 3 * time.Minute

func main() {
	if len(os.Args) > 1 && os.Args[1] == "init" {
		if err := runInit(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "supermixer init:", err)
			os.Exit(1)
		}
		return
	}
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

	st, err := store.OpenWait(ctx, cfg.Database.URL, cfg.Database.MaxConnections, databaseWait, logger)
	if err != nil {
		return err
	}
	defer st.Close()
	if dir := cfg.Database.MigrationBackupsDir; dir != "" {
		path, err := st.BackupBeforeMigrate(ctx, cfg.Database.URL, dir)
		if err != nil {
			return fmt.Errorf("backing up the database before migrating it (database.migration_backups_dir): %w", err)
		}
		if path != "" {
			logger.Info("backed up the database before migrating it", "path", path)
		}
	}
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
	// The certificate, if [tls] has one: files are checked now, so a
	// mistake stops start-up.
	certs, err := tlscert.New(cfg, logger)
	if err != nil {
		return err
	}
	go cleanupSessions(ctx, st, logger)
	pools := stack.NewPools(cfg.Projects.DBPoolSize, httpapi.StackNetwork(cfg, certs)) // connections to projects' databases
	defer pools.Close()

	// Prometheus metrics, on their own address.
	var m *metrics.Metrics
	var metricsSrv *http.Server
	if cfg.Metrics.Listen != "" {
		m = metrics.New(httpapi.MetricsState(st))
		if certs != nil {
			m.CertificateExpiry(certs.Expiry)
		}
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
	app := httpapi.New(httpapi.Deps{
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
		TLS:        certs,
	})

	// Plain HTTP on listen: the app, or with https_listen only redirects
	// to it (and health checks). ACME http-01 challenges are answered first.
	plain := app
	if cfg.Server.HTTPSListen != "" {
		plain = httpapi.RedirectToHTTPS(cfg.Server.PublicURL, app)
	}
	servers := []*http.Server{{Addr: cfg.Server.Listen, Handler: certs.HTTPChallenge(plain), ReadHeaderTimeout: 10 * time.Second}}
	if cfg.Server.HTTPSListen != "" {
		servers = append(servers, &http.Server{
			Addr: cfg.Server.HTTPSListen, Handler: app, TLSConfig: certs.ServerTLSConfig(), ReadHeaderTimeout: 10 * time.Second,
			// Failed handshakes (scanners, clients that don't trust the CA)
			// are routine on a public port.
			ErrorLog: slog.NewLogLogger(handler, slog.LevelDebug),
		})
	}
	// Bound before serving, so a port in use stops start-up, and before
	// the certificate manager starts, so ACME challenges find them.
	listeners := make([]net.Listener, len(servers))
	for i, srv := range servers {
		ln, err := net.Listen("tcp", srv.Addr)
		if err != nil {
			return fmt.Errorf("listening on %s: %w", srv.Addr, err)
		}
		listeners[i] = ln
	}
	if err := certs.Start(ctx); err != nil {
		return err
	}
	// SIGHUP rereads the certificate files now.
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	defer signal.Stop(hup)
	go func() {
		for range hup {
			logger.Info("SIGHUP: reloading the certificate")
			certs.Reload()
		}
	}()

	errc := make(chan error, len(servers))
	logger.Info("supermixer listening", "addr", cfg.Server.Listen, "https_addr", cfg.Server.HTTPSListen, "tls", cfg.TLS.Mode,
		"public_url", cfg.Server.PublicURL, "version", version.Version, "brand_color", palette.Brand.Hex())
	for i, srv := range servers {
		go func() {
			if srv.TLSConfig != nil {
				errc <- srv.ServeTLS(listeners[i], "", "") // the certificate comes from TLSConfig
			} else {
				errc <- srv.Serve(listeners[i])
			}
		}()
	}

	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		logger.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		var errs []error
		for _, srv := range servers {
			errs = append(errs, srv.Shutdown(shutdownCtx))
		}
		if err := errors.Join(errs...); err != nil {
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
