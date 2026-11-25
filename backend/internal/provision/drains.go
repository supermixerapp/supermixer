package provision

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// Log drains send a stack's logs somewhere else as well, as
// Supabase's Log Drains do. Its logs already flow through Vector (to
// Logflare); each drain adds a Vector sink, in a second config file
// (volumes/logs/drains/drains.yml) the overlay passes to Vector. The drains
// themselves, secrets included, are kept in log-drains.json (0600).

// LogDrain is one destination for a stack's logs.
type LogDrain struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Type    string `json:"type"` // http, loki or datadog
	Enabled bool   `json:"enabled"`
	// URL is the HTTP endpoint or Loki's base URL.
	URL     string   `json:"url,omitempty"`
	Headers []Header `json:"headers,omitempty"`
	Gzip    bool     `json:"gzip,omitempty"`
	// Datadog's site (datadoghq.com, datadoghq.eu, ...) and API key.
	DatadogSite string `json:"datadog_site,omitempty"`
	APIKey      string `json:"api_key,omitempty"`
}

// Header is an HTTP header sent with a drain's requests (its value secret).
type Header struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// DrainTypes are the kinds of drain.
var DrainTypes = []string{"http", "loki", "datadog"}

// DatadogSites are Datadog's regions.
var DatadogSites = []string{"datadoghq.com", "us3.datadoghq.com", "us5.datadoghq.com", "datadoghq.eu", "ap1.datadoghq.com", "ddog-gov.com"}

// drainSources are Vector's per-service log streams (template vector.yml),
// each tagged with its service before it goes to a drain.
var drainSources = map[string]string{
	"kong_logs": "api-gw", "kong_err": "api-gw", "auth_logs": "auth", "rest_logs": "rest",
	"realtime_logs": "realtime", "functions_logs": "functions", "storage_logs": "storage", "db_logs": "db",
}

const (
	drainsFile = "log-drains.json"
	// DrainsConfig is the Vector config the drains render to, and
	// drainsCandidate where a new one is checked first.
	drainsConfigDir = "volumes/logs/drains"
	drainsConfig    = "drains.yml"
	drainsCandidate = "next.yml"
)

var (
	headerName = regexp.MustCompile(`^[A-Za-z0-9!#$%&'*+.^_|~-]{1,100}$`)
	drainID    = regexp.MustCompile(`^[a-z0-9]{8,32}$`)
)

// ValidateDrain checks a drain's settings.
func ValidateDrain(d LogDrain) error {
	if !drainID.MatchString(d.ID) {
		return fmt.Errorf("bad drain id %q", d.ID)
	}
	name := strings.TrimSpace(d.Name)
	if name == "" || len(name) > 100 || strings.ContainsAny(name, "\n\r\x00") {
		return errors.New("give the drain a name of up to 100 characters")
	}
	if !slices.Contains(DrainTypes, d.Type) {
		return fmt.Errorf("a drain's type is one of %s", strings.Join(DrainTypes, ", "))
	}
	switch d.Type {
	case "http", "loki":
		u, err := url.Parse(d.URL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
			return errors.New("the URL must be http(s)://host[:port]/path, without a login in it (send one as a header)")
		}
		if strings.ContainsAny(d.URL, " \n\r\x00\"'{}") {
			return errors.New("the URL has characters that aren't allowed")
		}
	case "datadog":
		if !slices.Contains(DatadogSites, d.DatadogSite) {
			return fmt.Errorf("the Datadog site is one of %s", strings.Join(DatadogSites, ", "))
		}
		if strings.TrimSpace(d.APIKey) == "" {
			return errors.New("a Datadog drain needs an API key")
		}
	}
	if len(d.Headers) > 20 {
		return errors.New("a drain has 20 headers at most")
	}
	seen := map[string]bool{}
	for _, h := range d.Headers {
		if !headerName.MatchString(h.Name) {
			return fmt.Errorf("%q isn't a header name", h.Name)
		}
		if seen[strings.ToLower(h.Name)] {
			return fmt.Errorf("the header %s is there twice", h.Name)
		}
		seen[strings.ToLower(h.Name)] = true
		if strings.ContainsAny(h.Value, "\n\r\x00") || len(h.Value) > 4096 {
			return fmt.Errorf("the %s header's value must be one line, 4096 characters at most", h.Name)
		}
	}
	if strings.ContainsAny(d.APIKey, "\n\r\x00") {
		return errors.New("the API key must be one line")
	}
	return nil
}

// ReadDrains reads a stack's drains.
func ReadDrains(dir string) ([]LogDrain, error) {
	b, err := os.ReadFile(filepath.Join(dir, drainsFile))
	if errors.Is(err, fs.ErrNotExist) {
		return []LogDrain{}, nil
	}
	if err != nil {
		return nil, err
	}
	var out []LogDrain
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, fmt.Errorf("%s: %w", drainsFile, err)
	}
	return out, nil
}

