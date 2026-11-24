//go:build darwin || linux || windows

package native

import (
	"errors"
	"os"
	"path/filepath"
)

// Register installs the current user's host manifest for one browser.
func Register(browser, executable, extensionID string) error {
	payload, err := Manifest(executable, []string{extensionID})
	if err != nil {
		return err
	}
	path, err := registrationPath(browser)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".browser-host-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(payload); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(file.Name(), path); err != nil {
		return err
	}
	return registerPath(browser, path)
}

// Unregister removes only the selected browser's current-user registration.
func Unregister(browser string) error {
	path, err := registrationPath(browser)
	if err != nil {
		return err
	}
	if err := unregisterPath(browser); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
