package provision

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"slices"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"supermixer/internal/config"
)

// Backups can be copied to an S3-compatible bucket (provisioning.backup_s3):
// each backup's files under <prefix>/<ref>/<id>/, the manifest last, so a
// manifest in the bucket means the backup there is whole.

// ObjectStore is a bucket backups are copied to.
type ObjectStore interface {
	// Bucket is the bucket's name.
	Bucket() string
	// Put uploads a local file to key.
	Put(ctx context.Context, key, file string) error
	// Get reads the object at key.
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	// RemoveAll deletes every object under prefix/.
	RemoveAll(ctx context.Context, prefix string) error
	// Check makes sure the bucket is there and reachable.
	Check(ctx context.Context) error
}

// RemoteBackupKey is where one backup's files go in the bucket.
func RemoteBackupKey(prefix, ref, id string) string { return path.Join(prefix, ref, id) }

// backupObjects are a backup's files, in the order they're uploaded.
func backupObjects() []string {
	var out []string
	for _, f := range BackupFiles {
		out = append(out, f+".gz")
	}
	return append(out, "manifest.json")
}

// UploadBackup copies a backup's files from dir to key in the bucket.
func UploadBackup(ctx context.Context, s ObjectStore, dir, key string) error {
	for _, name := range backupObjects() {
		if err := s.Put(ctx, key+"/"+name, filepath.Join(dir, name)); err != nil {
			return fmt.Errorf("uploading %s: %w", name, err)
		}
	}
	return nil
}

// FetchBackup downloads a backup from key in the bucket into dir, which
// must not exist; it's only there once every file is.
func FetchBackup(ctx context.Context, s ObjectStore, key, dir string) error {
	tmp := dir + ".tmp"
	_ = os.RemoveAll(tmp)
	if err := os.MkdirAll(tmp, 0o700); err != nil {
		return err
	}
	for _, name := range backupObjects() {
		if err := fetchObject(ctx, s, key+"/"+name, filepath.Join(tmp, name)); err != nil {
			_ = os.RemoveAll(tmp)
			return fmt.Errorf("downloading %s: %w", name, err)
		}
	}
	return os.Rename(tmp, dir)
}

func fetchObject(ctx context.Context, s ObjectStore, key, file string) error {
	r, err := s.Get(ctx, key)
	if err != nil {
		return err
	}
	defer r.Close()
	f, err := os.OpenFile(file, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, r); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// OpenRemoteBackupFile streams one of a backup's dumps from the bucket, uncompressed.
func OpenRemoteBackupFile(ctx context.Context, s ObjectStore, key, file string) (io.ReadCloser, error) {
	if !slices.Contains(BackupFiles, file) {
		return nil, fmt.Errorf("a backup has %v", BackupFiles)
	}
	r, err := s.Get(ctx, key+"/"+file+".gz")
	if err != nil {
		return nil, err
	}
	return gunzip(r)
}

// S3 is an ObjectStore on an S3-compatible service.
type S3 struct {
	client *minio.Client
	bucket string
}

// NewS3 connects to the bucket in cfg (which config has validated).
func NewS3(cfg config.BackupS3) (*S3, error) {
	u, err := url.Parse(cfg.Endpoint)
	if err != nil {
		return nil, err
	}
	creds := credentials.NewStaticV4(cfg.AccessKeyID, cfg.SecretAccessKey, "")
	if cfg.AccessKeyID == "" {
		creds = credentials.NewChainCredentials([]credentials.Provider{
			&credentials.EnvAWS{}, &credentials.FileAWSCredentials{}, &credentials.IAM{},
		})
	}
	lookup := minio.BucketLookupDNS
	if cfg.PathStyle {
		lookup = minio.BucketLookupPath
	}
	c, err := minio.New(u.Host, &minio.Options{
		Creds: creds, Secure: u.Scheme == "https", Region: cfg.Region, BucketLookup: lookup,
	})
	if err != nil {
		return nil, fmt.Errorf("provisioning.backup_s3: %w", err)
	}
	c.SetAppInfo("supermixer", "")
	return &S3{client: c, bucket: cfg.Bucket}, nil
}

func (s *S3) Bucket() string { return s.bucket }

func (s *S3) Put(ctx context.Context, key, file string) error {
	ct := "application/gzip"
	if path.Ext(key) == ".json" {
		ct = "application/json"
	}
	_, err := s.client.FPutObject(ctx, s.bucket, key, file, minio.PutObjectOptions{ContentType: ct})
	return err
}

func (s *S3) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	obj, err := s.client.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	// GetObject is lazy; Stat finds a missing object now rather than mid-read.
	if _, err := obj.Stat(); err != nil {
		obj.Close()
		if minio.ToErrorResponse(err).Code == minio.NoSuchKey {
			return nil, fmt.Errorf("%s isn't in bucket %s", key, s.bucket)
		}
		return nil, err
	}
	return obj, nil
}

func (s *S3) RemoveAll(ctx context.Context, prefix string) error {
	objects := make(chan minio.ObjectInfo)
	var listErr error
	go func() {
		defer close(objects)
		for o := range s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Prefix: prefix + "/", Recursive: true}) {
			if o.Err != nil {
				listErr = o.Err
				return
			}
			objects <- o
		}
	}()
	var errs []error
	for e := range s.client.RemoveObjects(ctx, s.bucket, objects, minio.RemoveObjectsOptions{}) {
		errs = append(errs, fmt.Errorf("%s: %w", e.ObjectName, e.Err))
	}
	return errors.Join(append(errs, listErr)...) // listErr is read after the channel closed
}

func (s *S3) Check(ctx context.Context) error {
	ok, err := s.client.BucketExists(ctx, s.bucket)
	if err != nil {
		return fmt.Errorf("can't reach bucket %s: %w", s.bucket, err)
	}
	if !ok {
		return fmt.Errorf("bucket %s doesn't exist", s.bucket)
	}
	return nil
}
