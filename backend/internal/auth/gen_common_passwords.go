//go:build ignore

// Rebuilds common-passwords.txt.gz, the list new passwords are checked
// against: the UK National Cyber Security Centre's 100,000 most used
// passwords (from Have I Been Pwned), as published in SecLists (MIT
// licence, see NOTICE). Run from backend/:
//
//	go run internal/auth/gen_common_passwords.go
//
// It downloads the file at a pinned commit and checks its hash; to update,
// change both. Entries are normalized as passwords are (NFKC, lowercase),
// and those under 5 characters are left out: shorter passwords are refused
// anyway, and the list is also compared with a password's core (without
// trailing digits and symbols), where 5 is enough for words like "dragon".
package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"slices"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

const (
	commit = "1a7bb9127eca9e6ff2fc0301c597fe6e16a0cb56"
	file   = "Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt"
	sum    = "c2e5696882c603b76bb67a47ee970897e5a76fc4c3f5547abe3d0ca340c576e0"
	out    = "internal/auth/common-passwords.txt.gz"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	resp, err := http.Get("https://raw.githubusercontent.com/danielmiessler/SecLists/" + commit + "/" + file)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download: %s", resp.Status)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	if err != nil {
		return err
	}
	if h := sha256.Sum256(raw); hex.EncodeToString(h[:]) != sum {
		return fmt.Errorf("the download's SHA-256 is %x, not %s", h, sum)
	}
	seen := map[string]bool{}
	var list []string
	sc := bufio.NewScanner(bytes.NewReader(raw))
	for sc.Scan() {
		p := strings.ToLower(norm.NFKC.String(strings.TrimRight(sc.Text(), "\r")))
		if utf8.RuneCountInString(p) < 5 || strings.ContainsAny(p, "\n") || seen[p] {
			continue
		}
		seen[p] = true
		list = append(list, p)
	}
	slices.Sort(list) // byte order, for binary search
	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression) // no name or time: reproducible
	for _, p := range list {
		fmt.Fprintln(zw, p)
	}
	if err := zw.Close(); err != nil {
		return err
	}
	if err := os.WriteFile(out, buf.Bytes(), 0o644); err != nil {
		return err
	}
	fmt.Printf("%s: %d passwords, %d bytes\n", out, len(list), buf.Len())
	return nil
}
