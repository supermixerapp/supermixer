package provision

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// Compose runs docker compose for one stack.
type Compose struct {
	Docker string // the docker CLI
	Layout Layout
	Env    []string // extra environment, e.g. DOCKER_HOST
}

func (c Compose) args(sub ...string) []string {
	a := []string{"compose", "--project-name", c.Layout.Project, "--project-directory", c.Layout.Dir}
	for _, f := range composeFiles {
		a = append(a, "--file", f)
	}
	return append(a, sub...)
}

// Run runs a compose command, writing its output to log (and keeping the
// last lines for the error).
func (c Compose) Run(ctx context.Context, log io.Writer, sub ...string) error {
	return c.RunInput(ctx, log, nil, sub...)
}

// RunInput is Run with stdin (for SQL that mustn't appear in a process list).
func (c Compose) RunInput(ctx context.Context, log io.Writer, stdin io.Reader, sub ...string) error {
	cmd := exec.CommandContext(ctx, c.Docker, c.args(sub...)...)
	cmd.Stdin = stdin
	cmd.Dir = c.Layout.Dir
	if len(c.Env) > 0 {
		cmd.Env = append(cmd.Environ(), c.Env...)
	}
	tail := &tailWriter{max: 20}
	out := io.MultiWriter(tail, nopWriter(log))
	cmd.Stdout, cmd.Stderr = out, out
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("docker compose %s: %w", sub[0], ctx.Err())
		}
		return fmt.Errorf("docker compose %s failed: %v\n%s", sub[0], err, tail.String())
	}
	return nil
}

// Up creates and starts the stack, waiting until its services are healthy.
func (c Compose) Up(ctx context.Context, log io.Writer) error {
	return c.Run(ctx, log, "up", "--detach", "--wait", "--remove-orphans")
}

// Stop stops the containers, keeping them and their data (pause).
func (c Compose) Stop(ctx context.Context, log io.Writer) error {
	return c.Run(ctx, log, "stop")
}

// Restart restarts every service.
func (c Compose) Restart(ctx context.Context, log io.Writer) error {
	return c.Run(ctx, log, "restart")
}

// Down removes the containers, networks and volumes: the stack's data.
func (c Compose) Down(ctx context.Context, log io.Writer) error {
	return c.Run(ctx, log, "down", "--volumes", "--remove-orphans")
}

// Service is one container, as docker compose ps reports it.
type Service struct {
	Service string `json:"Service"`
	Name    string `json:"Name"`
	Image   string `json:"Image"`
	State   string `json:"State"`  // running, exited, …
	Health  string `json:"Health"` // healthy, starting, unhealthy, or empty
	Status  string `json:"Status"` // e.g. "Up 3 minutes (healthy)"
}

// PS lists the stack's containers, stopped ones too.
func (c Compose) PS(ctx context.Context) ([]Service, error) {
	cmd := exec.CommandContext(ctx, c.Docker, c.args("ps", "--all", "--format", "json")...)
	cmd.Dir = c.Layout.Dir
	if len(c.Env) > 0 {
		cmd.Env = append(cmd.Environ(), c.Env...)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("docker compose ps: %v: %s", err, strings.TrimSpace(stderr.String()))
	}
	return parsePS(out)
}

// parsePS reads compose's JSON: one object per line (current releases) or
// one array (older ones).
func parsePS(out []byte) ([]Service, error) {
	out = bytes.TrimSpace(out)
	if len(out) == 0 {
		return []Service{}, nil
	}
	if out[0] == '[' {
		var s []Service
		return s, json.Unmarshal(out, &s)
	}
	var services []Service
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var s Service
		if err := json.Unmarshal(line, &s); err != nil {
			return nil, fmt.Errorf("docker compose ps: %w", err)
		}
		services = append(services, s)
	}
	return services, sc.Err()
}

// Ports is one stack's host ports.
type Ports struct{ API, DB, Pooler int }

// PortRange is an inclusive range.
type PortRange struct{ First, Last int }

// ErrNoPorts means a range has no free port left.
var ErrNoPorts = errors.New("no free port left")

// AllocatePorts picks the lowest free port in each range. taken holds ports
// other stacks or containers already use; free, if set, is asked last
// (e.g. whether something else on the host is listening).
func AllocatePorts(api, db, pooler PortRange, taken map[int]bool, free func(int) bool) (Ports, error) {
	pick := func(name string, r PortRange) (int, error) {
		for p := r.First; p <= r.Last; p++ {
			if taken[p] || (free != nil && !free(p)) {
				continue
			}
			taken[p] = true
			return p, nil
		}
		return 0, fmt.Errorf("%w in %s ports %d-%d", ErrNoPorts, name, r.First, r.Last)
	}
	var p Ports
	var err error
	if p.API, err = pick("API", api); err != nil {
		return Ports{}, err
	}
	if p.DB, err = pick("database", db); err != nil {
		return Ports{}, err
	}
	if p.Pooler, err = pick("pooler", pooler); err != nil {
		return Ports{}, err
	}
	return p, nil
}

