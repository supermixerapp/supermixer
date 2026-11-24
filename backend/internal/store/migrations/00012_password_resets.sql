-- +goose Up
-- Stage 5.3: "Forgot your password?" links, sent by email. Each works once,
-- for an hour; only the token's hash is kept.
CREATE TABLE password_resets (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash bytea NOT NULL UNIQUE,
    ip         text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at    timestamptz
);
CREATE INDEX password_resets_user_id_idx ON password_resets (user_id);

-- +goose Down
DROP TABLE password_resets;
