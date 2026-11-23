// Package secrets seals stored Supabase credentials with AES-256-GCM.
package secrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
)

// Box encrypts and decrypts with a single 32-byte key.
type Box struct{ aead cipher.AEAD }

// New builds a Box from a base64-encoded 32-byte key (SUPERMIXER_ENCRYPTION_KEY).
func New(base64Key string) (*Box, error) {
	key, err := base64.StdEncoding.DecodeString(base64Key)
	if err != nil || len(key) != 32 {
		return nil, errors.New("encryption key must be 32 bytes, base64-encoded")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Box{aead: aead}, nil
}

// Seal encrypts plaintext. additionalData (e.g. the project ref) must match on Open.
func (b *Box) Seal(plaintext, additionalData []byte) ([]byte, error) {
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return b.aead.Seal(nonce, nonce, plaintext, additionalData), nil
}

// Open decrypts what Seal produced.
func (b *Box) Open(sealed, additionalData []byte) ([]byte, error) {
	n := b.aead.NonceSize()
	if len(sealed) < n {
		return nil, errors.New("sealed data too short")
	}
	out, err := b.aead.Open(nil, sealed[:n], sealed[n:], additionalData)
	if err != nil {
		return nil, fmt.Errorf("decrypting credentials (was SUPERMIXER_ENCRYPTION_KEY changed?): %w", err)
	}
	return out, nil
}

// SealJSON marshals v and seals it.
func (b *Box) SealJSON(v any, additionalData []byte) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return b.Seal(raw, additionalData)
}

// OpenJSON opens sealed data into v.
func (b *Box) OpenJSON(sealed, additionalData []byte, v any) error {
	raw, err := b.Open(sealed, additionalData)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, v)
}
