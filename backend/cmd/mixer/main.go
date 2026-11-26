// Command mixer tests the link to a Supermixer server through its REST API
// and prints what it finds.
//
//	mixer --server https://supermixer.example.com health
//
// Results go to stdout, one "key value" pair per line (or one JSON object
// with --json); errors go to stderr. The exit status says how it went, so
// scripts can use it without reading the output (see usage).
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"supermixer/internal/api"
	"supermixer/internal/version"
)

// Exit statuses.
const (
	exitOK          = 0   // the check passed
	exitUnhealthy   = 1   // the server answered, and the check failed
	exitUsage       = 2   // the command line is wrong
	exitUnreachable = 3   // no answer: no connection, a timeout, or not a Supermixer
	exitInterrupted = 130 // interrupted (Ctrl-C)
)

// The options every command takes, before or after its name.
const optionsHelp = `Options (before or after the command):
  --server URL          Supermixer's address, as you'd open it in a browser
                        (default: $SUPERMIXER_URL; http:// if no scheme is given)
  --json                Print one JSON object instead of "key value" lines
  -q, --quiet           Print nothing; report through the exit status only
  --timeout DURATION    Give up after this long (default 10s)
  -h, --help            Print help
`

const usage = `Usage: mixer [options] <command> [options]

Tests the link to a Supermixer server through its REST API.

Commands:
  health    Check the server and its database, and time the connection
  help      Print this help, or a command's (mixer help health)

` + optionsHelp + `  -V, --version         Print mixer's version (before the command)

Output is one "key value" pair per line, so it can be filtered:
  mixer health | awk '$1 == "total" { print $2 }'

Exit status:
  0    the check passed
  1    the server answered, and the check failed
  2    usage error
  3    no answer: can't connect, timed out, or not a Supermixer
  130  interrupted
`

const healthUsage = `Usage: mixer [options] health [options]

Checks Supermixer and its database (GET /api/v1/health), and times the
connection: DNS lookup, connect, TLS handshake, first byte and total.

` + optionsHelp + `
Exit status:
  0    healthy
  1    the server answered, and isn't healthy (its database is down)
  2    usage error
  3    no health report: can't connect, timed out, redirected, or not a Supermixer
  130  interrupted
`

// command is one of mixer's subcommands.
type command struct {
	usage string
	run   func(ctx context.Context, o options, env env) int
}

var commands = map[string]command{
	"health": {healthUsage, runHealth},
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := run(ctx, os.Args[1:], env{os.Getenv, os.Stdout, os.Stderr})
	stop()
	os.Exit(code)
}

// env is where a run reads its environment and writes its output.
type env struct {
	getenv         func(string) string
	stdout, stderr io.Writer
}

func (e env) fail(code int, format string, a ...any) int {
	fmt.Fprintf(e.stderr, "mixer: "+format+"\n", a...)
	return code
}

type options struct {
	server  string
	json    bool
	quiet   bool
	timeout time.Duration
}

// flags makes a flag set for the options every command takes, starting
// from o, so options given before the command carry over to after it.
func (o *options) flags(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard) // errors are reported by the caller, help goes to stdout
	fs.StringVar(&o.server, "server", o.server, "")
	fs.BoolVar(&o.json, "json", o.json, "")
	fs.BoolVar(&o.quiet, "quiet", o.quiet, "")
	fs.BoolVar(&o.quiet, "q", o.quiet, "")
	fs.DurationVar(&o.timeout, "timeout", o.timeout, "")
	return fs
}

