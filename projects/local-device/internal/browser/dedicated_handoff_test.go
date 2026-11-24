//go:build darwin || windows

package browser

import (
	"context"
	"encoding/json"
	"testing"

	"fastgpt.local/local-device/internal/grant"
)

type stubRunner struct {
	calls int
}

func (s *stubRunner) run(_ context.Context, action Action) (json.RawMessage, error) {
	s.calls++
	return json.Marshal(map[string]any{"ok": true, "action": action.Name, "calls": s.calls})
}

func TestManualDedicatedWindowAllowsChatHandoff(t *testing.T) {
	profile, err := dedicatedProfile(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	registry := &Registry{}
	stopped := false
	done := make(chan struct{})
	defer close(done)
	runner := &stubRunner{}
	window := &dedicatedWindow{
		manual: true,
		page:   runner,
		done:   done,
		stop:   func() { stopped = true },
	}
	registry.windows.Store(profile, window)
	registry.unboundWindows.Store(profile, window)

	ownerA := grant.Owner{DeviceID: "dev", TeamID: "t1", MemberID: "m1"}
	ownerB := grant.Owner{DeviceID: "dev", TeamID: "t1", MemberID: "m2"}
	ctx := context.Background()

	if err := registry.BindDedicated(ctx, ownerA, "grant-1", 1, profile); err != nil {
		t.Fatalf("first bind: %v", err)
	}
	if _, err := registry.Run(ctx, ownerA, Request{OperationID: "op1", GrantID: "grant-1", GrantVersion: 1, Action: Action{Name: "snapshot"}}); err != nil {
		t.Fatalf("first run: %v", err)
	}

	// 旧对话未过期时，新对话应能直接接管已打开的内置浏览器窗口而不报 grant_rejected / browser_profile_in_use。
	if err := registry.BindDedicated(ctx, ownerB, "grant-2", 1, profile); err != nil {
		t.Fatalf("handoff bind: %v", err)
	}
	if registry.Has(ownerA, "grant-1", 1) {
		t.Fatal("expected previous grant session to be unbound on handoff")
	}
	if stopped {
		t.Fatal("handoff should not close the manual window")
	}
	if _, err := registry.Run(ctx, ownerB, Request{OperationID: "op2", GrantID: "grant-2", GrantVersion: 1, Action: Action{Name: "snapshot"}}); err != nil {
		t.Fatalf("second run: %v", err)
	}
	if runner.calls != 2 {
		t.Fatalf("expected 2 calls on shared window, got %d", runner.calls)
	}
}
