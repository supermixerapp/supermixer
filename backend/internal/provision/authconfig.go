package provision

import (
	"errors"
	"fmt"
	"io/fs"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Auth (GoTrue) is configured by environment variables. Settings Supabase's
// compose file already passes from .env (SITE_URL, DISABLE_SIGNUP, SMTP_*, …)
// are changed there; the rest live in auth.env, which the overlay gives the
// auth service. Email template bodies are files under volumes/auth-templates,
// served to Auth by the overlay's auth-templates sidecar (GoTrue only fetches
// templates over HTTP). Field names follow Supabase's Management API
// (/v1/projects/{ref}/config/auth). Every GOTRUE_* name of a boolean, number
// or duration was checked against supabase/gotrue v2.197.0 by starting it with
// a bad value (envconfig names the variable it can't parse).

const (
	authEnvFile      = "auth.env"
	authTemplatesDir = "volumes/auth-templates"
)

// AuthKind is how a field's value is checked and stored.
type AuthKind int

const (
	AuthBool       AuthKind = iota
	AuthInt                 // a whole number ≥ 0
	AuthNumber              // a number ≥ 0 (rate limits)
	AuthSeconds             // a duration, in whole seconds (stored as "Ns")
	AuthString              // one line of text
	AuthEmail               // an email address
	AuthURL                 // an http(s) URL
	AuthURLList             // comma-separated redirect URLs (globs allowed)
	AuthEnum                // one of Enum
	AuthSecret              // one line, never returned
	AuthHookURI             // pg-functions://postgres/<schema>/<function>, or an http(s) URL
	AuthHookSecret          // v1,whsec_<base64>, never returned
	AuthTemplate            // an email template's HTML, stored as a file
)

// AuthField is one Auth setting.
type AuthField struct {
	Name     string // API name
	Env      string // the variable: in .env when InDotEnv, else GOTRUE_* in auth.env
	InDotEnv bool
	Kind     AuthKind
	Enum     []string
	Max      float64 // AuthInt / AuthNumber / AuthSeconds upper bound (0: none)
	// ResetEmpty: putting it back to the default empties it, instead of
	// restoring Supabase's example value (a fake SMTP login).
	ResetEmpty bool
}

// Secret reports whether the field's value is never returned.
func (f AuthField) Secret() bool { return f.Kind == AuthSecret || f.Kind == AuthHookSecret }

// OAuthProviders Supermixer offers. Each has _enabled, _client_id and
// _secret; those in oauthURLProviders also take a _url.
var OAuthProviders = []string{"apple", "azure", "bitbucket", "discord", "facebook", "figma", "github", "gitlab", "google",
	"kakao", "keycloak", "linkedin_oidc", "notion", "slack_oidc", "spotify", "twitch", "twitter", "x", "workos", "zoom"}

var oauthURLProviders = map[string]bool{"azure": true, "gitlab": true, "keycloak": true, "workos": true}

// Auth hooks: each has _enabled, _uri and _secrets.
var AuthHooks = []string{"custom_access_token", "send_sms", "send_email", "mfa_verification_attempt",
	"password_verification_attempt", "before_user_created"}

// EmailTemplates: each has mailer_subjects_<t> and mailer_templates_<t>_content.
var EmailTemplates = []string{"confirmation", "invite", "magic_link", "recovery", "email_change", "reauthentication"}

// SMS providers GoTrue supports.
var SMSProviders = []string{"twilio", "twilio_verify", "messagebird", "textlocal", "vonage"}

var authFields = buildAuthFields()

func buildAuthFields() []AuthField {
	dot := func(name, env string, k AuthKind) AuthField {
		return AuthField{Name: name, Env: env, InDotEnv: true, Kind: k}
	}
	gt := func(name string, k AuthKind) AuthField {
		return AuthField{Name: name, Env: "GOTRUE_" + strings.ToUpper(name), Kind: k}
	}
	f := []AuthField{
		// URL configuration and sign-ups (wired from .env by Supabase's compose file).
		dot("site_url", "SITE_URL", AuthURL),
		dot("uri_allow_list", "ADDITIONAL_REDIRECT_URLS", AuthURLList),
		dot("disable_signup", "DISABLE_SIGNUP", AuthBool),
		dot("external_email_enabled", "ENABLE_EMAIL_SIGNUP", AuthBool),
		dot("external_anonymous_users_enabled", "ENABLE_ANONYMOUS_USERS", AuthBool),
		dot("mailer_autoconfirm", "ENABLE_EMAIL_AUTOCONFIRM", AuthBool),
		dot("external_phone_enabled", "ENABLE_PHONE_SIGNUP", AuthBool),
		dot("sms_autoconfirm", "ENABLE_PHONE_AUTOCONFIRM", AuthBool),
		// SMTP.
		dot("smtp_admin_email", "SMTP_ADMIN_EMAIL", AuthEmail),
		dot("smtp_host", "SMTP_HOST", AuthString),
		{Name: "smtp_port", Env: "SMTP_PORT", InDotEnv: true, Kind: AuthInt, Max: 65535},
		{Name: "smtp_user", Env: "SMTP_USER", InDotEnv: true, Kind: AuthString, ResetEmpty: true},
		{Name: "smtp_pass", Env: "SMTP_PASS", InDotEnv: true, Kind: AuthSecret, ResetEmpty: true},
		dot("smtp_sender_name", "SMTP_SENDER_NAME", AuthString),
		{Name: "smtp_max_frequency", Env: "GOTRUE_SMTP_MAX_FREQUENCY", Kind: AuthSeconds, Max: 86400},

		// Email provider.
		gt("mailer_secure_email_change_enabled", AuthBool),
		{Name: "security_update_password_require_reauthentication", Env: "GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION", Kind: AuthBool},
		{Name: "mailer_otp_exp", Env: "GOTRUE_MAILER_OTP_EXP", Kind: AuthInt, Max: 86400},
		{Name: "mailer_otp_length", Env: "GOTRUE_MAILER_OTP_LENGTH", Kind: AuthInt, Max: 10},

		// Phone provider.
		{Name: "sms_provider", Env: "GOTRUE_SMS_PROVIDER", Kind: AuthEnum, Enum: SMSProviders},
		{Name: "sms_otp_exp", Env: "GOTRUE_SMS_OTP_EXP", Kind: AuthInt, Max: 86400},
		{Name: "sms_otp_length", Env: "GOTRUE_SMS_OTP_LENGTH", Kind: AuthInt, Max: 10},
		{Name: "sms_max_frequency", Env: "GOTRUE_SMS_MAX_FREQUENCY", Kind: AuthSeconds, Max: 86400},
		gt("sms_template", AuthString),
		gt("sms_twilio_account_sid", AuthString),
		gt("sms_twilio_auth_token", AuthSecret),
		gt("sms_twilio_message_service_sid", AuthString),
		gt("sms_twilio_verify_account_sid", AuthString),
		gt("sms_twilio_verify_auth_token", AuthSecret),
		gt("sms_twilio_verify_message_service_sid", AuthString),
		gt("sms_messagebird_access_key", AuthSecret),
		gt("sms_messagebird_originator", AuthString),
		gt("sms_textlocal_api_key", AuthSecret),
		gt("sms_textlocal_sender", AuthString),
		gt("sms_vonage_api_key", AuthString),
		gt("sms_vonage_api_secret", AuthSecret),
		gt("sms_vonage_from", AuthString),

		// Sessions.
		{Name: "refresh_token_rotation_enabled", Env: "GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED", Kind: AuthBool},
		{Name: "security_refresh_token_reuse_interval", Env: "GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL", Kind: AuthInt, Max: 3600},
		gt("sessions_single_per_user", AuthBool),
		{Name: "sessions_timebox", Env: "GOTRUE_SESSIONS_TIMEBOX", Kind: AuthSeconds, Max: 10 * 365 * 86400},
		{Name: "sessions_inactivity_timeout", Env: "GOTRUE_SESSIONS_INACTIVITY_TIMEOUT", Kind: AuthSeconds, Max: 10 * 365 * 86400},

		// Rate limits: email and SMS per hour, the rest per 5 minutes per IP
		// (anonymous sign-ins per hour per IP).
		{Name: "rate_limit_email_sent", Env: "GOTRUE_RATE_LIMIT_EMAIL_SENT", Kind: AuthNumber, Max: 1e6},
		{Name: "rate_limit_sms_sent", Env: "GOTRUE_RATE_LIMIT_SMS_SENT", Kind: AuthNumber, Max: 1e6},
		{Name: "rate_limit_token_refresh", Env: "GOTRUE_RATE_LIMIT_TOKEN_REFRESH", Kind: AuthNumber, Max: 1e6},
		{Name: "rate_limit_verify", Env: "GOTRUE_RATE_LIMIT_VERIFY", Kind: AuthNumber, Max: 1e6},
		{Name: "rate_limit_otp", Env: "GOTRUE_RATE_LIMIT_OTP", Kind: AuthNumber, Max: 1e6},
		{Name: "rate_limit_anonymous_users", Env: "GOTRUE_RATE_LIMIT_ANONYMOUS_USERS", Kind: AuthNumber, Max: 1e6},

		// Multi-factor.
		gt("mfa_totp_enroll_enabled", AuthBool),
		gt("mfa_totp_verify_enabled", AuthBool),
		gt("mfa_phone_enroll_enabled", AuthBool),
		gt("mfa_phone_verify_enabled", AuthBool),
		{Name: "mfa_max_enrolled_factors", Env: "GOTRUE_MFA_MAX_ENROLLED_FACTORS", Kind: AuthInt, Max: 100},

		// Attack protection.
		{Name: "password_min_length", Env: "GOTRUE_PASSWORD_MIN_LENGTH", Kind: AuthInt, Max: 72},
		{Name: "password_required_characters", Env: "GOTRUE_PASSWORD_REQUIRED_CHARACTERS", Kind: AuthEnum, Enum: PasswordRequirements},
		gt("password_hibp_enabled", AuthBool),
		gt("security_captcha_enabled", AuthBool),
		{Name: "security_captcha_provider", Env: "GOTRUE_SECURITY_CAPTCHA_PROVIDER", Kind: AuthEnum, Enum: []string{"hcaptcha", "turnstile"}},
		gt("security_captcha_secret", AuthSecret),
	}
	for _, p := range OAuthProviders {
		P := strings.ToUpper(p)
		f = append(f,
			AuthField{Name: "external_" + p + "_enabled", Env: "GOTRUE_EXTERNAL_" + P + "_ENABLED", Kind: AuthBool},
			AuthField{Name: "external_" + p + "_client_id", Env: "GOTRUE_EXTERNAL_" + P + "_CLIENT_ID", Kind: AuthString},
			AuthField{Name: "external_" + p + "_secret", Env: "GOTRUE_EXTERNAL_" + P + "_SECRET", Kind: AuthSecret},
		)
		if oauthURLProviders[p] {
			f = append(f, AuthField{Name: "external_" + p + "_url", Env: "GOTRUE_EXTERNAL_" + P + "_URL", Kind: AuthURL})
		}
	}
	for _, h := range AuthHooks {
		H := strings.ToUpper(h)
		f = append(f,
			AuthField{Name: "hook_" + h + "_enabled", Env: "GOTRUE_HOOK_" + H + "_ENABLED", Kind: AuthBool},
			AuthField{Name: "hook_" + h + "_uri", Env: "GOTRUE_HOOK_" + H + "_URI", Kind: AuthHookURI},
			AuthField{Name: "hook_" + h + "_secrets", Env: "GOTRUE_HOOK_" + H + "_SECRETS", Kind: AuthHookSecret},
		)
	}
	for _, t := range EmailTemplates {
		T := strings.ToUpper(t)
		f = append(f,
			AuthField{Name: "mailer_subjects_" + t, Env: "GOTRUE_MAILER_SUBJECTS_" + T, Kind: AuthString},
			AuthField{Name: "mailer_templates_" + t + "_content", Env: "GOTRUE_MAILER_TEMPLATES_" + T, Kind: AuthTemplate},
		)
	}
	return f
}

// PasswordRequirements are GoTrue's accepted sets of required characters
// (each group separated by ":"), as Studio offers them; "" is none.
var PasswordRequirements = []string{
	"",
	"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
	"abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
	"abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789:!@#$%^&*()_+-=[]{};'\\\\:\"|<>?,./`~",
}

// AuthFields lists every setting, in a stable order.
func AuthFields() []AuthField { return authFields }

func authField(name string) (AuthField, bool) {
	for _, f := range authFields {
		if f.Name == name {
			return f, true
		}
	}
	return AuthField{}, false
}

// AuthConfig is a stack's Auth settings: values of the fields that are set
// (nil when left to Auth's default), and which secrets are set.
type AuthConfig struct {
	Values     map[string]any // bool, float64 or string
	SecretsSet []string
}

// ReadAuthConfig reads a stack's Auth settings.
func ReadAuthConfig(stackDir string) (AuthConfig, error) {
	env, err := ReadEnv(stackDir)
	if err != nil {
		return AuthConfig{}, err
	}
	auth, err := readEnvFile(filepath.Join(stackDir, authEnvFile))
	if err != nil {
		return AuthConfig{}, err
	}
	out := AuthConfig{Values: map[string]any{}, SecretsSet: []string{}}
	for _, f := range authFields {
		var raw string
		var ok bool
		switch {
		case f.Kind == AuthTemplate:
			b, err := os.ReadFile(templatePath(stackDir, f))
			raw, ok = string(b), err == nil && len(b) > 0
		case f.InDotEnv:
			raw, ok = env[f.Env]
		default:
			raw, ok = auth[f.Env]
		}
		if !ok {
			out.Values[f.Name] = nil
			continue
		}
		if f.Secret() {
			if raw != "" {
				out.SecretsSet = append(out.SecretsSet, f.Name)
			}
			continue
		}
		out.Values[f.Name] = decodeAuthValue(f, raw)
	}
	sort.Strings(out.SecretsSet)
	return out, nil
}

func decodeAuthValue(f AuthField, raw string) any {
	switch f.Kind {
	case AuthBool:
		b, err := strconv.ParseBool(strings.TrimSpace(raw))
		if err != nil {
			return nil
		}
		return b
	case AuthInt, AuthNumber:
		n, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
		if err != nil {
			return nil
		}
		return n
	case AuthSeconds:
		d, err := time.ParseDuration(strings.TrimSpace(raw))
		if err != nil {
			if n, err2 := strconv.ParseFloat(strings.TrimSpace(raw), 64); err2 == nil {
				return n // GoTrue reads a bare number as nanoseconds; shown as is
			}
			return nil
		}
		return math.Round(d.Seconds())
	default:
		return raw
	}
}

// AuthChange is one setting to change; Value nil puts it back to its default.
type AuthChange struct {
	Name  string
	Value any
}

// ErrAuthField is a change that can't be made; its message says why.
type ErrAuthField struct{ msg string }

func (e ErrAuthField) Error() string { return e.msg }

func fieldErr(f AuthField, format string, a ...any) error {
	return ErrAuthField{f.Name + ": " + fmt.Sprintf(format, a...)}
}

// ValidateAuthChanges checks changes without applying them.
func ValidateAuthChanges(changes []AuthChange) error {
	seen := map[string]bool{}
	for _, c := range changes {
		f, ok := authField(c.Name)
		if !ok {
			return ErrAuthField{fmt.Sprintf("%s isn't an Auth setting Supermixer manages", c.Name)}
		}
		if seen[c.Name] {
			return fieldErr(f, "given twice")
		}
		seen[c.Name] = true
		if c.Value == nil {
			continue
		}
		if _, err := encodeAuthValue(f, c.Value); err != nil {
			return err
		}
	}
	return nil
}

var (
	hookPgFunction = regexp.MustCompile(`^pg-functions://postgres/[A-Za-z_][A-Za-z0-9_]*/[A-Za-z_][A-Za-z0-9_]*$`)
	hookSecret     = regexp.MustCompile(`^v1,whsec_[A-Za-z0-9+/]{24,}={0,2}(\|v1,whsec_[A-Za-z0-9+/]{24,}={0,2})*$`)
	emailAddress   = regexp.MustCompile(`^[^\s@]+@[^\s@]+$`)
)

// encodeAuthValue turns an API value into what's stored.
func encodeAuthValue(f AuthField, v any) (string, error) {
	str := func() (string, error) {
		s, ok := v.(string)
		if !ok {
			return "", fieldErr(f, "must be text")
		}
		if !utf8.ValidString(s) {
			return "", fieldErr(f, "isn't valid text")
		}
		if f.Kind != AuthTemplate {
			if len(s) > 4096 {
				return "", fieldErr(f, "is too long")
			}
			for _, r := range s {
				if r < 0x20 || r == 0x7f {
					return "", fieldErr(f, "must be one line, without control characters")
				}
			}
		}
		return s, nil
	}
	num := func() (float64, error) {
		n, ok := v.(float64)
		if !ok {
			if i, isInt := v.(int); isInt {
				n, ok = float64(i), true
			}
		}
		if !ok || math.IsNaN(n) || math.IsInf(n, 0) || n < 0 {
			return 0, fieldErr(f, "must be a number, 0 or more")
		}
		if f.Max > 0 && n > f.Max {
			return 0, fieldErr(f, "must be at most %v", f.Max)
		}
		if f.Kind != AuthNumber && n != math.Trunc(n) {
			return 0, fieldErr(f, "must be a whole number")
		}
		return n, nil
	}
	switch f.Kind {
	case AuthBool:
		b, ok := v.(bool)
		if !ok {
			return "", fieldErr(f, "must be true or false")
		}
		return strconv.FormatBool(b), nil
	case AuthInt, AuthNumber:
		n, err := num()
		if err != nil {
			return "", err
		}
		return strconv.FormatFloat(n, 'f', -1, 64), nil
	case AuthSeconds:
		n, err := num()
		if err != nil {
			return "", err
		}
		return strconv.FormatFloat(n, 'f', 0, 64) + "s", nil
	case AuthEnum:
		s, err := str()
		if err != nil {
			return "", err
		}
		for _, e := range f.Enum {
			if s == e {
				return s, nil
			}
		}
		return "", fieldErr(f, "isn't one of the allowed values")
	case AuthEmail:
		s, err := str()
		if err == nil && !emailAddress.MatchString(s) {
			err = fieldErr(f, "isn't an email address")
		}
		return s, err
	case AuthURL:
		s, err := str()
		if err != nil {
			return "", err
		}
		if s == "" {
			return s, nil
		}
		if u, perr := url.Parse(s); perr != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return "", fieldErr(f, "must be an http or https URL")
		}
		return s, nil
	case AuthURLList:
		s, err := str()
		if err != nil {
			return "", err
		}
		var out []string
		for _, part := range strings.Split(s, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			if strings.ContainsAny(part, " \t") || !strings.Contains(part, "://") && !strings.HasPrefix(part, "*") {
				return "", fieldErr(f, "%q isn't a URL (a scheme like https:// is needed; * wildcards are allowed)", part)
			}
			out = append(out, part)
		}
		return strings.Join(out, ","), nil
	case AuthHookURI:
		s, err := str()
		if err != nil {
			return "", err
		}
		if s == "" || hookPgFunction.MatchString(s) {
			return s, nil
		}
		u, perr := url.Parse(s)
		if perr != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return "", fieldErr(f, "must be pg-functions://postgres/<schema>/<function> or an http(s) URL")
		}
		// Auth only accepts plain http for these hosts.
		if u.Scheme == "http" && !slices.Contains([]string{"localhost", "127.0.0.1", "::1", "host.docker.internal"}, u.Hostname()) {
			return "", fieldErr(f, "use https; Auth only allows http for localhost and host.docker.internal")
		}
		return s, nil
	case AuthHookSecret:
		s, err := str()
		if err == nil && s != "" && !hookSecret.MatchString(s) {
			err = fieldErr(f, "must look like v1,whsec_<base64> (several separated by |)")
		}
		return s, err
	case AuthTemplate:
		s, err := str()
		if err == nil && len(s) > 100<<10 {
			err = fieldErr(f, "is over 100 KB")
		}
		if err == nil && strings.ContainsRune(s, 0) {
			err = fieldErr(f, "contains a NUL character")
		}
		return s, err
	default: // AuthString, AuthSecret
		return str()
	}
}

