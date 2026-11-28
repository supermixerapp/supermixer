package main

import (
	"flag"
	"fmt"

	"supermixer/internal/datadir"
)

// runInit prepares the data folder for the container install: run once as
// root before Supermixer and its database start (see
// deploy/production/compose.yml).
func runInit(args []string) error {
	fs := flag.NewFlagSet("init", flag.ContinueOnError)
	var o datadir.Options
	fs.StringVar(&o.Dir, "dir", "/var/lib/supermixer", "the data folder")
	fs.IntVar(&o.UID, "uid", 65532, "the user Supermixer runs as")
	fs.IntVar(&o.GID, "gid", 65532, "its group")
	fs.IntVar(&o.PostgresUID, "postgres-uid", 70, "the database container's user")
	fs.IntVar(&o.PostgresGID, "postgres-gid", 70, "its group")
	if err := fs.Parse(args); err != nil {
		return err
	}
	r, err := datadir.Prepare(o)
	if err != nil {
		return err
	}
	for _, p := range r.Created {
		fmt.Println("created", p)
	}
	if len(r.Created) == 0 {
		fmt.Println(o.Dir, "is ready")
	}
	return nil
}
