package native

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"regexp"
)

const HostName = "ai.studio.browser"

var extensionIDPattern = regexp.MustCompile(`^[a-p]{32}$`)

// Manifest binds a native host executable to the extension IDs assigned by
// Chrome or Edge. Each installed browser can register its own allowlist.
func Manifest(executable string, extensionIDs []string) ([]byte, error) {
	if !filepath.IsAbs(executable) || len(extensionIDs) == 0 {
		return nil, errors.New("invalid_browser_host_configuration")
	}
	origins := make([]string, 0, len(extensionIDs))
	seen := make(map[string]struct{}, len(extensionIDs))
	for _, id := range extensionIDs {
		if !extensionIDPattern.MatchString(id) {
			return nil, errors.New("invalid_browser_extension_id")
		}
		if _, duplicate := seen[id]; !duplicate {
			seen[id] = struct{}{}
			origins = append(origins, "chrome-extension://"+id+"/")
		}
	}
	return json.MarshalIndent(struct {
		Name        string   `json:"name"`
		Description string   `json:"description"`
		Path        string   `json:"path"`
		Type        string   `json:"type"`
		Origins     []string `json:"allowed_origins"`
	}{HostName, "AI Studio 共享标签页", executable, "stdio", origins}, "", "  ")
}
