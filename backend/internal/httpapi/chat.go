package httpapi

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"unicode/utf8"
)

// Chat notifications: an organization webhook whose kind is a chat app posts
// each event as a readable message to that app's incoming webhook. Names in
// a message come from people (project names, usernames, invited addresses),
// so each app's renderer escapes them: nothing typed into Supermixer can
// mention @channel or add a link, and only in Google Chat (which has no
// escapes) can * _ ~ in a name change its formatting.

const (
	kindWebhook    = "webhook"
	kindSlack      = "slack"
	kindTeams      = "teams"
	kindDiscord    = "discord"
	kindGoogleChat = "google_chat"
	kindMattermost = "mattermost"
)

func isChatKind(k string) bool {
	switch k {
	case kindSlack, kindTeams, kindDiscord, kindGoogleChat, kindMattermost:
		return true
	}
	return false
}

// chatDisplayURL is what's kept (and shown) of a chat app's incoming webhook
// address: its scheme and host. The rest of it is the credential.
func chatDisplayURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "(chat channel)"
	}
	return u.Scheme + "://" + u.Host
}

// chatBareHost reports whether a URL is only a scheme and host: what's shown
// of a chat channel's address, never an incoming webhook itself.
func chatBareHost(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Path == "" || u.Path == "/") && u.RawQuery == ""
}

// chatAddressCheck refuses a chat address that can't be an incoming webhook.
func chatAddressCheck(raw string) error {
	if chatBareHost(raw) {
		return badRequest("paste the chat app's whole incoming webhook URL, not only its host")
	}
	return nil
}

// chatPart is a run of a message's text.
type chatPart struct {
	Text   string
	Strong bool
}

// chatMessage is an event, in words.
type chatMessage struct {
	Parts    []chatPart // the sentence
	Detail   string     // a second line, such as an error, shown as code
	Org      string     // the organization's name
	Link     string     // where to look in Supermixer
	Problem  bool       // something failed
	Fallback string     // the plain sentence, for notifications' previews
}

// chatPhrases says each event in words: {actor} is who did it, {target} its
// target (usually the project), {role} a database role, and {state} on or
// off, {backup} the kind of backup ("scheduled "), {hook} webhook or chat
// channel. Events not here get a generic sentence.
var chatPhrases = map[string]string{
	"invitation.created": "{actor} invited {target} to the organization",
	"invitation.revoked": "{actor} revoked the invitation for {target}",
	"member.joined":      "{target} joined the organization",
	"member.left":        "{target} left the organization",
	"member.removed":     "{actor} removed {target} from the organization",
	"member.updated":     "{actor} changed {target}'s role",

	"organization.created":        "{actor} created the organization {target}",
	"organization.updated":        "{actor} changed the organization's settings",
	"organization.deleted":        "{actor} deleted the organization {target}",
	"organization.limits_updated": "{actor} changed the organization's resource limits",
	"organization.sso_updated":    "{actor} changed the organization's single sign-on settings",

	"project.created":                   "{actor} created project {target}",
	"project.updated":                   "{actor} changed project {target}'s settings",
	"project.deleted":                   "{actor} deleted project {target}",
	"project.transferred_in":            "{actor} moved project {target} into this organization",
	"project.transferred_out":           "{actor} moved project {target} to another organization",
	"project.stack_started":             "{actor} started project {target}",
	"project.stack_stopped":             "{actor} stopped project {target}",
	"project.stack_restarted":           "{actor} restarted project {target}",
	"project.upgraded":                  "{actor} upgraded project {target}",
	"project.restored":                  "{actor} restored a backup of project {target}",
	"project.backup_created":            "{actor} backed up project {target}",
	"project.backup_deleted":            "{actor} deleted a backup of project {target}",
	"project.backup_downloaded":         "{actor} downloaded a backup of project {target}",
	"project.keys_rotated":              "{actor} rotated keys of project {target}",
	"project.secrets_revealed":          "{actor} viewed secrets of project {target}",
	"project.rotation_advice_dismissed": "{actor} dismissed the key rotation advice for project {target}",
	"project.snapshot_taken":            "{actor} took an Advisors snapshot of project {target}",
	"project.function_deployed":         "{actor} deployed an Edge Function to project {target}",
	"project.function_deleted":          "{actor} deleted an Edge Function from project {target}",
	"project.function_restored":         "{actor} restored an earlier Edge Function version in project {target}",
	"project.function_invoked":          "{actor} sent a test request to an Edge Function in project {target}",
	"project.function_secrets_set":      "{actor} set Edge Function secrets in project {target}",
	"project.function_secrets_deleted":  "{actor} deleted Edge Function secrets in project {target}",
	"project.function_settings_updated": "{actor} changed Edge Function settings in project {target}",
	"project.auth_changed":              "{actor} changed Authentication settings of project {target}",
	"project.auth_config_updated":       "{actor} changed Authentication settings of project {target}",
	"project.storage_changed":           "{actor} changed Storage settings of project {target}",
	"project.storage_config_updated":    "{actor} changed Storage settings of project {target}",
	"project.logs_updated":              "{actor} turned logs {state} for project {target}",
	"project.log_drain_created":         "{actor} added a log drain to project {target}",
	"project.log_drain_updated":         "{actor} changed a log drain of project {target}",
	"project.log_drain_deleted":         "{actor} removed a log drain from project {target}",
	"project.database_role_created":     "{actor} created database role {role} in project {target}",
	"project.database_role_updated":     "{actor} changed database role {role} in project {target}",
	"project.database_role_dropped":     "{actor} dropped database role {role} in project {target}",
	"project.read_only_user_created":    "{actor} created the read-only database login of project {target}",
	"project.read_only_user_removed":    "{actor} removed the read-only database login of project {target}",
	"project.backup_failed":             "A {backup}backup of project {target} failed",
	"project.operation_failed":          "{operation} project {target} failed",

	"webhook.created":        "{actor} added {hook} {target}",
	"webhook.updated":        "{actor} changed {hook} {target}",
	"webhook.deleted":        "{actor} deleted {hook} {target}",
	"webhook.secret_rotated": "{actor} replaced the signing secret of webhook {target}",
	"webhook.test":           "{actor} sent a test message: this channel gets the organization's notifications",
}

