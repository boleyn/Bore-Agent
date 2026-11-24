//go:build darwin || linux

package native

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"

	"golang.org/x/sys/unix"
)

// SocketPath is inside a current-user directory. The listener must create that
// directory with mode 0700 and reject directories owned by other users.
func SocketPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".aistudio-browser", "connector.sock"), nil
}

// Dial opens the connector's current-user Unix socket.
func Dial() (net.Conn, error) {
	path, err := SocketPath()
	if err != nil {
		return nil, err
	}
	return net.Dial("unix", path)
}

// Listen opens the user-private endpoint. The lock remains held until Close,
// so a second connector cannot unlink a live listener.
func Listen() (net.Listener, error) {
	path, err := SocketPath()
	if err != nil {
		return nil, err
	}
	return listenAt(path)
}

func listenAt(path string) (net.Listener, error) {
	directory := filepath.Dir(path)
	if err := os.Mkdir(directory, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, err
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return nil, err
	}
	owner, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(owner.Uid) != os.Geteuid() || !info.IsDir() || info.Mode().Perm() != 0700 {
		return nil, errors.New("browser_socket_directory_not_private")
	}
	fd, err := unix.Open(path+".lock", unix.O_CREAT|unix.O_RDWR|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	lock := os.NewFile(uintptr(fd), "browser socket lock")
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		_ = lock.Close()
		return nil, err
	}
	listener, err := func() (net.Listener, error) {
		if previous, err := os.Lstat(path); err == nil {
			if previous.Mode()&os.ModeSocket == 0 {
				return nil, errors.New("browser_socket_path_in_use")
			}
			if err := os.Remove(path); err != nil {
				return nil, err
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		return net.Listen("unix", path)
	}()
	if err != nil {
		_ = lock.Close()
		return nil, err
	}
	return &lockedListener{Listener: listener, lock: lock}, nil
}

type lockedListener struct {
	net.Listener
	lock *os.File
	once sync.Once
	err  error
}

func (l *lockedListener) Close() error {
	l.once.Do(func() {
		l.err = l.Listener.Close()
		_ = l.lock.Close()
	})
	return l.err
}
