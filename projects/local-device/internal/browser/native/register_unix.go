//go:build darwin || linux

package native

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
)

func registrationPath(browser string) (string, error) {
	root, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	var directory string
	switch browser {
	case "chrome":
		directory = "google-chrome"
		if runtime.GOOS == "darwin" {
			directory = filepath.Join("Google", "Chrome")
		}
	case "edge":
		directory = "microsoft-edge"
		if runtime.GOOS == "darwin" {
			directory = "Microsoft Edge"
		}
	default:
		return "", errors.New("unsupported_browser")
	}
	return filepath.Join(root, directory, "NativeMessagingHosts", HostName+".json"), nil
}

func registerPath(string, string) error { return nil }
func unregisterPath(string) error       { return nil }
