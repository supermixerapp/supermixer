package provision

import (
	"slices"
	"testing"
	"time"
)

func TestExampleSecrets(t *testing.T) {
	ex := ExampleEnv()
	got := ExampleSecrets(ex["JWT_SECRET"], ex["ANON_KEY"], ex["SERVICE_ROLE_KEY"], ex["POSTGRES_PASSWORD"])
	if want := []string{"JWT secret", "anon key", "service_role key", "database password"}; !slices.Equal(got, want) {
		t.Fatalf("the template's examples: %v", got)
	}
	// Keys signed with the CLI's secret are caught too.
	cli, err := signHS256(cliJWTSecret, apiKeyClaims{Role: "anon", Iss: "supabase-demo", Exp: time.Now().Add(time.Hour).Unix()})
	if err != nil {
		t.Fatal(err)
	}
	if got := ExampleSecrets("", cli, "", ""); !slices.Equal(got, []string{"anon key"}) {
		t.Errorf("CLI-signed key: %v", got)
	}
	// A stack Supermixer generates has none.
	s, err := GenerateSecrets(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	keys, err := GenerateAPIKeys(s.JWTSecret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	env := keys.Env()
	if got := ExampleSecrets(s.JWTSecret, env["ANON_KEY"], env["SERVICE_ROLE_KEY"], s.Env()["POSTGRES_PASSWORD"]); len(got) != 0 {
		t.Errorf("generated secrets flagged: %v", got)
	}
	if got := ExampleSecrets("", "not-a-jwt", "a.b.!!", ""); len(got) != 0 {
		t.Errorf("garbage flagged: %v", got)
	}
}