// operationWords names a stack operation at the start of a sentence.
var operationWords = map[string]string{
	"backing_up":    "Backing up",
	"deleting":      "Deleting",
	"restarting":    "Restarting",
	"restoring":     "Restoring",
	"rotating_keys": "Rotating keys of",
	"starting":      "Starting",
	"stopping":      "Stopping",
	"updating":      "Updating",
	"upgrading":     "Upgrading",
}

// toChatMessage says an event in words. publicURL is where people reach
// Supermixer; orgName the organization's name.
func toChatMessage(ev webhookEvent, orgName, publicURL string) chatMessage {
	meta := map[string]any{}
	_ = json.Unmarshal(ev.Data, &meta)
	str := func(k string) string {
		s, _ := meta[k].(string)
		return s
	}
	actor := "Supermixer"
	if ev.Actor != nil && ev.Actor.Username != "" {
		actor = ev.Actor.Username
	}
	target := ev.Target.Name
	if ev.Target.Type == "webhook" {
		// A webhook's path can be its credential (Zapier, for one), and a
		// channel reaches more people than the audit log: the host only.
		target = chatDisplayURL(target)
	}
	vars := map[string]chatPart{
		"actor":  {Text: actor, Strong: true},
		"target": {Text: target, Strong: true},
		"role":   {Text: str("role"), Strong: true},
		"hook":   {Text: "webhook"},
		"state":  {Text: "off"},
		"backup": {},
	}
	if on, _ := meta["enabled"].(bool); on {
		vars["state"] = chatPart{Text: "on"}
	}
	if isChatKind(str("kind")) {
		vars["hook"] = chatPart{Text: "chat channel"}
	}
	switch str("backup_kind") {
	case "manual":
		vars["backup"] = chatPart{Text: "manual "}
	case "scheduled":
		vars["backup"] = chatPart{Text: "scheduled "}
	}
	op := str("operation")
	vars["operation"] = chatPart{Text: operationWords[op]}
	if vars["operation"].Text == "" {
		vars["operation"] = chatPart{Text: "An operation on"}
	}

	m := chatMessage{Org: orgName, Detail: str("error")}
	phrase, ok := chatPhrases[ev.Type]
	switch {
	case ev.Type == "project.operation_failed" && meta["recovered"] == true:
		phrase = "{operation} project {target} didn't complete; the project is as it was before"
	case !ok:
		phrase = "{actor}: " + ev.Type
		if ev.Target.Name != "" {
			phrase += " ({target})"
		}
	}
	m.Problem = strings.HasSuffix(ev.Type, "_failed")
	m.Parts = fillPhrase(phrase, vars)
	var plain strings.Builder
	for _, p := range m.Parts {
		plain.WriteString(p.Text)
	}
	m.Fallback = plain.String()

	base := strings.TrimRight(publicURL, "/")
	switch {
	case ev.Project != nil && ev.Type != "project.deleted" && ev.Type != "project.transferred_out":
		m.Link = base + "/project/" + url.PathEscape(*ev.Project)
	case ev.Organization != "":
		m.Link = base + "/org/" + url.PathEscape(ev.Organization) + "/audit"
	}
	return m
}

