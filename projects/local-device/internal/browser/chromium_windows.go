package browser

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// configureChromiumPipe gives the child only the browser endpoints. The
// parent endpoints stay private and no debugging port is opened.
func configureChromiumPipe(cmd *exec.Cmd, read, write *os.File) error {
	handles := []syscall.Handle{syscall.Handle(read.Fd()), syscall.Handle(write.Fd())}
	for _, handle := range handles {
		if err := windows.SetHandleInformation(windows.Handle(handle), windows.HANDLE_FLAG_INHERIT, windows.HANDLE_FLAG_INHERIT); err != nil {
			return err
		}
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{AdditionalInheritedHandles: handles}
	cmd.Args = append(cmd.Args, fmt.Sprintf("--remote-debugging-io-pipes=%d,%d", handles[0], handles[1]))
	return nil
}
