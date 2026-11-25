-- +goose Up
-- Stack upgrades back the database up first.
ALTER TYPE backup_kind ADD VALUE IF NOT EXISTS 'pre_upgrade';

-- +goose Down
-- Postgres can't drop an enum value; 'pre_upgrade' rows are harmless.
SELECT 1;
