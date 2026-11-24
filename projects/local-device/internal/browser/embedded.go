//go:build darwin || windows

package browser

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

// embeddedPaths supports the signed macOS bundle and flat development paths.
func embeddedPaths(directory string) (main, executable string) {
	main = filepath.Join(directory, "embedded-browser", "main.cjs")
	executable = filepath.Join(directory, "browser-runtime", "electron.exe")
	if runtime.GOOS == "darwin" {
		executable = filepath.Join(directory, "browser-runtime", "Electron.app", "Contents", "MacOS", "Electron")
		if filepath.Base(directory) == "MacOS" {
			contents := filepath.Dir(directory)
			bundle := filepath.Join(contents, "Frameworks", "Electron.app", "Contents")
			main = filepath.Join(bundle, "Resources", "app", "main.cjs")
			executable = filepath.Join(bundle, "MacOS", "Electron")
		}
	}
	return main, executable
}

// launchEmbedded starts the bundled renderer host. Windows GUI processes get
// unusable stdio, so the transport itself is platform specific.
func launchEmbedded(ctx context.Context, directory, profile string) (*cdpPipe, <-chan struct{}, error) {
	main, runtimePath := embeddedPaths(directory)
	if _, err := os.Stat(main); err != nil {
		return nil, nil, err
	}

	args := []string{"--connector-browser-profile=" + profile}
	if runtime.GOOS != "darwin" || filepath.Base(directory) != "MacOS" {
		args = append([]string{main}, args...)
	}
	return startEmbedded(ctx, main, runtimePath, args)
}

// embeddedPage forwards validated actions to the Electron agent engine, which
// owns tabs, snapshots, references and auto-waiting inside the window process.
type embeddedPage struct {
	pipe *cdpPipe
}

// openEmbeddedPage waits for the window to finish starting before any action.
func openEmbeddedPage(ctx context.Context, pipe *cdpPipe) (pageRunner, error) {
	if _, err := pipe.call(ctx, "", "Connector.ready", nil); err != nil {
		return nil, err
	}
	return &embeddedPage{pipe: pipe}, nil
}

// run sends the raw action. Engine-level failures come back as {"ok":false}
// results so the model can read the reason; only transport, pause and busy
// states surface as errors.
func (p *embeddedPage) run(ctx context.Context, action Action) (json.RawMessage, error) {
	if len(action.Raw) == 0 {
		return nil, errors.New("invalid_browser_action")
	}
	return p.pipe.call(ctx, "", "Agent.run", action.Raw)
}

const embeddedStartupTimeout = 20 * time.Second
