package auth

import (
	"sync"
	"time"
)

// Limiter is a fixed-window counter for failed sign-ins, keyed by
// client IP and by username, so neither can be brute-forced quickly.
type Limiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	hits   map[string]*window
	now    func() time.Time
}

type window struct {
	start time.Time
	count int
}

// NewLimiter allows max failures per key per window.
func NewLimiter(max int, w time.Duration) *Limiter {
	return &Limiter{max: max, window: w, hits: map[string]*window{}, now: time.Now}
}

// Blocked reports whether key has used up its failures, and when it resets.
func (l *Limiter) Blocked(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	w, ok := l.hits[key]
	if !ok {
		return false, 0
	}
	elapsed := l.now().Sub(w.start)
	if elapsed >= l.window {
		delete(l.hits, key)
		return false, 0
	}
	return w.count >= l.max, l.window - elapsed
}

// Fail records a failure for key.
func (l *Limiter) Fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	w, ok := l.hits[key]
	if !ok || now.Sub(w.start) >= l.window {
		l.hits[key] = &window{start: now, count: 1}
		// Opportunistic cleanup keeps the map bounded.
		if len(l.hits) > 10000 {
			for k, v := range l.hits {
				if now.Sub(v.start) >= l.window {
					delete(l.hits, k)
				}
			}
		}
		return
	}
	w.count++
}

// Reset clears key after a successful sign-in.
func (l *Limiter) Reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.hits, key)
}
