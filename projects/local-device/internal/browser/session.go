package browser

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
)

const maxSessionOperations = 10000

// Session serializes operations for one locally approved browser target. The
// caller cancels its lifetime on lease expiry, revocation, or target loss.
type Session struct {
	lifetime context.Context
	revoke   context.CancelFunc
	grantID  string
	version  int64
	execute  func(context.Context, Action) (json.RawMessage, error)

	mu            sync.Mutex
	turn          chan struct{}
	seen          map[string]struct{}
	active        context.CancelFunc
	paused        bool
	needsSnapshot bool
}

// NewSession binds a driver to the grant and lifetime established locally.
func NewSession(lifetime context.Context, grantID string, version int64, execute func(context.Context, Action) (json.RawMessage, error)) *Session {
	bound, revoke := context.WithCancel(lifetime)
	return &Session{
		lifetime: bound, revoke: revoke, grantID: grantID, version: version,
		execute: execute, seen: make(map[string]struct{}), turn: make(chan struct{}, 1),
	}
}

// Close revokes this browser target and cancels any in-flight operation.
func (s *Session) Close() {
	s.revoke()
}

// Run admits one action at a time. Operation IDs remain reserved even when the
// driver fails because a delivered click can take effect before an error arrives.
// Concurrent calls (e.g. an agent driving several tabs with parallel tool calls)
// queue behind the active one instead of failing with browser_busy.
func (s *Session) Run(ctx context.Context, request Request) (json.RawMessage, error) {
	if request.GrantID != s.grantID || request.GrantVersion != s.version {
		return nil, errors.New("browser_grant_mismatch")
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	s.mu.Lock()
	if err := s.admit(ctx, request); err != nil {
		s.mu.Unlock()
		return nil, err
	}
	s.mu.Unlock()
	if err := s.acquire(ctx); err != nil {
		return nil, err
	}
	defer func() { <-s.turn }()
	s.mu.Lock()
	// 排队期间用户可能暂停或接管，拿到执行权后重新检查。
	if s.paused {
		s.mu.Unlock()
		return nil, errors.New("browser_paused")
	}
	if s.needsSnapshot && !readOrNavAction(request.Action.Name) {
		s.mu.Unlock()
		return nil, errors.New("browser_snapshot_required")
	}
	s.active = cancel
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.active = nil
		s.mu.Unlock()
	}()

	stop := context.AfterFunc(s.lifetime, cancel)
	defer stop()
	if s.lifetime.Err() != nil {
		return nil, errors.New("browser_grant_expired")
	}
	result, err := s.execute(runCtx, request.Action)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err == nil && observesPage(request.Action) && runCtx.Err() == nil {
		s.needsSnapshot = false
	}
	return result, err
}

// acquire waits for the single execution slot, bounded by the caller and the grant lifetime.
func (s *Session) acquire(ctx context.Context) error {
	select {
	case s.turn <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-s.lifetime.Done():
		return errors.New("browser_grant_expired")
	}
}

// observesPage reports whether a successful action gave the model a fresh view
// of the page: snapshot, navigate, or any action that attached a snapshot.
func observesPage(action Action) bool {
	if action.Name == "snapshot" || action.Name == "navigate" {
		return true
	}
	var attached struct {
		Snapshot bool `json:"snapshot"`
	}
	return len(action.Raw) > 0 && json.Unmarshal(action.Raw, &attached) == nil && attached.Snapshot
}

// SetPaused hands control back to the user. Resume requires a fresh snapshot
// because the user may have navigated or changed the page during the pause.
func (s *Session) SetPaused(paused bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.paused = paused
	if paused {
		s.needsSnapshot = true
		if s.active != nil {
			s.active()
		}
	}
}

// admit is called under mu. A full session stops admitting calls so it never
// forgets an ambiguous operation and accidentally executes it again.
func (s *Session) admit(ctx context.Context, request Request) error {
	if s.lifetime.Err() != nil {
		return errors.New("browser_grant_expired")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, duplicate := s.seen[request.OperationID]; duplicate {
		return errors.New("browser_operation_already_dispatched")
	}
	if s.paused {
		return errors.New("browser_paused")
	}
	if s.needsSnapshot && !readOrNavAction(request.Action.Name) {
		return errors.New("browser_snapshot_required")
	}
	if len(s.seen) >= maxSessionOperations {
		return errors.New("browser_session_limit")
	}
	s.seen[request.OperationID] = struct{}{}
	return nil
}

func readOrNavAction(name string) bool {
	switch name {
	case "snapshot", "navigate", "tabs", "network", "trace", "screenshot", "extract":
		return true
	}
	return false
}
