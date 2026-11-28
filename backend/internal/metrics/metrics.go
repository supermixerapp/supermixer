// Package metrics is Supermixer's Prometheus metrics, served on
// their own address ([metrics] listen). A nil *Metrics records nothing, so
// code can call it whether or not metrics are on.
package metrics

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"supermixer/internal/version"
)

type Metrics struct {
	reg       *prometheus.Registry
	requests  *prometheus.CounterVec
	durations *prometheus.HistogramVec
	signIns   *prometheus.CounterVec
	emails    *prometheus.CounterVec
	drainSent *prometheus.CounterVec
	drainErrs *prometheus.CounterVec
	drainLag  *prometheus.GaugeVec
}

// New makes the metrics; state, if set, is read at each scrape for the
// numbers kept in the database.
func New(state StateFunc) *Metrics {
	m := &Metrics{
		reg: prometheus.NewRegistry(),
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "supermixer_http_requests_total", Help: "HTTP requests, by method, route and status code.",
		}, []string{"method", "route", "code"}),
		durations: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "supermixer_http_request_duration_seconds", Help: "How long HTTP requests took, by method and route.",
			Buckets: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 30},
		}, []string{"method", "route"}),
		signIns: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "supermixer_sign_ins_total", Help: "Sign-in steps, by method (password, mfa, sso) and result (success, failure).",
		}, []string{"method", "result"}),
		emails: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "supermixer_emails_total", Help: "Emails sent, by result (sent, failed).",
		}, []string{"result"}),
		drainSent: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "supermixer_audit_drain_entries_total", Help: "Audit log entries delivered, by drain.",
		}, []string{"drain"}),
		drainErrs: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "supermixer_audit_drain_errors_total", Help: "Failed deliveries, by drain.",
		}, []string{"drain"}),
		drainLag: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "supermixer_audit_drain_lag_entries", Help: "Audit log entries not yet delivered, by drain.",
		}, []string{"drain"}),
	}
	build := prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "supermixer_build_info", Help: "Supermixer's version."}, []string{"version"})
	build.WithLabelValues(version.Version).Set(1)
	m.reg.MustRegister(m.requests, m.durations, m.signIns, m.emails, m.drainSent, m.drainErrs, m.drainLag, build,
		collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	if state != nil {
		m.reg.MustRegister(&stateCollector{read: state})
	}
	return m
}

// Handler serves /metrics.
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.reg, promhttp.HandlerOpts{Timeout: 10 * time.Second})
}

// Request records an HTTP request; route is its pattern (/projects/{ref}),
// not the path, so there's one series per route.
func (m *Metrics) Request(method, route string, code int, took time.Duration) {
	if m == nil {
		return
	}
	if route == "" {
		route = "other"
	}
	// Any method name is accepted before routing: one label for the rest,
	// so made-up ones can't add series.
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions:
	default:
		method = "other"
	}
	m.requests.WithLabelValues(method, route, strconv.Itoa(code)).Inc()
	m.durations.WithLabelValues(method, route).Observe(took.Seconds())
}

func result(ok bool, yes, no string) string {
	if ok {
		return yes
	}
	return no
}

// SignIn records a sign-in step.
func (m *Metrics) SignIn(method string, ok bool) {
	if m != nil {
		m.signIns.WithLabelValues(method, result(ok, "success", "failure")).Inc()
	}
}

// Email records an email sent (or not).
func (m *Metrics) Email(ok bool) {
	if m != nil {
		m.emails.WithLabelValues(result(ok, "sent", "failed")).Inc()
	}
}

// Drain records an audit drain's delivery: entries sent, or a failure, and
// how many entries are left.
func (m *Metrics) Drain(id string, sent int, failed bool, lag int64) {
	if m == nil {
		return
	}
	if sent > 0 {
		m.drainSent.WithLabelValues(id).Add(float64(sent))
	}
	if failed {
		m.drainErrs.WithLabelValues(id).Inc()
	}
	m.drainLag.WithLabelValues(id).Set(float64(lag))
}

