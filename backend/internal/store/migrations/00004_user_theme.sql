-- +goose Up
-- Each user's theme, chosen under Account › Appearance. NULL means they
-- haven't chosen, and the instance default (appearance.default_theme) applies.
ALTER TABLE users ADD COLUMN theme text CHECK (theme IN ('dark', 'light', 'system'));

-- +goose Down
ALTER TABLE users DROP COLUMN theme;
