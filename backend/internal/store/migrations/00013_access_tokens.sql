-- +goose Up
-- Stage 5.4: personal access tokens, for scripts and CI. A token acts as
-- its owner; only its SHA-256 is kept.
CREATE TABLE access_tokens (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
    token_hash   bytea NOT NULL UNIQUE,
    -- The token's first characters, to tell tokens apart (sbp_1a2b…).
    prefix       text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    last_used_at timestamptz,
    last_used_ip text NOT NULL DEFAULT ''
);
CREATE INDEX access_tokens_user_id_idx ON access_tokens (user_id);

-- +goose Down
DROP TABLE access_tokens;