// StageDrains writes the Vector config for drains as the candidate, to
// check with ValidateDrains before CommitDrains makes it the one in use.
func StageDrains(dir, project string, drains []LogDrain) error {
	for _, d := range drains {
		if err := ValidateDrain(d); err != nil {
			return fmt.Errorf("%s: %w", d.Name, err)
		}
	}
	cfg, err := RenderDrains(project, drains)
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(dir, drainsConfigDir, drainsCandidate), []byte(cfg), 0o600)
}

// CommitDrains saves the drains and puts the staged config in place.
func CommitDrains(dir string, drains []LogDrain) error {
	b, err := json.MarshalIndent(drains, "", "  ")
	if err != nil {
		return err
	}
	if err := writeFileAtomic(filepath.Join(dir, drainsFile), b, 0o600); err != nil {
		return err
	}
	d := filepath.Join(dir, drainsConfigDir)
	return os.Rename(filepath.Join(d, drainsCandidate), filepath.Join(d, drainsConfig))
}

// DiscardDrains removes a staged config.
func DiscardDrains(dir string) {
	_ = os.Remove(filepath.Join(dir, drainsConfigDir, drainsCandidate))
}

// ensureDrainsConfig makes sure Vector's drains config exists (empty
// without drains), for stacks created before drains.
func ensureDrainsConfig(dir string) error {
	d := filepath.Join(dir, drainsConfigDir)
	if err := os.MkdirAll(d, 0o755); err != nil {
		return err
	}
	p := filepath.Join(d, drainsConfig)
	if _, err := os.Stat(p); err == nil {
		return nil
	}
	return writeFileAtomic(p, []byte("# Log drains, written by Supermixer: none yet.\n"), 0o600)
}

// ValidateDrains checks the staged config with Vector itself, in a
// throwaway container of the stack's Vector service.
func (c Compose) ValidateDrains(ctx context.Context, log io.Writer) error {
	return c.Run(ctx, log, "run", "--rm", "--no-deps", "-T", "--entrypoint", "vector", "vector",
		"validate", "--no-environment", "/etc/vector/vector.yml", "/etc/vector/drains/"+drainsCandidate)
}

// RenderDrains is the Vector config for a stack's enabled drains: a remap
// per service stream tagging events with it, and a sink per drain.
func RenderDrains(project string, drains []LogDrain) (string, error) {
	var b strings.Builder
	b.WriteString("# Log drains, written by Supermixer from log-drains.json; don't edit.\n")
	var enabled []LogDrain
	for _, d := range drains {
		if d.Enabled {
			enabled = append(enabled, d)
		}
	}
	if len(enabled) == 0 {
		return b.String(), nil
	}
	// JSON strings are YAML strings; "$" is doubled, or Vector would read
	// ${...} as an environment variable.
	q := func(s string) string { j, _ := json.Marshal(strings.ReplaceAll(s, "$", "$$")); return string(j) }
	b.WriteString("transforms:\n")
	for _, src := range slices.Sorted(maps.Keys(drainSources)) {
		fmt.Fprintf(&b, "  supermixer_drain_%s:\n    type: remap\n    inputs: [%s]\n    source: |\n", src, src)
		fmt.Fprintf(&b, "      .supabase_service = %s\n      .supabase_project = %s\n", q(drainSources[src]), q(project))
	}
	b.WriteString("sinks:\n")
	for _, d := range enabled {
		fmt.Fprintf(&b, "  supermixer_drain_sink_%s:\n    inputs: [\"supermixer_drain_*\"]\n", d.ID)
		headers := func(indent string) {
			if len(d.Headers) == 0 {
				return
			}
			fmt.Fprintf(&b, "%srequest:\n%s  headers:\n", indent, indent)
			for _, h := range d.Headers {
				fmt.Fprintf(&b, "%s    %s: %s\n", indent, q(h.Name), q(h.Value))
			}
		}
		switch d.Type {
		case "http":
			fmt.Fprintf(&b, "    type: http\n    uri: %s\n    method: post\n    encoding:\n      codec: json\n", q(d.URL))
			if d.Gzip {
				b.WriteString("    compression: gzip\n")
			}
			headers("    ")
		case "loki":
			fmt.Fprintf(&b, "    type: loki\n    endpoint: %s\n    encoding:\n      codec: json\n", q(d.URL))
			fmt.Fprintf(&b, "    labels:\n      project: %s\n      service: \"{{ supabase_service }}\"\n", q(project))
			b.WriteString("    out_of_order_action: accept\n")
			if d.Gzip {
				b.WriteString("    compression: gzip\n")
			}
			headers("    ")
		case "datadog":
			fmt.Fprintf(&b, "    type: datadog_logs\n    default_api_key: %s\n    site: %s\n", q(d.APIKey), q(d.DatadogSite))
			b.WriteString("    compression: gzip\n")
		}
	}
	return b.String(), nil
}

func writeFileAtomic(path string, b []byte, mode os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, mode); err != nil {
		return err
	}
	if err := os.Chmod(tmp, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