func run(ctx context.Context, args []string, e env) int {
	o := options{server: e.getenv("SUPERMIXER_URL"), timeout: 10 * time.Second}
	var showVersion bool
	fs := o.flags("mixer")
	fs.BoolVar(&showVersion, "version", false, "")
	fs.BoolVar(&showVersion, "V", false, "")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fmt.Fprint(e.stdout, usage)
			return exitOK
		}
		return e.fail(exitUsage, "%v\nTry 'mixer --help'.", err)
	}
	if showVersion {
		fmt.Fprintln(e.stdout, version.Version)
		return exitOK
	}
	if fs.NArg() == 0 {
		fmt.Fprint(e.stderr, usage)
		return exitUsage
	}

	name, rest := fs.Arg(0), fs.Args()[1:]
	if name == "help" {
		switch {
		case len(rest) == 0:
			fmt.Fprint(e.stdout, usage)
			return exitOK
		case commands[rest[0]].run != nil:
			fmt.Fprint(e.stdout, commands[rest[0]].usage)
			return exitOK
		}
		name = rest[0]
	}
	cmd, ok := commands[name]
	if !ok {
		return e.fail(exitUsage, "unknown command %q\nTry 'mixer --help'.", name)
	}

	fs = o.flags("mixer " + name)
	if err := fs.Parse(rest); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fmt.Fprint(e.stdout, cmd.usage)
			return exitOK
		}
		return e.fail(exitUsage, "%v\nTry 'mixer help %s'.", err, name)
	}
	switch {
	case fs.NArg() > 0:
		return e.fail(exitUsage, "unexpected argument %q\nTry 'mixer help %s'.", fs.Arg(0), name)
	case o.server == "":
		return e.fail(exitUsage, "no server; pass --server URL or set SUPERMIXER_URL")
	case o.json && o.quiet:
		return e.fail(exitUsage, "--json and --quiet can't be used together")
	case o.timeout <= 0:
		return e.fail(exitUsage, "--timeout must be more than 0")
	}
	return cmd.run(ctx, o, e)
}

// runHealth is mixer health.
func runHealth(ctx context.Context, o options, e env) int {
	base, err := serverURL(o.server)
	if err != nil {
		return e.fail(exitUsage, "%v", err)
	}
	res, err := checkHealth(ctx, base, o.timeout)
	if err != nil {
		if ctx.Err() != nil {
			return e.fail(exitInterrupted, "interrupted")
		}
		return e.fail(exitUnreachable, "%v", err)
	}

	switch {
	case o.quiet:
	case o.json:
		enc := json.NewEncoder(e.stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(res)
	default:
		writeText(e.stdout, res, colorful(e.stdout, e.getenv))
	}
	if res.HTTPStatus != http.StatusOK || res.Health.Status != api.HealthStatusHealthy {
		return exitUnhealthy
	}
	return exitOK
}

// serverURL turns what was given for --server into the server's base URL:
// http:// if there's no scheme, and without a trailing /api/v1 if it was
// pasted from the API's address.
func serverURL(s string) (*url.URL, error) {
	s = strings.TrimSpace(s)
	if !strings.Contains(s, "://") {
		s = "http://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("--server %q isn't a URL", s)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("--server must be an http:// or https:// URL")
	}
	u.Path = strings.TrimSuffix(strings.TrimSuffix(u.Path, "/"), "/api/v1")
	u.RawPath, u.RawQuery, u.Fragment = "", "", ""
	return u, nil
}

// result is what mixer health reports: the server's own report, and how the
// request got there. Its JSON is mixer's --json output.
type result struct {
	Server     string     `json:"server"`
	Health     api.Health `json:"health"`
	HTTPStatus int        `json:"http_status"`
	Link       link       `json:"link"`
}

type link struct {
	Address  string  `json:"address,omitempty"` // the server's IP and port
	Protocol string  `json:"protocol"`          // HTTP/1.1, HTTP/2.0
	TLS      string  `json:"tls,omitempty"`     // TLS1.3
	Timings  timings `json:"timings_ms"`
}

// timings in milliseconds; a phase that didn't happen (DNS for an IP
// address, TLS for http://) is left out.
type timings struct {
	DNS       *float64 `json:"dns,omitempty"`
	Connect   *float64 `json:"connect,omitempty"`
	TLS       *float64 `json:"tls,omitempty"`
	FirstByte float64  `json:"first_byte"`
	Total     float64  `json:"total"`
}

func checkHealth(ctx context.Context, base *url.URL, timeout time.Duration) (*result, error) {
	target := base.JoinPath("api/v1/health")
	res := &result{Server: base.String()}

	var dnsStart, connStart, tlsStart, firstByte time.Time
	var dns, conn, tlsDur time.Duration
	trace := &httptrace.ClientTrace{
		DNSStart:          func(httptrace.DNSStartInfo) { dnsStart = time.Now() },
		DNSDone:           func(httptrace.DNSDoneInfo) { dns = time.Since(dnsStart) },
		ConnectStart:      func(string, string) { connStart = time.Now() },
		ConnectDone:       func(string, string, error) { conn = time.Since(connStart) },
		TLSHandshakeStart: func() { tlsStart = time.Now() },
		TLSHandshakeDone: func(cs tls.ConnectionState, _ error) {
			tlsDur = time.Since(tlsStart)
			res.Link.TLS = strings.ReplaceAll(tls.VersionName(cs.Version), " ", "")
		},
		GotConn: func(i httptrace.GotConnInfo) {
			if a, ok := i.Conn.RemoteAddr().(*net.TCPAddr); ok {
				res.Link.Address = a.String()
			}
		},
		GotFirstResponseByte: func() { firstByte = time.Now() },
	}

	req, err := http.NewRequestWithContext(httptrace.WithClientTrace(ctx, trace), http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "mixer/"+version.Version)

	client := &http.Client{
		Timeout: timeout,
		// A redirect is reported, not followed: it's part of the link, and
		// timings across two requests would mislead.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) && ue.Timeout() {
			return nil, fmt.Errorf("%s: no answer within %s", base, timeout)
		}
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return nil, fmt.Errorf("can't reach %s: %v", base, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("%s: reading the response: %v", base, err)
	}
	total := time.Since(start)

	res.HTTPStatus = resp.StatusCode
	res.Link.Protocol = resp.Proto
	ms := func(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }
	opt := func(d time.Duration) *float64 {
		if d == 0 {
			return nil
		}
		v := ms(d)
		return &v
	}
	res.Link.Timings = timings{DNS: opt(dns), Connect: opt(conn), TLS: opt(tlsDur), FirstByte: ms(firstByte.Sub(start)), Total: ms(total)}

	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return nil, fmt.Errorf("%s redirects to %s; use that as --server", base, resp.Header.Get("Location"))
	}
	// 503 still carries a report: the server is up, its database isn't.
	if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusServiceUnavailable {
		if err := json.Unmarshal(body, &res.Health); err == nil && res.Health.Status != "" {
			return res, nil
		}
	}
	msg := resp.Status
	var e api.Error
	if json.Unmarshal(body, &e) == nil && e.Message != "" {
		msg += ": " + e.Message
	}
	return nil, fmt.Errorf("%s didn't answer like a Supermixer (%s)", base, msg)
}

