//go:build windows

package browser

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

const (
	embeddedHandshakeTimeout = 5 * time.Second
	maxEmbeddedHandshake     = 256
)

// embeddedEndpoint scopes both the control pipe and its ACL to the current
// Windows user. The nonce keeps the name unguessable for the life of one host.
func embeddedEndpoint() (name, securityDescriptor string, err error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", "", err
	}
	nonce := make([]byte, 8)
	if _, err := rand.Read(nonce); err != nil {
		return "", "", err
	}
	sid := user.User.Sid.String()
	name = `\\.\pipe\aistudio-browser-` + sid + "-" + hex.EncodeToString(nonce)
	// Deny network logons and grant the current user full control.
	return name, "D:P(D;;GA;;;NU)(A;;GA;;;" + sid + ")", nil
}

// startEmbedded launches the renderer host and authenticates the first
// connection on the user-scoped named pipe. A GUI process on Windows starts
// with unusable stdio, so the pipe replaces it.
func startEmbedded(ctx context.Context, _ string, runtimePath string, args []string) (*cdpPipe, <-chan struct{}, error) {
	name, securityDescriptor, err := embeddedEndpoint()
	if err != nil {
		return nil, nil, err
	}
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		return nil, nil, err
	}
	secret := hex.EncodeToString(token)

	listener, err := winio.ListenPipe(name, &winio.PipeConfig{SecurityDescriptor: securityDescriptor})
	if err != nil {
		return nil, nil, err
	}
	command := exec.CommandContext(ctx, runtimePath, append(args,
		"--connector-browser-pipe="+name,
		"--connector-browser-token="+secret,
	)...)
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		_ = listener.Close()
		return nil, nil, err
	}

	exited := make(chan struct{})
	go func() {
		defer close(exited)
		_ = command.Wait()
	}()

	connection, err := acceptEmbedded(ctx, listener, exited, secret)
	if closeErr := listener.Close(); err == nil && closeErr != nil {
		_ = connection.Close()
		err = closeErr
	}
	if err != nil {
		_ = command.Process.Kill()
		<-exited
		return nil, nil, err
	}

	pipe := newCDPPipe(ctx, connection, connection)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer pipe.stop()
		<-exited
	}()
	return pipe, done, nil
}

// acceptEmbedded admits exactly one authenticated connection. Any other
// connection, a wrong token, or a host that exits early fails the launch.
func acceptEmbedded(ctx context.Context, listener net.Listener, exited <-chan struct{}, secret string) (net.Conn, error) {
	type result struct {
		connection net.Conn
		err        error
	}
	accepted := make(chan result, 1)
	go func() {
		connection, err := listener.Accept()
		accepted <- result{connection, err}
	}()
	timer := time.NewTimer(embeddedStartupTimeout)
	defer timer.Stop()
	select {
	case outcome := <-accepted:
		if outcome.err != nil {
			return nil, outcome.err
		}
		if err := readEmbeddedToken(outcome.connection, secret); err != nil {
			_ = outcome.connection.Close()
			return nil, err
		}
		return outcome.connection, nil
	case <-exited:
		return nil, errors.New("embedded_browser_exited_before_handshake")
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		return nil, errors.New("embedded_browser_handshake_timeout")
	}
}

// readEmbeddedToken reads one NUL-terminated frame and compares it in constant
// time without buffering, so the CDP stream starts at the next byte.
func readEmbeddedToken(connection net.Conn, secret string) error {
	if err := connection.SetReadDeadline(time.Now().Add(embeddedHandshakeTimeout)); err != nil {
		return err
	}
	defer func() { _ = connection.SetReadDeadline(time.Time{}) }()
	frame := make([]byte, 0, maxEmbeddedHandshake)
	next := make([]byte, 1)
	for len(frame) < maxEmbeddedHandshake {
		if _, err := io.ReadFull(connection, next); err != nil {
			return err
		}
		if next[0] == 0 {
			break
		}
		frame = append(frame, next[0])
	}
	if len(frame) >= maxEmbeddedHandshake {
		return errors.New("embedded_browser_handshake_rejected")
	}
	var hello struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(frame, &hello); err != nil {
		return fmt.Errorf("embedded_browser_handshake_invalid: %w", err)
	}
	if subtle.ConstantTimeCompare([]byte(hello.Token), []byte(secret)) != 1 {
		return errors.New("embedded_browser_handshake_rejected")
	}
	return nil
}
