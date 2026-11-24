package provision

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestUpgrade(t *testing.T) {
	l := Layout{Dir: filepath.Join(t.TempDir(), "s"), Project: "supermixer-s"}
	if err := WriteStack(l, map[string]string{"POSTGRES_PASSWORD": "pw"}); err != nil {
		t.Fatal(err)
	}
	read := func(rel string) string {
		b, _ := os.ReadFile(filepath.Join(l.Dir, rel))
		return string(b)
	}
	write := func(rel, s string) {
		p := filepath.Join(l.Dir, rel)
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	fresh := read("docker-compose.yml")

	// Up to date: nothing to change.
	plan, err := PlanUpgrade(l)
	if err != nil || len(plan.Images) != 0 || len(plan.NewKeys) != 0 || plan.Blocked != "" {
		t.Fatalf("plan for a fresh stack = %+v, %v", plan, err)
	}

	// Pretend the stack is from an older template: an older image, a key the
	// new template added, a function of the user's, a value Supermixer quoted.
	gotrue := imageOr(t, fresh, "auth")
	write("docker-compose.yml", strings.Replace(fresh, gotrue, "supabase/gotrue:v2.100.0", 1))
	env := read(".env")
	env = replaceRe(t, env, "(?m)^PG_META_CRYPTO_KEY=.*\n", "")
	env += "SMTP_ADMIN_EMAIL=\"admin@example.com\"\n"
	write(".env", env)
	write("volumes/functions/hello/index.ts", "// the user's version")
	write("volumes/functions/mine/index.ts", "// the user's own")
	write("volumes/functions/main/index.ts", "// stale router")

	plan, err = PlanUpgrade(l)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Images) != 1 || plan.Images[0] != (ImageChange{"auth", "supabase/gotrue:v2.100.0", gotrue}) {
		t.Errorf("images = %+v", plan.Images)
	}
	if strings.Join(plan.NewKeys, ",") != "PG_META_CRYPTO_KEY" || plan.Blocked != "" {
		t.Errorf("plan = %+v", plan)
	}

	added, err := ApplyUpgrade(l, map[string]string{"PG_META_CRYPTO_KEY": "generated"})
	if err != nil || strings.Join(added, ",") != "PG_META_CRYPTO_KEY" {
		t.Fatalf("ApplyUpgrade = %v, %v", added, err)
	}
	if read("docker-compose.yml") != fresh {
		t.Error("the compose file wasn't brought up to date")
	}
	e, _ := ReadEnv(l.Dir)
	if e["PG_META_CRYPTO_KEY"] != "generated" || e["POSTGRES_PASSWORD"] != "pw" || !strings.Contains(read(".env"), `SMTP_ADMIN_EMAIL="admin@example.com"`) {
		t.Errorf(".env after upgrade:\n%s", read(".env"))
	}
	if read("volumes/functions/hello/index.ts") != "// the user's version" || read("volumes/functions/mine/index.ts") != "// the user's own" {
		t.Error("the user's functions were changed")
	}
	if strings.Contains(read("volumes/functions/main/index.ts"), "stale") {
		t.Error("the functions router wasn't updated")
	}
	if p, _ := PlanUpgrade(l); len(p.Images) != 0 || len(p.NewKeys) != 0 {
		t.Errorf("plan after upgrading = %+v", p)
	}

	// Going back restores the files from before.
	if err := RollBackUpgrade(l.Dir); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(read("docker-compose.yml"), "supabase/gotrue:v2.100.0") || strings.Contains(read(".env"), "PG_META_CRYPTO_KEY=generated") {
		t.Error("rolling back didn't restore the previous files")
	}
	if read("volumes/functions/main/index.ts") != "// stale router" {
		t.Error("rolling back didn't restore the functions router")
	}
	if err := FinishUpgrade(l.Dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(l.Dir, snapshotDir)); !os.IsNotExist(err) {
		t.Errorf("snapshot left: %v", err)
	}

	// A new major version of Postgres is refused.
	db := imageOr(t, fresh, "db")
	write("docker-compose.yml", strings.Replace(fresh, db, "supabase/postgres:15.8.1.085", 1))
	if p, _ := PlanUpgrade(l); !strings.Contains(p.Blocked, "from supabase/postgres:15.8.1.085") {
		t.Errorf("blocked = %q", p.Blocked)
	}
}

func imageOr(t *testing.T, compose, service string) string {
	t.Helper()
	img := composeImages([]byte(compose))[service]
	if img == "" {
		t.Fatalf("no %s image", service)
	}
	return img
}

func replaceRe(t *testing.T, s, re, with string) string {
	t.Helper()
	out := regexp.MustCompile(re).ReplaceAllString(s, with)
	if out == s {
		t.Fatalf("%s matched nothing", re)
	}
	return out
}

func TestComposeImages(t *testing.T) {
	b, _ := templateFS.ReadFile("template/docker-compose.yml")
	imgs := composeImages(b)
	for _, svc := range []string{"studio", "api-gw", "auth", "rest", "realtime", "storage", "imgproxy", "meta", "functions", "db", "supavisor"} {
		if imgs[svc] == "" {
			t.Errorf("no image for %s (got %v)", svc, imgs)
		}
	}
	if postgresMajor(imgs["db"]) != "17" {
		t.Errorf("postgres major of %s = %q", imgs["db"], postgresMajor(imgs["db"]))
	}
}
