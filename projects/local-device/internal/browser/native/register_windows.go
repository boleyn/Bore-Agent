package native

import (
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows/registry"
)

func registryPath(browser string) (string, error) {
	switch browser {
	case "chrome":
		return `Software\Google\Chrome\NativeMessagingHosts\` + HostName, nil
	case "edge":
		return `Software\Microsoft\Edge\NativeMessagingHosts\` + HostName, nil
	default:
		return "", errors.New("unsupported_browser")
	}
}

func registrationPath(browser string) (string, error) {
	if _, err := registryPath(browser); err != nil {
		return "", err
	}
	root, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "AI Studio", "Browser", browser, HostName+".json"), nil
}

func registerPath(browser, path string) error {
	keyPath, err := registryPath(browser)
	if err != nil {
		return err
	}
	key, _, err := registry.CreateKey(registry.CURRENT_USER, keyPath, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	return key.SetStringValue("", path)
}

func unregisterPath(browser string) error {
	keyPath, err := registryPath(browser)
	if err != nil {
		return err
	}
	if err := registry.DeleteKey(registry.CURRENT_USER, keyPath); !errors.Is(err, registry.ErrNotExist) {
		return err
	}
	return nil
}
