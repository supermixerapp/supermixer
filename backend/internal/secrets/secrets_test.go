package secrets

import (
	"bytes"
	"testing"
)

const key = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="

func TestRoundTripAndBinding(t *testing.T) {
	b, err := New(key)
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := b.SealJSON(map[string]string{"k": "v"}, []byte("projref"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, []byte(`"v"`)) {
		t.Fatal("plaintext visible in sealed output")
	}
	var got map[string]string
	if err := b.OpenJSON(sealed, []byte("projref"), &got); err != nil || got["k"] != "v" {
		t.Fatalf("open: %v %v", got, err)
	}
	if err := b.OpenJSON(sealed, []byte("otherref"), &got); err == nil {
		t.Fatal("expected failure with different additional data")
	}
}

func TestBadKey(t *testing.T) {
	if _, err := New("c2hvcnQ="); err == nil {
		t.Fatal("expected error for short key")
	}
}
