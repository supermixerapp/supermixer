// Package naming generates organization slugs and project refs.
package naming

import (
	"crypto/rand"
	"math/big"
	"regexp"
	"strings"
)

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

// Slugify turns an organization name into a URL slug ("Acme Inc." → "acme-inc").
func Slugify(name string) string {
	s := nonSlug.ReplaceAllString(strings.ToLower(name), "-")
	s = strings.Trim(s, "-")
	if len(s) > 40 {
		s = strings.TrimRight(s[:40], "-")
	}
	if len(s) < 2 {
		s = "org"
	}
	return s
}

// ProjectRef returns a random 20-letter lowercase ref, like Supabase's.
func ProjectRef() (string, error) {
	const letters = "abcdefghijklmnopqrstuvwxyz"
	b := make([]byte, 20)
	for i := range b {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(letters))))
		if err != nil {
			return "", err
		}
		b[i] = letters[n.Int64()]
	}
	return string(b), nil
}
