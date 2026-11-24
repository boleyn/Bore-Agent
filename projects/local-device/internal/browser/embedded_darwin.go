//go:build darwin

package browser

import (
	"context"
	"os"
	"os/exec"
)

// startEmbedded keeps the inherited stdio channel, which the signed macOS
// helper supports.
func startEmbedded(ctx context.Context, _ string, runtimePath string, args []string) (*cdpPipe, <-chan struct{}, error) {
	command := exec.CommandContext(ctx, runtimePath, args...)
	command.Stderr = os.Stderr
	in, err := command.StdinPipe()
	if err != nil {
		return nil, nil, err
	}
	out, err := command.StdoutPipe()
	if err != nil {
		_ = in.Close()
		return nil, nil, err
	}
	if err := command.Start(); err != nil {
		_ = in.Close()
		_ = out.Close()
		return nil, nil, err
	}
	pipe := newCDPPipe(ctx, out, in)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer pipe.stop()
		_ = command.Wait()
	}()
	return pipe, done, nil
}
