//go:build darwin || linux || windows

package browser

import (
	"context"
	"os"
	"os/exec"
)

// launchChromium starts a dedicated Chromium instance with private inherited
// file descriptors. The profile must be exclusively owned by the caller.
func launchChromium(ctx context.Context, executable, profile string, flags ...string) (*cdpPipe, <-chan struct{}, error) {
	fromConnector, toBrowser, err := os.Pipe()
	if err != nil {
		return nil, nil, err
	}
	defer fromConnector.Close()
	fromBrowser, toConnector, err := os.Pipe()
	if err != nil {
		toBrowser.Close()
		return nil, nil, err
	}
	defer toConnector.Close()

	args := append([]string{
		"--remote-debugging-pipe", "--user-data-dir=" + profile,
		"--no-first-run", "--no-default-browser-check",
	}, flags...)
	cmd := exec.CommandContext(ctx, executable, append(args, "about:blank")...)
	if err := configureChromiumPipe(cmd, fromConnector, toConnector); err != nil {
		toBrowser.Close()
		fromBrowser.Close()
		return nil, nil, err
	}
	if err := cmd.Start(); err != nil {
		toBrowser.Close()
		fromBrowser.Close()
		return nil, nil, err
	}
	pipe := newCDPPipe(ctx, fromBrowser, toBrowser)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer pipe.stop()
		_ = cmd.Wait()
	}()
	return pipe, done, nil
}
