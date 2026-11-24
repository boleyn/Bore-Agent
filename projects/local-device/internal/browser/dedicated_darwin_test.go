package browser

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"fastgpt.local/local-device/internal/grant"
)

func TestVisibleDedicatedBrowserGrant(t *testing.T) {
	if os.Getenv("FASTGPT_TEST_VISIBLE_BROWSER") != "1" {
		t.Skip("set FASTGPT_TEST_VISIBLE_BROWSER=1 on a desktop with Chrome or Edge")
	}
	lifetime, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	registry := &Registry{}
	owner := grant.Owner{DeviceID: "visible_device", TeamID: "team", MemberID: "member"}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	profile := filepath.Join(root, "profile")
	if err := registry.BindDedicated(lifetime, owner, "grant", 1, profile); err != nil {
		t.Fatal(err)
	}
	defer func() {
		registry.Revoke(owner, "grant", 1)
		deadline := time.Now().Add(8 * time.Second)
		for {
			_, occupied := registry.profiles.Load(profile)
			if !occupied {
				break
			}
			if time.Now().After(deadline) {
				t.Error("browser profile remained occupied after revocation")
				return
			}
			time.Sleep(25 * time.Millisecond)
		}
	}()

	request := Request{GrantID: "grant", GrantVersion: 1, OperationID: "snapshot", Action: Action{Name: "snapshot"}}
	if _, err := registry.Run(lifetime, owner, request); err != nil {
		t.Fatal(err)
	}
	if err := registry.BindDedicated(lifetime, owner, "other", 1, profile); err == nil || err.Error() != "browser_profile_in_use" {
		t.Fatalf("concurrent profile binding: %v", err)
	}
	registry.Revoke(owner, "grant", 1)
	if registry.Has(owner, "grant", 1) {
		t.Fatal("revoked browser target is still live")
	}
}
