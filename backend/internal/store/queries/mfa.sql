-- name: SetTOTPPending :exec
UPDATE users SET totp_pending = $2, updated_at = now() WHERE id = $1;

-- name: EnableTOTP :one
-- Confirms the pending secret, remembering the step its first code used.
UPDATE users
SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = $2, mfa_enabled_at = now(), updated_at = now()
WHERE id = $1 AND totp_pending IS NOT NULL AND totp_secret IS NULL
RETURNING *;

-- name: DisableMFA :exec
UPDATE users
SET totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL, mfa_enabled_at = NULL, updated_at = now()
WHERE id = $1;

-- name: UseTOTPStep :one
-- Accepts a code's step only once, and only after the last one accepted.
UPDATE users SET totp_last_step = $2
WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)
RETURNING id;

-- name: DeleteRecoveryCodes :exec
DELETE FROM mfa_recovery_codes WHERE user_id = $1;

-- name: AddRecoveryCode :exec
INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2);

-- name: UseRecoveryCode :one
UPDATE mfa_recovery_codes SET used_at = now()
WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
RETURNING user_id;

-- name: CountRecoveryCodesLeft :one
SELECT count(*)::int FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL;

-- name: UseChallenge :one
-- Records a sign-in challenge as used; no row if it already was.
INSERT INTO mfa_used_challenges (id, expires_at) VALUES ($1, $2)
ON CONFLICT (id) DO NOTHING
RETURNING id;

-- name: PruneUsedChallenges :exec
DELETE FROM mfa_used_challenges WHERE expires_at < now();

-- name: ChallengeUsed :one
SELECT EXISTS (SELECT 1 FROM mfa_used_challenges WHERE id = $1);
