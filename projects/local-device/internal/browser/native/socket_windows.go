package native

import (
	"net"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

// endpoint scopes both the pipe name and its ACL to the current Windows user.
func endpoint() (string, string, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", "", err
	}
	sid := user.User.Sid.String()
	return `\\.\pipe\aistudio-browser-` + sid, sid, nil
}

// Listen admits the current user and denies network logons.
func Listen() (net.Listener, error) {
	path, sid, err := endpoint()
	if err != nil {
		return nil, err
	}
	return winio.ListenPipe(path, &winio.PipeConfig{
		SecurityDescriptor: "D:P(D;;GA;;;NU)(A;;GA;;;" + sid + ")",
	})
}

// Dial opens the current user's connector endpoint with bounded startup time.
func Dial() (net.Conn, error) {
	path, _, err := endpoint()
	if err != nil {
		return nil, err
	}
	timeout := 2 * time.Second
	return winio.DialPipe(path, &timeout)
}
