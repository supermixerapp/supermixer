package naming

import (
	"regexp"
	"testing"
)

func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"Acme Inc.":        "acme-inc",
		"  Hello  World ":  "hello-world",
		"ÜBER":             "ber",
		"!!":               "org",
		"Piccadilly Line!": "piccadilly-line",
	}
	for in, want := range cases {
		if got := Slugify(in); got != want {
			t.Errorf("Slugify(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestProjectRef(t *testing.T) {
	ref, err := ProjectRef()
	if err != nil || !regexp.MustCompile(`^[a-z]{20}$`).MatchString(ref) {
		t.Fatalf("ref %q err %v", ref, err)
	}
}
