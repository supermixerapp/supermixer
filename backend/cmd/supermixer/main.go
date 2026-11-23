// Command supermixer runs the Supermixer management plane: REST API, theme
// assets and the embedded web UI, backed by its own PostgreSQL database.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"supermixer/internal/config"
	"supermixer/internal/httpapi"
	"supermixer/internal/store"
	"supermixer/internal/theme"
	"supermixer/internal/version"
	"supermixer/internal/webui"
)

func main() {
	envFile := flag.String("env-file", ".env", "path to a .env file (real environment variables take precedence)")
	flag.Parse()

	if err := run(*envFile); err != nil {
		fmt.Fprintln(os.Stderr, "supermixer:", err)
		os.Exit(1)
	}
}

func run(envFile string) error {
	cfg, err := config.Load(envFile)
	if err != nil {
		return fmt.Errorf("configuration: %w", err)
	}
	level, _ := cfg.SlogLevel()
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(logger)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	palette, err := theme.Derive(cfg.BrandColor)
	if err != nil {
		return err
	}

	st, err := store.Open(ctx, cfg.DatabaseURL, logger)
	if err != nil {
		return err
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		return err
	}

	srv := &http.Server{
		Addr: cfg.HTTPAddr,
		Handler: httpapi.New(httpapi.Deps{
			Config:  cfg,
			DB:      st,
			Palette: palette,
			Logger:  logger,
			WebUI:   webui.FS(),
		}),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errc := make(chan error, 1)
	go func() {
		logger.Info("supermixer listening", "addr", cfg.HTTPAddr, "public_url", cfg.PublicURL, "version", version.Version, "brand_color", palette.Brand.Hex())
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
	}
	return nil
}