// ApplyAuthChanges writes changes to the stack's .env, auth.env and template
// files. Values are checked first, alone and together with the stack's other
// settings; nothing is written if any is invalid. auth.env and .env are
// written before template files, each by an atomic rename. It returns the
// names that changed.
func ApplyAuthChanges(stackDir string, changes []AuthChange) ([]string, error) {
	if err := ValidateAuthChanges(changes); err != nil {
		return nil, err
	}
	current, err := ReadAuthConfig(stackDir)
	if err != nil {
		return nil, err
	}
	if err := checkAuthTogether(current, changes); err != nil {
		return nil, err
	}
	example := ExampleEnv()
	auth, err := readEnvFile(filepath.Join(stackDir, authEnvFile))
	if err != nil {
		return nil, err
	}
	dot := map[string]string{}
	templates := map[string]string{} // field name → new content ("" removes it)
	var changed []string
	for _, c := range changes {
		f, _ := authField(c.Name)
		var val string
		if c.Value != nil {
			val, _ = encodeAuthValue(f, c.Value)
		}
		switch {
		case f.Kind == AuthTemplate:
			templates[f.Name] = val
		case f.InDotEnv:
			if c.Value == nil && !f.ResetEmpty {
				val = example[f.Env] // Supabase's default
			}
			// Quoted as Compose reads .env: $ and " #" would change the value otherwise.
			dot[f.Env] = quoteEnv(val)
		case c.Value == nil:
			delete(auth, f.Env)
		default:
			auth[f.Env] = val
		}
		changed = append(changed, f.Name)
	}
	// Auth fetches each custom template from the sidecar.
	for _, f := range authFields {
		if f.Kind != AuthTemplate {
			continue
		}
		content, pending := templates[f.Name]
		if !pending {
			b, _ := os.ReadFile(templatePath(stackDir, f))
			content = string(b)
		}
		if content != "" {
			auth[f.Env] = "http://" + authTemplatesService + ":8080/" + filepath.Base(templatePath(stackDir, f))
		} else {
			delete(auth, f.Env)
		}
	}
	// Callback URLs come from the overlay now (they follow API_EXTERNAL_URL);
	// earlier versions copied them here.
	for _, p := range OAuthProviders {
		delete(auth, "GOTRUE_EXTERNAL_"+strings.ToUpper(p)+"_REDIRECT_URI")
	}
	if err := writeEnvFile(filepath.Join(stackDir, authEnvFile), auth,
		"# Auth settings, written by Supermixer. Change them in Supermixer: Authentication."); err != nil {
		return nil, err
	}
	if len(dot) > 0 {
		if err := UpdateEnv(stackDir, dot); err != nil {
			return nil, err
		}
	}
	for name, content := range templates {
		f, _ := authField(name)
		if err := writeTemplate(stackDir, f, content); err != nil {
			return nil, err
		}
	}
	sort.Strings(changed)
	return changed, nil
}

