package httpapi

import "sync"

// wakeup tells whoever subscribed that something happened (a new audit log
// entry), without blocking and without queuing: one pending wake-up each.
type wakeup struct {
	mu   sync.Mutex
	subs map[chan struct{}]bool
}

// subscribe returns a channel woken on each notify, and a function to stop.
func (w *wakeup) subscribe() (<-chan struct{}, func()) {
	c := make(chan struct{}, 1)
	w.mu.Lock()
	if w.subs == nil {
		w.subs = map[chan struct{}]bool{}
	}
	w.subs[c] = true
	w.mu.Unlock()
	return c, func() {
		w.mu.Lock()
		delete(w.subs, c)
		w.mu.Unlock()
	}
}

func (w *wakeup) notify() {
	w.mu.Lock()
	defer w.mu.Unlock()
	for c := range w.subs {
		select {
		case c <- struct{}{}:
		default:
		}
	}
}
