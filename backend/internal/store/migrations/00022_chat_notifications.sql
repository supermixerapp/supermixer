-- +goose Up
-- Chat notifications: an organization webhook can post to a chat app's
-- incoming webhook (Slack, Microsoft Teams, Discord, Google Chat,
-- Mattermost) as a readable message instead of signed JSON. For those,
-- the address itself is the credential: `secret` holds it sealed, and `url`
-- only its scheme and host, to show.
ALTER TABLE org_webhooks
    ADD COLUMN kind text NOT NULL DEFAULT 'webhook'
        CHECK (kind IN ('webhook', 'slack', 'teams', 'discord', 'google_chat', 'mattermost'));

-- +goose Down
-- Without kind, a chat channel would look like a signed webhook to its bare
-- host: remove them.
DELETE FROM org_webhooks WHERE kind <> 'webhook';
ALTER TABLE org_webhooks DROP COLUMN kind;