// State is what's counted in the database, read at each scrape.
type State struct {
	Users, ActiveUsers, Organizations, Projects int
	// Stacks counts created stacks by status.
	Stacks map[string]int
	// LastBackup is each created stack's newest completed backup (by ref);
	// stacks without one are left out.
	LastBackup map[string]time.Time
	// FailedBackups counts backups that failed in the last day, by ref.
	FailedBackups map[string]int
}

type StateFunc func(ctx context.Context) (State, error)

type stateCollector struct{ read StateFunc }

var (
	usersDesc      = prometheus.NewDesc("supermixer_users", "Accounts, by whether they're active or disabled.", []string{"state"}, nil)
	orgsDesc       = prometheus.NewDesc("supermixer_organizations", "Organizations.", nil, nil)
	projectsDesc   = prometheus.NewDesc("supermixer_projects", "Projects.", nil, nil)
	stacksDesc     = prometheus.NewDesc("supermixer_stacks", "Stacks Supermixer created, by status.", []string{"status"}, nil)
	lastBackupDesc = prometheus.NewDesc("supermixer_backup_last_success_timestamp_seconds", "When each stack's newest completed backup finished.", []string{"project"}, nil)
	failedDesc     = prometheus.NewDesc("supermixer_backups_failed_last_day", "Backups that failed in the last 24 hours, by stack.", []string{"project"}, nil)
	stateUpDesc    = prometheus.NewDesc("supermixer_state_up", "1 if the database could be read for these metrics.", nil, nil)
)

func (c *stateCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range []*prometheus.Desc{usersDesc, orgsDesc, projectsDesc, stacksDesc, lastBackupDesc, failedDesc, stateUpDesc} {
		ch <- d
	}
}

func (c *stateCollector) Collect(ch chan<- prometheus.Metric) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s, err := c.read(ctx)
	if err != nil {
		ch <- prometheus.MustNewConstMetric(stateUpDesc, prometheus.GaugeValue, 0)
		return
	}
	ch <- prometheus.MustNewConstMetric(stateUpDesc, prometheus.GaugeValue, 1)
	ch <- prometheus.MustNewConstMetric(usersDesc, prometheus.GaugeValue, float64(s.ActiveUsers), "active")
	ch <- prometheus.MustNewConstMetric(usersDesc, prometheus.GaugeValue, float64(s.Users-s.ActiveUsers), "disabled")
	ch <- prometheus.MustNewConstMetric(orgsDesc, prometheus.GaugeValue, float64(s.Organizations))
	ch <- prometheus.MustNewConstMetric(projectsDesc, prometheus.GaugeValue, float64(s.Projects))
	for _, status := range []string{"provisioning", "running", "paused", "failed", "deleting"} {
		ch <- prometheus.MustNewConstMetric(stacksDesc, prometheus.GaugeValue, float64(s.Stacks[status]), status)
	}
	for ref, t := range s.LastBackup {
		ch <- prometheus.MustNewConstMetric(lastBackupDesc, prometheus.GaugeValue, float64(t.Unix()), ref)
	}
	for ref, n := range s.FailedBackups {
		ch <- prometheus.MustNewConstMetric(failedDesc, prometheus.GaugeValue, float64(n), ref)
	}
}

var certExpiryDesc = prometheus.NewDesc("supermixer_tls_certificate_expiry_timestamp_seconds",
	"When the certificate for each host name expires ([tls]).", []string{"name"}, nil)

type certCollector struct{ read func() map[string]time.Time }

func (c certCollector) Describe(ch chan<- *prometheus.Desc) { ch <- certExpiryDesc }

func (c certCollector) Collect(ch chan<- prometheus.Metric) {
	for name, t := range c.read() {
		ch <- prometheus.MustNewConstMetric(certExpiryDesc, prometheus.GaugeValue, float64(t.Unix()), name)
	}
}

// CertificateExpiry reports, at each scrape, when each host name's
// certificate expires.
func (m *Metrics) CertificateExpiry(read func() map[string]time.Time) {
	if m == nil {
		return
	}
	m.reg.MustRegister(certCollector{read: read})
}
