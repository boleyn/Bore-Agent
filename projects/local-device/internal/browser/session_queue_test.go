package browser

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"
)

// 并发调用（如 Agent 并行操作多个标签）应排队执行，而不是返回 browser_busy。
func TestSessionQueuesConcurrentOperations(t *testing.T) {
	release := make(chan struct{})
	var mu sync.Mutex
	running, maxRunning := 0, 0
	session := NewSession(context.Background(), "grant", 1, func(context.Context, Action) (json.RawMessage, error) {
		mu.Lock()
		running++
		if running > maxRunning {
			maxRunning = running
		}
		mu.Unlock()
		<-release
		mu.Lock()
		running--
		mu.Unlock()
		return json.RawMessage(`{}`), nil
	})
	errs := make(chan error, 2)
	for _, id := range []string{"a", "b"} {
		go func(id string) {
			_, err := session.Run(context.Background(), Request{GrantID: "grant", GrantVersion: 1, OperationID: id, Action: Action{Name: "click"}})
			errs <- err
		}(id)
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	for range 2 {
		if err := <-errs; err != nil {
			t.Fatalf("queued run error = %v", err)
		}
	}
	if maxRunning != 1 {
		t.Fatalf("operations overlapped: %d", maxRunning)
	}
}

// 排队中的调用方取消时立即返回，不占用执行权。
func TestSessionQueuedOperationHonorsCancel(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	session := NewSession(context.Background(), "grant", 1, func(context.Context, Action) (json.RawMessage, error) {
		<-release
		return json.RawMessage(`{}`), nil
	})
	go session.Run(context.Background(), Request{GrantID: "grant", GrantVersion: 1, OperationID: "first", Action: Action{Name: "snapshot"}})
	time.Sleep(20 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := session.Run(ctx, Request{GrantID: "grant", GrantVersion: 1, OperationID: "second", Action: Action{Name: "snapshot"}}); err == nil {
		t.Fatal("expected cancellation while queued")
	}
}

// 带 snapshot:true 的动作已让模型看到最新页面，应解除暂停后的快照要求。
func TestSessionAttachedSnapshotClearsRequirement(t *testing.T) {
	session := NewSession(context.Background(), "grant", 1, func(context.Context, Action) (json.RawMessage, error) {
		return json.RawMessage(`{}`), nil
	})
	session.SetPaused(true)
	session.SetPaused(false)
	scroll := Action{Name: "scroll", Raw: json.RawMessage(`{"action":"scroll","snapshot":true}`)}
	if _, err := session.Run(context.Background(), Request{GrantID: "grant", GrantVersion: 1, OperationID: "s", Action: scroll}); err == nil {
		t.Fatal("scroll should still require a snapshot first")
	}
	wait := Action{Name: "extract", Raw: json.RawMessage(`{"action":"extract"}`)}
	if _, err := session.Run(context.Background(), Request{GrantID: "grant", GrantVersion: 1, OperationID: "x", Action: wait}); err != nil {
		t.Fatal(err)
	}
	nav := Action{Name: "navigate", Raw: json.RawMessage(`{"action":"navigate","url":"https://a.test"}`)}
	if _, err := session.Run(context.Background(), Request{GrantID: "grant", GrantVersion: 1, OperationID: "n", Action: nav}); err != nil {
		t.Fatal(err)
	}
	click := Action{Name: "click", Raw: json.RawMessage(`{"action":"click","ref":"e1"}`)}
	if _, err := session.Run(context.Background(), Request{GrantID: "grant", GrantVersion: 1, OperationID: "c", Action: click}); err != nil {
		t.Fatal(err)
	}
}
