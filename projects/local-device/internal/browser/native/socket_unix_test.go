//go:build darwin || linux

package native

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestListenerPreservesLiveSocket(t *testing.T) {
	directory, err := os.MkdirTemp("/tmp", "fastgpt-ipc-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(directory)
	path := filepath.Join(directory, "connector.sock")
	listener, err := listenAt(path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if duplicate, err := listenAt(path); err == nil {
		duplicate.Close()
		t.Fatal("second listener replaced the live socket")
	}
	client, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	server.Close()
}
