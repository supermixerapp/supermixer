// Package bootstrap creates the first admin account on a fresh install,
// which must choose a new password when it first signs in.
package bootstrap

import (
	"context"
	"crypto/rand"
	"encoding/base64"
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
		password, generated := cfg.BootstrapAdmin.Password, false
		if password == "" {
			b := make([]byte, 15)
			if _, err := rand.Read(b); err != nil {
				return err
			}
			password, generated = base64.RawURLEncoding.EncodeToString(b), true
		}
		hash, err := auth.HashPassword(password)
		if err != nil {
			return err
		}
		if _, err := q.CreateUser(ctx, db.CreateUserParams{
			Username: username, DisplayName: "Administrator", PasswordHash: hash,
			IsInstanceAdmin: true, DefaultPassword: password == WellKnownPassword,
			PasswordChangeRequired: true, // whoever reads the log or the config knows it
		}); err != nil {
			return fmt.Errorf("creating bootstrap admin: %w", err)
		}
		if generated {
			// Printed once; it only works until the admin chooses a new one.
			logger.Warn("created the first admin account with a one-time password: sign in and choose a new one",
				"username", username, "password", password)
		} else {
			logger.Info("created the first admin account with bootstrap_admin.password; it must choose a new one at first sign-in",
				"username", username)
		}
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
