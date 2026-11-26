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
	"sync"
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
  1    the server answered, and isn't healthy (its database is down, or it
       answered with an error)
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
		// Options don't matter to help (mixer help --json is still help),
		// but they're parsed so an option's value isn't taken for the topic.
		hfs := o.flags("mixer help")
		if err := hfs.Parse(rest); err != nil && !errors.Is(err, flag.ErrHelp) {
			return e.fail(exitUsage, "%v\nTry 'mixer --help'.", err)
		}
		topic := hfs.Arg(0)
		switch {
		case topic == "":
			fmt.Fprint(e.stdout, usage)
			return exitOK
		case commands[topic].run != nil:
			fmt.Fprint(e.stdout, commands[topic].usage)
			return exitOK
		}
		name = topic
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
	o.server = strings.TrimSpace(o.server)
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
		var bad *unhealthyError
		if errors.As(err, &bad) {
			return e.fail(exitUnhealthy, "%v", err)
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

// apiSuffixes are API addresses people paste for --server, longest first:
// the health check's, Supermixer's API and the Management API.
var apiSuffixes = []string{"/api/v1/health", "/api/v1", "/v1"}

// serverURL turns what was given for --server into the server's base URL:
// http:// if there's no scheme, and without an API path pasted with it.
func serverURL(in string) (*url.URL, error) {
	s := strings.TrimSpace(in)
	if !strings.Contains(s, "://") {
		// As curl does, but https for port 443, which only speaks TLS.
		if strings.HasSuffix(strings.SplitN(s, "/", 2)[0], ":443") {
			s = "https://" + s
		} else {
			s = "http://" + s
		}
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("--server %q isn't a URL", in)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("--server must be an http:// or https:// URL")
	}
	u.Path = strings.TrimSuffix(u.Path, "/")
	for _, suffix := range apiSuffixes {
		if strings.HasSuffix(u.Path, suffix) {
			u.Path = strings.TrimSuffix(u.Path, suffix)
			break
		}
	}
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
	// The proxy the request went through (HTTPS_PROXY and so on), without
	// its password; the address and timings are then the proxy's.
	Proxy    string  `json:"proxy,omitempty"`
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

	// The dialer may try IPv6 and IPv4 addresses at once (Happy Eyeballs),
	// so connects are timed per address, and the one reported is the
	// connection the request used. The callbacks can run on other
	// goroutines, even after the request is done, hence the lock.
	var (
		mu                            sync.Mutex
		dnsStart, tlsStart, firstByte time.Time
		dns, tlsDur                   time.Duration
		connStart                     = map[string]time.Time{}
		connected                     = map[string]time.Duration{}
	)
	locked := func(f func()) { mu.Lock(); defer mu.Unlock(); f() }
	trace := &httptrace.ClientTrace{
		DNSStart: func(httptrace.DNSStartInfo) { locked(func() { dnsStart = time.Now() }) },
		DNSDone:  func(httptrace.DNSDoneInfo) { locked(func() { dns = time.Since(dnsStart) }) },
		ConnectStart: func(_, addr string) {
			locked(func() { connStart[addr] = time.Now() })
		},
		ConnectDone: func(_, addr string, err error) {
			locked(func() {
				if err == nil {
					connected[addr] = time.Since(connStart[addr])
				}
			})
		},
		TLSHandshakeStart: func() { locked(func() { tlsStart = time.Now() }) },
		TLSHandshakeDone: func(cs tls.ConnectionState, err error) {
			locked(func() {
				if err == nil {
					tlsDur = time.Since(tlsStart)
					res.Link.TLS = strings.ReplaceAll(tls.VersionName(cs.Version), " ", "")
				}
			})
		},
		GotConn: func(i httptrace.GotConnInfo) {
			locked(func() {
				if a, ok := i.Conn.RemoteAddr().(*net.TCPAddr); ok {
					res.Link.Address = a.String()
				}
			})
		},
		GotFirstResponseByte: func() { locked(func() { firstByte = time.Now() }) },
	}

	req, err := http.NewRequestWithContext(httptrace.WithClientTrace(ctx, trace), http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "mixer/"+version.Version)
	// The default transport goes through the proxy the environment names;
	// say so, since the link measured is then the proxy's.
	via := ""
	if p, err := http.ProxyFromEnvironment(req); err == nil && p != nil {
		res.Link.Proxy = p.Redacted()
		via = " through proxy " + res.Link.Proxy
	}

	client := &http.Client{
		Timeout: timeout,
		// A redirect is reported, not followed: it's part of the link, and
		// timings across two requests would mislead.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	start := time.Now()
	timedOut := func(err error) bool {
		var ne net.Error
		return errors.Is(err, context.DeadlineExceeded) || errors.As(err, &ne) && ne.Timeout()
	}
	resp, err := client.Do(req)
	if err != nil {
		if timedOut(err) {
			return nil, fmt.Errorf("%s: no answer within %s%s", base, timeout, via)
		}
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return nil, fmt.Errorf("can't reach %s%s: %v", base, via, err)
	}
	defer resp.Body.Close()
	// The client's timeout covers reading the body too.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		if timedOut(err) {
			return nil, fmt.Errorf("%s: no answer within %s%s", base, timeout, via)
		}
		return nil, fmt.Errorf("%s: reading the response: %v", base, err)
	}
	total := time.Since(start)
	mu.Lock()
	defer mu.Unlock()

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
	res.Link.Timings = timings{
		DNS: opt(dns), Connect: opt(connected[res.Link.Address]), TLS: opt(tlsDur),
		FirstByte: ms(firstByte.Sub(start)), Total: ms(total),
	}

	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		// Location is usually the health check's own address, perhaps
		// relative: then suggest the server it points to. Anywhere else (a
		// sign-in page in front of it) isn't a Supermixer to suggest.
		loc, err := resp.Location()
		if err != nil {
			return nil, fmt.Errorf("%s redirects (%s) without saying where", base, resp.Status)
		}
		if strings.HasSuffix(strings.TrimSuffix(loc.Path, "/"), "/api/v1/health") {
			if to, err := serverURL(loc.String()); err == nil {
				return nil, fmt.Errorf("%s redirects to %s; try --server %s", base, loc, to)
			}
		}
		return nil, fmt.Errorf("%s redirects to %s", base, loc)
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
		// Supermixer's own error, from its health check: it answered, and
		// isn't healthy.
		if resp.StatusCode >= 500 && strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
			return nil, &unhealthyError{fmt.Sprintf("%s answered %s", base, msg)}
		}
	}
	return nil, fmt.Errorf("%s didn't answer like a Supermixer (%s)", base, msg)
}

// unhealthyError is a server that answered its health check with an error
// rather than a report: reachable, but not healthy (exit status 1).
type unhealthyError struct{ msg string }

func (e *unhealthyError) Error() string { return e.msg }

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
	if r.Link.Proxy != "" {
		line("proxy", r.Link.Proxy)
	}
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
