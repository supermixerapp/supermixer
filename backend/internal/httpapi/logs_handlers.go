package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"supermixer/internal/api"
	"supermixer/internal/rbac"
	"supermixer/internal/stack"
)

// Self-hosted Logflare keeps its data, logs included, in this database of the
// stack's Postgres, under the _analytics schema: one log_events_<token> table
// per source.
const analyticsDatabase = "_supabase"

// logSources maps our names to the Logflare sources self-hosted Supabase's
// Vector config sends to (volumes/logs/vector.yml).
var logSources = map[api.LogSource]string{
	api.LogSourceApiGateway: "cloudflare.logs.prod",
	api.LogSourceAuth:       "gotrue.logs.prod",
	api.LogSourcePostgres:   "postgres.logs",
	api.LogSourcePostgrest:  "postgREST.logs.prod",
	api.LogSourcePooler:     "pgbouncer.logs.prod",
	api.LogSourceStorage:    "storage.logs.prod.2",
	api.LogSourceRealtime:   "realtime.logs.prod",
	api.LogSourceFunctions:  "deno-relay-logs",
}

var logTableToken = regexp.MustCompile(`^[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}$`)

// errNoAnalytics means the stack doesn't run log analytics (no _supabase
// database, no _analytics schema, or no such source yet).
var errNoAnalytics = errors.New("log analytics isn't running on this stack")

// analyticsQuery runs one fixed statement on the stack's _supabase database
// in a read-only transaction. Callers build the SQL; only parameters vary.
func (h *handlers) analyticsQuery(ctx context.Context, a *projectAccess, sql string, params ...*string) (stack.Result, error) {
	conn, err := h.connection(a.Project())
	if err != nil {
		return stack.Result{}, err
	}
	db := conn.Database
	db.Name = analyticsDatabase
	if params == nil {
		params = []*string{}
	}
	res, err := h.pools.Query(ctx, a.Project().Ref+stack.AnalyticsPoolSuffix, db, sql, stack.QueryOptions{
		ReadOnly: true, Params: params, MaxRows: maxQueryRows, Timeout: h.deps.Config.Projects.QueryTimeout,
	})
	var qe *stack.QueryError
	var pe *pgconn.PgError
	switch {
	case errors.As(err, &pe) && pe.Code == "3D000":
		return stack.Result{}, errNoAnalytics // refused at connect: no _supabase database
	case errors.As(err, &qe) && (qe.Code == "3D000" || qe.Code == "3F000" || qe.Code == "42P01"):
		return stack.Result{}, errNoAnalytics // no database, schema or table
	case errors.As(err, &qe) && qe.Code == "42501":
		// Logflare creates its tables as supabase_admin; the registered
		// user may not be allowed to read them.
		return stack.Result{}, newError(http.StatusBadGateway,
			"the project's database user %q can't read the logs Logflare keeps in the _supabase database (%s). Grant it USAGE on schema _analytics and SELECT on its tables, or register the project with the postgres user",
			db.User, qe.Message)
	case errors.As(err, &qe):
		return stack.Result{}, newError(http.StatusBadGateway, "reading logs failed: %s", qe.Message)
	case err != nil:
		return stack.Result{}, newError(http.StatusBadGateway, "could not reach the project's database: %s", stack.Describe(err))
	case len(res) == 0:
		return stack.Result{}, errors.New("no result")
	}
	return res[len(res)-1], nil
}

// logTable finds a source's table, e.g. _analytics.log_events_6b1f…
func (h *handlers) logTable(ctx context.Context, a *projectAccess, source string) (string, error) {
	res, err := h.analyticsQuery(ctx, a, `select replace(token::text, '-', '_') from _analytics.sources where name = $1`, &source)
	if err != nil {
		return "", err
	}
	if len(res.Rows) == 0 {
		return "", errNoAnalytics
	}
	token, _ := res.Rows[0][0].(string)
	if !logTableToken.MatchString(token) {
		return "", fmt.Errorf("unexpected Logflare source token %q", token)
	}
	return `_analytics."log_events_` + token + `"`, nil
}

