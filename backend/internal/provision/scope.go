package provision

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Supabase's compose files pin container names (supabase-db, ...), and Docker
// container names are global, so a second stack can't start. scopeContainers
// drops each container_name and adds the old name as a network alias instead:
// aliases are per Compose network, and services still reach each other by
// those names. It is the Go version of deploy/dev-stacks/scope-containers.py.

var (
	containerName = regexp.MustCompile(`^    container_name:\s*(\S+)\s*$`)
	serviceKey    = regexp.MustCompile(`^  [A-Za-z0-9_.-]+:\s*$`)
)

func scopeContainers(text string) (string, error) {
	lines := splitLines(text)
	var blocks [][]string
	var current []string
	for _, line := range lines {
		if serviceKey.MatchString(line) && len(current) > 0 {
			blocks = append(blocks, current)
			current = nil
		}
		current = append(current, line)
	}
	blocks = append(blocks, current)

	var out []string
	for _, block := range blocks {
		var name string
		var kept []string
		for _, l := range block {
			if m := containerName.FindStringSubmatch(l); m != nil {
				if name == "" {
					name = m[1]
				}
				continue
			}
			kept = append(kept, l)
		}
		if name == "" {
			out = append(out, block...)
			continue
		}
		alias := "          - " + name + "\n"
		if i := indexOf(kept, "        aliases:\n"); i >= 0 {
			i++
			for i < len(kept) && strings.HasPrefix(kept[i], "          - ") {
				i++
			}
			kept = insert(kept, i, alias)
		} else if hasPrefix(kept, "    networks:") {
			return "", fmt.Errorf("don't know how to add an alias to a service with its own networks: %s", name)
		} else {
			kept = insert(kept, 1, "    networks:\n", "      default:\n", "        aliases:\n", alias)
		}
		out = append(out, kept...)
	}
	return strings.Join(out, ""), nil
}

// Supabase's vector.yml reads every container's logs on the Docker host and
// tells services apart by container name. scopeVector limits it to this
// stack's Compose project and maps each service back to its original name.
// It is the Go version of deploy/dev-stacks/scope-vector.py.

const (
	vectorBegin  = "# supermixer: begin"
	vectorEnd    = "# supermixer: end"
	projectLabel = "com.docker.compose.project"
	serviceLabel = "com.docker.compose.service"
)

var (
	aliasLine     = regexp.MustCompile(`^\s+- ((?:[A-Za-z0-9-]+\.)?supabase-[A-Za-z0-9-]+)\s*$`)
	serviceName   = regexp.MustCompile(`^  ([A-Za-z0-9_.-]+):\s*$`)
	appnameLine   = regexp.MustCompile(`^(\s*)\.appname = del\(\.container_name\)\s*$`)
	dockerSource  = regexp.MustCompile(`^(\s*)type: docker_logs\s*$`)
	composeProjRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)
)

// serviceAliases maps each Compose service to its first supabase-* alias.
func serviceAliases(composeFiles ...string) map[string]string {
	names := map[string]string{}
	for _, text := range composeFiles {
		service := ""
		for _, line := range splitLines(text) {
			if m := serviceName.FindStringSubmatch(line); m != nil {
				service = m[1]
				continue
			}
			if m := aliasLine.FindStringSubmatch(line); m != nil && service != "" {
				if _, ok := names[service]; !ok {
					names[service] = m[1]
				}
			}
		}
	}
	return names
}

func scopeVector(vector, project string, names map[string]string) (string, error) {
	if !composeProjRe.MatchString(project) {
		return "", fmt.Errorf("invalid Compose project name %q", project)
	}
	services := make([]string, 0, len(names))
	for s := range names {
		services = append(services, s)
	}
	sort.Strings(services)

	var out []string
	sources := 0
	for _, line := range splitLines(vector) {
		out = append(out, line)
		if m := dockerSource.FindStringSubmatch(line); m != nil {
			sources++
			pad := m[1]
			out = append(out,
				pad+vectorBegin+"\n",
				pad+"# Only this stack's containers: the Docker host may run others.\n",
				pad+"include_labels:\n",
				pad+"  - "+projectLabel+"="+project+"\n",
				pad+vectorEnd+"\n",
			)
			continue
		}
		if m := appnameLine.FindStringSubmatch(line); m != nil {
			pad := m[1]
			out = append(out,
				pad+vectorBegin+"\n",
				pad+`project = string(.label."`+projectLabel+`") ?? ""`+"\n",
				pad+`svc = string(.label."`+serviceLabel+`") ?? ""`+"\n",
				pad+`if project == "`+project+`" {`+"\n",
			)
			for _, s := range services {
				out = append(out, pad+`  if svc == "`+s+`" { .appname = "`+names[s]+`" }`+"\n")
			}
			out = append(out, pad+"}\n", pad+vectorEnd+"\n")
		}
	}
	text := strings.Join(out, "")
	// Refuse rather than collect other containers' logs.
	if sources == 0 {
		return "", fmt.Errorf("vector.yml has no docker_logs source")
	}
	if !strings.Contains(text, "- "+projectLabel+"="+project+"\n") {
		return "", fmt.Errorf("vector.yml's docker_logs source wasn't limited to %s", project)
	}
	if !strings.Contains(text, `if project == "`+project+`"`) {
		return "", fmt.Errorf("vector.yml no longer sets .appname from .container_name; the service mapping wasn't added")
	}
	return text, nil
}

func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.SplitAfter(s, "\n")
	if parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	return parts
}

func indexOf(lines []string, want string) int {
	for i, l := range lines {
		if l == want {
			return i
		}
	}
	return -1
}

func hasPrefix(lines []string, prefix string) bool {
	for _, l := range lines {
		if strings.HasPrefix(l, prefix) {
			return true
		}
	}
	return false
}

func insert(lines []string, at int, add ...string) []string {
	out := make([]string, 0, len(lines)+len(add))
	out = append(out, lines[:at]...)
	out = append(out, add...)
	return append(out, lines[at:]...)
}