// checkAuthTogether rejects combinations Auth refuses at startup (it would
// stay down after the restart): an enabled hook without a target, an HTTP
// hook without a secret, CAPTCHA without a provider or secret.
func checkAuthTogether(current AuthConfig, changes []AuthChange) error {
	given := map[string]AuthChange{}
	for _, c := range changes {
		given[c.Name] = c
	}
	value := func(name string) any {
		if c, ok := given[name]; ok {
			return c.Value
		}
		return current.Values[name]
	}
	secretSet := func(name string) bool {
		if c, ok := given[name]; ok {
			s, _ := c.Value.(string)
			return s != ""
		}
		return slices.Contains(current.SecretsSet, name)
	}
	for _, h := range AuthHooks {
		if value("hook_"+h+"_enabled") != true {
			continue
		}
		uri, _ := value("hook_" + h + "_uri").(string)
		if uri == "" {
			return ErrAuthField{"hook_" + h + "_uri: an enabled hook needs a target"}
		}
		if strings.HasPrefix(uri, "http") && !secretSet("hook_"+h+"_secrets") {
			return ErrAuthField{"hook_" + h + "_secrets: an HTTP hook needs a secret, to sign its requests"}
		}
	}
	if value("security_captcha_enabled") == true {
		if p, _ := value("security_captcha_provider").(string); p == "" {
			return ErrAuthField{"security_captcha_provider: choose a CAPTCHA provider"}
		}
		if !secretSet("security_captcha_secret") {
			return ErrAuthField{"security_captcha_secret: CAPTCHA needs the provider's secret key"}
		}
	}
	return nil
}

