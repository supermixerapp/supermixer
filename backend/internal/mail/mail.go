// Package mail sends email over SMTP: invitations, password-reset links and
// security notices.
package mail

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"net/textproto"
	"strconv"
	"strings"
	"time"

	"supermixer/internal/config"
)

// Message is one email to one or more people.
type Message struct {
	To      []string
	Subject string
	Text    string
	// HTML is optional; with it the email has both versions.
	HTML string
}

// Sender sends email.
type Sender interface {
	Send(ctx context.Context, m Message) error
	// From is the sender's address, for showing where mail comes from.
	From() string
}

// SMTP sends through an SMTP server.
type SMTP struct {
	cfg  config.Email
	from *mail.Address
}

// New returns a sender for the configuration, or nil if email is off.
func New(cfg config.Email) (*SMTP, error) {
	if !cfg.Enabled() {
		return nil, nil
	}
	from, err := mail.ParseAddress(cfg.From)
	if err != nil {
		return nil, fmt.Errorf("email.from: %w", err)
	}
	return &SMTP{cfg: cfg, from: from}, nil
}

func (s *SMTP) From() string { return s.from.String() }

// Send delivers m, or says why the server wouldn't take it.
func (s *SMTP) Send(ctx context.Context, m Message) error {
	raw, rcpt, err := Build(s.from, m, time.Now())
	if err != nil {
		return err
	}
	deadline := time.Now().Add(s.cfg.Timeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	addr := net.JoinHostPort(s.cfg.SMTPHost, strconv.Itoa(s.cfg.SMTPPort))
	dialer := &net.Dialer{Deadline: deadline}
	tlsConfig := &tls.Config{ServerName: s.cfg.SMTPHost, MinVersion: tls.VersionTLS12}
	var conn net.Conn
	if s.cfg.Security == "tls" {
		conn, err = (&tls.Dialer{NetDialer: dialer, Config: tlsConfig}).DialContext(ctx, "tcp", addr)
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("connecting to %s: %w", addr, err)
	}
	_ = conn.SetDeadline(deadline)
	c, err := smtp.NewClient(conn, s.cfg.SMTPHost)
	if err != nil {
		conn.Close()
		return fmt.Errorf("talking to %s: %w", addr, err)
	}
	defer c.Close()
	if s.cfg.Security == "starttls" {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			return fmt.Errorf("%s doesn't offer STARTTLS; set email.security to tls or none", addr)
		}
		if err := c.StartTLS(tlsConfig); err != nil {
			return fmt.Errorf("starting TLS with %s: %w", addr, err)
		}
	}
	if s.cfg.Username != "" {
		if err := c.Auth(smtp.PlainAuth("", s.cfg.Username, s.cfg.Password, s.cfg.SMTPHost)); err != nil {
			return fmt.Errorf("signing in to %s as %s: %w", addr, s.cfg.Username, err)
		}
	}
	if err := c.Mail(s.from.Address); err != nil {
		return fmt.Errorf("sender %s refused: %w", s.from.Address, err)
	}
	for _, r := range rcpt {
		if err := c.Rcpt(r); err != nil {
			return fmt.Errorf("recipient %s refused: %w", r, err)
		}
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(raw); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("message refused: %w", err)
	}
	return c.Quit()
}

// Build renders m as a MIME message, and returns its recipients' addresses.
func Build(from *mail.Address, m Message, now time.Time) ([]byte, []string, error) {
	if len(m.To) == 0 {
		return nil, nil, errors.New("no recipients")
	}
	var to, rcpt []string
	for _, t := range m.To {
		a, err := mail.ParseAddress(t)
		if err != nil || strings.ContainsAny(a.Address, "\r\n") {
			return nil, nil, fmt.Errorf("%q isn't an email address", t)
		}
		to, rcpt = append(to, a.String()), append(rcpt, a.Address)
	}
	id := make([]byte, 12)
	_, _ = rand.Read(id)
	domain := from.Address[strings.LastIndex(from.Address, "@")+1:]

	var b bytes.Buffer
	h := func(k, v string) { fmt.Fprintf(&b, "%s: %s\r\n", k, v) }
	h("From", from.String())
	h("To", strings.Join(to, ", "))
	h("Subject", mime.QEncoding.Encode("utf-8", strings.NewReplacer("\r", " ", "\n", " ").Replace(m.Subject)))
	h("Date", now.Format(time.RFC1123Z))
	h("Message-ID", "<"+hex.EncodeToString(id)+"@"+domain+">")
	h("MIME-Version", "1.0")
	h("Auto-Submitted", "auto-generated")

	part := func(mw *multipart.Writer, ctype, body string) error {
		pw, err := mw.CreatePart(textproto.MIMEHeader{"Content-Type": {ctype + "; charset=utf-8"}, "Content-Transfer-Encoding": {"quoted-printable"}})
		if err != nil {
			return err
		}
		q := quotedprintable.NewWriter(pw)
		if _, err := q.Write([]byte(strings.ReplaceAll(body, "\n", "\r\n"))); err != nil {
			return err
		}
		return q.Close()
	}
	if m.HTML == "" {
		h("Content-Type", "text/plain; charset=utf-8")
		h("Content-Transfer-Encoding", "quoted-printable")
		b.WriteString("\r\n")
		q := quotedprintable.NewWriter(&b)
		_, _ = q.Write([]byte(strings.ReplaceAll(m.Text, "\n", "\r\n")))
		_ = q.Close()
		return b.Bytes(), rcpt, nil
	}
	mw := multipart.NewWriter(&b)
	h("Content-Type", "multipart/alternative; boundary="+mw.Boundary())
	b.WriteString("\r\n")
	if err := part(mw, "text/plain", m.Text); err != nil {
		return nil, nil, err
	}
	if err := part(mw, "text/html", m.HTML); err != nil {
		return nil, nil, err
	}
	if err := mw.Close(); err != nil {
		return nil, nil, err
	}
	return b.Bytes(), rcpt, nil
}
