package httpapi

import (
	"bytes"
	"context"
	"fmt"
	"html/template"
	"net/url"
	"strings"
	"time"

	"supermixer/internal/mail"
	"supermixer/internal/store/db"
)

// Emails Supermixer sends (Stage 5.3): each has a plain-text and an HTML
// version from the same content.

type emailContent struct {
	Heading string
	// Paragraphs before and after the button.
	Intro  []string
	Button string
	Link   string
	Outro  []string
}

var emailHTML = template.Must(template.New("email").Parse(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:16px;background:#f6f6f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1c1c">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border:1px solid #e4e4e4;border-radius:8px">
<tr><td style="padding:24px;border-bottom:1px solid #eee;font-size:15px;font-weight:600">Supermixer</td></tr>
<tr><td style="padding:24px;font-size:14px;line-height:1.6">
<h1 style="margin:0 0 16px;font-size:20px;font-weight:600">{{.Heading}}</h1>
{{range .Intro}}<p style="margin:0 0 12px">{{.}}</p>{{end}}
{{if .Link}}<p style="margin:20px 0"><a href="{{.Link}}" style="display:inline-block;background:{{.Brand}};color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:500">{{.Button}}</a></p>
<p style="margin:0 0 12px;font-size:12px;color:#707070">Or open this link: <a href="{{.Link}}" style="color:{{.Brand}};word-break:break-all">{{.Link}}</a></p>{{end}}
{{range .Outro}}<p style="margin:0 0 12px;color:#505050">{{.}}</p>{{end}}
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #eee;font-size:12px;color:#8a8a8a">Sent by Supermixer at {{.Host}}. You can't reply to this email.</td></tr>
</table></td></tr></table></body></html>`))

func (h *handlers) host() string {
	if u, err := url.Parse(h.deps.Config.Server.PublicURL); err == nil && u.Host != "" {
		return u.Host
	}
	return h.deps.Config.Server.PublicURL
}

// renderEmail returns the text and HTML versions.
func (h *handlers) renderEmail(c emailContent) (string, string) {
	var t strings.Builder
	t.WriteString(c.Heading + "\n\n")
	for _, p := range c.Intro {
		t.WriteString(p + "\n\n")
	}
	if c.Link != "" {
		t.WriteString(c.Button + ": " + c.Link + "\n\n")
	}
	for _, p := range c.Outro {
		t.WriteString(p + "\n\n")
	}
	t.WriteString("--\nSent by Supermixer at " + h.host() + ".\n")

	var b bytes.Buffer
	brand := "#0019A8"
	if h.deps.Palette != nil {
		brand = h.deps.Palette.Brand.Hex()
	}
	_ = emailHTML.Execute(&b, struct {
		emailContent
		Brand, Host string
	}{c, brand, h.host()})
	return t.String(), b.String()
}

// sendEmail sends one email now, and says why it couldn't.
func (h *handlers) sendEmail(ctx context.Context, to, subject string, c emailContent) error {
	if h.mailer == nil {
		return fmt.Errorf("email is off (email.smtp_host)")
	}
	text, html := h.renderEmail(c)
	err := h.mailer.Send(ctx, mail.Message{To: []string{to}, Subject: subject, Text: text, HTML: html})
	h.deps.Metrics.Email(err == nil)
	return err
}

// sendLater sends in the background (a request doesn't wait for, or
// reveal, the mail server), logging failures.
func (h *handlers) sendLater(to, subject string, c emailContent) {
	if h.mailer == nil || to == "" {
		return
	}
	h.pending.Add(1)
	go func() {
		defer h.pending.Done()
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if err := h.sendEmail(ctx, to, subject, c); err != nil {
			h.deps.Logger.Warn("sending email", "to", to, "subject", subject, "err", err)
		}
	}()
}

// notify tells a user about a change to their account's security, at their
// email address if they have one, so a change they didn't make doesn't go
// unnoticed.
func (h *handlers) notify(ctx context.Context, u db.User, subject, what string) {
	if u.Email == nil {
		return
	}
	ip := reqInfo(ctx).IP
	h.sendLater(*u.Email, subject, emailContent{
		Heading: subject,
		Intro: []string{
			fmt.Sprintf("%s for your Supermixer account %s at %s.", what, u.Username, h.host()),
			fmt.Sprintf("When: %s, from %s.", time.Now().UTC().Format("2 January 2006, 15:04 UTC"), ip),
		},
		Outro: []string{"If this was you, there's nothing to do. If it wasn't, someone else may have your password: tell your Supermixer administrator now."},
	})
}
