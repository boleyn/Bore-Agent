package browser

import (
	"context"
	"net"
	"testing"
	"time"

	"fastgpt.local/local-device/internal/browser/native"
	"fastgpt.local/local-device/internal/grant"
)

func TestSharedPageReturnsExtensionResult(t *testing.T) {
	connector, extension := net.Pipe()
	defer extension.Close()
	page := NewSharedPage(connector)
	defer page.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	request := make(chan string, 1)
	go func() {
		body, _ := native.ReadMessage(extension)
		request <- string(body)
		_ = native.WriteMessage(extension, []byte(`{"type":"result","id":1,"result":{"applied":true}}`))
	}()
	result, err := page.Execute(ctx, Action{Name: "fill", Ref: "field", Text: ""})
	if err != nil || string(result) != `{"applied":true}` {
		t.Fatalf("result = %s, error = %v", result, err)
	}
	if got := <-request; got != `{"id":1,"request":{"action":"fill","ref":"field","text":""},"type":"action"}` {
		t.Fatalf("unexpected request: %s", got)
	}
}

func TestSharedOfferWaitsForApprovalAndReadiness(t *testing.T) {
	connector, extension := net.Pipe()
	defer extension.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	extensionDone := make(chan error, 1)
	go func() {
		if err := native.WriteMessage(extension, []byte(`{"type":"offer","origin":"https://example.com","version":1}`)); err != nil {
			extensionDone <- err
			return
		}
		if _, err := native.ReadMessage(extension); err != nil {
			extensionDone <- err
			return
		}
		extensionDone <- native.WriteMessage(extension, []byte(`{"type":"ready"}`))
	}()
	approved := false
	page, err := AcceptSharedPage(ctx, connector, func(_ context.Context, origin string) error {
		approved = origin == "https://example.com"
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer page.Close()
	if err := <-extensionDone; err != nil || !approved {
		t.Fatalf("approval = %t, error = %v", approved, err)
	}
}

func TestSharedOfferRejectsIncompatibleExtensionBeforeApproval(t *testing.T) {
	connector, extension := net.Pipe()
	defer extension.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = extension.SetDeadline(time.Now().Add(time.Second))
	done := make(chan error, 1)
	go func() {
		_, err := AcceptSharedPage(ctx, connector, func(context.Context, string) error {
			t.Error("incompatible extension triggered local approval")
			return nil
		})
		done <- err
	}()
	if err := native.WriteMessage(extension, []byte(`{"type":"offer","origin":"https://example.com","version":2}`)); err != nil {
		t.Fatal(err)
	}
	body, err := native.ReadMessage(extension)
	if err != nil || string(body) != `{"type":"error","error":"browser_extension_version_mismatch"}` {
		t.Fatalf("extension got %s, error %v", body, err)
	}
	if err := <-done; err == nil || err.Error() != "browser_extension_version_mismatch" {
		t.Fatalf("connector got %v", err)
	}
}

func TestSharedBindingEndsWhenIdleTabDisconnects(t *testing.T) {
	connector, extension := net.Pipe()
	registry := &Registry{}
	owner := grant.Owner{DeviceID: "device", TeamID: "team", MemberID: "member"}
	page := NewSharedPage(connector)
	defer page.Close()
	if err := registry.BindShared(context.Background(), owner, "grant", 1, page); err != nil {
		t.Fatal(err)
	}
	value, ok := registry.sessions.Load(sessionKey{"device", "team", "member", "grant"})
	if !ok {
		t.Fatal("missing session")
	}
	extension.Close()
	select {
	case <-value.(*Session).lifetime.Done():
	case <-time.After(time.Second):
		t.Fatal("idle tab disconnection did not end the grant")
	}
}

func TestSharedPageDiscardsCancelledActionReply(t *testing.T) {
	connector, extension := net.Pipe()
	defer extension.Close()
	page := NewSharedPage(connector)
	defer page.Close()
	ctx, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	firstCtx, cancelFirst := context.WithCancel(ctx)
	defer cancelFirst()

	extensionDone := make(chan error, 1)
	go func() {
		if _, err := native.ReadMessage(extension); err != nil {
			extensionDone <- err
			return
		}
		cancelFirst()
		if err := native.WriteMessage(extension, []byte(`{"type":"result","id":1,"result":{"old":true}}`)); err != nil {
			extensionDone <- err
			return
		}
		if _, err := native.ReadMessage(extension); err != nil {
			extensionDone <- err
			return
		}
		extensionDone <- native.WriteMessage(extension, []byte(`{"type":"result","id":2,"result":{"fresh":true}}`))
	}()
	// The extension can finish at the same time as cancellation. Either way,
	// the old result must never be returned for the resumed snapshot.
	_, _ = page.Execute(firstCtx, Action{Name: "click", Ref: "button"})
	result, err := page.Execute(ctx, Action{Name: "snapshot"})
	if err != nil || string(result) != `{"fresh":true}` {
		t.Fatalf("resumed snapshot = %s, error = %v", result, err)
	}
	if err := <-extensionDone; err != nil {
		t.Fatal(err)
	}
}
