// Command connector starts the desktop execution core with native approval dialogs.
// Installer/tray integration uses the same connector.Start entry point.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"fastgpt.local/local-device/internal/browser"
	"fastgpt.local/local-device/internal/browser/native"
	"fastgpt.local/local-device/internal/connector"
	"fastgpt.local/local-device/internal/desktop"
)

var version = "development"
var stateDirName = "ai.studio.local-device"

// devLoopback retains compatibility with the existing packaging flag.
var devLoopback string

func main() {
	if native.IsBrowserLaunch(os.Args[1:]) {
		if err := native.RunHost(); err != nil {
			log.Fatal("browser native session ended")
		}
		return
	}
	desktop.ClientVersion = version
	if devLoopback == "1" {
		os.Setenv("LOCAL_DEVICE_DEV_LOOPBACK", "1")
	}
	browserMCP := flag.Bool("browser-mcp", false, "Serve a fresh embedded browser to a local MCP client over stdio")
	testPlatform := flag.String("test-platform", "", "Test platform discovery and gateway access without connecting")
	showVersion := flag.Bool("version", false, "Show connector version and exit")
	origin := flag.String("platform", "", "Platform origin (HTTP or HTTPS)")
	gateway := flag.String("gateway", "", "Optional WS/WSS override; normally discovered from the platform")
	directory := flag.String("state-dir", "", "Private state directory (defaults to the user config directory)")
	name := flag.String("name", "", "Device display name (defaults to hostname)")
	shell := flag.String("shell", "", "Local shell: bash/sh, or powershell/cmd on Windows")
	registerBrowser := flag.String("register-browser", "", "Register this executable as the native host for chrome or edge")
	unregisterBrowser := flag.String("unregister-browser", "", "Remove the current-user browser host registration")
	extensionID := flag.String("browser-extension-id", "", "Explicit extension ID for browser host registration")
	flag.Parse()
	if *browserMCP {
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		if err := browser.RunMCP(ctx); err != nil {
			log.Fatal(err)
		}
		return
	}
	if *registerBrowser != "" {
		if *unregisterBrowser != "" {
			log.Fatal("register and unregister are mutually exclusive")
		}
		executable, err := os.Executable()
		if err == nil {
			err = native.Register(*registerBrowser, executable, *extensionID)
		}
		if err != nil {
			log.Fatal(err)
		}
		return
	}
	if *unregisterBrowser != "" {
		if err := native.Unregister(*unregisterBrowser); err != nil {
			log.Fatal(err)
		}
		return
	}
	if *testPlatform != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		defer cancel()
		client, err := connector.NewPlatformClient(*testPlatform, nil)
		if err == nil {
			_, err = client.Discover(ctx)
		}
		if err != nil {
			fmt.Print(err.Error())
			os.Exit(1)
		}
		fmt.Print("ok")
		return
	}
	if *showVersion {
		fmt.Println(version)
		return
	}
	release, acquired, err := acquireInstance()
	if err != nil {
		log.Fatal("cannot acquire connector instance: ", err)
	}
	if !acquired {
		return
	}
	defer release()
	if err := registerLaunchProtocol(); err != nil {
		log.Print("connector: cannot register launch protocol: ", err)
	}
	if *directory == "" {
		config, err := os.UserConfigDir()
		if err != nil {
			log.Fatal("cannot resolve private configuration directory")
		}
		*directory = filepath.Join(config, stateDirName)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	err = desktop.Run(ctx, connector.StartOptions{
		Origin: *origin, GatewayURL: *gateway, StateDirectory: *directory, Name: *name, Shell: *shell,
		Confirm: desktop.Confirm,
		Status:  func(value string) { log.Print("connector: ", value) },
	})
	if err != nil && !errors.Is(err, context.Canceled) {
		log.Fatal("connector stopped: ", err)
	}
}
