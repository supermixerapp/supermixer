package provision

import (
	"encoding/json"
	"os/exec"
	"testing"
	"time"
)

// What Compose gives the storage service: the template's values, then the
// .env's once changed (needs the docker CLI).
func TestStorageSettingsAsComposeResolvesThem(t *testing.T) {
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("no docker CLI")
	}
	dir := writtenStack(t)
	storageEnv := func() map[string]*string {
		cmd := exec.Command("docker", "compose", "config", "--format", "json")
		cmd.Dir = dir
		out, err := cmd.Output()
		if err != nil {
			t.Skipf("docker compose config: %v", err)
		}
		var cfg struct {
			Services map[string]struct {
				Environment map[string]*string `json:"environment"`
			} `json:"services"`
		}
		if err := json.Unmarshal(out, &cfg); err != nil {
			t.Fatal(err)
		}
		return cfg.Services["storage"].Environment
	}
	e := storageEnv()
	if deref(e["FILE_SIZE_LIMIT"]) != "52428800" || deref(e["ENABLE_IMAGE_TRANSFORMATION"]) != "true" {
		t.Fatalf("defaults: %s, %s", deref(e["FILE_SIZE_LIMIT"]), deref(e["ENABLE_IMAGE_TRANSFORMATION"]))
	}
	limit, off := int64(1<<30), false
	changed, err := ApplyStorageChange(dir, StorageChange{FileSizeLimit: &limit, ImageTransformation: &off})
	if err != nil || len(changed) != 2 {
		t.Fatalf("changed %v, %v", changed, err)
	}
	e = storageEnv()
	if deref(e["FILE_SIZE_LIMIT"]) != "1073741824" || deref(e["ENABLE_IMAGE_TRANSFORMATION"]) != "false" {
		t.Fatalf("after: %s, %s", deref(e["FILE_SIZE_LIMIT"]), deref(e["ENABLE_IMAGE_TRANSFORMATION"]))
	}
	c, _ := ReadStorageConfig(dir)
	if c.FileSizeLimit != limit || c.ImageTransformation || c.S3AccessKeyID == "" || c.Region == "" {
		t.Fatalf("read back %+v", c)
	}
	// Nothing to change: nothing written.
	if changed, err := ApplyStorageChange(dir, StorageChange{FileSizeLimit: &limit}); err != nil || changed != nil {
		t.Fatalf("no-op: %v, %v", changed, err)
	}
	tooBig := MaxFileSizeLimit + 1
	if _, err := ApplyStorageChange(dir, StorageChange{FileSizeLimit: &tooBig}); err == nil {
		t.Fatal("accepted more than 500 GB")
	}
}

func TestRotateS3Keys(t *testing.T) {
	env := map[string]string{"S3_PROTOCOL_ACCESS_KEY_ID": "old", "S3_PROTOCOL_ACCESS_KEY_SECRET": "old"}
	out, err := Rotate(env, []Rotation{RotateS3Keys}, time.Now())
	if err != nil || len(out) != 2 || len(out["S3_PROTOCOL_ACCESS_KEY_ID"]) != 32 || len(out["S3_PROTOCOL_ACCESS_KEY_SECRET"]) != 64 {
		t.Fatalf("rotated %v, %v", out, err)
	}
}
