//go:build darwin || linux || windows

package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

// This integration check uses a fresh profile and an explicitly selected browser.
func TestChromiumPipeHandshake(t *testing.T) {
	executable := os.Getenv("FASTGPT_TEST_CHROMIUM")
	if executable == "" {
		t.Skip("FASTGPT_TEST_CHROMIUM is unset")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pipe, done, err := launchChromium(ctx, executable, t.TempDir(), "--headless")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		closeCtx, stop := context.WithTimeout(context.Background(), 3*time.Second)
		defer stop()
		_, _ = pipe.call(closeCtx, "", "Browser.close", nil)
		select {
		case <-done:
		case <-closeCtx.Done():
			cancel()
			<-done
		}
	}()
	result, err := pipe.call(ctx, "", "Browser.getVersion", nil)
	if err != nil {
		t.Fatal(err)
	}
	var version struct {
		Product string `json:"product"`
	}
	if err := json.Unmarshal(result, &version); err != nil || version.Product == "" {
		t.Fatalf("invalid browser version response: %s (%v)", result, err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<title>Browser test</title><input aria-label=Query oninput=\"document.querySelector('output').textContent=this.value\"><output></output><button onclick=\"this.textContent='Search complete'\">Search tickets</button>"))
	}))
	defer server.Close()
	page, err := openPage(ctx, pipe)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = page.run(ctx, Action{Name: "navigate", URL: server.URL}); err != nil {
		t.Fatal(err)
	}
	for {
		result, err := page.run(ctx, Action{Name: "snapshot"})
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(result, []byte("Search tickets")) {
			var snapshot struct {
				Nodes []struct{ Role, Name, Ref string }
			}
			if err := json.Unmarshal(result, &snapshot); err != nil {
				t.Fatal(err)
			}
			for _, node := range snapshot.Nodes {
				if node.Role == "textbox" && node.Name == "Query" {
					if _, err := page.run(ctx, Action{Name: "fill", Ref: node.Ref, Text: "Open tickets"}); err != nil {
						t.Fatal(err)
					}
				}
			}
			for _, node := range snapshot.Nodes {
				if node.Role == "button" && node.Name == "Search tickets" {
					if _, err := page.run(ctx, Action{Name: "click", Ref: node.Ref}); err != nil {
						t.Fatal(err)
					}
					break
				}
			}
			updated, err := page.run(ctx, Action{Name: "snapshot"})
			if err != nil || !bytes.Contains(updated, []byte("Search complete")) || !bytes.Contains(updated, []byte("Open tickets")) {
				t.Fatalf("click did not update the page: %s (%v)", updated, err)
			}
			for _, action := range []Action{{Name: "press", Key: "Tab"}, {Name: "scroll", DeltaY: 100}, {Name: "screenshot"}} {
				if _, err := page.run(ctx, action); err != nil {
					t.Fatalf("%s: %v", action.Name, err)
				}
			}
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(25 * time.Millisecond):
		}
	}
}