func (h *handlers) ListLogs(ctx context.Context, req api.ListLogsRequestObject) (api.ListLogsResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectDataRead, "view this project's logs")
	if err != nil {
		return nil, err
	}
	source, ok := logSources[req.Params.Source]
	if !ok {
		return nil, badRequest("unknown log source")
	}
	limit := 100
	if req.Params.Limit != nil {
		if *req.Params.Limit < 1 || *req.Params.Limit > 500 {
			return nil, badRequest("limit must be between 1 and 500")
		}
		limit = *req.Params.Limit
	}
	var since, before, beforeID, pattern *string
	if req.Params.BeforeId != nil {
		if req.Params.Before == nil {
			return nil, badRequest("before_id needs before")
		}
		beforeID = req.Params.BeforeId
	}
	if req.Params.Since != nil {
		v := req.Params.Since.UTC().Format(time.RFC3339Nano)
		since = &v
	}
	if req.Params.Before != nil {
		v := req.Params.Before.UTC().Format(time.RFC3339Nano)
		before = &v
	}
	if req.Params.Search != nil && strings.TrimSpace(*req.Params.Search) != "" {
		if len(*req.Params.Search) > 200 {
			return nil, badRequest("search is limited to 200 characters")
		}
		// Every word must appear, in any order.
		words := strings.Fields(*req.Params.Search)
		if len(words) > 10 {
			return nil, badRequest("search for at most 10 words")
		}
		patterns := make([]string, len(words))
		for i, w := range words {
			patterns[i] = "%" + likeEscaper.Replace(w) + "%"
		}
		raw, _ := json.Marshal(patterns)
		v := string(raw)
		pattern = &v
	}
	table, err := h.logTable(ctx, a, source)
	if errors.Is(err, errNoAnalytics) {
		return api.ListLogs200JSONResponse{Available: false, Entries: []api.LogEntry{}}, nil
	}
	if err != nil {
		return nil, err
	}
	// The timestamp column holds UTC without a zone.
	res, err := h.analyticsQuery(ctx, a, fmt.Sprintf(`
select id::text, to_json(timestamp at time zone 'UTC') as ts, event_message, coalesce(body->'metadata', '{}'::jsonb) as metadata
from %s
where ($1::text is null or timestamp >= ($1::timestamptz at time zone 'UTC'))
  and ($2::text is null or ($4::text is null and timestamp < ($2::timestamptz at time zone 'UTC'))
       or (timestamp, id::text) < (($2::timestamptz at time zone 'UTC'), $4::text))
  and ($3::text is null or event_message ilike all (array(select json_array_elements_text($3::json))))
order by timestamp desc, id::text desc limit %d`, table, limit), since, before, pattern, beforeID)
	if errors.Is(err, errNoAnalytics) {
		return api.ListLogs200JSONResponse{Available: false, Entries: []api.LogEntry{}}, nil
	}
	if err != nil {
		return nil, err
	}
	out := api.ListLogs200JSONResponse{Available: true, Entries: make([]api.LogEntry, 0, len(res.Rows))}
	for _, row := range res.Rows {
		e := api.LogEntry{Metadata: map[string]any{}}
		e.Id, _ = row[0].(string)
		if raw, ok := row[1].(json.RawMessage); ok {
			_ = json.Unmarshal(raw, &e.Timestamp)
		}
		e.Message, _ = row[2].(string)
		if raw, ok := row[3].(json.RawMessage); ok {
			_ = json.Unmarshal(raw, &e.Metadata)
		}
		out.Entries = append(out.Entries, e)
	}
	return out, nil
}

var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

func (h *handlers) GetRequestStats(ctx context.Context, req api.GetRequestStatsRequestObject) (api.GetRequestStatsResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectDataRead, "view this project's logs")
	if err != nil {
		return nil, err
	}
	empty := api.GetRequestStats200JSONResponse{Hours: []struct {
		Count  int64     `json:"count"`
		Errors int64     `json:"errors"`
		Hour   time.Time `json:"hour"`
	}{}, Statuses: []struct {
		Count  int64 `json:"count"`
		Status int   `json:"status"`
	}{}, Paths: []struct {
		Count  int64  `json:"count"`
		Errors int64  `json:"errors"`
		Method string `json:"method"`
		Path   string `json:"path"`
	}{}}
	table, err := h.logTable(ctx, a, logSources[api.LogSourceApiGateway])
	if errors.Is(err, errNoAnalytics) {
		return empty, nil
	}
	if err != nil {
		return nil, err
	}
	since := req.Params.Since.UTC().Format(time.RFC3339Nano)
	// One statement: the three groupings as JSON.
	res, err := h.analyticsQuery(ctx, a, fmt.Sprintf(`
with r as (
  select date_trunc('hour', timestamp) as hour,
    coalesce((body #>> '{metadata,response,status_code}')::int, 0) as status,
    coalesce(body #>> '{metadata,request,method}', '') as method,
    coalesce(split_part(body #>> '{metadata,request,path}', '?', 1), '') as path
  from %s where timestamp >= ($1::timestamptz at time zone 'UTC')
)
select
  (select count(*) from r)::text as total,
  coalesce((select json_agg(json_build_object('hour', to_json(hour at time zone 'UTC'), 'count', n, 'errors', e) order by hour)
            from (select hour, count(*) as n, count(*) filter (where status >= 400) as e from r group by hour) h), '[]') as hours,
  coalesce((select json_agg(json_build_object('status', status, 'count', n) order by n desc)
            from (select status, count(*) as n from r group by status) s), '[]') as statuses,
  coalesce((select json_agg(json_build_object('method', method, 'path', path, 'count', n, 'errors', e) order by n desc)
            from (select method, path, count(*) as n, count(*) filter (where status >= 400) as e from r group by 1, 2 order by 3 desc limit 20) p), '[]') as paths`, table), &since)
	if errors.Is(err, errNoAnalytics) {
		return empty, nil
	}
	if err != nil {
		return nil, err
	}
	if len(res.Rows) != 1 {
		return nil, errors.New("request stats: no row")
	}
	row := res.Rows[0]
	out := empty
	out.Available = true
	if s, ok := row[0].(string); ok {
		_, _ = fmt.Sscan(s, &out.Total)
	}
	for i, dst := range []any{&out.Hours, &out.Statuses, &out.Paths} {
		if raw, ok := row[i+1].(json.RawMessage); ok {
			if err := json.Unmarshal(raw, dst); err != nil {
				return nil, fmt.Errorf("request stats: %w", err)
			}
		}
	}
	return out, nil
}
