package provision

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// Each stack gets its own Docker network, and Docker carves each one out of
// its default address pools. Out of the box those hold about 30 networks
// (172.17–31.0.0/16 and 192.168.0.0/16 in /20s), so a server runs out of
// networks long before it runs out of memory. Docker's default-address-pools
// setting (daemon.json) makes room for more.

// ErrNoNetworkRoom is Docker having no address space left for another network.
var ErrNoNetworkRoom = errors.New("no address space left for another Docker network, as Docker's address pools are used up; " +
	"whoever runs this server can give it more with the default-address-pools setting in Docker's daemon.json")

// What Docker says when its address pools are used up.
var poolExhausted = regexp.MustCompile(`(?i)could not find an available, non-overlapping IPv4 address pool|all predefined address pools have been fully subnetted`)

// PoolExhausted reports whether Docker's output says its address pools are used up.
func PoolExhausted(output string) bool { return poolExhausted.MatchString(output) }

// checkLabel marks the throwaway networks CheckNetworkRoom makes.
const checkLabel = "supermixer.network-check"

// CheckNetworkRoom makes sure Docker can create another network, by creating
// a throwaway one and removing it. It returns ErrNoNetworkRoom when Docker's
// address pools are used up.
func CheckNetworkRoom(ctx context.Context, docker string) error {
	// Clear any left behind by an earlier check that couldn't remove its own.
	_ = exec.CommandContext(ctx, docker, "network", "prune", "--force", "--filter", "label="+checkLabel).Run()

	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return err
	}
	name := "supermixer-network-check-" + hex.EncodeToString(b)
	out, err := exec.CommandContext(ctx, docker, "network", "create", "--label", checkLabel, name).CombinedOutput()
	if err != nil {
		if PoolExhausted(string(out)) {
			return ErrNoNetworkRoom
		}
		if ctx.Err() != nil {
			return fmt.Errorf("docker network create: %w", ctx.Err())
		}
		return fmt.Errorf("docker network create: %v: %s", err, strings.TrimSpace(string(out)))
	}
	// Remove it even if ctx is done; if that fails, the next check prunes it.
	rmCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	_ = exec.CommandContext(rmCtx, docker, "network", "rm", name).Run()
	return nil
}
