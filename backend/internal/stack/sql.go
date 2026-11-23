package stack

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// QueryOptions controls one SQL run.
type QueryOptions struct {
	// ReadOnly runs a single statement in a READ ONLY transaction. Postgres
	// refuses to make the transaction writable once it has started, and the
	// extended protocol refuses multi-statement strings, so data and schema
	// cannot change. (Self-hosted stacks don't let postgres SET ROLE to
	// supabase_read_only_user, so the session role stays the same.)
	ReadOnly bool
	// Params, when set, sends the statement with the extended protocol and
	// these text parameters ($1, $2, …). Only one statement is allowed then.
	Params []*string
	// MaxRows caps the rows returned per result; more are counted but dropped.
	MaxRows int
	// Timeout is the statement_timeout; 0 means 60s.
	Timeout time.Duration
}

// Column describes one result column.
type Column struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// Result is one statement's outcome.
type Result struct {
	Command   string   `json:"command"`
	RowCount  int64    `json:"row_count"`
	Columns   []Column `json:"columns"`
	Rows      [][]any  `json:"rows"`
	Truncated bool     `json:"truncated"`
	Notices   []string `json:"notices,omitempty"`
}

// QueryError is a Postgres error with the details Studio shows.
type QueryError struct {
	Message  string `json:"message"`
	Code     string `json:"code,omitempty"`
	Detail   string `json:"detail,omitempty"`
	Hint     string `json:"hint,omitempty"`
	Position int32  `json:"position,omitempty"`
}

func (e *QueryError) Error() string { return e.Message }

// Pools keeps a small pgx pool per project. A pool is keyed by the project
// ref and a hash of its connection, so changed credentials get a new pool.
type Pools struct {
	mu    sync.Mutex
	pools map[string]*poolEntry
	size  int32
	// notices collects RAISE NOTICE output per connection while it runs a query.
	notices sync.Map // *pgconn.PgConn → *[]string
}

type poolEntry struct {
	key  string
	pool *pgxpool.Pool
}

// NewPools keeps up to size connections per project database (0 means 4).
func NewPools(size int) *Pools {
	if size <= 0 {
		size = 4
	}
	return &Pools{pools: map[string]*poolEntry{}, size: int32(size)}
}

// Close closes every pool.
func (p *Pools) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for ref, e := range p.pools {
		e.pool.Close()
		delete(p.pools, ref)
	}
}

// Forget closes a project's pool (after it is updated or removed).
func (p *Pools) Forget(ref string) {
	p.mu.Lock()
	var closing []*poolEntry
	for _, key := range []string{ref, ref + ReadOnlyPoolSuffix} {
		if e := p.pools[key]; e != nil {
			closing = append(closing, e)
			delete(p.pools, key)
		}
	}
	p.mu.Unlock()
	for _, e := range closing {
		go e.pool.Close()
	}
}

// ReadOnlyPoolSuffix keys the pool of a project's read-only login.
const ReadOnlyPoolSuffix = "#read-only"

func (p *Pools) get(ref string, d Database) (*pgxpool.Pool, error) {
	sum := sha256.Sum256([]byte(d.URI(true)))
	key := hex.EncodeToString(sum[:])
	p.mu.Lock()
	defer p.mu.Unlock()
	if e := p.pools[ref]; e != nil {
		if e.key == key {
			return e.pool, nil
		}
		go e.pool.Close()
	}
	cfg, err := pgxpool.ParseConfig(d.URI(true))
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = p.size
	cfg.MinConns = 0
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.ConnConfig.ConnectTimeout = 5 * time.Second
	cfg.ConnConfig.RuntimeParams["application_name"] = "supermixer"
	// No prepared-statement cache: connections are reset with DISCARD ALL.
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	cfg.ConnConfig.OnNotice = func(pc *pgconn.PgConn, n *pgconn.Notice) {
		if v, ok := p.notices.Load(pc); ok {
			out := v.(*[]string)
			*out = append(*out, fmt.Sprintf("%s: %s", n.Severity, n.Message))
		}
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		return nil, err
	}
	p.pools[ref] = &poolEntry{key: key, pool: pool}
	return pool, nil
}

