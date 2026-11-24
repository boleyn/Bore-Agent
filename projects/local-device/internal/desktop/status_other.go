//go:build !darwin || headless

package desktop

func installStatusHook(bool)        {}
func setNativeWindowPID(pid int)    {}
func setNativeStatus(status string) {}
