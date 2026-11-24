//go:build (darwin || windows) && !headless

package desktop

import (
	"context"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"

	"fastgpt.local/local-device/internal/browser"
	"fastgpt.local/local-device/internal/browser/native"
	"fastgpt.local/local-device/internal/connector"
	"fastgpt.local/local-device/internal/grant"
)

// Build-time IDs are assigned by the extension distribution for each browser.
var ChromeExtensionID string
var EdgeExtensionID string

func registerDistributedBrowserHosts() {
	executable, err := os.Executable()
	if err != nil {
		log.Print("browser host executable unavailable")
		return
	}
	for name, id := range map[string]string{"chrome": ChromeExtensionID, "edge": EdgeExtensionID} {
		if id != "" {
			if err := native.Register(name, executable, id); err != nil {
				log.Printf("browser host registration failed browser=%s", name)
			}
		}
	}
}

// configureBrowser shares one registry and listener across all accounts managed
// by the tray. Each approval remains bound to its authenticated device owner.
func configureBrowser(ctx context.Context, input *connector.StartOptions) (
	openWindow func(bool) error,
) {
	if ChromeExtensionID != "" || EdgeExtensionID != "" {
		registerDistributedBrowserHosts()
	}
	registry := &browser.Registry{}
	registry.Management = func(ctx context.Context, action string) any {
		reply := make(chan managementSnapshot, 1)
		select {
		case managementSnapshotRequests <- managementSnapshotRequest{ctx: ctx, reply: reply, action: action}:
		case <-ctx.Done():
			return managementSnapshot{Error: "连接器未响应，请刷新。"}
		}
		select {
		case snapshot := <-reply:
			return snapshot
		case <-ctx.Done():
			return managementSnapshot{Error: "连接器未响应，请刷新。"}
		}
	}
	listener, _ := browser.ListenForSharedTabs()
	if listener != nil {
		context.AfterFunc(ctx, func() { _ = listener.Close() })
	}
	// 主窗口属于本机操作系统用户；账号和聊天授权只决定谁可以控制当前网页。
	profile := filepath.Join(input.StateDirectory, "browser-profiles", "local")
	input.Browser = registry
	input.ConfirmBrowser = func(promptCtx, lifetime context.Context, value grant.Grant) error {
		confirm := func(ctx context.Context, target string) error {
			message := executionApprovalMessage(value, "当前浏览器会话")
			message = strings.SplitN(message, "\n\n命令以", 2)[0] + "\n\n浏览器：" + target
			result, err := dialog(ctx, "browserApprove", message, "")
			if err != nil {
				return err
			}
			if strings.TrimSpace(result) != "confirmed" {
				return errors.New("local_confirmation_cancelled")
			}
			return ctx.Err()
		}
		switch value.BrowserMode {
		case "dedicated":
			// 内置浏览器沿用已有设备授权；聊天仍按 owner、grant 和版本绑定当前窗口。
			if err := promptCtx.Err(); err != nil {
				return err
			}
			if browser.EmbeddedAvailable() {
				if err := registry.OpenDedicated(ctx, profile, false); err != nil {
					return err
				}
			}
			return registry.BindDedicated(lifetime, value.Owner, value.ID, value.Version, profile)
		case "sharedTab":
			if listener == nil {
				return errors.New("browser_unavailable")
			}
			page, err := listener.Wait(promptCtx, confirm)
			if err != nil {
				return err
			}
			return registry.BindShared(lifetime, value.Owner, value.ID, value.Version, page)
		default:
			return errors.New("invalid_browser_grant")
		}
	}
	if browser.EmbeddedAvailable() {
		openWindow = func(management bool) error {
			return registry.OpenDedicated(ctx, profile, management)
		}
	}
	return openWindow
}