// "0.0.0.0:8200->8000/tcp", or a range: "0.0.0.0:8200-8210->8200-8210/tcp".
var publishedPort = regexp.MustCompile(`:(\d+)(?:-(\d+))?->`)

// PublishedPorts lists host ports Docker's running containers publish.
func PublishedPorts(ctx context.Context, docker string) (map[int]bool, error) {
	out, err := exec.CommandContext(ctx, docker, "ps", "--format", "{{.Ports}}").Output()
	if err != nil {
		return nil, fmt.Errorf("docker ps: %w", err)
	}
	return parsePublished(string(out)), nil
}

func parsePublished(out string) map[int]bool {
	ports := map[int]bool{}
	for _, m := range publishedPort.FindAllStringSubmatch(out, -1) {
		first, err := strconv.Atoi(m[1])
		if err != nil {
			continue
		}
		last := first
		if m[2] != "" {
			if n, err := strconv.Atoi(m[2]); err == nil && n >= first && n-first < 65536 {
				last = n
			}
		}
		for p := first; p <= last; p++ {
			ports[p] = true
		}
	}
	return ports
}

// ListenFree reports whether nothing on this machine listens on port. It's
// a best-effort check: inside a container it only sees the container.
func ListenFree(port int) bool {
	l, err := net.Listen("tcp", ":"+strconv.Itoa(port))
	if err != nil {
		return false
	}
	_ = l.Close()
	return true
}

// tailWriter keeps the last max lines written.
type tailWriter struct {
	mu    sync.Mutex
	max   int
	lines []string
	part  string
}

func (t *tailWriter) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	s := t.part + string(p)
	parts := strings.Split(s, "\n")
	t.part = parts[len(parts)-1]
	for _, l := range parts[:len(parts)-1] {
		t.lines = append(t.lines, l)
		if len(t.lines) > t.max {
			t.lines = t.lines[1:]
		}
	}
	return len(p), nil
}

func (t *tailWriter) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	lines := t.lines
	if t.part != "" {
		lines = append(append([]string{}, lines...), t.part)
	}
	return strings.Join(lines, "\n")
}

func nopWriter(w io.Writer) io.Writer {
	if w == nil {
		return io.Discard
	}
	return w
}

// Recreate recreates one service (picking up new files or settings) and
// waits for it to be healthy. Other services keep running.
func (c Compose) Recreate(ctx context.Context, log io.Writer, service string) error {
	return c.Run(ctx, log, "up", "--detach", "--wait", "--no-deps", "--force-recreate", service)
}

// RestartAndWait restarts every service, then waits until they're healthy
// (restart alone returns as soon as they're started).
func (c Compose) RestartAndWait(ctx context.Context, log io.Writer) error {
	if err := c.Restart(ctx, log); err != nil {
		return err
	}
	return c.Up(ctx, log)
}

// Ensure starts a service if it isn't running (new in the overlay, say),
// leaving it alone if it is.
func (c Compose) Ensure(ctx context.Context, log io.Writer, service string) error {
	return c.Run(ctx, log, "up", "--detach", "--wait", "--no-deps", service)
}

// RemoveStackDir deletes a stack's folder. Anything in it a container's user
// owns (Linux bind mounts) is removed from inside a container first, using
// the stack's own Postgres image so nothing is downloaded.
func RemoveStackDir(ctx context.Context, docker, dir string, log io.Writer) error {
	if err := os.RemoveAll(dir); err == nil {
		return nil
	}
	image, err := StackImage(dir)
	if err != nil {
		return fmt.Errorf("removing %s: %w", dir, err)
	}
	cmd := exec.CommandContext(ctx, docker, "run", "--rm", "--entrypoint", "sh", "--volume", dir+":/stack", image,
		"-c", "rm -rf /stack/..?* /stack/.[!.]* /stack/*")
	out, err := cmd.CombinedOutput()
	fmt.Fprintf(nopWriter(log), "%s", out)
	if err != nil {
		return fmt.Errorf("removing %s's files in a container: %v", dir, err)
	}
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("removing %s: %w", dir, err)
	}
	return nil
}
