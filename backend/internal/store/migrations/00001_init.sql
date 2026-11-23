-- +goose Up
-- Key/value settings for this Supermixer installation.
CREATE TABLE instance_settings (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO instance_settings (key, value) VALUES ('installed_at', to_jsonb(now()));

-- +goose Down
DROP TABLE instance_settings;