// writeText prints the result as "key value" lines: one word per key,
// aligned, so both people and awk/grep/cut can read it.
func writeText(w io.Writer, r *result, color bool) {
	state := func(s string) string {
		if !color {
			return s
		}
		if s == "healthy" {
			return "\x1b[32m" + s + "\x1b[0m"
		}
		return "\x1b[31m" + s + "\x1b[0m"
	}
	line := func(k, v string) { fmt.Fprintf(w, "%-15s %s\n", k, v) }
	msf := func(v float64) string { return fmt.Sprintf("%.1fms", v) }

	h := r.Health
	line("status", state(string(h.Status)))
	line("version", h.Version)
	line("database", state(string(h.Database.Status)))
	if h.Database.SchemaVersion != nil {
		line("schema_version", fmt.Sprint(*h.Database.SchemaVersion))
	}
	if h.Database.InstalledAt != nil {
		line("installed_at", h.Database.InstalledAt.UTC().Format(time.RFC3339))
	}
	if h.Database.Error != nil {
		line("database_error", *h.Database.Error)
	}
	line("server", r.Server)
	if r.Link.Address != "" {
		line("address", r.Link.Address)
	}
	line("protocol", r.Link.Protocol)
	if r.Link.TLS != "" {
		line("tls", r.Link.TLS)
	}
	line("http_status", fmt.Sprint(r.HTTPStatus))
	t := r.Link.Timings
	if t.DNS != nil {
		line("dns", msf(*t.DNS))
	}
	if t.Connect != nil {
		line("connect", msf(*t.Connect))
	}
	if t.TLS != nil {
		line("tls_handshake", msf(*t.TLS))
	}
	line("first_byte", msf(t.FirstByte))
	line("total", msf(t.Total))
}

// colorful reports whether to color the output: only for a terminal, and
// not when NO_COLOR is set (no-color.org) or TERM is dumb.
func colorful(w io.Writer, getenv func(string) string) bool {
	f, ok := w.(*os.File)
	if !ok || getenv("NO_COLOR") != "" || getenv("TERM") == "dumb" {
		return false
	}
	fi, err := f.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}
