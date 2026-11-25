-- +goose Up
-- An account that must choose a new password before doing
-- anything else: the bootstrap admin, accounts an instance admin creates,
-- and passwords an instance admin resets (each can opt out).
ALTER TABLE users ADD COLUMN password_change_required boolean NOT NULL DEFAULT false;
-- Accounts still on the well-known default password change it now.
UPDATE users SET password_change_required = true WHERE default_password;

-- +goose Down
ALTER TABLE users DROP COLUMN password_change_required;