// OAuthCallbackURL is the redirect URL to register with OAuth providers.
func OAuthCallbackURL(stackDir string) string {
	env, _ := ReadEnv(stackDir)
	return strings.TrimRight(env["API_EXTERNAL_URL"], "/") + "/callback"
}

func templatePath(stackDir string, f AuthField) string {
	t := strings.TrimSuffix(strings.TrimPrefix(f.Name, "mailer_templates_"), "_content")
	return filepath.Join(stackDir, filepath.FromSlash(authTemplatesDir), t+".html")
}

func writeTemplate(stackDir string, f AuthField, content string) error {
	path := templatePath(stackDir, f)
	if content == "" {
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	// Readable by the sidecar's user; templates aren't secret.
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// readEnvFile reads a KEY="value" file Supermixer writes (functions.env, auth.env).
func readEnvFile(path string) (map[string]string, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	return parseQuotedEnv(string(b)), nil
}

// writeEnvFile replaces such a file (mode 0600: it may hold secrets).
func writeEnvFile(path string, values map[string]string, header string) error {
	names := make([]string, 0, len(values))
	for k := range values {
		names = append(names, k)
	}
	sort.Strings(names)
	var b strings.Builder
	b.WriteString(header + "\n")
	for _, k := range names {
		b.WriteString(k + "=" + quoteEnv(values[k]) + "\n")
	}
	tmp := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+".tmp")
	if err := os.WriteFile(tmp, []byte(b.String()), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
