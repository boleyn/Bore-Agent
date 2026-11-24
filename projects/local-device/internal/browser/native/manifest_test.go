package native

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func TestManifestRequiresExplicitExtensionOrigin(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "browser-native-host")
	id := strings.Repeat("a", 32)
	manifest, err := Manifest(executable, []string{id, id})
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Path    string   `json:"path"`
		Origins []string `json:"allowed_origins"`
	}
	if json.Unmarshal(manifest, &parsed) != nil || parsed.Path != executable ||
		len(parsed.Origins) != 1 || parsed.Origins[0] != "chrome-extension://"+id+"/" {
		t.Fatalf("unexpected manifest: %s", manifest)
	}
	for _, ids := range [][]string{nil, {"*"}, {id + "/"}} {
		if _, err := Manifest(executable, ids); err == nil {
			t.Fatalf("accepted invalid extension IDs: %v", ids)
		}
	}
}
