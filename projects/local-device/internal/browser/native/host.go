package native

import (
	"errors"
	"io"
	"os"
	"strings"
)

// IsBrowserLaunch recognizes the origin argument Chromium passes to its host.
func IsBrowserLaunch(args []string) bool {
	if len(args) == 0 {
		return false
	}
	id, ok := strings.CutPrefix(args[0], "chrome-extension://")
	return ok && strings.HasSuffix(id, "/") && extensionIDPattern.MatchString(strings.TrimSuffix(id, "/"))
}

// RunHost connects browser stdio to the private current-user connector.
func RunHost() error {
	connector, err := Dial()
	if err != nil {
		return errors.New("browser connector unavailable")
	}
	err = Relay(os.Stdin, os.Stdout, connector)
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}
