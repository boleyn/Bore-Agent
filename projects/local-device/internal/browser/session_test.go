package browser

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestSessionRejectsReplayAfterAmbiguousDriverFailure(t *testing.T) {
	lifetime, cancel := context.WithCancel(context.Background())
	defer cancel()
	calls := 0
	session := NewSession(lifetime, "grant", 2, func(context.Context, Action) (json.RawMessage, error) {
		calls++
		return nil, errors.New("lost_reply")
	})
	request := Request{GrantID: "grant", GrantVersion: 2, OperationID: "click"}
	if _, err := session.Run(context.Background(), request); err == nil || err.Error() != "lost_reply" {
		t.Fatalf("first run error = %v", err)
	}
	if _, err := session.Run(context.Background(), request); err == nil || err.Error() != "browser_operation_already_dispatched" {
		t.Fatalf("replay error = %v", err)
	}
	if calls != 1 {
		t.Fatalf("driver ran %d times", calls)
	}
	cancel()
	request.OperationID = "another-click"
	if _, err := session.Run(context.Background(), request); err == nil || err.Error() != "browser_grant_expired" {
		t.Fatalf("revoked session error = %v", err)
	}
}

func TestSessionPauseRequiresFreshSnapshot(t *testing.T) {
	session := NewSession(context.Background(), "grant", 1, func(_ context.Context, _ Action) (json.RawMessage, error) {
		return json.RawMessage("{}"), nil
	})
	request := Request{GrantID: "grant", GrantVersion: 1, OperationID: "click", Action: Action{Name: "click"}}
	session.SetPaused(true)
	if _, err := session.Run(context.Background(), request); err == nil || err.Error() != "browser_paused" {
		t.Fatalf("paused run error = %v", err)
	}
	session.SetPaused(false)
	if _, err := session.Run(context.Background(), request); err == nil || err.Error() != "browser_snapshot_required" {
		t.Fatalf("resume run error = %v", err)
	}
	snapshot := Request{GrantID: "grant", GrantVersion: 1, OperationID: "snapshot", Action: Action{Name: "snapshot"}}
	if _, err := session.Run(context.Background(), snapshot); err != nil {
		t.Fatal(err)
	}
	if _, err := session.Run(context.Background(), request); err != nil {
		t.Fatal(err)
	}
}
