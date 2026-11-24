-- +goose Up
-- Account › Audit log: what someone did, and what was done to their account.
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, id DESC);
CREATE INDEX audit_logs_target_idx ON audit_logs (target_type, target_id, id DESC);

-- +goose Down
DROP INDEX audit_logs_target_idx;
DROP INDEX audit_logs_actor_idx;
