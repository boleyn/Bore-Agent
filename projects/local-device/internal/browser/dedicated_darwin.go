package browser

import (
	"errors"
	"os"
	"path/filepath"
)

func installedChromium() (string, error) {
	home, _ := os.UserHomeDir()
	locations := []string{"/Applications"}
	if home != "" {
		locations = append(locations, filepath.Join(home, "Applications"))
	}
	for _, root := range locations {
		for _, name := range []string{"Google Chrome", "Microsoft Edge"} {
			path := filepath.Join(root, name+".app", "Contents", "MacOS", name)
			if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0 {
				return path, nil
			}
		}
	}
	return "", errors.New("browser_executable_not_found")
}
