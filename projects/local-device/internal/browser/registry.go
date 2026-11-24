package browser

import (
	"context"
	"encoding/json"
	"errors"
	"sync"

	"fastgpt.local/local-device/internal/grant"
)

// Registry routes actions only to browser sessions registered by the local
// consent flow. Both the authenticated connection owner and grant must match.
type Registry struct {
	Management     func(context.Context, string) any
	sessions       sync.Map
	windowMu       sync.Mutex // 串行处理打开与接管，窗口发布完成后再允许下一个请求。
	activeProfile  string
	profiles       sync.Map
	windows        sync.Map
	unboundWindows sync.Map
	pauseMu        sync.Mutex
	paused         bool
}

type sessionKey struct {
	deviceID string
	teamID   string
	memberID string
	grantID  string
}

// Bind reserves the grant until the browser session lifetime ends.
func (r *Registry) Bind(owner grant.Owner, session *Session) error {
	key := sessionKey{owner.DeviceID, owner.TeamID, owner.MemberID, session.grantID}
	if err := session.lifetime.Err(); err != nil {
		return err
	}
	r.pauseMu.Lock()
	defer r.pauseMu.Unlock()
	if _, exists := r.sessions.LoadOrStore(key, session); exists {
		return errors.New("browser_grant_in_use")
	}
	if r.paused {
		session.SetPaused(true)
	}
	context.AfterFunc(session.lifetime, func() {
		r.sessions.CompareAndDelete(key, session)
	})
	return nil
}

// Unbind detaches and closes a specific session immediately so a replacement
// session for the same grant or window can take over without race conditions.
func (r *Registry) Unbind(owner grant.Owner, session *Session) {
	if session == nil {
		return
	}
	key := sessionKey{owner.DeviceID, owner.TeamID, owner.MemberID, session.grantID}
	r.sessions.CompareAndDelete(key, session)
	session.Close()
}

// Run resolves the grant without taking any target identifier from the model.
func (r *Registry) Run(ctx context.Context, owner grant.Owner, request Request) (json.RawMessage, error) {
	key := sessionKey{owner.DeviceID, owner.TeamID, owner.MemberID, request.GrantID}
	value, exists := r.sessions.Load(key)
	if !exists {
		return nil, errors.New("browser_grant_missing")
	}
	return value.(*Session).Run(ctx, request)
}

// Revoke closes only the target associated with the scoped browser grant.
func (r *Registry) Revoke(owner grant.Owner, grantID string, version int64) {
	key := sessionKey{owner.DeviceID, owner.TeamID, owner.MemberID, grantID}
	if value, ok := r.sessions.Load(key); ok {
		session := value.(*Session)
		if session.version == version {
			session.Close()
		}
	}
}

// Has reports whether the exact grant still has a live local browser target.
func (r *Registry) Has(owner grant.Owner, grantID string, version int64) bool {
	key := sessionKey{owner.DeviceID, owner.TeamID, owner.MemberID, grantID}
	value, ok := r.sessions.Load(key)
	if !ok {
		return false
	}
	session := value.(*Session)
	return session.version == version && session.lifetime.Err() == nil
}

// SetPaused toggles browser control from the local tray for current and new targets.
func (r *Registry) SetPaused(paused bool) {
	r.pauseMu.Lock()
	defer r.pauseMu.Unlock()
	r.paused = paused
	r.sessions.Range(func(_, value any) bool {
		value.(*Session).SetPaused(paused)
		return true
	})
}
