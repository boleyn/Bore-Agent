package browser

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"fastgpt.local/local-device/internal/browser/native"
	"fastgpt.local/local-device/internal/grant"
)

// SharedPage sends bounded, structured operations to an extension that the
// user has already authorized to control one tab. Replies are correlated by
// ID so a cancelled operation can finish without ending the tab binding.
type SharedPage struct {
	conn      net.Conn
	sequence  atomic.Uint64
	closeOnce sync.Once
	done      chan struct{}
	replies   chan json.RawMessage
}

// NewSharedPage takes ownership of an authorized extension connection. Callers
// serialize Execute via Session.Run and close the connection on revocation.
func NewSharedPage(conn net.Conn) *SharedPage {
	page := &SharedPage{conn: conn, done: make(chan struct{}), replies: make(chan json.RawMessage, 1)}
	go page.readReplies()
	return page
}

func (p *SharedPage) Close() error {
	var err error
	p.closeOnce.Do(func() {
		close(p.done)
		err = p.conn.Close()
	})
	return err
}

// readReplies detects tab or host disconnection even while no action is pending.
func (p *SharedPage) readReplies() {
	defer p.Close()
	for {
		message, err := native.ReadMessage(p.conn)
		if err != nil {
			return
		}
		select {
		case p.replies <- message:
		case <-p.done:
			return
		}
	}
}

type sharedResponse struct {
	Type   string          `json:"type"`
	ID     uint64          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
}

// Execute performs one request against the already chosen tab.
func (p *SharedPage) Execute(ctx context.Context, action Action) (json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if action.Name == "fill_form" {
		return fillForm(ctx, action.Fields, p.Execute)
	}
	id := p.sequence.Add(1)
	payload := map[string]any{"action": action.Name}
	switch action.Name {
	case "navigate":
		payload["url"] = action.URL
	case "click", "fill", "matches":
		payload["ref"] = action.Ref
		if action.Name == "fill" || action.Name == "matches" {
			payload["text"] = action.Text
		}
	case "press":
		payload["key"] = action.Key
	case "snapshot":
		if action.Offset > 0 {
			payload["offset"] = action.Offset
		}
	case "scroll":
		payload["deltaY"] = action.DeltaY
	}
	message, err := json.Marshal(map[string]any{"type": "action", "id": id, "request": payload})
	if err != nil {
		return nil, err
	}

	writeDeadline := time.Now().Add(2 * time.Second)
	if deadline, ok := ctx.Deadline(); ok && deadline.Before(writeDeadline) {
		writeDeadline = deadline
	}
	if err := p.conn.SetWriteDeadline(writeDeadline); err != nil {
		_ = p.Close()
		return nil, errors.New("browser_outcome_unknown")
	}
	if err := native.WriteMessage(p.conn, message); err != nil {
		// A partial frame cannot be recovered on the same connection.
		_ = p.Close()
		return nil, errors.New("browser_outcome_unknown")
	}
	var response sharedResponse
	for {
		select {
		case body := <-p.replies:
			response = sharedResponse{}
			if json.Unmarshal(body, &response) != nil || response.Type != "result" || response.ID == 0 || response.ID > id {
				_ = p.Close()
				return nil, errors.New("browser_outcome_unknown")
			}
			if response.ID == id {
				break
			}
			// The cancelled caller may have returned before its reply arrived.
			continue
		case <-p.done:
			return nil, errors.New("browser_outcome_unknown")
		case <-ctx.Done():
			return nil, errors.New("browser_outcome_unknown")
		}
		break
	}
	if response.Error != "" {
		switch response.Error {
		case "browser_snapshot_required", "browser_site_approval_required", "browser_paused", "browser_element_unavailable":
			return nil, errors.New(response.Error)
		default:
			return nil, errors.New("browser_operation_rejected")
		}
	}
	if len(response.Result) == 0 || len(response.Result) > 768*1024 {
		return nil, errors.New("invalid_browser_result")
	}
	return response.Result, nil
}

// BindShared ties the selected tab's connection to the browser grant lifetime.
func (r *Registry) BindShared(lifetime context.Context, owner grant.Owner, id string, version int64, page *SharedPage) error {
	session := NewSession(lifetime, id, version, page.Execute)
	context.AfterFunc(session.lifetime, func() { _ = page.Close() })
	go func() {
		<-page.done
		session.Close()
	}()
	if err := r.Bind(owner, session); err != nil {
		session.Close()
		return err
	}
	return nil
}
