-- +goose Up
-- Each user's language for the web app, chosen in its language menu. NULL
-- means they haven't chosen, and their browser's language applies.
ALTER TABLE users ADD COLUMN language text CHECK (language IN ('en', 'ja', 'fr', 'es', 'de'));

-- +goose Down
ALTER TABLE users DROP COLUMN language;
