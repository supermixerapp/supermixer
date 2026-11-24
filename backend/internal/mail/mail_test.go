package mail

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/mail"
	"strings"
	"testing"
	"time"

	"supermixer/internal/config"
)

// fakeServer is enough of an SMTP server to take one message.
func fakeServer(t *testing.T) (port int, got chan string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	got = make(chan string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r, w := bufio.NewReader(conn), conn
		say := func(s string) { _, _ = io.WriteString(w, s+"\r\n") }
		say("220 fake ESMTP")
		var data strings.Builder
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			cmd := strings.ToUpper(strings.TrimSpace(line))
			switch {
			case strings.HasPrefix(cmd, "EHLO"):
				say("250-fake")
				say("250 8BITMIME")
			case strings.HasPrefix(cmd, "MAIL"), strings.HasPrefix(cmd, "RCPT"):
				data.WriteString(strings.TrimSpace(line) + "\n")
				say("250 OK")
			case cmd == "DATA":
				say("354 go ahead")
				for {
					l, err := r.ReadString('\n')
					if err != nil || l == ".\r\n" {
						break
					}
					data.WriteString(l)
				}
				say("250 queued")
			case cmd == "QUIT":
				say("221 bye")
				got <- data.String()
				return
			default:
				say("250 OK")
			}
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, got
}

func TestSend(t *testing.T) {
	port, got := fakeServer(t)
	s, err := New(config.Email{SMTPHost: "127.0.0.1", SMTPPort: port, Security: "none", From: "Supermixer <sm@example.com>", Timeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	err = s.Send(context.Background(), Message{To: []string{"Ann <ann@example.com>"}, Subject: "Héllo\r\nBcc: evil@example.com",
		Text: "Join here:\nhttps://example.com/join?token=abc", HTML: "<p>Join <a href=\"https://example.com\">here</a></p>"})
	if err != nil {
		t.Fatal(err)
	}
	msg := <-got
	for _, want := range []string{"MAIL FROM:<sm@example.com>", "RCPT TO:<ann@example.com>", "From: \"Supermixer\" <sm@example.com>",
		"To: \"Ann\" <ann@example.com>", "Subject: =?utf-8?q?H=C3=A9llo__Bcc:_evil@example.com?=", "multipart/alternative",
		"text/plain; charset=utf-8", "text/html; charset=utf-8", "https://example.com/join?token=3Dabc"} {
		if !strings.Contains(msg, want) {
			t.Errorf("message lacks %q:\n%s", want, msg)
		}
	}
	if strings.Contains(msg, "\r\nBcc:") {
		t.Error("a header was injected through the subject")
	}
}

func TestBuildRefusesBadRecipients(t *testing.T) {
	from, _ := mail.ParseAddress("sm@example.com")
	for _, to := range []string{"", "not an address", "a@example.com\r\nBcc: b@example.com"} {
		if _, _, err := Build(from, Message{To: []string{to}, Subject: "x", Text: "x"}, time.Now()); err == nil {
			t.Errorf("%q was accepted", to)
		}
	}
}

func TestStartTLSRequired(t *testing.T) {
	port, _ := fakeServer(t)
	s, _ := New(config.Email{SMTPHost: "127.0.0.1", SMTPPort: port, Security: "starttls", From: "sm@example.com", Timeout: 5 * time.Second})
	if err := s.Send(context.Background(), Message{To: []string{"ann@example.com"}, Subject: "x", Text: "x"}); err == nil || !strings.Contains(err.Error(), "STARTTLS") {
		t.Fatalf("err = %v", err)
	}
}
