package provision

import (
	"fmt"
	"strconv"
)

// Storage settings of stacks Supermixer created (Storage › Settings). The
// template sets them in the compose file; the overlay takes them from .env
// instead (STORAGE_FILE_SIZE_LIMIT, STORAGE_IMAGE_TRANSFORMATION), with the
// template's values as defaults. Changing them recreates the storage service.

const (
	// DefaultFileSizeLimit is the template's upload limit: 50 MiB.
	DefaultFileSizeLimit int64 = 50 << 20
	// MaxFileSizeLimit is the largest upload limit Supermixer sets: 500 GiB,
	// Supabase's own ceiling.
	MaxFileSizeLimit int64 = 500 << 30
	// MinFileSizeLimit is the smallest: 1 KiB.
	MinFileSizeLimit int64 = 1 << 10

	envFileSizeLimit       = "STORAGE_FILE_SIZE_LIMIT"
	envImageTransformation = "STORAGE_IMAGE_TRANSFORMATION"
)

// StorageConfig is a created stack's Storage settings and S3 access.
type StorageConfig struct {
	FileSizeLimit       int64
	ImageTransformation bool
	// Problems are .env values Supermixer can't read (edited by hand): Storage
	// is given them as they are, and the setting shows its default. Saving
	// that setting replaces the value.
	Problems []StorageProblem
	// S3 access (the S3 protocol): the region and key pair from .env.
	Region, S3AccessKeyID, S3AccessKeySecret string

	badLimit, badTransform bool
}

// StorageProblem is a setting whose .env value can't be read.
type StorageProblem struct {
	Setting, Message string // Setting: the API's name (file_size_limit, image_transformation)
}

// ReadStorageConfig reads a stack's Storage settings.
func ReadStorageConfig(stackDir string) (StorageConfig, error) {
	env, err := ReadEnv(stackDir)
	if err != nil {
		return StorageConfig{}, err
	}
	c := StorageConfig{FileSizeLimit: DefaultFileSizeLimit, ImageTransformation: true, Region: env["REGION"],
		S3AccessKeyID: env["S3_PROTOCOL_ACCESS_KEY_ID"], S3AccessKeySecret: env["S3_PROTOCOL_ACCESS_KEY_SECRET"]}
	if v := env[envFileSizeLimit]; v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			c.FileSizeLimit = n
		} else {
			c.badLimit = true
			c.Problems = append(c.Problems, StorageProblem{"file_size_limit",
				fmt.Sprintf("%s in the stack's .env is %q, not a number of bytes", envFileSizeLimit, v)})
		}
	}
	switch v := env[envImageTransformation]; v {
	case "":
	case "true", "false":
		c.ImageTransformation = v == "true"
	default:
		c.badTransform = true
		c.Problems = append(c.Problems, StorageProblem{"image_transformation",
			fmt.Sprintf("%s in the stack's .env is %q, not true or false", envImageTransformation, v)})
	}
	return c, nil
}

// StorageChange is a change to Storage's settings; nil leaves one as it is.
type StorageChange struct {
	FileSizeLimit       *int64
	ImageTransformation *bool
}

// ValidateStorageChange checks a change without applying it.
func ValidateStorageChange(c StorageChange) error {
	if c.FileSizeLimit == nil && c.ImageTransformation == nil {
		return fmt.Errorf("no settings given")
	}
	if n := c.FileSizeLimit; n != nil && (*n < MinFileSizeLimit || *n > MaxFileSizeLimit) {
		return fmt.Errorf("the upload limit must be between 1 KB and 500 GB")
	}
	return nil
}

// StorageDiff is what a change would write to .env: the settings that
// differ from the current ones (or replace a value that can't be read).
func StorageDiff(current StorageConfig, c StorageChange) map[string]string {
	set := map[string]string{}
	if c.FileSizeLimit != nil && (*c.FileSizeLimit != current.FileSizeLimit || current.badLimit) {
		set[envFileSizeLimit] = strconv.FormatInt(*c.FileSizeLimit, 10)
	}
	if c.ImageTransformation != nil && (*c.ImageTransformation != current.ImageTransformation || current.badTransform) {
		set[envImageTransformation] = strconv.FormatBool(*c.ImageTransformation)
	}
	return set
}

// StorageSettingNames are the API's names for the .env keys in a diff.
func StorageSettingNames(set map[string]string) []string {
	var names []string
	if _, ok := set[envFileSizeLimit]; ok {
		names = append(names, "file_size_limit")
	}
	if _, ok := set[envImageTransformation]; ok {
		names = append(names, "image_transformation")
	}
	return names
}

// ApplyStorageChange writes a change to the stack's .env (one atomic
// rename), returning the settings that changed; none if it fails.
func ApplyStorageChange(stackDir string, c StorageChange) ([]string, error) {
	if err := ValidateStorageChange(c); err != nil {
		return nil, err
	}
	current, err := ReadStorageConfig(stackDir)
	if err != nil {
		return nil, err
	}
	set := StorageDiff(current, c)
	if len(set) == 0 {
		return nil, nil
	}
	if err := UpdateEnv(stackDir, set); err != nil {
		return nil, err
	}
	return StorageSettingNames(set), nil
}
