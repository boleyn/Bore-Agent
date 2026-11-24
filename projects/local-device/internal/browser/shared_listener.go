//go:build darwin || linux || windows

package browser

import (
	"context"
	"errors"
	"net"
	"sync"

	"fastgpt.local/local-device/internal/browser/native"
)

// SharedListener matches extension connections to a single pending native
// approval. The extension cannot choose a conversation or grant.
type SharedListener struct {
	listener net.Listener
	done     chan struct{}
	mu       sync.Mutex
	pending  chan net.Conn
}

// ListenForSharedTabs opens the connector's user-private transport. Its caller
// owns the lifetime and closes it when the connector exits.
func ListenForSharedTabs() (*SharedListener, error) {
	listener, err := native.Listen()
	if err != nil {
		return nil, err
	}
	shared := &SharedListener{listener: listener, done: make(chan struct{})}
	go shared.route()
	return shared, nil
}

func (s *SharedListener) Close() error {
	return s.listener.Close()
}

func (s *SharedListener) route() {
	defer close(s.done)
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		select {
		case s.pending <- conn:
		default:
			_ = conn.Close()
		}
		s.mu.Unlock()
	}
}

// Wait accepts a single extension offer for the locally pending conversation.
// Concurrent approvals are rejected so a user gesture cannot bind ambiguously.
func (s *SharedListener) Wait(ctx context.Context, approve func(context.Context, string) error) (*SharedPage, error) {
	s.mu.Lock()
	if s.pending != nil {
		s.mu.Unlock()
		return nil, errors.New("browser_share_pending")
	}
	pending := make(chan net.Conn, 1)
	s.pending = pending
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.pending = nil
		select {
		case conn := <-pending:
			_ = conn.Close()
		default:
		}
	}()

	select {
	case conn := <-pending:
		return AcceptSharedPage(ctx, conn, approve)
	case <-s.done:
		return nil, errors.New("browser_listener_closed")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
