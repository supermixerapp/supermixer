// Package webui embeds the built React app (web/ → `pnpm build`), which Vite
// writes into ./dist. The directory always contains .gitkeep so the backend
// compiles before the frontend has been built.
package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var embedded embed.FS

// FS returns the contents of dist/.
func FS() fs.FS {
	sub, err := fs.Sub(embedded, "dist")
	if err != nil {
		panic(err) // dist is embedded at compile time; this cannot fail
	}
	return sub
}
