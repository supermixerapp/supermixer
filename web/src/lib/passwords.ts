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
  const rest = `not a common password or ${whose} username`
  if (mfa === true) return { min: MIN_PASSWORD, hint: `At least ${MIN_PASSWORD} characters (with two-factor sign-in on), and ${rest}` }
  if (mfa === false) {
    return {
      min: MIN_SINGLE_FACTOR_PASSWORD,
      hint: `At least ${MIN_SINGLE_FACTOR_PASSWORD} characters (${MIN_PASSWORD} with two-factor sign-in on), and ${rest}`,
    }
  }
  return {
    min: MIN_PASSWORD,
    hint: `At least ${MIN_SINGLE_FACTOR_PASSWORD} characters, or ${MIN_PASSWORD} if two-factor sign-in is on; ${rest}`,
  }
}
