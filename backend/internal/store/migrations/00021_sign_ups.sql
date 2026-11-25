-- +goose Up
-- Open sign-up (Instance › Sign-up). Someone gives an email address and gets
-- a link; their account is made only when they follow it. Each link works
-- once, for a day; only the token's hash is kept. While the instance
-- requires approval, accounts made this way wait for an instance admin's
-- before they can sign in.
CREATE TABLE sign_ups (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email      text NOT NULL,
    token_hash bytea NOT NULL UNIQUE,
    ip         text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at    timestamptz
);
CREATE INDEX sign_ups_email_idx ON sign_ups (email);

ALTER TABLE users ADD COLUMN waiting_approval boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE users DROP COLUMN waiting_approval;
DROP TABLE sign_ups;
