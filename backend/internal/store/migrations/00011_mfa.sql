-- +goose Up
-- Two-factor sign-in with an authenticator app (TOTP) and
-- single-use recovery codes, and organizations that require it.
ALTER TABLE users
    -- The TOTP secret, encrypted with the instance key (set once confirmed).
    ADD COLUMN totp_secret    bytea,
    -- A secret being set up, until the first code confirms it.
    ADD COLUMN totp_pending   bytea,
    -- The last 30-second step a code was accepted for: a code can't be used twice.
    ADD COLUMN totp_last_step bigint,
    ADD COLUMN mfa_enabled_at timestamptz;

CREATE TABLE mfa_recovery_codes (
    user_id   uuid  NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- SHA-256 of the code; codes are random, so a plain hash is enough.
    code_hash bytea NOT NULL,
    used_at   timestamptz,
    PRIMARY KEY (user_id, code_hash)
);

ALTER TABLE organizations ADD COLUMN mfa_required boolean NOT NULL DEFAULT false;

-- Sign-in challenges that have made a session: each works once.
CREATE TABLE mfa_used_challenges (
    id         uuid PRIMARY KEY,
    expires_at timestamptz NOT NULL
);

-- +goose Down
DROP TABLE mfa_used_challenges;
ALTER TABLE organizations DROP COLUMN mfa_required;
DROP TABLE mfa_recovery_codes;
ALTER TABLE users DROP COLUMN totp_secret, DROP COLUMN totp_pending, DROP COLUMN totp_last_step, DROP COLUMN mfa_enabled_at;