// Query runs SQL on a project's database. Postgres errors come back as
// *QueryError; anything else is a connection problem.
func (p *Pools) Query(ctx context.Context, ref string, d Database, sql string, opt QueryOptions) ([]Result, error) {
	pool, err := p.get(ref, d)
	if err != nil {
		return nil, err
	}
	if opt.MaxRows <= 0 {
		opt.MaxRows = 1000
	}
	if opt.Timeout <= 0 {
		opt.Timeout = 60 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, opt.Timeout+5*time.Second)
	defer cancel()

	c, err := pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	// A user may leave session state behind (SET ROLE, search_path, an open
	// transaction). Reset it, or throw the connection away.
	defer func() {
		resetCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		conn := c.Conn().PgConn()
		if conn.TxStatus() != 'I' {
			_ = conn.Exec(resetCtx, "ROLLBACK").Close()
		}
		if err := conn.Exec(resetCtx, "DISCARD ALL").Close(); err != nil {
			_ = c.Hijack().Close(resetCtx)
			return
		}
		c.Release()
	}()

	conn := c.Conn().PgConn()
	var notices []string
	p.notices.Store(conn, &notices)
	defer p.notices.Delete(conn)

	timeoutMs := strconv.FormatInt(opt.Timeout.Milliseconds(), 10)
	if err := conn.Exec(ctx, "SET statement_timeout = "+timeoutMs).Close(); err != nil {
		return nil, wrapPgError(err)
	}

	tm := c.Conn().TypeMap()
	var results []Result
	if opt.ReadOnly {
		if err := conn.Exec(ctx, "BEGIN READ ONLY").Close(); err != nil {
			return nil, wrapPgError(err)
		}
		r, err := execParams(ctx, conn, tm, sql, opt)
		_ = conn.Exec(ctx, "ROLLBACK").Close()
		if err != nil {
			return nil, err
		}
		results = []Result{r}
	} else if opt.Params != nil {
		r, err := execParams(ctx, conn, tm, sql, opt)
		if err != nil {
			return nil, err
		}
		results = []Result{r}
	} else {
		mrr := conn.Exec(ctx, sql)
		for mrr.NextResult() {
			r, err := collect(mrr.ResultReader(), tm, opt.MaxRows)
			if err != nil {
				_ = mrr.Close()
				return nil, wrapPgError(err)
			}
			results = append(results, r)
		}
		if err := mrr.Close(); err != nil {
			return nil, wrapPgError(err)
		}
	}
	if len(results) > 0 {
		results[len(results)-1].Notices = notices
	}
	return results, nil
}

// execParams runs exactly one statement with the extended protocol, which
// rejects multi-statement strings such as "COMMIT; DROP TABLE x".
func execParams(ctx context.Context, conn *pgconn.PgConn, tm *pgtype.Map, sql string, opt QueryOptions) (Result, error) {
	params := make([][]byte, len(opt.Params))
	for i, v := range opt.Params {
		if v != nil {
			params[i] = []byte(*v)
		}
	}
	r, err := collect(conn.ExecParams(ctx, sql, params, nil, nil, nil), tm, opt.MaxRows)
	if err != nil {
		return Result{}, wrapPgError(err)
	}
	return r, nil
}

// collect reads a result to the end, keeping at most maxRows rows.
func collect(rr *pgconn.ResultReader, tm *pgtype.Map, maxRows int) (Result, error) {
	fields := rr.FieldDescriptions()
	r := Result{Columns: make([]Column, len(fields)), Rows: [][]any{}}
	for i, f := range fields {
		r.Columns[i] = Column{Name: f.Name, Type: typeName(tm, f.DataTypeOID)}
	}
	var n int64
	for rr.NextRow() {
		n++
		if len(r.Rows) >= maxRows {
			r.Truncated = true
			continue
		}
		vals := rr.Values()
		row := make([]any, len(vals))
		for i, v := range vals {
			row[i] = decode(v, fields[i].DataTypeOID, fields[i].Format)
		}
		r.Rows = append(r.Rows, row)
	}
	tag, err := rr.Close()
	if err != nil {
		return Result{}, err
	}
	r.Command = commandName(tag)
	r.RowCount = tag.RowsAffected()
	if r.RowCount == 0 && len(fields) > 0 {
		r.RowCount = n
	}
	return r, nil
}

func commandName(tag pgconn.CommandTag) string {
	s := tag.String()
	if i := strings.IndexByte(s, ' '); i > 0 {
		s = s[:i]
	}
	return s
}

func typeName(tm *pgtype.Map, oid uint32) string {
	if t, ok := tm.TypeForOID(oid); ok {
		return t.Name
	}
	return strconv.FormatUint(uint64(oid), 10)
}

// decode turns a text-format value into JSON-friendly Go: numbers that fit
// a float64 exactly, booleans, raw JSON; everything else stays text.
func decode(v []byte, oid uint32, format int16) any {
	if v == nil {
		return nil
	}
	if format != pgtype.TextFormatCode {
		return fmt.Sprintf("\\x%x", v)
	}
	s := string(v)
	switch oid {
	case pgtype.BoolOID:
		return s == "t"
	case pgtype.Int2OID, pgtype.Int4OID, pgtype.OIDOID:
		if n, err := strconv.ParseInt(s, 10, 64); err == nil {
			return n
		}
	case pgtype.Float4OID, pgtype.Float8OID:
		if f, err := strconv.ParseFloat(s, 64); err == nil && !isSpecialFloat(s) {
			return f
		}
	case pgtype.JSONOID, pgtype.JSONBOID:
		if json.Valid(v) {
			return json.RawMessage(v)
		}
	}
	return s
}

func isSpecialFloat(s string) bool {
	return s == "NaN" || s == "Infinity" || s == "-Infinity"
}

func wrapPgError(err error) error {
	var pe *pgconn.PgError
	if errors.As(err, &pe) {
		return &QueryError{Message: pe.Message, Code: pe.Code, Detail: pe.Detail, Hint: pe.Hint, Position: pe.Position}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &QueryError{Message: "the query took too long and was cancelled", Code: "57014"}
	}
	return err
}
