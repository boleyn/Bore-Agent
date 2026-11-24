package connector

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"fastgpt.local/local-device/internal/browser"
	"fastgpt.local/local-device/internal/grant"
	"fastgpt.local/local-device/internal/journal"
	"fastgpt.local/local-device/internal/protocol"
	"github.com/coder/websocket"
)

func TestBrowserGrantOverDeviceConnection(t *testing.T) {
	for _, mode := range []string{"dedicated", "sharedTab"} {
		t.Run(mode, func(t *testing.T) { testBrowserGrantOverDeviceConnection(t, mode) })
	}
}

func testBrowserGrantOverDeviceConnection(t *testing.T, mode string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ledger, err := journal.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer ledger.Close()
	owner := grant.Owner{DeviceID: "device", TeamID: "team", MemberID: "member"}
	registry := &browser.Registry{}
	open, err := NewLocalSessionFactory(LocalOptions{
		AccountMode: true, DeviceID: owner.DeviceID, Journal: ledger,
		HasBrowser: registry.Has, RevokeBrowser: registry.Revoke,
		ConfirmBrowser: func(_ context.Context, g grant.Grant) error {
			session := browser.NewSession(ctx, g.ID, g.Version, func(context.Context, browser.Action) (json.RawMessage, error) {
				return json.RawMessage(`{"nodes":[]}`), nil
			})
			return registry.Bind(owner, session)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	accepted := make(chan *websocket.Conn, 1)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		socket, err := websocket.Accept(w, request, nil)
		if err == nil {
			accepted <- socket
		}
	}))
	defer server.Close()
	done := make(chan error, 1)
	go func() {
		done <- Connect(ctx, Options{
			URL: "wss" + strings.TrimPrefix(server.URL, "https"), Ticket: strings.Repeat("a", 43),
			OpenSession: open, HandleBrowser: registry.Run, HTTPClient: server.Client(),
		})
	}()
	defer func() { cancel(); <-done }()
	var socket *websocket.Conn
	select {
	case socket = <-accepted:
	case <-ctx.Done():
		t.Fatal("device did not connect")
	}
	defer socket.CloseNow()
	send := func(frame protocol.Frame) {
		t.Helper()
		frame.Version, frame.Epoch, frame.ServerTime = 1, "epoch", time.Now().UnixMilli()
		data, err := json.Marshal(frame)
		if err != nil {
			t.Fatal(err)
		}
		if err := socket.Write(ctx, websocket.MessageText, data); err != nil {
			t.Fatal(err)
		}
	}
	read := func(wantType, wantError string) {
		t.Helper()
		_, data, err := socket.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		frame, err := protocol.Decode(data)
		if err != nil || frame.Type != wantType || frame.Error != wantError {
			t.Fatalf("response %s, error %v; want %s/%s", data, err, wantType, wantError)
		}
	}

	send(protocol.Frame{Type: "welcome", Owner: &owner, AuthExpiresAt: time.Now().Add(time.Minute).UnixMilli()})
	approved := grant.Grant{Owner: owner, ID: "browser_grant", Version: 1, AppID: "app", ChatID: "chat", SourceTarget: "entry", BrowserMode: mode}
	send(protocol.Frame{Type: "grant_request", RequestID: "approve", GrantID: approved.ID, Grant: &approved})
	read("grant_result", "")
	action := func(requestID string) {
		payload, err := json.Marshal(map[string]any{
			"operationId": "op", "deadline": time.Now().Add(time.Second).UnixMilli(),
			"grantId": approved.ID, "grantVersion": approved.Version,
			"browserAction": map[string]string{"action": "snapshot"},
		})
		if err != nil {
			t.Fatal(err)
		}
		send(protocol.Frame{Type: "browser_start", RequestID: requestID, OperationID: "op", BrowserRequest: payload})
	}
	action("without_lease")
	read("browser_error", "grant_revoked")
	send(protocol.Frame{Type: "grant_renew", RequestID: "renew", GrantID: approved.ID, Grant: &approved, LeaseExpiresAt: time.Now().Add(30 * time.Second).UnixMilli()})
	read("grant_result", "")
	action("snapshot")
	read("browser_result", "")
	action("duplicate")
	read("browser_error", "browser_operation_already_dispatched")
	registry.Revoke(owner, approved.ID, approved.Version)
	send(protocol.Frame{Type: "grant_renew", RequestID: "renew_missing_target", GrantID: approved.ID, Grant: &approved, LeaseExpiresAt: time.Now().Add(30 * time.Second).UnixMilli()})
	if mode == "dedicated" {
		read("grant_result", "")
		if !registry.Has(owner, approved.ID, approved.Version) {
			t.Fatal("renewal did not restore the dedicated target")
		}
	} else {
		read("grant_error", "browser_unavailable")
		if registry.Has(owner, approved.ID, approved.Version) {
			t.Fatal("renewal restored a shared tab without selection")
		}
	}
	send(protocol.Frame{Type: "grant_revoke", RequestID: "revoke", GrantID: approved.ID, Grant: &approved})
	read("grant_result", "")
	action("after_revoke")
	read("browser_error", "grant_revoked")
	if registry.Has(owner, approved.ID, approved.Version) {
		t.Fatal("revoked grant still has a browser target")
	}
}
