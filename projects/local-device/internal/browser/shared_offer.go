package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"time"

	"fastgpt.local/local-device/internal/browser/native"
)

const sharedTabProtocolVersion = 1

// AcceptSharedPage negotiates a single tab with the extension. The approval
// callback must bind the offered origin to a pending local conversation.
func AcceptSharedPage(ctx context.Context, conn net.Conn, approve func(context.Context, string) error) (*SharedPage, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	accepted := false
	defer func() {
		stop()
		if !accepted {
			_ = conn.Close()
		}
	}()

	deadline, _ := ctx.Deadline()
	if err := conn.SetDeadline(deadline); err != nil {
		return nil, err
	}
	body, err := native.ReadMessage(conn)
	if err != nil {
		return nil, err
	}
	var offer struct {
		Type    string `json:"type"`
		Origin  string `json:"origin"`
		Version int    `json:"version"`
	}
	if len(body) > 4096 || json.Unmarshal(body, &offer) != nil || offer.Type != "offer" {
		return nil, errors.New("invalid_browser_offer")
	}
	if offer.Version != sharedTabProtocolVersion {
		_ = native.WriteMessage(conn, json.RawMessage(`{"type":"error","error":"browser_extension_version_mismatch"}`))
		return nil, errors.New("browser_extension_version_mismatch")
	}
	origin, err := url.Parse(offer.Origin)
	if err != nil || origin.Hostname() == "" || origin.User != nil ||
		(origin.Scheme != "https" && origin.Scheme != "http") ||
		offer.Origin != origin.Scheme+"://"+origin.Host {
		return nil, errors.New("invalid_browser_origin")
	}
	if err := approve(ctx, offer.Origin); err != nil {
		return nil, err
	}
	if err := native.WriteMessage(conn, []byte(fmt.Sprintf(`{"type":"approved","version":%d}`, sharedTabProtocolVersion))); err != nil {
		return nil, err
	}
	body, err = native.ReadMessage(conn)
	if err != nil {
		return nil, err
	}
	var ready struct {
		Type string `json:"type"`
	}
	if len(body) > 256 || json.Unmarshal(body, &ready) != nil || ready.Type != "ready" {
		return nil, errors.New("browser_tab_not_ready")
	}
	if err := conn.SetDeadline(time.Time{}); err != nil {
		return nil, err
	}
	if !stop() || ctx.Err() != nil {
		return nil, context.Canceled
	}
	accepted = true
	return NewSharedPage(conn), nil
}
