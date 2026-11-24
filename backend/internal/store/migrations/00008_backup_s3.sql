-- +goose Up
-- Copies of backups in an S3-compatible bucket (provisioning.backup_s3).
ALTER TABLE backups
    -- Whether the files are in provisioning.backups_dir.
    ADD COLUMN local               boolean NOT NULL DEFAULT true,
    -- Where the copy went, once uploaded (the key holds its files).
    ADD COLUMN remote_bucket       text NOT NULL DEFAULT '',
    ADD COLUMN remote_key          text NOT NULL DEFAULT '',
    ADD COLUMN uploaded_at         timestamptz,
    -- The last failed upload, and how many failed (to wait longer between tries).
    ADD COLUMN upload_error        text NOT NULL DEFAULT '',
    ADD COLUMN upload_attempts     int NOT NULL DEFAULT 0,
    ADD COLUMN upload_attempted_at timestamptz;

-- Backup copies in a bucket whose records are gone but which couldn't be
-- removed yet (the bucket was unreachable, or isn't the one configured).
-- The uploader removes them once it can.
CREATE TABLE backup_leftovers (
    bucket     text NOT NULL,
    key        text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (bucket, key)
);

-- +goose Down
DROP TABLE backup_leftovers;
ALTER TABLE backups
    DROP COLUMN local, DROP COLUMN remote_bucket, DROP COLUMN remote_key, DROP COLUMN uploaded_at,
    DROP COLUMN upload_error, DROP COLUMN upload_attempts, DROP COLUMN upload_attempted_at;
