import { t } from '@/lib/i18n'

/**
 * Password lengths, as the server enforces them (NIST SP 800-63B-4): 15
 * characters for a password that's the only way to sign in, 8 with
 * two-factor sign-in. Characters are code points, so this is a hint only;
 * the server has the last word.
 */
export const MIN_PASSWORD = 8
export const MIN_SINGLE_FACTOR_PASSWORD = 15

/**
 * The minimum and hint for a new password. `mfa` is whether the account uses
 * two-factor sign-in (undefined when not known, as on the reset page);
 * `whose` is "your" or "their".
 */
export function passwordRule(mfa: boolean | undefined, whose: 'your' | 'their' = 'your') {
  const v = { min: MIN_SINGLE_FACTOR_PASSWORD, mfaMin: MIN_PASSWORD }
  if (mfa === true) {
    return {
      min: MIN_PASSWORD,
      hint: whose === 'your' ? t('common:passwords.mfaYour', { min: MIN_PASSWORD }) : t('common:passwords.mfaTheir', { min: MIN_PASSWORD }),
    }
  }
  if (mfa === false) {
    return {
      min: MIN_SINGLE_FACTOR_PASSWORD,
      hint: whose === 'your' ? t('common:passwords.singleYour', v) : t('common:passwords.singleTheir', v),
    }
  }
  return {
    min: MIN_PASSWORD,
    hint: whose === 'your' ? t('common:passwords.unknownYour', v) : t('common:passwords.unknownTheir', v),
  }
}
