package httpapi

import (
	"bytes"
	"errors"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// defaultThemePlaceholder in web/index.html is replaced with
// SUPERMIXER_DEFAULT_THEME so the first paint uses the right theme.
const defaultThemePlaceholder = "%SM_DEFAULT_THEME%"

const notBuiltPage = `<!doctype html><html><head><meta charset="utf-8"><title>Supermixer</title></head>
<body style="font-family:system-ui;background:#121212;color:#fafafa;padding:3rem">
<h1 style="font-weight:500">Supermixer API is running</h1>
<p>The web UI has not been built into this binary. For development, run <code>make dev</code>
and open the Vite server (http://localhost:5173). For a release build, run <code>make build</code>.</p>
</body></html>`

// spaHandler serves the built React app: real files directly, any other
// non-API path as index.html so client-side routes work on reload.
type spaHandler struct {
	files fs.FS
	index []byte // nil when the UI is not built
}

func newSPAHandler(files fs.FS, defaultTheme string) *spaHandler {
	h := &spaHandler{files: files}
	if files == nil {
		return h
	}
	if raw, err := fs.ReadFile(files, "index.html"); err == nil {
		h.index = bytes.ReplaceAll(raw, []byte(defaultThemePlaceholder), []byte(defaultTheme))
	}
	return h
}

func (h *spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if h.index == nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(notBuiltPage))
		return
	}

	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name != "" && name != "index.html" {
		if f, err := h.files.Open(name); err == nil {
			stat, statErr := f.Stat()
			_ = f.Close()
			if statErr == nil && !stat.IsDir() {
				if strings.HasPrefix(name, "assets/") {
					// Vite fingerprints everything under assets/.
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				http.ServeFileFS(w, r, h.files, name)
				return
			}
		} else if !errors.Is(err, fs.ErrNotExist) {
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}
		// A missing build asset is a real 404. Anything else is a client-side
		// route, even if it contains a dot (e.g. /org/acme.io).
		if strings.HasPrefix(name, "assets/") {
			http.NotFound(w, r)
			return
		}
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(h.index)
}
