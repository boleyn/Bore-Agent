package browser

import (
	"errors"
	"os"
	"path/filepath"
)

func installedChromium() (string, error) {
	for _, variable := range []string{"ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"} {
		root := os.Getenv(variable)
		if !filepath.IsAbs(root) {
			continue
		}
		for _, relative := range []string{
			filepath.Join("Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join("Microsoft", "Edge", "Application", "msedge.exe"),
		} {
			path := filepath.Join(root, relative)
			if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
				return path, nil
			}
		}
	}
	return "", errors.New("browser_executable_not_found")
}
