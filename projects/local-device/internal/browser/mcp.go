//go:build darwin || windows

package browser

import (
	"context"
	"encoding/json"
	"os"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// RunMCP serves a local client over stdio in a fresh browser profile.
// It never attaches to the connector's paired sessions.
func RunMCP(ctx context.Context) error {
	profile, err := os.MkdirTemp("", "connector-browser-mcp-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(profile)
	registry := &Registry{}
	window, err := registry.startDedicated(ctx, profile)
	if err != nil {
		return err
	}
	defer window.stop()

	run := func(ctx context.Context, name string, input any) (*mcp.CallToolResult, any, error) {
		body, err := json.Marshal(input)
		if err != nil {
			return nil, nil, err
		}
		var fields map[string]any
		if err := json.Unmarshal(body, &fields); err != nil {
			return nil, nil, err
		}
		fields["action"] = name
		body, err = json.Marshal(fields)
		if err != nil {
			return nil, nil, err
		}
		action, err := DecodeAction(body)
		if err != nil {
			return nil, nil, err
		}

		window.actions.Lock()
		defer window.actions.Unlock()
		ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
		defer cancel()
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		result, err := window.page.run(ctx, action)
		if err != nil {
			return nil, nil, err
		}
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(result)}}}, nil, nil
	}

	server := mcp.NewServer(&mcp.Implementation{Name: "connector-browser", Title: "Connector Browser"}, nil)
	add := func(name, description string, handler func(context.Context, json.RawMessage) (*mcp.CallToolResult, any, error)) {
		mcp.AddTool(server, &mcp.Tool{Name: name, Description: description},
			func(ctx context.Context, _ *mcp.CallToolRequest, input json.RawMessage) (*mcp.CallToolResult, any, error) {
				return handler(ctx, input)
			})
	}
	_ = add

	mcp.AddTool(server, &mcp.Tool{Name: "browser_navigate", Description: "Navigate to an HTTP or HTTPS URL."},
		func(ctx context.Context, _ *mcp.CallToolRequest, input struct {
			URL      string `json:"url"`
			TabID    *int   `json:"tabId,omitempty"`
			Snapshot bool   `json:"snapshot,omitempty"`
		}) (*mcp.CallToolResult, any, error) {
			return run(ctx, "navigate", input)
		})
	mcp.AddTool(server, &mcp.Tool{Name: "browser_snapshot", Description: "Read the structured accessibility snapshot with element references, values and states."},
		func(ctx context.Context, _ *mcp.CallToolRequest, input struct {
			Ref         string `json:"ref,omitempty"`
			Selector    string `json:"selector,omitempty"`
			Offset      int    `json:"offset,omitempty"`
			MaxChars    int    `json:"maxChars,omitempty"`
			Interactive bool   `json:"interactive,omitempty"`
			FormOnly    bool   `json:"formOnly,omitempty"`
			TabID       *int   `json:"tabId,omitempty"`
		}) (*mcp.CallToolResult, any, error) {
			return run(ctx, "snapshot", input)
		})
	mcp.AddTool(server, &mcp.Tool{Name: "browser_click", Description: "Click an element by snapshot ref or fallback CSS selector."},
		func(ctx context.Context, _ *mcp.CallToolRequest, input struct {
			Ref         string   `json:"ref,omitempty"`
			Selector    string   `json:"selector,omitempty"`
			Button      string   `json:"button,omitempty"`
			DoubleClick bool     `json:"doubleClick,omitempty"`
			Modifiers   []string `json:"modifiers,omitempty"`
			Force       bool     `json:"force,omitempty"`
			TabID       *int     `json:"tabId,omitempty"`
			Snapshot    bool     `json:"snapshot,omitempty"`
		}) (*mcp.CallToolResult, any, error) {
			return run(ctx, "click", input)
		})
	mcp.AddTool(server, &mcp.Tool{Name: "browser_fill", Description: "Fill a text input, textarea, select or rich-text editor."},
		func(ctx context.Context, _ *mcp.CallToolRequest, input struct {
			Ref      string `json:"ref"`
			Text     string `json:"text"`
			TabID    *int   `json:"tabId,omitempty"`
			Snapshot bool   `json:"snapshot,omitempty"`
		}) (*mcp.CallToolResult, any, error) {
			return run(ctx, "fill", input)
		})
	mcp.AddTool(server, &mcp.Tool{Name: "browser_fill_form", Description: "Fill multiple form fields (text, boolean checkbox/radio, array select/cascader) in order."},
		func(ctx context.Context, _ *mcp.CallToolRequest, input struct {
			Fields []struct {
				Ref   string `json:"ref"`
				Value any    `json:"value"`
			} `json:"fields"`
			TabID    *int `json:"tabId,omitempty"`
			Snapshot bool `json:"snapshot,omitempty"`
		}) (*mcp.CallToolResult, any, error) {
			return run(ctx, "fill_form", input)
		})
	mcp.AddTool(server, &mcp.Tool{Name: "browser_select_option", Description: "Select option(s) in a native select or custom dropdown/cascader."},
		func(ctx context.Context, _ *mcp.CallToolRequest, input struct {
			Ref      string   `json:"ref"`
			Values   []string `json:"values"`
			TabID    *int     `json:"tabId,omitempty"`
			Snapshot bool     `json:"snapshot,omitempty"`
		}) (*mcp.CallToolResult, any, error) {
			return run(ctx, "select_option", input)
		})
	mcp.AddTool(server, &mcp.Tool{Name: "browser_type", Description: "Type text key-by-key, useful for search autocomplete."},
		func(ctx context.Context, _ *mcp.CallToolRequest, input struct {
			Ref      string `json:"ref,omitempty"`
			Text     string `json:"text"`
			Submit   bool   `json:"submit,omitempty"`
			Slowly   bool   `json:"slowly,omitempty"`
			Clear    bool   `json:"clear,omitempty"`
			TabID    *int   `json:"tabId,omitempty"`
			Snapshot bool   `json:"snapshot,omitempty"`
		}) (*mcp.CallToolResult, any, error) {
			return run(ctx, "type", input)
		})
	mcp.AddTool(server, &mcp.Tool{Name: "browser_press", Description: "Press a key or key combination such as Enter or Control+A."},
		func(ctx context.Context, _ *mcp.CallToolRequest, input struct {
			Key      string `json:"key"`
			Ref      string `json:"ref,omitempty"`
			TabID    *int   `json:"tabId,omitempty"`
			Snapshot bool   `json:"snapshot,omitempty"`
		}) (*mcp.CallToolResult, any, error) {
			return run(ctx, "press", input)
		})
	mcp.AddTool(server, &mcp.Tool{Name: "browser_scroll", Description: "Scroll the page or a referenced container."},
		func(ctx context.Context, _ *mcp.CallToolRequest, input struct {
			Ref      string `json:"ref,omitempty"`
			DeltaX   int    `json:"deltaX,omitempty"`
			DeltaY   int    `json:"deltaY,omitempty"`
			To       string `json:"to,omitempty"`
			TabID    *int   `json:"tabId,omitempty"`
			Snapshot bool   `json:"snapshot,omitempty"`
		}) (*mcp.CallToolResult, any, error) {
			return run(ctx, "scroll", input)
		})
	mcp.AddTool(server, &mcp.Tool{Name: "browser_extract", Description: "Extract readable markdown, plain text, tables (JSON [{columns, rows}]) or links from the page or an element."},
		func(ctx context.Context, _ *mcp.CallToolRequest, input struct {
			Ref      string `json:"ref,omitempty"`
			Format   string `json:"format,omitempty"`
			Offset   int    `json:"offset,omitempty"`
			MaxChars int    `json:"maxChars,omitempty"`
			TabID    *int   `json:"tabId,omitempty"`
		}) (*mcp.CallToolResult, any, error) {
			return run(ctx, "extract", input)
		})
	mcp.AddTool(server, &mcp.Tool{Name: "browser_evaluate", Description: "Evaluate JavaScript in the page (or on a referenced element) and return its result."},
		func(ctx context.Context, _ *mcp.CallToolRequest, input struct {
			Script   string `json:"script"`
			Ref      string `json:"ref,omitempty"`
			TabID    *int   `json:"tabId,omitempty"`
			Snapshot bool   `json:"snapshot,omitempty"`
		}) (*mcp.CallToolResult, any, error) {
			return run(ctx, "evaluate", input)
		})
	mcp.AddTool(server, &mcp.Tool{Name: "browser_wait_for", Description: "Wait for text to appear/disappear, a transient UI event (toast/status/loading/idle), or a fixed duration."},
		func(ctx context.Context, _ *mcp.CallToolRequest, input struct {
			Text     string  `json:"text,omitempty"`
			TextGone string  `json:"textGone,omitempty"`
			Event    string  `json:"event,omitempty"`
			Seconds  float64 `json:"seconds,omitempty"`
			Timeout  float64 `json:"timeout,omitempty"`
			TabID    *int    `json:"tabId,omitempty"`
			Snapshot bool    `json:"snapshot,omitempty"`
		}) (*mcp.CallToolResult, any, error) {
			return run(ctx, "wait_for", input)
		})
	mcp.AddTool(server, &mcp.Tool{Name: "browser_network", Description: "Inspect captured HTTP/XHR/Fetch requests, status codes, request payloads and response bodies."},
		func(ctx context.Context, _ *mcp.CallToolRequest, input struct {
			URLPattern string `json:"urlPattern,omitempty"`
			Method     string `json:"method,omitempty"`
			StatusMin  int    `json:"statusMin,omitempty"`
			FailedOnly bool   `json:"failedOnly,omitempty"`
			Clear      bool   `json:"clear,omitempty"`
			Limit      int    `json:"limit,omitempty"`
			TabID      *int   `json:"tabId,omitempty"`
		}) (*mcp.CallToolResult, any, error) {
			return run(ctx, "network", input)
		})
	mcp.AddTool(server, &mcp.Tool{Name: "browser_trace", Description: "Inspect or export action timeline and HAR 1.2 network log to disk for replay/audit."},
		func(ctx context.Context, _ *mcp.CallToolRequest, input struct {
			Op    string `json:"op"`
			Path  string `json:"path,omitempty"`
			Limit int    `json:"limit,omitempty"`
			TabID *int   `json:"tabId,omitempty"`
		}) (*mcp.CallToolResult, any, error) {
			return run(ctx, "trace", input)
		})
	mcp.AddTool(server, &mcp.Tool{Name: "browser_tabs", Description: "List, open, select or close browser tabs."},
		func(ctx context.Context, _ *mcp.CallToolRequest, input struct {
			Op       string `json:"op"`
			TabID    *int   `json:"tabId,omitempty"`
			Index    *int   `json:"index,omitempty"`
			URL      string `json:"url,omitempty"`
			Activate *bool  `json:"activate,omitempty"`
			Snapshot bool   `json:"snapshot,omitempty"`
		}) (*mcp.CallToolResult, any, error) {
			return run(ctx, "tabs", input)
		})
	mcp.AddTool(server, &mcp.Tool{Name: "browser_screenshot", Description: "Capture a JPEG screenshot of the viewport, full page or element."},
		func(ctx context.Context, _ *mcp.CallToolRequest, input struct {
			Ref      string `json:"ref,omitempty"`
			FullPage bool   `json:"fullPage,omitempty"`
			TabID    *int   `json:"tabId,omitempty"`
		}) (*mcp.CallToolResult, any, error) {
			return run(ctx, "screenshot", input)
		})
	return server.Run(ctx, &mcp.StdioTransport{})
}
