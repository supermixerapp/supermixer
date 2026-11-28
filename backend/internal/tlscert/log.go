package tlscert

import (
	"context"
	"log/slog"
	"net"
	"slices"
	"sort"
	"strconv"

	"go.uber.org/zap/zapcore"
)

// slogCore sends certmagic's zap logs to Supermixer's slog logger.
type slogCore struct {
	l      *slog.Logger
	fields []zapcore.Field
}

func level(l zapcore.Level) slog.Level {
	switch {
	case l >= zapcore.ErrorLevel:
		return slog.LevelError
	case l == zapcore.WarnLevel:
		return slog.LevelWarn
	case l == zapcore.InfoLevel:
		return slog.LevelInfo
	default:
		return slog.LevelDebug
	}
}

func (c slogCore) Enabled(l zapcore.Level) bool {
	return c.l.Enabled(context.Background(), level(l))
}

func (c slogCore) With(f []zapcore.Field) zapcore.Core {
	return slogCore{l: c.l, fields: append(slices.Clip(c.fields), f...)}
}

func (c slogCore) Check(e zapcore.Entry, ce *zapcore.CheckedEntry) *zapcore.CheckedEntry {
	if c.Enabled(e.Level) {
		return ce.AddCore(e, c)
	}
	return ce
}

func (c slogCore) Write(e zapcore.Entry, fields []zapcore.Field) error {
	enc := zapcore.NewMapObjectEncoder()
	for _, f := range append(slices.Clip(c.fields), fields...) {
		f.AddTo(enc)
	}
	keys := make([]string, 0, len(enc.Fields))
	for k := range enc.Fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	attrs := make([]any, 0, 2*len(keys)+2)
	if e.LoggerName != "" {
		attrs = append(attrs, "certmagic", e.LoggerName)
	}
	for _, k := range keys {
		attrs = append(attrs, k, enc.Fields[k])
	}
	c.l.Log(context.Background(), level(e.Level), e.Message, attrs...)
	return nil
}

func (c slogCore) Sync() error { return nil }

// hostPort splits a listen address; a missing or bad port is 0.
func hostPort(addr string) (string, int) {
	h, p, err := net.SplitHostPort(addr)
	if err != nil {
		return "", 0
	}
	n, _ := strconv.Atoi(p)
	return h, n
}