// fillPhrase splits a phrase into runs, replacing {name}s.
func fillPhrase(phrase string, vars map[string]chatPart) []chatPart {
	var out []chatPart
	for phrase != "" {
		i := strings.IndexByte(phrase, '{')
		j := -1
		if i >= 0 {
			j = strings.IndexByte(phrase[i:], '}')
		}
		if i < 0 || j < 0 {
			out = append(out, chatPart{Text: phrase})
			break
		}
		if i > 0 {
			out = append(out, chatPart{Text: phrase[:i]})
		}
		name := phrase[i+1 : i+j]
		if v, ok := vars[name]; ok {
			v.Text = clip(v.Text, 200)
			out = append(out, v)
		} else {
			out = append(out, chatPart{Text: phrase[i : i+j+1]})
		}
		phrase = phrase[i+j+1:]
	}
	return out
}

// clip shortens s to at most n characters.
func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n-1]) + "…"
}

// chatBody is the JSON a chat app's incoming webhook takes.
func chatBody(kind string, m chatMessage) ([]byte, error) {
	detail := clip(strings.Join(strings.Fields(m.Detail), " "), 500)
	switch kind {
	case kindSlack:
		// Block Kit rich text: its text elements are taken literally (no
		// mrkdwn, so no formatting or mentions from names), bold by style.
		var runs []map[string]any
		if m.Problem {
			runs = append(runs, map[string]any{"type": "emoji", "name": "warning"}, map[string]any{"type": "text", "text": " "})
		}
		for _, p := range m.Parts {
			if p.Text == "" {
				continue
			}
			run := map[string]any{"type": "text", "text": p.Text}
			if p.Strong {
				run["style"] = map[string]any{"bold": true}
			}
			runs = append(runs, run)
		}
		elements := []map[string]any{{"type": "rich_text_section", "elements": runs}}
		if detail != "" {
			elements = append(elements, map[string]any{"type": "rich_text_preformatted",
				"elements": []map[string]any{{"type": "text", "text": detail}}})
		}
		footer := []map[string]any{{"type": "text", "text": m.Org}}
		if m.Link != "" {
			footer = append(footer, map[string]any{"type": "text", "text": " · "},
				map[string]any{"type": "link", "url": m.Link, "text": "Open in Supermixer"})
		}
		elements = append(elements, map[string]any{"type": "rich_text_section", "elements": footer})
		return json.Marshal(map[string]any{
			// For notifications; Slack shows the blocks.
			"text":         slackEscape(m.Fallback),
			"blocks":       []map[string]any{{"type": "rich_text", "elements": elements}},
			"unfurl_links": false,
			"unfurl_media": false,
		})
	case kindGoogleChat:
		// Google Chat's text formatting: *bold*, <url|text>, <users/…>
		// mentions. It has no escapes, so < and > in names become look-alikes
		// (no mentions or links); * _ ~ in a name can still restyle it.
		var b strings.Builder
		if m.Problem {
			b.WriteString("⚠️ ")
		}
		for _, p := range m.Parts {
			if p.Strong {
				b.WriteString("*" + chatAngles(p.Text) + "*")
			} else {
				b.WriteString(chatAngles(p.Text))
			}
		}
		if detail != "" {
			b.WriteString("\n`" + chatAngles(strings.ReplaceAll(detail, "`", "'")) + "`")
		}
		b.WriteString("\n" + chatAngles(m.Org))
		if m.Link != "" {
			b.WriteString(" · <" + m.Link + "|Open in Supermixer>")
		}
		return json.Marshal(map[string]any{"text": b.String()})
	case kindDiscord, kindMattermost:
		var b strings.Builder
		if m.Problem {
			b.WriteString("⚠️ ")
		}
		for _, p := range m.Parts {
			if p.Strong {
				b.WriteString("**" + markdownEscape(p.Text) + "**")
			} else {
				b.WriteString(markdownEscape(p.Text))
			}
		}
		if detail != "" {
			b.WriteString("\n`" + noMentions(strings.ReplaceAll(detail, "`", "'")) + "`")
		}
		b.WriteString("\n" + markdownEscape(m.Org))
		if m.Link != "" {
			b.WriteString(" · [Open in Supermixer](" + m.Link + ")")
		}
		if kind == kindDiscord {
			// No pings, whatever the text says.
			return json.Marshal(map[string]any{"content": clip(b.String(), 2000), "allowed_mentions": map[string]any{"parse": []string{}}})
		}
		return json.Marshal(map[string]any{"text": b.String()})
	case kindTeams:
		// A Teams workflow ("When a Teams webhook request is received")
		// takes an Adaptive Card. TextRuns aren't Markdown, so nothing needs
		// escaping.
		var inlines []map[string]any
		if m.Problem {
			inlines = append(inlines, map[string]any{"type": "TextRun", "text": "⚠️ ", "color": "attention"})
		}
		for _, p := range m.Parts {
			run := map[string]any{"type": "TextRun", "text": p.Text}
			if p.Strong {
				run["weight"] = "bolder"
			}
			inlines = append(inlines, run)
		}
		body := []map[string]any{{"type": "RichTextBlock", "inlines": inlines}}
		if detail != "" {
			body = append(body, map[string]any{"type": "RichTextBlock", "inlines": []map[string]any{
				{"type": "TextRun", "text": detail, "fontType": "monospace", "size": "small"},
			}})
		}
		body = append(body, map[string]any{"type": "RichTextBlock", "inlines": []map[string]any{
			{"type": "TextRun", "text": m.Org, "isSubtle": true, "size": "small"},
		}})
		card := map[string]any{
			"$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
			"type":    "AdaptiveCard",
			"version": "1.4",
			"body":    body,
		}
		if m.Link != "" {
			card["actions"] = []map[string]any{{"type": "Action.OpenUrl", "title": "Open in Supermixer", "url": m.Link}}
		}
		return json.Marshal(map[string]any{
			"type": "message",
			"text": m.Fallback,
			"attachments": []map[string]any{{
				"contentType": "application/vnd.microsoft.card.adaptive",
				"content":     card,
			}},
		})
	}
	return nil, fmt.Errorf("unknown chat app %q", kind)
}

var slackEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")

// slackEscape is for Slack's top-level text, which it reads as mrkdwn.
func slackEscape(s string) string { return slackEscaper.Replace(s) }

var angleReplacer = strings.NewReplacer("<", "‹", ">", "›")

// chatAngles swaps < and > for look-alikes, for Google Chat, where they
// start links and mentions and can't be escaped.
func chatAngles(s string) string { return angleReplacer.Replace(s) }

// markdownEscape backslash-escapes Markdown's punctuation (CommonMark and
// Discord both drop a backslash before any punctuation) and breaks up
// mentions.
func markdownEscape(s string) string {
	var b strings.Builder
	for _, r := range s {
		if strings.ContainsRune("\\`*_~|>#[](){}<!-+.=:", r) {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return noMentions(b.String())
}

// noMentions puts a zero-width space after each @, so "@channel" or
// "@all" in a name doesn't notify anyone (Mattermost mentions by text).
func noMentions(s string) string { return strings.ReplaceAll(s, "@", "@​") }
