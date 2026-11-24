//go:build darwin || linux

package browser

import (
	"os"
	"os/exec"
)

func configureChromiumPipe(cmd *exec.Cmd, read, write *os.File) error {
	cmd.ExtraFiles = []*os.File{read, write}
	return nil
}
