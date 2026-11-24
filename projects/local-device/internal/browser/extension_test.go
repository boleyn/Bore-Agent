//go:build darwin || linux || windows

package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"fastgpt.local/local-device/internal/browser/native"
)

func TestChromiumLoadsConnectorExtension(t *testing.T) {
	executable, extension := os.Getenv("FASTGPT_TEST_CHROMIUM"), os.Getenv("FASTGPT_TEST_EXTENSION")
	if executable == "" || extension == "" {
		t.Skip("set FASTGPT_TEST_CHROMIUM and FASTGPT_TEST_EXTENSION to a Chromium executable and built extension")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	profile := t.TempDir()
	pipe, done, err := launchChromium(ctx, executable, profile, "--headless=new", "--load-extension="+extension)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 3*time.Second)
		defer stop()
		_, _ = pipe.call(cleanup, "", "Browser.close", nil)
		select {
		case <-done:
		case <-cleanup.Done():
			cancel()
			<-done
		}
	}()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<button onclick="this.textContent='Submitted'">Submit fixture</button>`))
	}))
	defer server.Close()
	created, err := pipe.call(ctx, "", "Target.createTarget", map[string]string{"url": server.URL})
	if err != nil {
		t.Fatalf("create fixture target: %v", err)
	}
	var fixtureTarget struct {
		ID string `json:"targetId"`
	}
	if json.Unmarshal(created, &fixtureTarget) != nil || fixtureTarget.ID == "" {
		t.Fatalf("missing fixture target: %s", created)
	}
	if _, err := pipe.call(ctx, "", "Target.activateTarget", map[string]string{"targetId": fixtureTarget.ID}); err != nil {
		t.Fatal(err)
	}
	for {
		result, err := pipe.call(ctx, "", "Target.getTargets", nil)
		if err != nil {
			t.Fatal(err)
		}
		var reply struct {
			Targets []struct {
				ID   string `json:"targetId"`
				Type string `json:"type"`
				URL  string `json:"url"`
			} `json:"targetInfos"`
		}
		if err := json.Unmarshal(result, &reply); err != nil {
			t.Fatal(err)
		}
		for _, target := range reply.Targets {
			if target.Type == "service_worker" && strings.HasPrefix(target.URL, "chrome-extension://") &&
				strings.HasSuffix(target.URL, "/background.js") {
				var sharedResult <-chan error
				if runtime.GOOS == "darwin" || runtime.GOOS == "linux" {
					sharedResult = registerExtensionTestHost(t, ctx, profile, strings.Split(target.URL, "/")[2], server.URL)
				}
				checkExtensionPageActions(t, ctx, pipe, target.ID, server.URL, sharedResult != nil)
				if sharedResult != nil {
					select {
					case err := <-sharedResult:
						if err != nil {
							t.Fatal(err)
						}
					case <-ctx.Done():
						t.Fatal("shared browser actions timed out")
					}
				}
				return
			}
		}
		select {
		case <-ctx.Done():
			t.Fatal("extension service worker did not start")
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// Register an isolated Native Messaging host backed by the production relay.
// The fixture connector accepts one offer over a temporary loopback connection.
func registerExtensionTestHost(t *testing.T, ctx context.Context, profile, extensionID, origin string) <-chan error {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	result := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			result <- err
			return
		}
		defer conn.Close()
		result <- checkActionsOverNativeRelay(ctx, conn, origin)
	}()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	host := filepath.Join(profile, "fixture-native-host")
	quotedExecutable := "'" + strings.ReplaceAll(executable, "'", "'\"'\"'") + "'"
	script := "#!/bin/sh\nFASTGPT_TEST_NATIVE_RELAY=" + listener.Addr().String() +
		" exec " + quotedExecutable + " -test.run='^TestChromiumNativeRelayHelper$'\n"
	if err := os.WriteFile(host, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	manifest, err := native.Manifest(host, []string{extensionID})
	if err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(profile, "NativeMessagingHosts")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, native.HostName+".json"), manifest, 0600); err != nil {
		t.Fatal(err)
	}
	return result
}

// checkActionsOverNativeRelay exercises the connector's real tab handshake and
// action transport. Only the approval callback is supplied by the fixture.
func checkActionsOverNativeRelay(ctx context.Context, conn net.Conn, origin string) error {
	page, err := AcceptSharedPage(ctx, conn, func(_ context.Context, offeredOrigin string) error {
		if offeredOrigin != origin {
			return fmt.Errorf("unexpected shared origin %q", offeredOrigin)
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("accept shared tab: %w", err)
	}
	defer page.Close()
	snapshot, err := page.Execute(ctx, Action{Name: "snapshot"})
	if err != nil {
		return fmt.Errorf("read shared page: %w", err)
	}
	var tree struct {
		Nodes []struct{ Name, Role, Ref string }
	}
	if err := json.Unmarshal(snapshot, &tree); err != nil {
		return err
	}
	for _, node := range tree.Nodes {
		if node.Role != "button" || node.Name != "Submit fixture" || node.Ref == "" {
			continue
		}
		if _, err := page.Execute(ctx, Action{Name: "click", Ref: node.Ref}); err != nil {
			return fmt.Errorf("click shared element: %w", err)
		}
		updated, err := page.Execute(ctx, Action{Name: "snapshot"})
		if err != nil {
			return fmt.Errorf("read shared page after click: %w", err)
		}
		if !strings.Contains(string(updated), `"name":"Submitted"`) {
			return fmt.Errorf("shared page did not update: %s", updated)
		}
		return nil
	}
	return fmt.Errorf("shared page did not contain the fixture button: %s", snapshot)
}

// TestChromiumNativeRelayHelper runs as the browser's native host subprocess.
func TestChromiumNativeRelayHelper(t *testing.T) {
	address := os.Getenv("FASTGPT_TEST_NATIVE_RELAY")
	if address == "" {
		t.Skip("helper process only")
	}
	conn, err := net.DialTimeout("tcp4", address, 5*time.Second)
	if err != nil {
		os.Exit(1)
	}
	_ = native.Relay(os.Stdin, os.Stdout, conn)
	// Go test writes its final status to stdout, which is reserved for frames.
	os.Exit(0)
}

// Bind a synthetic offer inside the isolated worker to exercise actual Chrome
// debugger calls without installing a global native host on the developer's Mac.
func checkExtensionPageActions(t *testing.T, ctx context.Context, pipe *cdpPipe, worker, origin string, useNativeRelay bool) {
	t.Helper()
	attached, err := pipe.call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": worker, "flatten": true})
	if err != nil {
		t.Fatalf("attach extension worker: %v", err)
	}
	var target struct {
		Session string `json:"sessionId"`
	}
	if json.Unmarshal(attached, &target) != nil || target.Session == "" {
		t.Fatalf("attach extension worker: %s", attached)
	}
	// The service-worker target can be published before its JS context starts.
	if _, err := pipe.call(ctx, target.Session, "Runtime.runIfWaitingForDebugger", nil); err != nil {
		t.Fatalf("resume extension worker: %v", err)
	}
	encodedOrigin, err := json.Marshal(origin)
	if err != nil {
		t.Fatal(err)
	}
	nativeCheck := ""
	if useNativeRelay {
		nativeCheck = `chrome.tabs.get = async () => ({url: origin});
		await shareActiveTab({id: fixture.tabId, url: origin});
		return 'ok';`
	}
	expression := `void (async (origin) => {
		const targets = await chrome.debugger.getTargets();
		const fixture = targets.find(target => target.url.startsWith(origin));
		if (!fixture?.tabId) return JSON.stringify(targets);
		` + nativeCheck + `
		const target = {tabId: fixture.tabId};
		await chrome.debugger.attach(target, '1.3');
		try {
			const session = {target, origin, refs: new Map(), snapshot: 0, state: 'attached'};
			shared = session;
			// activeTab is granted only by the browser's toolbar UI. The test
			// supplies the fixture URL while leaving debugger calls unmodified.
			const originalGet = chrome.tabs.get;
			chrome.tabs.get = async () => ({url: origin});
			try {
				const snapshot = await execute(session, {action:'snapshot'});
				const button = snapshot.nodes.find(node => node.role === 'button' && node.name === 'Submit fixture');
				if (!button?.ref) return JSON.stringify(snapshot);
				await execute(session, {action:'click', ref:button.ref});
				const updated = await execute(session, {action:'snapshot'});
				if (!updated.nodes.some(node => node.name === 'Submitted')) return JSON.stringify(updated);
				const expectError = async (action, expected) => {
					try { await execute(session, action); } catch (error) { return error.message === expected; }
					return false;
				};
				if (!await expectError({action:'click', ref:button.ref}, 'browser_snapshot_required')) return 'stale reference accepted';
				const foreignOrigin = new URL(origin);
				foreignOrigin.hostname = 'localhost';
				if (!await expectError({action:'navigate', url:foreignOrigin.href}, 'browser_site_approval_required')) return 'foreign origin accepted';
				return 'ok';
			} finally {
				chrome.tabs.get = originalGet;
				shared = undefined;
			}
		} finally {
			await chrome.debugger.detach(target);
		}
	})(` + string(encodedOrigin) + `).then(
		value => { self.connectorTestResult = value },
		error => { self.connectorTestResult = String(error) }
	)`
	if _, err := pipe.call(ctx, target.Session, "Runtime.evaluate", map[string]any{
		"expression": expression,
	}); err != nil {
		t.Fatalf("start extension action sequence: %v", err)
	}
	for {
		result, err := pipe.call(ctx, target.Session, "Runtime.evaluate", map[string]any{
			"expression": "self.connectorTestResult", "returnByValue": true,
		})
		if err != nil {
			t.Fatalf("read extension action result: %v", err)
		}
		var output struct {
			Result struct {
				Value *string `json:"value"`
			} `json:"result"`
		}
		if err := json.Unmarshal(result, &output); err != nil {
			t.Fatal(err)
		}
		if output.Result.Value != nil {
			if *output.Result.Value != "ok" {
				t.Fatalf("extension action sequence failed: %s", *output.Result.Value)
			}
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("extension action sequence timed out")
		case <-time.After(25 * time.Millisecond):
		}
	}
}
