-- +goose Up
-- Audit log drains.
--
-- Entries are read in the order of the transaction that wrote them (txid,
-- then id), and only once every transaction that could still add an
-- earlier one has finished: ids alone could skip an entry whose
-- transaction committed after a later id's.
ALTER TABLE audit_logs ADD COLUMN txid bigint NOT NULL DEFAULT (pg_current_xact_id()::text::bigint);
CREATE INDEX audit_logs_txid_idx ON audit_logs (txid, id);

-- How far each drain has delivered: entries after (last_txid, last_id) are
-- still to send. A new drain starts after what's already there.
CREATE TABLE audit_drains (
    id              text PRIMARY KEY,
    last_txid       bigint NOT NULL,
    last_id         bigint NOT NULL,
    last_success_at timestamptz,
    last_error      text NOT NULL DEFAULT '',
    last_error_at   timestamptz
);

-- +goose Down
DROP TABLE audit_drains;
DROP INDEX audit_logs_txid_idx;
ALTER TABLE audit_logs DROP COLUMN txid;
