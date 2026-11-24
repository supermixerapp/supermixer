package httpapi

import (
	"context"
	"time"

	"supermixer/internal/metrics"
	"supermixer/internal/store"
)

// MetricsState reads what /metrics reports from the database, at each
// scrape.
func MetricsState(st *store.Store) metrics.StateFunc {
	return func(ctx context.Context) (metrics.State, error) {
		q := st.Queries
		c, err := q.InstanceCounts(ctx)
		if err != nil {
			return metrics.State{}, err
		}
		s := metrics.State{Users: int(c.Users), ActiveUsers: int(c.ActiveUsers), Organizations: int(c.Organizations),
			Projects: int(c.Projects), Stacks: map[string]int{}, LastBackup: map[string]time.Time{}, FailedBackups: map[string]int{}}
		stacks, err := q.StacksByStatus(ctx)
		if err != nil {
			return s, err
		}
		for _, r := range stacks {
			s.Stacks[r.Status] = int(r.N)
		}
		last, err := q.LastCompletedBackups(ctx)
		if err != nil {
			return s, err
		}
		for _, r := range last {
			s.LastBackup[r.Ref] = r.FinishedAt
		}
		failed, err := q.FailedBackupsLastDay(ctx)
		if err != nil {
			return s, err
		}
		for _, r := range failed {
			s.FailedBackups[r.Ref] = int(r.N)
		}
		return s, nil
	}
}
