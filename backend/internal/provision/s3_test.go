package provision

import (
	"bytes"
	"crypto/rand"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/minio/minio-go/v7"

	"supermixer/internal/config"
)

// TestS3 runs against a real S3-compatible service when one is given:
//
//	SUPERMIXER_TEST_S3_ENDPOINT=http://localhost:9000 SUPERMIXER_TEST_S3_BUCKET=test \
//	SUPERMIXER_TEST_S3_ACCESS_KEY=... SUPERMIXER_TEST_S3_SECRET_KEY=... go test ./internal/provision -run TestS3
//
// SUPERMIXER_TEST_S3_CREATE=1 creates the bucket first.
func TestS3(t *testing.T) {
	endpoint := os.Getenv("SUPERMIXER_TEST_S3_ENDPOINT")
	if endpoint == "" {
		t.Skip("SUPERMIXER_TEST_S3_ENDPOINT isn't set")
	}
	cfg := config.BackupS3{
		Endpoint: endpoint, Bucket: os.Getenv("SUPERMIXER_TEST_S3_BUCKET"), Region: os.Getenv("SUPERMIXER_TEST_S3_REGION"),
		AccessKeyID: os.Getenv("SUPERMIXER_TEST_S3_ACCESS_KEY"), SecretAccessKey: os.Getenv("SUPERMIXER_TEST_S3_SECRET_KEY"),
		PathStyle: true,
	}
	s, err := NewS3(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	if os.Getenv("SUPERMIXER_TEST_S3_CREATE") != "" { // a throwaway server: make the bucket
		if ok, _ := s.client.BucketExists(ctx, cfg.Bucket); !ok {
			if err := s.client.MakeBucket(ctx, cfg.Bucket, minio.MakeBucketOptions{Region: cfg.Region}); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := s.Check(ctx); err != nil {
		t.Fatal(err)
	}

	// A backup bigger than one part (multipart upload), and back.
	src := t.TempDir()
	big := make([]byte, 40<<20)
	_, _ = rand.Read(big)
	for _, name := range backupObjects() {
		b := []byte("small " + name)
		if name == "data.sql.gz" {
			b = big
		}
		if err := os.WriteFile(filepath.Join(src, name), b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	key := RemoteBackupKey("supermixer-test", "ref", t.Name())
	if err := UploadBackup(ctx, s, src, key); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.RemoveAll(t.Context(), key) })
	dst := filepath.Join(t.TempDir(), "copy")
	if err := FetchBackup(ctx, s, key, dst); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dst, "data.sql.gz")); !bytes.Equal(b, big) {
		t.Fatalf("data.sql.gz came back with %d bytes, want %d", len(b), len(big))
	}

	// A missing object says so before any reading.
	if _, err := s.Get(ctx, key+"/nothing"); err == nil || !strings.Contains(err.Error(), "isn't in bucket") {
		t.Fatalf("missing object: %v", err)
	}
	// RemoveAll takes everything under the key, and nothing beside it.
	other := RemoteBackupKey("supermixer-test", "ref", t.Name()+"-other")
	if err := s.Put(ctx, other+"/manifest.json", filepath.Join(src, "manifest.json")); err != nil {
		t.Fatal(err)
	}
	if err := s.RemoveAll(ctx, key); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(ctx, key+"/manifest.json"); err == nil {
		t.Error("an object remains under the removed key")
	}
	r, err := s.Get(ctx, other+"/manifest.json")
	if err != nil {
		t.Fatalf("the neighbouring object went too: %v", err)
	}
	_, _ = io.Copy(io.Discard, r)
	r.Close()
	_ = s.RemoveAll(ctx, other)

	// A bucket that isn't there, and wrong credentials, fail the check.
	missing := cfg
	missing.Bucket = "supermixer-no-such-bucket"
	if s2, _ := NewS3(missing); s2.Check(ctx) == nil {
		t.Error("a missing bucket passed the check")
	}
	wrong := cfg
	wrong.SecretAccessKey = "wrong"
	if s3, _ := NewS3(wrong); s3.Check(ctx) == nil {
		t.Error("wrong credentials passed the check")
	}
}
