//go:build darwin || windows

package browser

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"fastgpt.local/local-device/internal/grant"
)

type dedicatedWindow struct {
	actions sync.Mutex
	manual  bool
	owner   grant.Owner
	session *Session
	page    pageRunner
	pipe    *cdpPipe
	done    <-chan struct{}
	stop    func()
}

// pageRunner executes one browser action on the window's current page.
type pageRunner interface {
	run(ctx context.Context, action Action) (json.RawMessage, error)
}

// EmbeddedAvailable reports whether the connector distribution includes the
// window and its runtime. Older packages cannot open a manual embedded window.
func EmbeddedAvailable() bool {
	executable, err := os.Executable()
	if err != nil {
		return false
	}
	main, runtimePath := embeddedPaths(filepath.Dir(executable))
	for _, file := range []string{main, runtimePath} {
		info, err := os.Stat(file)
		if err != nil || !info.Mode().IsRegular() {
			return false
		}
	}
	return true
}

func dedicatedProfile(profile string) (string, error) {
	if !filepath.IsAbs(profile) {
		return "", errors.New("invalid_browser_profile")
	}
	if err := os.MkdirAll(profile, 0700); err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(profile)
}

// startDedicated reserves the profile until its browser process has exited.
func (r *Registry) startDedicated(lifetime context.Context, profile string) (*dedicatedWindow, error) {
	if r.activeProfile != "" {
		return nil, errors.New("browser_profile_in_use")
	}
	if _, occupied := r.profiles.LoadOrStore(profile, struct{}{}); occupied {
		return nil, errors.New("browser_profile_in_use")
	}
	owned := false
	defer func() {
		if !owned {
			r.profiles.Delete(profile)
		}
	}()
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	directory := filepath.Dir(executable)
	processCtx, terminate := context.WithCancel(context.WithoutCancel(lifetime))
	var pipe *cdpPipe
	var done <-chan struct{}
	open := func(ctx context.Context, pipe *cdpPipe) (pageRunner, error) { return openPage(ctx, pipe) }
	main, _ := embeddedPaths(directory)
	if _, statErr := os.Stat(main); statErr == nil {
		pipe, done, err = launchEmbedded(processCtx, directory, profile)
		open = openEmbeddedPage
	} else {
		var browserExecutable string
		browserExecutable, err = installedChromium()
		if err == nil {
			pipe, done, err = launchChromium(processCtx, browserExecutable, profile)
		}
	}
	if err != nil {
		terminate()
		return nil, err
	}
	closeBrowser := func() {
		defer terminate()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_, _ = pipe.call(ctx, "", "Browser.close", nil)
		select {
		case <-done:
		case <-ctx.Done():
			terminate()
			<-done
		}
	}
	startup, timeout := context.WithTimeout(lifetime, embeddedStartupTimeout)
	defer timeout()
	page, err := open(startup, pipe)
	if err != nil {
		closeBrowser()
		return nil, err
	}
	window := &dedicatedWindow{page: page, pipe: pipe, done: done, stop: closeBrowser}
	owned = true
	r.activeProfile = profile
	r.windows.Store(profile, window)
	if r.Management != nil {
		go func() {
			for {
				select {
				case action := <-pipe.management:
					ctx, cancel := context.WithTimeout(lifetime, 8*time.Second)
					payload := r.Management(ctx, action)
					_, _ = pipe.call(ctx, "", "Connector.managementSnapshot", payload)
					cancel()
				case <-done:
					return
				case <-lifetime.Done():
					return
				}
			}
		}()
	}
	go func() {
		<-done
		r.windowMu.Lock()
		defer r.windowMu.Unlock()
		r.activeProfile = ""
		terminate()
		r.unboundWindows.CompareAndDelete(profile, window)
		r.windows.CompareAndDelete(profile, window)
		r.profiles.Delete(profile)
	}()
	return window, nil
}

// OpenDedicated makes the user-owned window available to the next authorized
// chat for this account. Focusing an existing window never changes its binding.
func (r *Registry) OpenDedicated(lifetime context.Context, profile string, management bool) error {
	r.windowMu.Lock()
	defer r.windowMu.Unlock()
	if !EmbeddedAvailable() {
		return errors.New("browser_unavailable")
	}
	profile, err := dedicatedProfile(profile)
	if err != nil {
		return err
	}
	focus := func(window *dedicatedWindow) error {
		ctx, cancel := context.WithTimeout(lifetime, 3*time.Second)
		defer cancel()
		_, err := window.pipe.call(ctx, "", "Connector.focus", map[string]bool{"management": management})
		return err
	}
	if opened, ok := r.windows.Load(profile); ok {
		return focus(opened.(*dedicatedWindow))
	}
	window, err := r.startDedicated(lifetime, profile)
	if err != nil {
		return err
	}
	window.manual = true
	r.unboundWindows.Store(profile, window)
	go func() {
		select {
		case <-lifetime.Done():
			window.stop()
		case <-window.done:
			r.unboundWindows.CompareAndDelete(profile, window)
		}
	}()
	return focus(window)
}

// BindDedicated attaches one authenticated grant to the existing local window.
// A user-owned window remains open when its grant ends.
func (r *Registry) BindDedicated(lifetime context.Context, owner grant.Owner, grantID string, version int64, profile string) error {
	profile, err := dedicatedProfile(profile)
	if err != nil {
		return err
	}
	r.windowMu.Lock()
	defer r.windowMu.Unlock()
	var window *dedicatedWindow
	var prevSession *Session
	if opened, ok := r.unboundWindows.LoadAndDelete(profile); ok {
		window = opened.(*dedicatedWindow)
	} else if opened, ok := r.windows.Load(profile); ok {
		existing := opened.(*dedicatedWindow)
		// 内置浏览器主窗口允许新对话直接接管，无需等待旧对话租约过期。
		if existing.manual {
			window = existing
			prevSession = existing.session
		}
	}
	if window == nil {
		window, err = r.startDedicated(lifetime, profile)
		if err != nil {
			return err
		}
	}
	session := NewSession(lifetime, grantID, version, func(ctx context.Context, action Action) (json.RawMessage, error) {
		window.actions.Lock()
		defer window.actions.Unlock()
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return window.page.run(ctx, action)
	})
	// 内置浏览器引擎的 ref 绑定 backendNodeId 且全局唯一，失效 ref 会被引擎拒绝或按语义重定位，
	// 接管时无需强制重新 snapshot；外部 Chromium 驱动仍要求先观察页面。
	session.needsSnapshot = !window.manual
	if prevSession != nil {
		r.Unbind(window.owner, prevSession)
	}
	if err := r.Bind(owner, session); err != nil {
		session.Close()
		if window.manual && prevSession == nil {
			r.unboundWindows.Store(profile, window)
		} else if !window.manual {
			window.stop()
		}
		return err
	}
	window.owner = owner
	window.session = session
	go func() {
		defer session.Close()
		select {
		case <-session.lifetime.Done():
			if window.manual {
				r.windowMu.Lock()
				if window.session == session {
					window.session = nil
					if current, ok := r.windows.Load(profile); ok && current == window {
						r.unboundWindows.Store(profile, window)
					}
				}
				r.windowMu.Unlock()
			} else {
				window.stop()
			}
		case <-window.done:
		}
	}()
	return nil
}
