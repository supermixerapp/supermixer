package httpapi

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5/pgconn"
)

// apiError is returned by handlers to produce a specific status and message.
// Any other error becomes a logged 500.
type apiError struct {
	status  int
	message string
	// code, if set, tells clients what to do (see the Error schema).
	code string
}

func (e *apiError) Error() string { return e.message }

func newError(status int, format string, args ...any) error {
	return &apiError{status: status, message: fmt.Sprintf(format, args...)}
}

func badRequest(format string, args ...any) error {
	return newError(http.StatusBadRequest, format, args...)
}
func notFound(what string) error { return newError(http.StatusNotFound, "%s not found", what) }
func conflict(format string, args ...any) error {
	return newError(http.StatusConflict, format, args...)
}

// forbidden uses Studio's wording for missing permissions.
func forbidden(action string) error {
	return newError(http.StatusForbidden, "You need additional permissions to %s", action)
}

var errUnauthorized = &apiError{status: http.StatusUnauthorized, message: "sign in to continue"}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// errorStatus maps an error to a status, error code and client-safe message.
func errorStatus(err error) (int, string, string, bool) {
	var ae *apiError
	if errors.As(err, &ae) {
		return ae.status, ae.code, ae.message, true
	}
	return http.StatusInternalServerError, "", "internal server error", false
}
