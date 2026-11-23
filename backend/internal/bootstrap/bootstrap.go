// Package bootstrap creates the first admin account on a fresh install.
//
// This is temporary: Stage 5 replaces it with proper admin management.
package bootstrap

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strings"

	"supermixer/internal/auth"
	"supermixer/internal/config"
	"supermixer/internal/store"
	"supermixer/internal/store/db"
)

// WellKnownPassword is the documented default; accounts using it are flagged.
const WellKnownPassword = "admin"

var usernamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{1,38}[a-z0-9]$`)

// EnsureAdmin creates the bootstrap instance admin when no users exist, and
// warns about any account still using the well-known password.
func EnsureAdmin(ctx context.Context, st *store.Store, cfg *config.Config, logger *slog.Logger) error {
	q := st.Queries
	n, err := q.CountUsers(ctx)
	if err != nil {
		return err
	}
	if n == 0 {
		username := strings.ToLower(strings.TrimSpace(cfg.BootstrapAdmin.Username))
		if !usernamePattern.MatchString(username) {
			return fmt.Errorf("bootstrap_admin.username %q is not a valid username (3–40 of a-z 0-9 . _ -)", cfg.BootstrapAdmin.Username)
		}
		hash, err := auth.HashPassword(cfg.BootstrapAdmin.Password)
		if err != nil {
			return err
		}
		if _, err := q.CreateUser(ctx, db.CreateUserParams{
			Username: username, DisplayName: "Administrator", PasswordHash: hash,
			IsInstanceAdmin: true, DefaultPassword: cfg.BootstrapAdmin.Password == WellKnownPassword,
		}); err != nil {
			return fmt.Errorf("creating bootstrap admin: %w", err)
		}
		logger.Info("created bootstrap admin account", "username", username)
	}

	weak, err := q.ListDefaultPasswordUsers(ctx)
	if err != nil {
		return err
	}
	if len(weak) > 0 {
		logger.Warn("SECURITY: these accounts still use the default password; sign in and change it under Account › Preferences",
			"usernames", strings.Join(weak, ", "))
	}
	return nil
}
