-- +goose Up
-- Single sign-on. An identity is an account at an OIDC provider
-- (its issuer's subject) connected to a Supermixer user.
CREATE TABLE user_identities (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider        text NOT NULL,
    subject         text NOT NULL,
    email           text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_sign_in_at timestamptz,
    UNIQUE (provider, subject),
    -- One identity per provider per user.
    UNIQUE (user_id, provider)
);

-- Accounts made by signing in through a provider have no password until
-- they set one (a reset link, or an admin).
ALTER TABLE users ADD COLUMN has_password boolean NOT NULL DEFAULT true;

-- Emails are compared without case: Ann@x and ann@x are one address.
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

-- +goose Down
DROP INDEX users_email_lower_idx;
ALTER TABLE users DROP COLUMN has_password;
DROP TABLE user_identities;
